// Adapter between TgEngine and the GramJS MTProto library ("telegram" npm package, installed by the Cloudflare build).
// The library is imported lazily so the rest of the app (and the unit tests) never depend on it.
// IMPORTANT: this file talks to the real Telegram network and can only be fully confirmed on a live deployment.
// Use the "Диагностика" button in the UI: it checks every layer separately and reports exactly where it fails.

const PEER_RETRYABLE = /PHONE_CODE_INVALID|PASSWORD_HASH_INVALID/;

function pick(mod, name) {
  return mod?.[name] ?? mod?.default?.[name] ?? mod?.connection?.[name] ?? null;
}

async function loadLib() {
  const core = await import('telegram');
  const sessions = await import('telegram/sessions');
  const ext = await import('telegram/extensions');
  const conn = await import('telegram/network/connection');
  const lib = {
    TelegramClient: pick(core, 'TelegramClient'),
    Api: pick(core, 'Api'),
    utils: pick(core, 'utils'),
    StringSession: pick(sessions, 'StringSession'),
    PromisedWebSockets: pick(ext, 'PromisedWebSockets'),
    ConnectionTCPObfuscated: pick(conn, 'ConnectionTCPObfuscated'),
  };
  const missing = Object.entries(lib).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`gramjs_exports_missing:${missing.join(',')}`);
  return lib;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`timeout:${label}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mapUser(u) {
  if (!u) return null;
  return {
    id: String(u.id),
    firstName: u.firstName || null,
    lastName: u.lastName || null,
    username: u.username || null,
    phone: u.phone || null,
    isBot: Boolean(u.bot),
  };
}

function clientOptions(lib) {
  return {
    connection: lib.ConnectionTCPObfuscated,
    networkSocket: lib.PromisedWebSockets,
    useWSS: true,
    connectionRetries: 2,
    deviceModel: 'Lead Database Manager',
    systemVersion: 'Cloudflare Workers',
    appVersion: '0.1.2',
    langCode: 'ru',
    systemLangCode: 'ru',
  };
}

class GramClient {
  constructor(creds, session) {
    this.creds = creds;
    this.session = session || '';
    this.lib = null;
    this.client = null;
    this.entities = new Map();
  }

  async init() {
    if (this.client) return;
    this.lib = await loadLib();
    const { TelegramClient, StringSession } = this.lib;
    this.client = new TelegramClient(new StringSession(this.session), this.creds.apiId, this.creds.apiHash, clientOptions(this.lib));
    try { this.client.setLogLevel('none'); } catch { /* optional */ }
  }

  async connect() {
    await this.init();
    await withTimeout(this.client.connect(), 30000, 'connect');
  }

  async disconnect() {
    if (!this.client) return;
    try { await this.client.disconnect(); } catch { /* ignore */ }
    try { await this.client.destroy?.(); } catch { /* ignore */ }
  }

  stopOnError(err) {
    return !PEER_RETRYABLE.test(String(err?.errorMessage || err?.message || ''));
  }

  async loginQr({ onQr, getPassword, onError }) {
    await this.client.signInUserWithQrCode(
      { apiId: this.creds.apiId, apiHash: this.creds.apiHash },
      {
        qrCode: async (code) => onQr({ url: `tg://login?token=${b64url(code.token)}`, expiresAt: Number(code.expires) * 1000 }),
        password: async (hint) => getPassword(hint),
        onError: async (err) => { onError(err); return this.stopOnError(err); },
      },
    );
    return this.getMe();
  }

  async loginPhone({ phone, getCode, getPassword, onError }) {
    await this.client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => getCode(),
      password: async (hint) => getPassword(hint),
      onError: async (err) => { onError(err); return this.stopOnError(err); },
    });
    return this.getMe();
  }

  async getMe() {
    return mapUser(await this.client.getMe());
  }

  async exportSession() {
    return this.client.session.save();
  }

  async logOut() {
    await this.client.invoke(new this.lib.Api.auth.LogOut());
  }

  async listDialogs() {
    const { utils } = this.lib;
    const dialogs = await this.client.getDialogs({ limit: 300 });
    const out = [];
    for (const d of dialogs) {
      const e = d.entity;
      if (!e || d.isUser) continue;
      let kind = null;
      if (e.className === 'Chat' && !e.deactivated) kind = 'group';
      else if (e.className === 'Channel') kind = e.megagroup ? 'supergroup' : (e.broadcast ? 'channel' : null);
      if (!kind) continue;
      const id = String(utils.getPeerId(e));
      this.entities.set(id, e);
      out.push({ id, title: d.title || e.title || id, kind, members: e.participantsCount ?? null });
    }
    return out;
  }

  /** For a broadcast channel returns its linked discussion group — that is where comments are posted. */
  async resolveDiscussion(channelId) {
    const { Api, utils } = this.lib;
    const channel = this.entities.get(String(channelId));
    if (!channel) return null;
    const full = await this.client.invoke(new Api.channels.GetFullChannel({ channel }));
    const linked = full?.fullChat?.linkedChatId;
    if (!linked) return null;
    const chat = (full.chats || []).find((c) => String(c.id) === String(linked));
    if (!chat) return null;
    const id = String(utils.getPeerId(chat));
    this.entities.set(id, chat);
    return { id, title: chat.title || id };
  }

  async fetchMessages(targetId, { latest, afterId, limit, parentId } = {}) {
    let entity = this.entities.get(String(targetId));
    if (!entity && parentId && parentId !== targetId) {
      if (!this.entities.has(String(parentId))) await this.listDialogs();
      await this.resolveDiscussion(parentId);
      entity = this.entities.get(String(targetId));
    }
    if (!entity) { await this.listDialogs(); entity = this.entities.get(String(targetId)); }
    if (!entity) throw new Error('PEER_ID_INVALID');

    const raw = latest
      ? await this.client.getMessages(entity, { limit: latest })
      : await this.client.getMessages(entity, { reverse: true, offsetId: Number(afterId) || 0, limit: limit || 100 });

    const out = [];
    for (const m of raw) {
      let sender = m.sender;
      if (!sender && m.senderId) { try { sender = await m.getSender(); } catch { sender = null; } }
      const isUser = sender && sender.className === 'User';
      out.push({
        id: Number(m.id),
        date: new Date(Number(m.date) * 1000).toISOString(),
        text: typeof m.message === 'string' ? m.message : '',
        sender: isUser ? mapUser(sender) : null,
      });
    }
    out.sort((a, b) => a.id - b.id);
    return afterId ? out.filter((m) => m.id > Number(afterId)) : out;
  }
}

