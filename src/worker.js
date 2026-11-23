import {
  buildConsentMessage,
  getPrivateUpdateContext,
  getUpdateType,
  isValidWebhookSecret,
  parseCommand,
  CONSENT_YES,
  CONSENT_NO,
} from './lib/telegram.js';
import { safeEqual } from './lib/crypto.js';
import { createStore } from './tg/store.js';
import { HttpError } from './tg/engine.js';

const VERSION = '0.1.2';
const WEBHOOK_PATH = '/api/telegram/webhook';
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function callTelegram(env, method, payload = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('telegram_not_configured');

  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('telegram_invalid_response');
  }
  if (!response.ok || !result?.ok) {
    // Do not include request URL or token in logs/errors.
    throw new Error(`telegram_${method}_failed`);
  }
  return result.result;
}

async function checkDatabase(env) {
  if (!env.DB) return { status: 'not_configured', leadsCount: null };
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM leads').first();
    return { status: 'connected', leadsCount: Number(row?.total ?? 0) };
  } catch {
    return { status: 'schema_missing_or_unavailable', leadsCount: null };
  }
}

async function health(request, env) {
  const database = await checkDatabase(env);
  const telegram = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET
    ? 'configured'
    : 'not_configured';
  const ok = database.status === 'connected';
  return json({
    ok,
    app: 'Lead Database Manager',
    version: VERSION,
    checks: {
      worker: 'ok',
      database: database.status,
      telegram,
      webhook: 'not_checked',
    },
    leads_count: database.leadsCount,
    checked_at: new Date().toISOString(),
  }, ok ? 200 : 503);
}

async function registerWebhook(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!env.SETUP_TOKEN || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET || !env.DB) {
    return json({ ok: false, error: 'missing_worker_configuration' }, 503);
  }
  const setupToken = request.headers.get('x-setup-token') || '';
  if (setupToken.length < 32 || setupToken !== env.SETUP_TOKEN) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (!isValidWebhookSecret(env.TELEGRAM_WEBHOOK_SECRET, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ ok: false, error: 'invalid_webhook_secret_format' }, 503);
  }
  const dbCheck = await checkDatabase(env);
  if (dbCheck.status !== 'connected') {
    return json({ ok: false, error: 'database_not_ready_apply_migration' }, 503);
  }

  try {
    const bot = await callTelegram(env, 'getMe');
    const webhookUrl = `${new URL(request.url).origin}${WEBHOOK_PATH}`;
    await callTelegram(env, 'setWebhook', {
      url: webhookUrl,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: false,
    });
    return json({
      ok: true,
      message: 'Telegram webhook зарегистрирован.',
      bot_username: bot?.username || null,
      webhook_url: webhookUrl,
    });
  } catch (error) {
    console.error('telegram_webhook_setup_failed', error?.message || 'unknown');
    return json({ ok: false, error: 'telegram_connection_or_webhook_setup_failed' }, 502);
  }
}

async function claimUpdate(env, update) {
  const updateId = update?.update_id;
  if (!Number.isSafeInteger(updateId) || updateId < 0) return false;
  const receivedAt = new Date().toISOString();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO telegram_updates (update_id, update_type, status, received_at)
    VALUES (?, ?, 'received', ?)
  `).bind(updateId, getUpdateType(update), receivedAt).run();

  const claim = await env.DB.prepare(`
    UPDATE telegram_updates
       SET status = 'processing', processing_at = ?, error_code = NULL
     WHERE update_id = ?
       AND (
         status IN ('received', 'failed')
         OR (status = 'processing' AND julianday(processing_at) < julianday('now', '-2 minutes'))
       )
  `).bind(receivedAt, updateId).run();
  return Number(claim?.meta?.changes || 0) > 0;
}

async function markUpdate(env, updateId, status, errorCode = null) {
  const processedAt = status === 'processed' ? new Date().toISOString() : null;
  await env.DB.prepare(`
    UPDATE telegram_updates
       SET status = ?, processed_at = COALESCE(?, processed_at), error_code = ?
     WHERE update_id = ?
  `).bind(status, processedAt, errorCode, updateId).run();
}

async function recordConsent(env, context, updateId) {
  const now = new Date().toISOString();
  const leadId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO leads (
        id, telegram_id, username, first_name, last_name, source,
        quality, status, consent_status, consent_at, consent_source,
        last_interaction_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'telegram_bot', 'unclassified', 'new', 'granted', ?, 'telegram_bot:inline_consent', ?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username = COALESCE(excluded.username, leads.username),
        first_name = COALESCE(excluded.first_name, leads.first_name),
        last_name = COALESCE(excluded.last_name, leads.last_name),
        consent_status = 'granted',
        consent_at = excluded.consent_at,
        consent_source = excluded.consent_source,
        last_interaction_at = excluded.last_interaction_at,
        updated_at = excluded.updated_at
    `).bind(
      leadId, context.telegramId, context.user.username, context.user.firstName,
      context.user.lastName, now, now, now, now,
    ),
    env.DB.prepare(`
      INSERT OR IGNORE INTO consent_events (id, lead_id, action, source, event_key, created_at)
      VALUES (?, (SELECT id FROM leads WHERE telegram_id = ?), 'granted', 'telegram_bot:inline_consent', ?, ?)
    `).bind(eventId, context.telegramId, `telegram:update:${updateId}:consent`, now),
  ]);
}

