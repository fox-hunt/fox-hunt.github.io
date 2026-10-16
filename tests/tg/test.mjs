// Tests for the Telegram function (supabase/functions/tg): the real code against a fake Telegram and a fake database.
// Run: sh tests/run.sh
import { createHmac } from 'node:crypto';
const env = { SUPABASE_URL: 'https://sb', SUPABASE_SERVICE_ROLE_KEY: 'svc', TG_BOT_TOKEN: '123:ABC', TG_SECRET: 'sec' };
let handler; globalThis.Deno = { env: { get: k => env[k] }, serve: h => { handler = h; } };
const sent = [], edited = new Set();
globalThis.fetch = async (url, o) => {
  const b = o?.body ? JSON.parse(o.body) : {}; const m = String(url).split('/').pop(); sent.push([m, b]);
  if (m === 'editMessageText' && !b.reply_markup){ const k = b.chat_id + ':' + b.message_id; if (edited.has(k)) return { ok: true, json: async () => ({ ok: false, description: 'message is not modified' }) }; edited.add(k); }
  const res = m === 'sendMessage' ? { ok: true, result: { message_id: 500 } } : m === 'getUserProfilePhotos' ? { ok: true, result: { photos: globalThis.__photo ? [[{ file_id: 'f', width: 320 }]] : [] } } : m === 'getFile' ? { ok: true, result: { file_path: 'p.jpg' } } : { ok: true, result: true };
  return { ok: true, json: async () => res, arrayBuffer: async () => new ArrayBuffer(8) };
};
const M = await import('./mock.mjs');
await import('../.build/tg.js');
const hook = u => handler(new Request('https://f/tg', { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'sec' }, body: JSON.stringify(u) }));
const call = (b, tok) => handler(new Request('https://f/tg', { method: 'POST', headers: tok ? { authorization: 'Bearer x.' + tok + '.y' } : {}, body: JSON.stringify(b) })).then(async r => ({ s: r.status, d: await r.json() }));
const initData = (user, date = Math.floor(Date.now() / 1000)) => {
  const p = new URLSearchParams({ auth_date: String(date), user: JSON.stringify(user) });
  const check = [...p.entries()].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update('123:ABC').digest();
  p.set('hash', createHmac('sha256', secret).update(check).digest('hex')); return p.toString();
};
let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : fail++; console.log((ok ? '✓ ' : '✗ ') + name); };
const N1 = 'a'.repeat(32), N2 = 'b'.repeat(32), N3 = 'c'.repeat(32), N4 = 'd'.repeat(32);
const now = Math.floor(Date.now() / 1000);
const priv = id => ({ id, type: 'private' });

