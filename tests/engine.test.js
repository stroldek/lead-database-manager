import test from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './helpers/d1.js';
import { FakeWorld } from './helpers/fakeTelegram.js';
import { TgEngine } from '../src/tg/engine.js';
import { createStore } from '../src/tg/store.js';
import { decryptSecret } from '../src/lib/crypto.js';

const SECRET = 'unit-test-app-secret-0123456789abcdef';
const API_HASH = 'a'.repeat(32);

function setup(world = new FakeWorld(), db = createD1()) {
  const alarms = [];
  const make = () => new TgEngine({
    store: createStore(db), makeClient: world.makeClient, secret: SECRET,
    scheduleAlarm: async (ms) => alarms.push(ms), sleep: () => new Promise((r) => setImmediate(r)),
  });
  return { world, db, alarms, engine: make(), restart: make };
}

async function loggedIn(ctx) {
  await ctx.engine.saveCredentials('1234567', API_HASH);
  const p = ctx.engine.startQr();
  await Promise.resolve();
  ctx.world.qrScan.resolve();
  await p;
  await ctx.engine.waitFor(() => ctx.engine.state === 'connected', 2000);
}

test('credentials are validated and stored encrypted', async () => {
  const { engine, db } = setup();
  await assert.rejects(() => engine.saveCredentials('abc', API_HASH), /API ID/);
  await assert.rejects(() => engine.saveCredentials('1234567', 'short'), /API hash/);
  const st = await engine.saveCredentials('1234567', API_HASH.toUpperCase());
  assert.equal(st.hasCredentials, true);
  const row = db.raw.prepare('SELECT * FROM tg_account WHERE id = 1').get();
  assert.ok(!row.api_hash_enc.includes(API_HASH), 'api hash must not be stored in plaintext');
  assert.equal(await decryptSecret(SECRET, row.api_id_enc), '1234567');
  assert.equal(await decryptSecret(SECRET, row.api_hash_enc), API_HASH);
});

test('login without credentials is refused with a clear message', async () => {
  const { engine } = setup();
  await assert.rejects(() => engine.startQr(), /API ID/);
});

test('QR login: shows QR, then connects and stores the session encrypted', async () => {
  const ctx = setup();
  await ctx.engine.saveCredentials('1234567', API_HASH);
  const p = ctx.engine.startQr();
  const waiting = await p;
  assert.equal(waiting.state, 'qr_pending');
  assert.match(waiting.qr.url, /^tg:\/\/login\?token=/);
  ctx.world.qrScan.resolve();
  await ctx.engine.waitFor(() => ctx.engine.state === 'connected', 2000);
  const st = await ctx.engine.status();
  assert.equal(st.state, 'connected');
  assert.equal(st.me.username, 'tester');
  assert.ok(st.me.phoneMasked.includes('•'), 'phone is masked in the UI payload');
  const row = ctx.db.raw.prepare('SELECT session_enc FROM tg_account WHERE id = 1').get();
  assert.ok(row.session_enc.startsWith('v1:') && !row.session_enc.includes('SESSION-STRING'));
  assert.equal(await decryptSecret(SECRET, row.session_enc), 'SESSION-STRING-123');
});

test('QR login with 2FA: wrong password keeps asking, right one connects', async () => {
  const ctx = setup();
  ctx.world.need2fa = true;
  await ctx.engine.saveCredentials('1234567', API_HASH);
  await ctx.engine.startQr();
  ctx.world.qrScan.resolve();
  await ctx.engine.waitFor(() => ctx.engine.state === 'password_needed', 2000);
  assert.equal((await ctx.engine.status()).passwordHint, 'подсказка');
  let st = await ctx.engine.submitPassword('wrong');
  assert.equal(st.state, 'password_needed');
  assert.match(st.notice, /Неверный пароль/);
  st = await ctx.engine.submitPassword('secret2fa');
  assert.equal(st.state, 'connected');
});