async function revokeConsent(env, context, updateId) {
  const existing = await env.DB.prepare('SELECT id FROM leads WHERE telegram_id = ?').bind(context.telegramId).first();
  if (!existing?.id) return false;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE leads
         SET consent_status = 'revoked', last_interaction_at = ?, updated_at = ?
       WHERE telegram_id = ?
    `).bind(now, now, context.telegramId),
    env.DB.prepare(`
      INSERT OR IGNORE INTO consent_events (id, lead_id, action, source, event_key, created_at)
      VALUES (?, ?, 'revoked', 'telegram_bot:/stop', ?, ?)
    `).bind(crypto.randomUUID(), existing.id, `telegram:update:${updateId}:revoke`, now),
  ]);
  return true;
}

async function handleTelegramUpdate(env, update) {
  const context = getPrivateUpdateContext(update);
  if (!context) return;

  if (context.type === 'callback_query') {
    await callTelegram(env, 'answerCallbackQuery', { callback_query_id: context.callbackQueryId });
    if (context.callbackData === CONSENT_YES) {
      await recordConsent(env, context, update.update_id);
      await callTelegram(env, 'sendMessage', {
        chat_id: context.chatId,
        text: 'Согласие сохранено. Ваш профиль добавлен в базу. Вы можете отозвать согласие в любой момент командой /stop.',
      });
    } else if (context.callbackData === CONSENT_NO) {
      await callTelegram(env, 'sendMessage', {
        chat_id: context.chatId,
        text: 'Понял. Профиль не добавлен в базу. Вы можете вернуться и дать согласие позже командой /start.',
      });
    }
    return;
  }

  const command = parseCommand(context.text);
  if (command === 'start') {
    await callTelegram(env, 'sendMessage', {
      chat_id: context.chatId,
      ...buildConsentMessage(),
    });
  } else if (command === 'help') {
    await callTelegram(env, 'sendMessage', {
      chat_id: context.chatId,
      text: 'Команды: /start — ознакомиться с условиями и дать согласие; /stop — отозвать согласие; /help — помощь.',
    });
  } else if (command === 'stop') {
    const revoked = await revokeConsent(env, context, update.update_id);
    await callTelegram(env, 'sendMessage', {
      chat_id: context.chatId,
      text: revoked
        ? 'Согласие отозвано. Новые сообщения от этого бота отправляться не будут.'
        : 'Ваш профиль не найден в базе. Новые сообщения отправляться не будут.',
    });
  }
}

async function telegramWebhook(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_WEBHOOK_SECRET) {
    return json({ ok: false, error: 'telegram_or_database_not_configured' }, 503);
  }
  const receivedSecret = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!isValidWebhookSecret(receivedSecret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  let update;
  try {
    const raw = await request.text();
    if (raw.length > 256_000) return json({ ok: false, error: 'payload_too_large' }, 413);
    update = JSON.parse(raw);
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  if (!Number.isSafeInteger(update?.update_id)) {
    return json({ ok: false, error: 'invalid_update_id' }, 400);
  }

  try {
    const claimed = await claimUpdate(env, update);
    if (!claimed) return json({ ok: true, duplicate: true });
    await handleTelegramUpdate(env, update);
    await markUpdate(env, update.update_id, 'processed');
    return json({ ok: true, duplicate: false });
  } catch (error) {
    try { await markUpdate(env, update.update_id, 'failed', 'processing_failed'); } catch { /* keep the original failure */ }
    console.error('telegram_update_processing_failed', error?.message || 'unknown');
    return json({ ok: false, error: 'processing_failed' }, 500);
  }
}

// ---------- admin API (everything except health, bot webhook and webhook setup) ----------
const failedAuth = new Map(); // per-isolate brute-force damper; real rate limiting arrives with stage 10

async function isAdmin(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 20) return { ok: false, reason: 'admin_not_configured' };
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const rec = failedAuth.get(ip);
  if (rec && rec.count >= 10 && Date.now() - rec.at < 10 * 60_000) return { ok: false, reason: 'too_many_attempts' };
  if (await safeEqual(token, env.ADMIN_TOKEN)) { failedAuth.delete(ip); return { ok: true }; }
  failedAuth.set(ip, { count: (rec && Date.now() - rec.at < 10 * 60_000 ? rec.count : 0) + 1, at: Date.now() });
  return { ok: false, reason: 'unauthorized' };
}

async function readJson(request, max = 20_000) {
  const raw = await request.text();
  if (raw.length > max) throw new HttpError(413, 'Слишком большой запрос.');
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Некорректный JSON.'); }
}

function tg(env) {
  if (!env.TG) throw new HttpError(503, 'Durable Object TG не подключён (см. wrangler.jsonc).');
  const stub = env.TG.get(env.TG.idFromName('main'));
  return async (method, ...args) => {
    const res = await stub.invoke(method, args);
    if (!res.ok) throw new HttpError(res.status || 502, res.error || 'Ошибка Telegram-модуля.');
    return res.data;
  };
}

function needSecrets(env) {
  if (!env.DB) throw new HttpError(503, 'Не подключена база D1 (binding DB).');
  if (!env.APP_SECRET || env.APP_SECRET.length < 24) throw new HttpError(503, 'Не задан секрет APP_SECRET (24+ символов).');
}

const KYIV = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function formatKyiv(value) {
  if (!value) return '';
  const text = String(value);
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return text;
  return KYIV.format(date);
}

export const EXPORT_HEADERS = ['Имя', 'Ник', 'Номер телефона', 'Источник', 'Дата добавления в базу', 'Текст сообщения (триггер)'];
const EXPORT_PAGE = 500;

export function leadToExportRow(l) {
  const name = [l.first_name, l.last_name].filter(Boolean).join(' ').trim();
  return [
    name || '—',
    l.username ? `@${l.username}` : '—',
    l.phone || 'Nope',
    l.source_title || '—',
    formatKyiv(l.created_at),
    l.trigger_text || '',
  ];
}

// The .xlsx file is assembled in the browser (public/lib/xlsx.js): building a workbook costs far more CPU than the free
// Workers plan allows per request. The server only hands out ready-made rows, one cheap page at a time.
async function exportPage(env, url) {
  const store = createStore(env.DB);
  const after = Math.max(parseInt(url.searchParams.get('after') || '0', 10) || 0, 0);
  const batch = await store.leadsBatch(after, EXPORT_PAGE);
  const total = after === 0 ? await store.countLeads() : undefined;
  return json({
    ok: true,
    data: {
      headers: EXPORT_HEADERS,
      rows: batch.map(leadToExportRow),
      next: batch.length === EXPORT_PAGE ? batch[batch.length - 1].rid : null,
      total,
    },
  });
}

async function workerConfigSteps(env) {
  const steps = [];
  steps.push({ name: 'admin', title: 'Ключ доступа ADMIN_TOKEN', ok: Boolean(env.ADMIN_TOKEN && env.ADMIN_TOKEN.length >= 20), detail: '' });
  steps.push({ name: 'secret', title: 'Секрет шифрования APP_SECRET (24+ символов)', ok: Boolean(env.APP_SECRET && env.APP_SECRET.length >= 24), detail: '' });
  steps.push({ name: 'do', title: 'Durable Object (TG) подключён', ok: Boolean(env.TG), detail: '' });
  let schema = false;
  let detail = '';
  if (env.DB) {
    try { await env.DB.prepare('SELECT 1 FROM tg_account LIMIT 1').first(); schema = true; } catch { detail = 'Выполните миграцию 0002 в D1 → SQL Console.'; }
  } else detail = 'Нет binding DB.';
  steps.push({ name: 'schema', title: 'База D1: миграция 0002 применена', ok: schema, detail });
  return steps;
}

async function adminApi(request, env, url) {
  const { pathname } = url;
  const method = request.method;
  const route = `${method} ${pathname}`;

  if (route === 'GET /api/auth/check') return json({ ok: true });

  needSecrets(env);
  const store = createStore(env.DB);
  const call = tg(env);

  if (route === 'GET /api/tg/status') return json({ ok: true, data: await call('status', { wake: true }) });
  if (route === 'POST /api/tg/credentials') { const b = await readJson(request); return json({ ok: true, data: await call('saveCredentials', b.api_id, b.api_hash) }); }
  if (route === 'POST /api/tg/login/qr') return json({ ok: true, data: await call('startQr') });
  if (route === 'POST /api/tg/login/phone') { const b = await readJson(request); return json({ ok: true, data: await call('startPhone', b.phone) }); }
  if (route === 'POST /api/tg/login/code') { const b = await readJson(request); return json({ ok: true, data: await call('submitCode', b.code) }); }
  if (route === 'POST /api/tg/login/password') { const b = await readJson(request); return json({ ok: true, data: await call('submitPassword', b.password) }); }
  if (route === 'POST /api/tg/login/cancel') return json({ ok: true, data: await call('cancelLogin') });
  if (route === 'POST /api/tg/logout') { const b = await readJson(request); if (b.confirm !== 'LOGOUT') throw new HttpError(400, 'Нужно подтверждение.'); return json({ ok: true, data: await call('logout') }); }
  if (route === 'GET /api/tg/dialogs') return json({ ok: true, data: await call('listDialogs') });
  if (route === 'GET /api/tg/diagnostics') {
    const config = await workerConfigSteps(env);
    let remote = { steps: [] };
    if (config.every((s) => s.ok)) remote = await call('runDiagnostics');
    return json({ ok: true, data: { steps: [...config, ...remote.steps] } });
  }

  if (route === 'GET /api/monitor/state') return json({ ok: true, data: await call('monitorState') });
  if (route === 'POST /api/monitor/settings') { const b = await readJson(request); return json({ ok: true, data: await call('saveMonitorSettings', b) }); }
  if (route === 'POST /api/monitor/sources') { const b = await readJson(request); return json({ ok: true, data: await call('addSource', b.id) }); }
  if (route === 'POST /api/monitor/sources/remove') { const b = await readJson(request); return json({ ok: true, data: await call('removeSource', b.id) }); }
  if (route === 'POST /api/monitor/check') { const b = await readJson(request); return json({ ok: true, data: await call('runCheck', { backfill: b.backfill }) }); }

  if (route === 'GET /api/leads') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '25', 10) || 25, 1), 100);
    const page = Math.max(parseInt(url.searchParams.get('page') || '1', 10) || 1, 1);
    const data = await store.listLeads({ q: url.searchParams.get('q') || '', limit, offset: (page - 1) * limit });
    return json({ ok: true, data: { ...data, page, limit } });
  }
  if (route === 'POST /api/leads/clear') {
    const b = await readJson(request);
    if (b.confirm !== 'DELETE') throw new HttpError(400, 'Нужно подтверждение.');
    await store.clearLeads();
    await store.addLog('warn', 'Тестовая база лидов очищена вручную');
    return json({ ok: true });
  }
  if (route === 'GET /api/export/leads') return exportPage(env, url);

  return json({ ok: false, error: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/health') {
      if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
      return health(request, env);
    }
    if (pathname === '/api/setup/telegram-webhook') return registerWebhook(request, env);
    if (pathname === WEBHOOK_PATH) return telegramWebhook(request, env);

    if (pathname.startsWith('/api/')) {
      const auth = await isAdmin(request, env);
      if (!auth.ok) {
        const status = auth.reason === 'admin_not_configured' ? 503 : auth.reason === 'too_many_attempts' ? 429 : 401;
        return json({ ok: false, error: auth.reason }, status);
      }
      try {
        return await adminApi(request, env, url);
      } catch (error) {
        if (error instanceof HttpError) return json({ ok: false, error: error.message }, error.status);
        console.error('admin_api_failed', error?.message || 'unknown');
        return json({ ok: false, error: 'Внутренняя ошибка сервера.' }, 500);
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
