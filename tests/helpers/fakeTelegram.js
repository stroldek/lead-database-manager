// Scriptable stand-in for the GramJS adapter: same interface, no network.
export function deferred() {
  let resolve; let reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

export class FakeWorld {
  constructor() {
    this.me = { id: '777', firstName: 'Тест', lastName: null, username: 'tester', phone: '380500000000', isBot: false };
    this.dialogs = [];
    this.messages = new Map(); // targetId -> [{id,date,text,sender}]
    this.discussions = new Map(); // channelId -> {id,title}
    this.clients = [];
    this.sessionValid = true;
    this.qrScan = deferred();
    this.need2fa = false;
    this.password = 'secret2fa';
    this.validCode = '12345';
    this.floodOnFetch = null;
  }
  addChat(id, title, kind, discussion = null) {
    this.dialogs.push({ id, title, kind, members: 10 });
    this.messages.set(id, []);
    if (discussion) { this.discussions.set(id, discussion); this.messages.set(discussion.id, []); }
  }
  say(target, id, text, sender = { id: '1001', firstName: 'Иван', lastName: 'Петров', username: 'ivan', phone: '380501112233', isBot: false }) {
    this.messages.get(target).push({ id, date: new Date(1_700_000_000_000 + id * 1000).toISOString(), text, sender });
  }
  makeClient = (creds, session) => {
    const c = new FakeClient(this, creds, session);
    this.clients.push(c);
    return c;
  };
}

class FakeClient {
  constructor(world, creds, session) { this.w = world; this.creds = creds; this.session = session; this.connected = false; this.loggedOut = false; }
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  async getMe() {
    if (!this.w.sessionValid || this.session === 'dead') { const e = new Error('401'); e.errorMessage = 'AUTH_KEY_UNREGISTERED'; throw e; }
    return this.w.me;
  }
  async exportSession() { return 'SESSION-STRING-123'; }
  async logOut() { this.loggedOut = true; }
  async loginQr({ onQr, getPassword, onError }) {
    onQr({ url: 'tg://login?token=AAAA', expiresAt: Date.now() + 30000 });
    await this.w.qrScan.promise;
    if (this.w.need2fa) {
      for (;;) {
        const pw = await getPassword('подсказка');
        if (pw === this.w.password) break;
        const e = new Error('bad'); e.errorMessage = 'PASSWORD_HASH_INVALID'; onError(e);
      }
    }
    return this.w.me;
  }
  async loginPhone({ phone, getCode, getPassword, onError }) {
    if (phone === '+11111111111') { const e = new Error('x'); e.errorMessage = 'PHONE_NUMBER_INVALID'; throw e; }
    for (;;) {
      const code = await getCode();
      if (code === this.w.validCode) break;
      const e = new Error('bad'); e.errorMessage = 'PHONE_CODE_INVALID'; onError(e);
    }
    if (this.w.need2fa) {
      for (;;) {
        const pw = await getPassword('hint');
        if (pw === this.w.password) break;
        const e = new Error('bad'); e.errorMessage = 'PASSWORD_HASH_INVALID'; onError(e);
      }
    }
    return this.w.me;
  }
  async listDialogs() { return this.w.dialogs.map((d) => ({ ...d })); }
  async resolveDiscussion(id) { return this.w.discussions.get(String(id)) || null; }
  async fetchMessages(target, { latest, afterId, limit } = {}) {
    if (this.w.floodOnFetch) { const e = new Error('flood'); e.errorMessage = 'FLOOD_WAIT_42'; e.seconds = 42; throw e; }
    const all = this.w.messages.get(String(target));
    if (!all) { const e = new Error('x'); e.errorMessage = 'CHANNEL_PRIVATE'; throw e; }
    if (latest) return all.slice(-latest).map((m) => ({ ...m }));
    return all.filter((m) => m.id > afterId).slice(0, limit).map((m) => ({ ...m }));
  }
}