test('phone login: invalid number, wrong code, then success', async () => {
  const ctx = setup();
  await ctx.engine.saveCredentials('1234567', API_HASH);
  await assert.rejects(() => ctx.engine.startPhone('12'), /международном формате/);
  let st = await ctx.engine.startPhone('+1 111 111 1111');
  assert.equal(st.state, 'error');
  assert.match(st.error, /Неверный номер/);
  st = await ctx.engine.startPhone('+380 50 123 45 67');
  assert.equal(st.state, 'code_pending');
  st = await ctx.engine.submitCode('00000');
  assert.equal(st.state, 'code_pending');
  assert.match(st.notice, /Неверный код/);
  st = await ctx.engine.submitCode('12345');
  assert.equal(st.state, 'connected');
});

test('restart: saved session reconnects without a new login', async () => {
  const ctx = setup();
  await loggedIn(ctx);
  const again = ctx.restart();
  assert.equal((await again.status()).state, 'disconnected');
  await again.ensureConnected();
  assert.equal(again.state, 'connected');
  const last = ctx.world.clients.at(-1);
  assert.equal(last.session, 'SESSION-STRING-123', 'decrypted session was handed to the client');
});

test('revoked session is detected: logged out, monitoring stopped', async () => {
  const ctx = setup();
  await loggedIn(ctx);
  await ctx.engine.saveMonitorSettings({ matchAny: true, running: true });
  ctx.world.sessionValid = false;
  const again = ctx.restart();
  await assert.rejects(() => again.ensureConnected());
  assert.equal(again.state, 'logged_out');
  assert.equal((await createStore(ctx.db).getSettings()).running, false);
  assert.equal(ctx.db.raw.prepare('SELECT session_enc FROM tg_account WHERE id = 1').get().session_enc, null);
});

test('cancel and logout clear everything', async () => {
  const ctx = setup();
  await ctx.engine.saveCredentials('1234567', API_HASH);
  await ctx.engine.startQr();
  let st = await ctx.engine.cancelLogin();
  assert.equal(st.state, 'logged_out');
  await loggedIn(ctx);
  st = await ctx.engine.logout();
  assert.equal(st.state, 'logged_out');
  assert.equal(ctx.world.clients.at(-1).loggedOut, true);
  assert.equal(ctx.db.raw.prepare('SELECT session_enc FROM tg_account WHERE id = 1').get().session_enc, null);
});

function populated() {
  const ctx = setup();
  ctx.world.addChat('-1001', 'Мобильные аксессуары', 'supergroup');
  ctx.world.addChat('-1002', 'Новости рынка', 'channel', { id: '-1003', title: 'Новости рынка — обсуждение' });
  ctx.world.addChat('-1004', 'Канал без комментариев', 'channel');
  ctx.world.addChat('-1005', 'Старая группа', 'group');
  return ctx;
}

test('sources: group, supergroup, channel with comments; channel without comments is refused', async () => {
  const ctx = populated();
  await loggedIn(ctx);
  const dialogs = await ctx.engine.listDialogs();
  assert.equal(dialogs.length, 4);
  const ch = await ctx.engine.addSource('-1002');
  assert.equal(ch.targetId, '-1003');
  await ctx.engine.addSource('-1001');
  await assert.rejects(() => ctx.engine.addSource('-1004'), /нет группы комментариев/);
  await assert.rejects(() => ctx.engine.addSource('-9999'), /не найден/);
  await assert.rejects(() => ctx.engine.addSource("1; DROP TABLE leads"), /Некорректный/);
  const list = await ctx.engine.listDialogs();
  assert.equal(list.filter((d) => d.monitored).length, 2);
});

