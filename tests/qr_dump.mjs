import fs from 'node:fs'; import vm from 'node:vm';
const code = fs.readFileSync(new URL('../public/qr.js', import.meta.url), 'utf8');
const ctx = {}; vm.createContext(ctx); vm.runInContext(code, ctx); // writes ctx.QR through globalThis fallback
const QR = ctx.QR;
const samples = [
  'tg://login?token=' + 'A'.repeat(43),
  'tg://login?token=' + Buffer.from(Array.from({length:32},(_, i)=> (i*37+11)&255)).toString('base64url'),
  'tg://login?token=-_Zx9Kq0V3mP4rT7yU1wE5aS8dF2gH6jL0nBcXvMzQo',
  'Привет, Telegram! ' + 'x'.repeat(60),
  'https://example.com/' + 'abc123/'.repeat(12),
  'a', 'B'.repeat(150), 'tg://login?token=' + 'Zz9_-'.repeat(10),
];
fs.writeFileSync('/tmp/qr_cases.json', JSON.stringify(samples.map(t => ({ text: t, matrix: QR.matrix(t) }))));
console.log('cases:', samples.length, 'sizes:', samples.map(t => QR.matrix(t).length).join(','));
