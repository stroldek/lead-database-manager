import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import worker, { leadToExportRow, EXPORT_HEADERS } from '../src/worker.js';
import { buildXlsx } from '../public/lib/xlsx.js';
import { createD1 } from './helpers/d1.js';
import { FakeWorld } from './helpers/fakeTelegram.js';
import { TgEngine, HttpError, describeError } from '../src/tg/engine.js';
import { createStore } from '../src/tg/store.js';

const ADMIN = 'admin-token-for-tests-0123456789';
const SECRET = 'unit-test-app-secret-0123456789abcdef';

function makeEnv() {
  const db = createD1();
  const world = new FakeWorld();
  const engine = new TgEngine({ store: createStore(db), makeClient: world.makeClient, secret: SECRET, sleep: () => new Promise((r) => setImmediate(r)) });
  // Stand-in for the Durable Object namespace: same envelope the real DO returns.
  const TG = {
    idFromName: () => 'main',
    get: () => ({
      async invoke(method, args = []) {
        try { return { ok: true, data: await engine[method](...args) }; } catch (e) {
          return e instanceof HttpError ? { ok: false, status: e.status, error: e.message } : { ok: false, status: 502, error: describeError(e) };
        }
      },
    }),
  };
  return { env: { DB: db, TG, ADMIN_TOKEN: ADMIN, APP_SECRET: SECRET }, db, engine, world };
}

const call = (env, path, { method = 'GET', body, token = ADMIN, ip } = {}) =>
  worker.fetch(new Request(`https://x.workers.dev${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(ip ? { 'cf-connecting-ip': ip } : {}), 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), env);

test('admin API is closed without the key; health stays public', async () => {
  const { env } = makeEnv();
  assert.equal((await call(env, '/api/tg/status', { token: null })).status, 401);
  assert.equal((await call(env, '/api/tg/status', { token: 'wrong' })).status, 401);
  assert.equal((await call(env, '/api/leads', { token: null })).status, 401);
  assert.equal((await call(env, '/api/export/leads', { token: null })).status, 401);
  assert.equal((await call(env, '/api/health', { token: null })).status, 200);
  assert.equal((await call(env, '/api/auth/check')).status, 200);
  const noAdmin = { ...env, ADMIN_TOKEN: undefined };
  assert.equal((await call(noAdmin, '/api/auth/check')).status, 503, 'refuses to run unprotected');
  const short = { ...env, ADMIN_TOKEN: 'short' };
  assert.equal((await call(short, '/api/auth/check', { token: 'short' })).status, 503);
});

test('repeated wrong keys from one address get throttled', async () => {
  const { env } = makeEnv();
  let last;
  for (let i = 0; i < 12; i += 1) last = await call(env, '/api/leads', { token: `bad${i}`, ip: '203.0.113.9' });
  assert.equal(last.status, 429);
  assert.equal((await call(env, '/api/leads', { ip: '198.51.100.1' })).status, 200, 'other addresses are unaffected');
});

test('missing APP_SECRET is reported instead of storing secrets unencrypted', async () => {
  const { env } = makeEnv();
  const res = await call({ ...env, APP_SECRET: undefined }, '/api/tg/status');
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /APP_SECRET/);
});

test('QR / credentials endpoints work end-to-end through the API', async () => {
  const { env, world } = makeEnv();
  let r = await call(env, '/api/tg/credentials', { method: 'POST', body: { api_id: '1234567', api_hash: 'b'.repeat(32) } });
  assert.equal(r.status, 200);
  r = await call(env, '/api/tg/login/qr', { method: 'POST' });
  const body = await r.json();
  assert.equal(body.data.state, 'qr_pending');
  world.qrScan.resolve();
  await new Promise((res) => setTimeout(res, 50));
  const st = await (await call(env, '/api/tg/status')).json();
  assert.equal(st.data.state, 'connected');
  assert.equal(JSON.stringify(st).includes('SESSION-STRING'), false, 'session never leaves the server');
  const bad = await call(env, '/api/tg/credentials', { method: 'POST', body: { api_id: 'x', api_hash: 'y' } });
  assert.equal(bad.status, 400);
});

test('leads list: search, pagination, and the destructive action needs confirmation', async () => {
  const { env, db } = makeEnv();
  const store = createStore(db);
  for (let i = 1; i <= 30; i += 1) {
    await store.recordHit({ telegramId: String(i), username: `user${i}`, firstName: `Имя${i}`, lastName: null, phone: null, sourceTitle: 'Чат', sourceChatId: '-1', messageId: i, text: `текст ${i}`, keyword: 'k', date: 'd' });
  }
  const page2 = await (await call(env, '/api/leads?page=2&limit=25')).json();
  assert.equal(page2.data.total, 30);
  assert.equal(page2.data.rows.length, 5);
  const found = await (await call(env, '/api/leads?q=' + encodeURIComponent('user2'))).json();
  assert.ok(found.data.rows.length >= 1 && found.data.rows.every((r) => /user2/.test(r.username)));
  const injection = await call(env, '/api/leads?q=' + encodeURIComponent("' OR 1=1 --"));
  assert.equal((await injection.json()).data.total, 0, 'search term is bound as a parameter');
  assert.equal((await call(env, '/api/leads/clear', { method: 'POST', body: {} })).status, 400);
  assert.equal((await call(env, '/api/leads/clear', { method: 'POST', body: { confirm: 'DELETE' } })).status, 200);
  assert.equal(await store.countLeads(), 0);
});

test('Excel export: columns, "Nope" for missing phone, Kyiv time, cyrillic and awkward characters', async () => {
  const { env, db } = makeEnv();
  const store = createStore(db);
  await store.recordHit({ telegramId: '1', username: 'ivan', firstName: 'Иван', lastName: 'Петров', phone: '+380501112233', sourceTitle: 'Мобильные аксессуары', sourceChatId: '-1', messageId: 1, text: 'Куплю оптом <чехлы> & "кабели"\nнедорого', keyword: 'куплю', date: 'd' });
  await store.recordHit({ telegramId: '2', username: null, firstName: null, lastName: null, phone: null, sourceTitle: 'Новости (комментарии)', sourceChatId: '-2', messageId: 1, text: 'нужна цена', keyword: 'цена', date: 'd' });
  const res = await call(env, '/api/export/leads');
  assert.equal(res.status, 200);
  const page = (await res.json()).data;
  assert.deepEqual(page.headers, ['Имя', 'Ник', 'Номер телефона', 'Источник', 'Дата добавления в базу', 'Текст сообщения (триггер)']);
  assert.equal(page.total, 2);
  assert.equal(page.next, null);
  assert.equal(page.rows[0][0], 'Иван Петров');
  assert.equal(page.rows[0][2], '+380501112233');
  assert.deepEqual([page.rows[1][0], page.rows[1][1], page.rows[1][2]], ['—', '—', 'Nope']);
  fs.writeFileSync('/tmp/export_test.xlsx', buildXlsx(page.headers, page.rows, { sheetName: 'Лиды' }));

  const row = leadToExportRow({ first_name: null, last_name: null, username: null, phone: null, source_title: null, created_at: '2026-11-19 12:30:00', trigger_text: null });
  assert.deepEqual(row, ['—', '—', 'Nope', '—', '2026-11-19 14:30:00', ''], 'SQLite-style UTC timestamps are shown in Kyiv time (UTC+2 in November)');
  assert.equal(EXPORT_HEADERS.length, 6);
});

test('export is paged by keyset: every lead exactly once, in order, no deep OFFSET', async () => {
  const { env, db } = makeEnv();
  db.raw.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 1203)
    INSERT INTO leads (id, telegram_id, username, source) SELECT 'id'||i, 't'||i, 'u'||i, 'x' FROM n`);
  const seen = [];
  let after = 0; let pages = 0; let total;
  for (;;) {
    const data = (await (await call(env, `/api/export/leads?after=${after}`)).json()).data;
    if (data.total !== undefined) total = data.total;
    seen.push(...data.rows.map((r) => r[1]));
    pages += 1;
    if (data.next === null) break;
    after = data.next;
  }
  assert.equal(total, 1203);
  assert.equal(seen.length, 1203);
  assert.equal(new Set(seen).size, 1203);
  assert.equal(pages, 3);
});