test('monitoring: baseline first, then only new matching messages become leads', async () => {
  const ctx = populated();
  await loggedIn(ctx);
  await ctx.engine.addSource('-1001');
  ctx.world.say('-1001', 1, 'Старое сообщение: куплю чехлы');
  await ctx.engine.saveMonitorSettings({ keywords: 'куплю, оптом\nпоставщик', running: true });
  assert.equal(ctx.alarms.at(-1), 1500);

  await ctx.engine.tick(); // baseline
  assert.equal(await createStore(ctx.db).countLeads(), 0, 'history before start is ignored');

  ctx.world.say('-1001', 2, 'Привет всем');
  ctx.world.say('-1001', 3, 'Ищу ПОСТАВЩИКА чехлов для iPhone');
  ctx.world.say('-1001', 4, 'куплю оптом', { id: '2002', firstName: 'Анна', lastName: 'К', username: null, phone: null, isBot: false });
  ctx.world.say('-1001', 5, 'куплю бот', { id: '9', firstName: 'Bot', username: 'b_bot', isBot: true });
  ctx.world.say('-1001', 6, 'куплю сам', { id: '777', firstName: 'Тест', isBot: false });
  ctx.world.say('-1001', 7, 'куплю от канала', null);
  const stats = await ctx.engine.tick();
  assert.equal(stats.newLeads, 2);

  const rows = ctx.db.raw.prepare('SELECT * FROM leads ORDER BY telegram_id').all();
  assert.equal(rows.length, 2);
  const ivan = rows.find((r) => r.telegram_id === '1001');
  assert.equal(ivan.phone, '+380501112233');
  assert.equal(ivan.username, 'ivan');
  assert.equal(ivan.source_title, 'Мобильные аксессуары');
  assert.equal(ivan.trigger_text, 'Ищу ПОСТАВЩИКА чехлов для iPhone');
  assert.equal(ivan.trigger_keyword, 'поставщик');
  const anna = rows.find((r) => r.telegram_id === '2002');
  assert.equal(anna.phone, null);

  const again = await ctx.engine.tick();
  assert.equal(again.checked, 0, 'processed messages are not read twice');
  assert.ok(ctx.alarms.at(-1) >= 30000, 'next tick is scheduled');
});

test('comments of a channel are read from the linked discussion group', async () => {
  const ctx = populated();
  await loggedIn(ctx);
  await ctx.engine.addSource('-1002');
  await ctx.engine.saveMonitorSettings({ matchAny: true, running: true });
  await ctx.engine.tick();
  ctx.world.say('-1003', 10, 'Подскажите контакты производителя');
  await ctx.engine.tick();
  const lead = ctx.db.raw.prepare('SELECT * FROM leads').get();
  assert.equal(lead.source_title, 'Новости рынка (комментарии)');
  assert.equal(lead.source_chat_id, '-1003');
});

test('the same person in several chats / several messages is one lead with a hit counter', async () => {
  const ctx = populated();
  await loggedIn(ctx);
  await ctx.engine.addSource('-1001');
  await ctx.engine.addSource('-1005');
  await ctx.engine.saveMonitorSettings({ keywords: 'куплю', running: true });
  await ctx.engine.tick();
  ctx.world.say('-1001', 2, 'куплю чехлы');
  ctx.world.say('-1005', 2, 'куплю кабель');
  ctx.world.say('-1001', 3, 'ещё куплю зарядки');
  await ctx.engine.tick();
  const leads = ctx.db.raw.prepare('SELECT * FROM leads').all();
  assert.equal(leads.length, 1);
  assert.equal(leads[0].hits_count, 3);
  assert.equal(leads[0].trigger_text, 'куплю чехлы', 'first trigger is kept');
  assert.equal(ctx.db.raw.prepare('SELECT COUNT(*) n FROM lead_hits').get().n, 3);
});

test('restart does not duplicate or lose anything; re-checking the same history is idempotent', async () => {
  const ctx = populated();
  await loggedIn(ctx);
  await ctx.engine.addSource('-1001');
  await ctx.engine.saveMonitorSettings({ keywords: 'куплю', running: true });
  await ctx.engine.tick();
  ctx.world.say('-1001', 2, 'куплю чехлы');
  await ctx.engine.tick();

  const restarted = ctx.restart();
  await restarted.tick();
  assert.equal(ctx.db.raw.prepare('SELECT COUNT(*) n FROM leads').get().n, 1);

  const first = await restarted.runCheck({ backfill: 50 });
  assert.equal(first.newLeads, 0);
  assert.equal(first.repeated, 1, 'known message is recognised, not re-counted');
  assert.equal(ctx.db.raw.prepare('SELECT hits_count h FROM leads').get().h, 1);
});