// 1. /start only asks, saves nothing
sent.length = 0;
await hook({ message: { message_id: 1, date: now, text: '/start ' + N1, chat: priv(77), from: { id: 77, first_name: 'Ира' } } });
t('/start не входит сразу, а спрашивает', M.T.tg_logins.length === 0 && sent.some(([m, b]) => m === 'sendMessage' && b.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data === `ok:${N1}:${now}`));
t('опрос до подтверждения — wait', (await call({ nonce: N1 })).d.status === 'wait');
// 2. foreign tap in a group is ignored
await hook({ callback_query: { id: 'q', data: `ok:${N1}:${now}`, from: { id: 99 }, message: { message_id: 1001, chat: { id: -100, type: 'group' } } } });
t('кнопка в группе не сохраняет вход', M.T.tg_logins.length === 0);
await hook({ callback_query: { id: 'q', data: `ok:${N1}:${now}`, from: { id: 99 }, message: { message_id: 1002, chat: priv(77) } } });
t('чужое нажатие в личном чате не сохраняет', M.T.tg_logins.length === 0);
// 3. expired button
sent.length = 0;
await hook({ callback_query: { id: 'q', data: `ok:${N1}:${now - 16 * 60}`, from: { id: 77 }, message: { message_id: 1003, chat: priv(77) } } });
t('кнопка старше 15 минут не работает', M.T.tg_logins.length === 0 && sent.some(([m, b]) => m === 'answerCallbackQuery' && b.show_alert));
// 4. confirm → poll → session, new player linked
await hook({ callback_query: { id: 'q', data: `ok:${N1}:${now}`, from: { id: 77, first_name: 'Ира', username: 'ira' }, message: { message_id: 1004, chat: priv(77) } } });
t('подтверждение сохраняет вход', M.T.tg_logins.length === 1 && M.T.tg_logins[0].tg_id === 77);
const [p1, p2] = await Promise.all([call({ nonce: N1 }), call({ nonce: N1 })]);
t('одновременный опрос: сессия выдана ровно один раз', [p1, p2].filter(r => r.d.status === 'ok').length === 1);
t('Telegram привязан к новому игроку', M.T.tg_links.length === 1 && M.T.tg_links[0].tg_id === 77);
// 5. anonymous caller keeps their account
M.users.push({ id: 'anon1' });
await hook({ callback_query: { id: 'q', data: `ok:${N2}:${now}`, from: { id: 88 }, message: { message_id: 1005, chat: priv(88) } } });
const r2 = await call({ nonce: N2 }, 'anon1');
t('аноним с ником привязывает Telegram к своему аккаунту', r2.d.status === 'ok' && M.T.tg_links.find(l => l.tg_id === 88)?.user_id === 'anon1');
// 6. lost link row: auth user exists, anon caller → recovers, no 500
M.T.tg_links = M.T.tg_links.filter(l => l.tg_id !== 77);
M.users.push({ id: 'anon2' });
await hook({ callback_query: { id: 'q', data: `ok:${N3}:${now}`, from: { id: 77 }, message: { message_id: 1006, chat: priv(77) } } });
const r3 = await call({ nonce: N3 }, 'anon2');
t('потерянная привязка восстанавливается', r3.s === 200 && M.T.tg_links.find(l => l.tg_id === 77)?.user_id === 'u1');
// 7. Mini App sign-in with a valid / forged signature
const w = await call({ action: 'webapp', initData: initData({ id: 55, first_name: 'Лис' }) });
t('Mini App: верная подпись — вход', w.d.status === 'ok' && w.d.tg_id === 55);
const forged = initData({ id: 55 }).replace(/hash=\w+/, 'hash=' + '0'.repeat(64));
t('Mini App: поддельная подпись — отказ', (await call({ action: 'webapp', initData: forged })).s === 401);
t('Mini App: подпись старше суток — отказ', (await call({ action: 'webapp', initData: initData({ id: 55 }, now - 90000) })).d.why === 'old');
// 8. handoff only for a linked Telegram
t('переход в браузер: непривязанный Telegram — отказ', (await call({ action: 'handoff', nonce: N4, initData: initData({ id: 4242 }) })).d.error === 'notg');
t('переход в браузер: привязанный — ок', (await call({ action: 'handoff', nonce: N4, initData: initData({ id: 55 }) })).d.ok === true);
t('код перехода не берётся обычным опросом', (await call({ nonce: N4 })).d.status === 'wait');
M.users.push({ id: 'anon9' });
const hv = await call({ nonce: N4, handoff: true }, 'anon9');
t('по ссылке перехода входит тот же игрок, аккаунт открывшего не трогается', hv.d.tg_id === 55 && !M.T.tg_links.some(l => l.user_id === 'anon9'));
// attack: bot-confirmed code of an unlinked Telegram sent as #login link
const NA = '9'.repeat(32);
await hook({ callback_query: { id: 'q', data: `ok:${NA}:${now}`, from: { id: 6666 }, message: { message_id: 1007, chat: priv(6666) } } });
M.users.push({ id: 'victim' });
const atk = await call({ nonce: NA, handoff: true }, 'victim');
t('атака: подтверждённый в боте код по ссылке #login не привязывает чужой Telegram', atk.d.status === 'wait' && !M.T.tg_links.some(l => l.tg_id === 6666));
// crash inside sign-in keeps the code for the next poll
const NC = '7'.repeat(32);
await hook({ callback_query: { id: 'q', data: `ok:${NC}:${now}`, from: { id: 3131 }, message: { message_id: 1008, chat: priv(3131) } } });
M.fail.create = true;
let crashed = false; try { await call({ nonce: NC }); } catch { crashed = true; }
t('сбой посреди входа: код сохраняется', crashed && M.T.tg_logins.some(r => r.nonce === NC));
t('после сбоя следующий опрос входит', (await call({ nonce: NC })).d.status === 'ok');
const ND = '6'.repeat(32);
await hook({ callback_query: { id: 'q', data: `ok:${ND}:${now}`, from: { id: 3232 }, message: { message_id: 1009, chat: priv(3232) } } });
await call({ nonce: ND }); M.fail.link = true;   // first sign-in creates the player; now the next one hits a passing auth error
await hook({ callback_query: { id: 'q', data: `ok:${ND}:${now}`, from: { id: 3232 }, message: { message_id: 1010, chat: priv(3232) } } });
const fe = await call({ nonce: ND });
t('ошибка Supabase посреди входа (не исключение): код сохраняется', fe.s === 500 && M.T.tg_logins.some(r => r.nonce === ND));
t('и следующий опрос входит', (await call({ nonce: ND })).d.status === 'ok');
// double tap on the confirm button: the second press doesn't bring a used code back
const NE = '5'.repeat(32);
await hook({ callback_query: { id: 'q', data: `ok:${NE}:${now}`, from: { id: 4141 }, message: { message_id: 77, chat: priv(4141) } } });
await call({ nonce: NE });
await hook({ callback_query: { id: 'q', data: `ok:${NE}:${now}`, from: { id: 4141 }, message: { message_id: 77, chat: priv(4141) } } });
t('двойное нажатие «Да, это я»: использованный код не возвращается', !M.T.tg_logins.some(r => r.nonce === NE));
// a player with a profile and no avatar links Telegram for the first time: the photo is set
M.users.push({ id: 'withProf' }); M.T.profiles.push({ id: 'withProf', avatar_v: null });
globalThis.__photo = true;
await hook({ callback_query: { id: 'q', data: `ok:${'3'.repeat(32)}:${now}`, from: { id: 5151 }, message: { message_id: 5555, chat: priv(5151) } } });
const rp = await call({ nonce: '3'.repeat(32) }, 'withProf');
t('первая привязка Telegram ставит фото из Telegram', rp.d.photo > 0 && M.T.profiles.find(p => p.id === 'withProf').avatar_v > 0);
// a removed avatar does not come back on the next Telegram sign-in
M.T.profiles.push({ id: 'u1', avatar_v: null });
globalThis.__photo = true;
await hook({ callback_query: { id: 'q', data: `ok:${'4'.repeat(32)}:${now}`, from: { id: 77 }, message: { message_id: 4444, chat: priv(77) } } });
const ra = await call({ nonce: '4'.repeat(32) });
t('убранное фото не возвращается при следующем входе', ra.d.status === 'ok' && !M.T.profiles.find(p => p.id === 'u1').avatar_v && ra.d.photo === null);
globalThis.__photo = false;
// 9. bad input
t('кривой код — 400', (await call({ nonce: 'zz' })).s === 400);
// 10. webhook survives a Telegram outage
const realFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('down'); };
const hr = await hook({ message: { message_id: 9, date: now, text: '/help', chat: priv(77), from: { id: 77 } } });
globalThis.fetch = realFetch;
t('сбой Telegram: webhook всё равно отвечает 200', hr.status === 200);
// 11. /clear deletes from the newest message down
sent.length = 0;
await hook({ callback_query: { id: 'q', data: 'clear', from: { id: 77 }, message: { message_id: 50, chat: priv(77) } } });
const del = sent.filter(([m]) => m === 'deleteMessages');
t('«Очистить чат» удаляет и более новые сообщения', del.some(([, b]) => b.message_ids.includes(499)) && !del.some(([, b]) => b.message_ids.includes(500)));
// 12. old codes are cleared
M.T.tg_logins.push({ nonce: 'e'.repeat(32), tg_id: 1, created_at: new Date(Date.now() - 2 * 864e5).toISOString() });
await hook({ callback_query: { id: 'q', data: `ok:${'f'.repeat(32)}:${now}`, from: { id: 77 }, message: { message_id: 1011, chat: priv(77) } } });
t('коды старше суток удаляются', !M.T.tg_logins.some(r => r.nonce === 'e'.repeat(32)));
// 14. daily reminders
const cron = (b, key = 'sec') => handler(new Request('https://f/tg', { method: 'POST', headers: { 'x-fox-cron': key }, body: JSON.stringify(b) })).then(async r => ({ s: r.status, d: await r.json() }));
M.RPC.tg_remind_due = () => ({ data: { players: 7, due: [{ chat: 201, linked: true, streak: 4, first: true }, { chat: 202, linked: false, streak: 0, first: false }, { chat: 203, linked: true, streak: 0, first: false }] } });
const realF = globalThis.fetch;
globalThis.fetch = async (url, o) => { const b = o?.body ? JSON.parse(o.body) : {}; if (b.chat_id === 203) { sent.push(['sendMessage', b]); return { ok: true, json: async () => ({ ok: false, error_code: 403 }) }; } return realF(url, o); };
sent.length = 0; M.log.length = 0;
t('рассылка без секрета не запускается', (await cron({ action: 'remind' }, 'nope')).s === 400 && !sent.length);
const rr = await cron({ action: 'remind', hour: 19 });
globalThis.fetch = realF;
const msgs = sent.filter(([m]) => m === 'sendMessage');
t('напоминания разосланы всем, кому пора', rr.d.sent === 2 && rr.d.blocked === 1 && msgs.length === 3);
t('в напоминании серия, число игроков и пояснение для первого раза', /серия: 4 дня/.test(msgs[0][1].text) && /7 охотников/.test(msgs[0][1].text) && /кнопками ниже/.test(msgs[0][1].text) && !/кнопками ниже/.test(msgs[1][1].text));
t('под напоминанием «Играть» и «Не напоминать»', msgs[0][1].reply_markup.inline_keyboard.flat().some(k => k.web_app) && msgs[0][1].reply_markup.inline_keyboard.flat().some(k => k.callback_data === 'rh:off'));
const mark = M.log.find(([k, fn]) => k === 'rpc' && fn === 'tg_remind_sent');
t('отмечены отправленные и остановившие бота', mark && mark[2].p_sent.join() === '201,202' && mark[2].p_blocked.join() === '203');
M.RPC.tg_remind = ({ p_hour, p_set }) => ({ data: { hour: p_set ? p_hour : 19 } });
sent.length = 0; M.log.length = 0;
await hook({ callback_query: { id: 'q', data: 'rh:off', from: { id: 77 }, message: { message_id: 60, chat: priv(77), reply_markup: { inline_keyboard: [[{ callback_data: 'remind' }, { callback_data: 'rh:off' }]] } } } });
t('«Не напоминать» выключает и присылает настройки', M.log.some(([k, fn, a]) => fn === 'tg_remind' && a.p_set && a.p_hour === null) && sent.some(([m, b]) => m === 'sendMessage' && /выключены/.test(b.text)));
sent.length = 0;
await hook({ callback_query: { id: 'q', data: 'rh:21', from: { id: 77 }, message: { message_id: 61, chat: priv(77), reply_markup: { inline_keyboard: [[{ callback_data: 'rh:9' }]] } } } });
t('выбор времени в настройках правит то же сообщение', sent.some(([m, b]) => m === 'editMessageText' && b.message_id === 61 && /21:00/.test(b.text) && b.reply_markup.inline_keyboard[0].some(k => k.text === '✓ 21:00')));
sent.length = 0; M.log.length = 0;
await hook({ message: { message_id: 10, date: now, text: '/remind', chat: priv(77), from: { id: 77, username: 'ira' } } });
t('/remind показывает настройки и запоминает чат', sent.some(([m, b]) => m === 'sendMessage' && /19:00/.test(b.text)) && M.log.some(([, fn, a]) => fn === 'tg_seen' && a.p_chat === 77));
// 13. unknown setup secret
t('настройка без секрета — 404', (await handler(new Request('https://f/tg?setup=nope'))).status === 404);
console.log(`\n${pass} из ${pass + fail} проверок прошли`);
process.exit(fail ? 1 : 0);