test('search is case-insensitive for Cyrillic and ё, and escapes % and _', async () => {
  const { env, db } = makeEnv();
  const store = createStore(db);
  const base = { sourceChatId: '-1', text: 'Куплю цемент', keyword: 'куплю', date: '2026-11-22T10:00:00Z', phone: null, username: null, lastName: null };
  await store.recordHit({ ...base, telegramId: '1', firstName: 'Олег', sourceTitle: 'Будівельний ринок', messageId: 1 });
  await store.recordHit({ ...base, telegramId: '2', firstName: 'Артём', username: 'Art_em', sourceTitle: 'Чат', messageId: 2 });
  await store.recordHit({ ...base, telegramId: '3', firstName: 'Ян', sourceTitle: 'Чат 100%', messageId: 3 });
  const find = async (q) => (await (await call(env, `/api/leads?q=${encodeURIComponent(q)}`)).json()).data;
  assert.equal((await find('олег')).total, 1);
  assert.equal((await find('ОЛЕГ')).total, 1);
  assert.equal((await find('артем')).total, 1, 'ё and е are the same letter for search');
  assert.equal((await find('art_em')).total, 1);
  assert.equal((await find('будівельний')).total, 1);
  assert.equal((await find('100%')).total, 1, '% is searched literally');
  assert.equal((await find('_')).total, 1, '_ is not a wildcard (only the username has one)');
  assert.equal((await find('куплю')).total, 3, 'trigger text is searchable');
  // a returning person who gains a username becomes findable by it
  await store.recordHit({ ...base, telegramId: '1', firstName: 'Олег', username: 'oleg_new', sourceTitle: 'Другой чат', messageId: 4 });
  assert.equal((await find('oleg_new')).total, 1);
});