test('manual check reads the latest N messages and creates leads immediately', async () => {
  const ctx = populated();
  await loggedIn(ctx);
  await assert.rejects(() => ctx.engine.runCheck({ backfill: 5 }), /ключевые слова/);
  await ctx.engine.saveMonitorSettings({ keywords: 'цена' });
  await assert.rejects(() => ctx.engine.runCheck({ backfill: 5 }), /источник/);
  await ctx.engine.addSource('-1001');
  for (let i = 1; i <= 30; i += 1) ctx.world.say('-1001', i, i % 10 === 0 ? `какая цена ${i}?` : 'болтовня', { id: String(5000 + i), firstName: `U${i}`, username: `u${i}`, isBot: false });
  const res = await ctx.engine.runCheck({ backfill: 25 });
  assert.equal(res.checked, 25);
  assert.equal(res.newLeads, 3, 'last 25 of 30 messages are ids 6..30 -> triggers at 10, 20, 30');
  assert.equal(res.perSource[0].read, 25);
});

test('more than 100 new messages are paged and none are skipped', async () => {
  const ctx = populated();
  await loggedIn(ctx);
  await ctx.engine.addSource('-1001');
  await ctx.engine.saveMonitorSettings({ matchAny: true, running: true });
  await ctx.engine.tick();
  for (let i = 1; i <= 250; i += 1) ctx.world.say('-1001', i, `сообщение ${i}`, { id: String(8000 + i), firstName: 'U', isBot: false });
  await ctx.engine.tick();
  assert.equal(ctx.db.raw.prepare('SELECT COUNT(*) n FROM leads').get().n, 250);
});

test('Telegram flood-wait pauses polling and is logged; broken chat does not stop the others', async () => {
  const ctx = populated();
  await loggedIn(ctx);
  await ctx.engine.addSource('-1001');
  await ctx.engine.saveMonitorSettings({ matchAny: true, running: true });
  await ctx.engine.tick();
  ctx.world.floodOnFetch = true;
  await ctx.engine.tick();
  assert.ok(ctx.engine.pausedUntil > Date.now());
  const skipped = await ctx.engine.tick();
  assert.equal(skipped.skipped, 'flood_wait');
  assert.ok(ctx.alarms.at(-1) >= 40000, 'next alarm waits out the flood');
  assert.match(createStore(ctx.db) && ctx.db.raw.prepare("SELECT message FROM monitor_log WHERE level='warn'").get().message, /пауза 42/);

  ctx.world.floodOnFetch = false;
  ctx.engine.pausedUntil = 0;
  ctx.world.messages.delete('-1005');
  await ctx.engine.addSource('-1005');
  ctx.world.messages.delete('-1005'); // chat becomes inaccessible
  ctx.world.say('-1001', 2, 'жив');
  await ctx.engine.tick();
  await ctx.engine.tick();
  const bad = ctx.db.raw.prepare("SELECT last_error FROM monitor_sources WHERE id='-1005'").get();
  assert.match(bad.last_error, /Нет доступа/);
  assert.equal(ctx.db.raw.prepare("SELECT COUNT(*) n FROM leads").get().n, 1, 'healthy chat was still processed');
});

test('monitor cannot start without keywords unless "any message" is on', async () => {
  const ctx = populated();
  await loggedIn(ctx);
  await assert.rejects(() => ctx.engine.saveMonitorSettings({ running: true }), /ключевые слова/);
  assert.equal((await createStore(ctx.db).getSettings()).running, false);
  await assert.rejects(() => ctx.engine.saveMonitorSettings({ intervalSeconds: 3 }), /15 до 3600/);
});
