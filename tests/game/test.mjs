// Tests for the game page (docs/index.html) in headless Chrome: board, layout, JS errors, Telegram sign-in edge cases.
// Run: sh tests/run.sh
import puppeteer from 'puppeteer-core';
const URLX = new URL('../../docs/index.html', import.meta.url).href;   // the built site
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
let pass = 0, fail = 0; const t = (n, ok) => { ok ? pass++ : fail++; console.log((ok ? '✓ ' : '✗ ') + n); };
for (const [name, vp] of [['компьютер', { width: 1280, height: 900 }], ['телефон', { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
  const p = await b.newPage(); await p.setViewport(vp);
  const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && !/Failed to load resource|supabase|manifest/.test(m.text()) && errs.push(m.text()));
  await p.goto(URLX, { waitUntil: 'load' });
  await new Promise(r => setTimeout(r, 1500));
  const cells = await p.$$('#board .cell');
  t(`${name}: поле нарисовано (${cells.length} клеток)`, cells.length >= 64);
  for (const c of cells.slice(0, 12)) { try { await c.click(); } catch {} await new Promise(r => setTimeout(r, 120)); }
  const opened = await p.$$eval('#board .cell', cs => cs.filter(c => c.className !== cs[cs.length-1].className).length);
  t(`${name}: клетки открываются по нажатию (${opened})`, opened > 0);
  const over = await p.evaluate(() => { const bc = document.getElementById('boardcard').getBoundingClientRect(); return bc.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1; });
  t(`${name}: нет горизонтальной прокрутки`, over);
  t(`${name}: без ошибок JS`, errs.length === 0 || (console.log('   ', errs), false));
  await p.close();
}
// login error path: the server refuses → stops waiting, says so
const p = await b.newPage(); await p.setRequestInterception(true);
p.on('request', r => r.url().includes('/functions/v1/tg') ? r.respond(r.method() === 'OPTIONS' ? { status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } } : { status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"link"}' }) : r.continue());
await p.goto(URLX, { waitUntil: 'load' });
await p.evaluate(() => { localStorage.setItem('foxhunt.tgNonce', JSON.stringify({ n: 'a'.repeat(32), at: Date.now() })); });
await p.reload({ waitUntil: 'load' });
let seen = false;   // 5 tries, 2.5 s apart, then the message
for (let i = 0; i < 50 && !seen; i++){ await new Promise(r => setTimeout(r, 500)); seen = await p.evaluate(() => document.body.innerText.includes('Вход не удался')); }
const st = await p.evaluate(() => ({ n: localStorage.getItem('foxhunt.tgNonce'), toast: document.body.innerText.includes('Вход не удался') }));
t('вход отклонён сервером: после 5 попыток ожидание прекращено и показано сообщение', seen && (st.n === null || st.n === 'null'));
// a passing gateway error (no JSON from the function) keeps waiting
{ const q = await b.newPage(); await q.setRequestInterception(true);
  q.on('request', r => r.url().includes('/functions/v1/tg') ? r.respond(r.method() === 'OPTIONS' ? { status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } } : { status: 503, headers: { 'access-control-allow-origin': '*' }, body: 'Service Unavailable' }) : r.continue());
  await q.goto(URLX, { waitUntil: 'load' });
  await q.evaluate(() => localStorage.setItem('foxhunt.tgNonce', JSON.stringify({ n: 'a'.repeat(32), at: Date.now() })));
  await q.reload({ waitUntil: 'load' }); await new Promise(r => setTimeout(r, 6000));
  const n = await q.evaluate(() => localStorage.getItem('foxhunt.tgNonce'));
  t('временный сбой сервера: игра продолжает ждать', n && n !== 'null'); }
// a #login link is polled as a handoff, without this device's account
{ const q = await b.newPage(); await q.setRequestInterception(true); let body = null, auth = null;
  q.on('request', r => { if (r.url().includes('/functions/v1/tg') && r.method() === 'POST'){ body = r.postData(); auth = r.headers().authorization; }
    r.url().includes('/functions/v1/tg') ? r.respond(r.method() === 'OPTIONS' ? { status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' } } : { status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"status":"wait"}' }) : r.continue(); });
  await q.goto(URLX + '#login=' + 'b'.repeat(32), { waitUntil: 'load' }); await new Promise(r => setTimeout(r, 4000));
  t('ссылка #login опрашивается как переход, без аккаунта устройства', body && JSON.parse(body).handoff === true && !(auth || '').includes('.')); }
// signed in, but the profile failed to load: an existing player is not sent to the nick screen
{ const q = await b.newPage(); await q.setRequestInterception(true);
  const C = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST' };
  q.on('request', r => { const u = r.url();
    if (r.method() === 'OPTIONS' && /supabase/.test(u)) return r.respond({ status: 200, headers: C });
    if (u.includes('/functions/v1/tg')) return r.respond({ status: 200, contentType: 'application/json', headers: C, body: JSON.stringify({ status: 'ok', tg_id: 1, name: 'Ира', session: { access_token: 'a.b.c', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600 } }) });
    if (u.includes('/rpc/my_profile')) return r.respond({ status: 503, headers: C, body: 'down' });
    r.continue(); });
  await q.goto(URLX, { waitUntil: 'load' });
  await q.evaluate(() => localStorage.setItem('foxhunt.tgNonce', JSON.stringify({ n: 'a'.repeat(32), at: Date.now() })));
  await q.reload({ waitUntil: 'load' });
  let ok = false, bad = false;
  for (let i = 0; i < 30 && !ok; i++){ await new Promise(r => setTimeout(r, 300)); const txt = await q.evaluate(() => document.body.innerText); ok = txt.includes('Вы вошли через Telegram'); bad ||= txt.includes('Осталось выбрать ник'); }
  t('профиль не загрузился: игрока не отправляют выбирать ник заново', ok && !bad); }
await b.close();
console.log(`\n${pass} из ${pass + fail} проверок прошли`);
process.exit(fail ? 1 : 0);