export function makeGramClient(creds, session) {
  return new GramClient(creds, session);
}

// ---------- diagnostics: every layer is checked separately ----------
async function probeWebSocket(url) {
  const viaConstructor = () => new Promise((resolve, reject) => {
    if (typeof globalThis.WebSocket !== 'function') return reject(new Error('WebSocket constructor is not available'));
    let done = false;
    const ws = new WebSocket(url, 'binary');
    const timer = setTimeout(() => { if (!done) { done = true; try { ws.close(); } catch { /* */ } reject(new Error('timeout')); } }, 8000);
    ws.addEventListener('open', () => { if (!done) { done = true; clearTimeout(timer); try { ws.close(); } catch { /* */ } resolve(); } });
    ws.addEventListener('error', () => { if (!done) { done = true; clearTimeout(timer); reject(new Error('socket error')); } });
  });
  try { await viaConstructor(); return 'new WebSocket()'; } catch (first) {
    const resp = await withTimeout(fetch(url.replace(/^wss:/, 'https:'), { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': 'binary' } }), 8000, 'ws-fetch');
    if (resp.status !== 101 || !resp.webSocket) throw new Error(`constructor failed (${first.message}); fetch-upgrade status ${resp.status}`);
    resp.webSocket.accept();
    resp.webSocket.close();
    return 'fetch-upgrade';
  }
}

export async function runDiagnostics({ creds }) {
  const steps = [];
  const run = async (name, title, fn) => {
    const t0 = Date.now();
    try {
      const detail = await fn();
      steps.push({ name, title, ok: true, ms: Date.now() - t0, detail: detail || '' });
      return true;
    } catch (e) {
      steps.push({ name, title, ok: false, ms: Date.now() - t0, detail: String(e?.errorMessage || e?.message || e).slice(0, 300) });
      return false;
    }
  };

  let lib = null;
  if (!(await run('library', 'Библиотека Telegram (GramJS) загружается', async () => { lib = await loadLib(); return 'импорт выполнен'; }))) return { steps };
  if (!(await run('websocket', 'Соединение с серверами Telegram (WebSocket)', () => probeWebSocket('wss://zws2.web.telegram.org/apiws')))) return { steps };
  if (!creds) {
    steps.push({ name: 'handshake', title: 'Рукопожатие MTProto', ok: false, ms: 0, detail: 'Сначала сохраните API ID и API hash.' });
    return { steps };
  }
  const gc = new GramClient(creds, '');
  await run('handshake', 'Рукопожатие MTProto (шифрованный канал)', async () => {
    try {
      await gc.connect();
      const dc = await withTimeout(gc.client.invoke(new lib.Api.help.GetNearestDc()), 15000, 'GetNearestDc');
      return `канал установлен, ближайший DC: ${dc.nearestDc}`;
    } finally {
      await gc.disconnect();
    }
  });
  return { steps };
}
