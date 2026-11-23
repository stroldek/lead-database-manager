// Local test server for browser UI checks: the REAL worker + REAL migrations (SQLite) + scripted fake Telegram.
// Not part of the product. Usage: node tests/ui_harness.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import worker from '../src/worker.js';
import { createD1 } from './helpers/d1.js';
import { FakeWorld, deferred } from './helpers/fakeTelegram.js';
import { TgEngine, HttpError, describeError } from '../src/tg/engine.js';
import { createStore } from '../src/tg/store.js';

const ADMIN = 'ui-test-admin-token-0123456789';
const SECRET = 'ui-test-app-secret-0123456789abcdef';
const PUBLIC = new URL('../public/', import.meta.url).pathname;
const port = Number(process.argv[2] || 8799);

const db = createD1();
const world = new FakeWorld();
world.addChat('-1001', 'Будівельний ринок Харків', 'supergroup');
world.addChat('-1002', 'Новини будівництва', 'channel', { id: '-1003', title: 'Новини будівництва · обговорення' });
world.addChat('-1004', 'Канал без комментариев', 'channel');
const engine = new TgEngine({ store: createStore(db), makeClient: world.makeClient, secret: SECRET });
const TG = { idFromName: () => 'main', get: () => ({ async invoke(method, args = []) {
  try { return { ok: true, data: await engine[method](...args) }; }
  catch (e) { return e instanceof HttpError ? { ok: false, status: e.status, error: e.message } : { ok: false, status: 502, error: describeError(e) }; }
} }) };
const env = { DB: db, TG, ADMIN_TOKEN: ADMIN, APP_SECRET: SECRET };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname.startsWith('/__test/')) {
    const op = url.pathname.slice(8);
    if (op === 'scan') world.qrScan.resolve();
    if (op === 'twofa') world.need2fa = true;
    if (op === 'newqr') world.qrScan = deferred();
    if (op === 'say') {
      const { target, id, text, sender } = JSON.parse(url.searchParams.get('m'));
      world.say(target, id, text, sender);
    }
    res.end('ok'); return;
  }
  if (url.pathname.startsWith('/api/')) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  let file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(port, () => console.log('harness on', port, 'admin key:', ADMIN));
