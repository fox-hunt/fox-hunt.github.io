// «Охота на лис» — вход через Telegram (Supabase Edge Function «tg»)
//
// 1. Игра придумывает случайный nonce и открывает t.me/<бот>?start=<nonce>.
// 2. Игрок жмёт Start — Telegram присылает сюда webhook, мы запоминаем, кто это (tg_logins).
// 3. Игра опрашивает эту функцию с nonce и получает сессию Supabase для игрока,
//    привязанного к этому Telegram (или привязывает Telegram к текущему игроку на устройстве).
//
// Секреты функции (Edge Functions → Secrets): TG_BOT_TOKEN, TG_SECRET.
// В настройках функции выключить «Verify JWT» — Telegram не присылает токен.

import { createClient } from "npm:@supabase/supabase-js@2";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
  ?? JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default;
const BOT = (Deno.env.get("TG_BOT_TOKEN") ?? "").trim();     // a pasted token often carries an invisible line break
const SECRET = (Deno.env.get("TG_SECRET") ?? "").trim();
const SITE = "https://fox-hunt.github.io/";
const PUBLISHABLE = "sb_publishable_sSBwofwoUVYgoqhHx1GVUA_9Dts6BHr";   // public key: the bot reads the day table like any visitor
const LEVELS: [string, string][] = [["kid", "🐾 Лисёнок"], ["classic", "🌲 Классика"], ["pro", "🏔 Профи"]];
const OWNER = 1337312153;                    // the developer's Telegram: gets each donation, /donations, payment questions
const APP_LINK = "https://t.me/FoxHuntGameBot?startapp";
const SHARE = "https://t.me/share/url?url=" + encodeURIComponent(APP_LINK) +
  "&text=" + encodeURIComponent("🦊 Сыграй в «Охоту на лис» — логическая игра: найди всех лис в лесу! Игра дня одна для всех, давай сравним результаты.");
const PLAY = { inline_keyboard: [[{ text: "🦊 Играть", web_app: { url: SITE } }]] };
const MENU = { inline_keyboard: [
  [{ text: "🦊 Играть", web_app: { url: SITE } }],
  [{ text: "🏆 Таблица дня", callback_data: "top" }, { text: "❓ Как играть", callback_data: "help" }],
  [{ text: "📤 Поделиться игрой", url: SHARE }, { text: "🧹 Очистить чат", callback_data: "clear" }],
  [{ text: "⏰ Напоминания", callback_data: "remind" }, { text: "⭐ Поддержать", callback_data: "donate" }],
] };
const fmtMs = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
const moves = (n: number) => n % 10 === 1 && n % 100 !== 11 ? "ход" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "хода" : "ходов";

async function dayTop(): Promise<string> {
  const day = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);       // the day as in Moscow
  const medal = ["🥇", "🥈", "🥉", "4.", "5."];
  let out = `🏆 Игра дня, ${day.split("-").reverse().join(".")}\n`;
  const boards = await Promise.all(LEVELS.map(([lv]) => fetch(`${SB_URL}/rest/v1/rpc/day_board`, {
    method: "POST", headers: { apikey: PUBLISHABLE, "Content-Type": "application/json" },
    body: JSON.stringify({ p_level: lv, p_day: day }),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  for (const [i, [, name]] of LEVELS.entries()) {
    const b = boards[i];
    out += `\n${name}` + (!b ? "\nне удалось загрузить, попробуйте позже\n" : b.total ? ` · игроков: ${b.total}\n` : "\nпока никто не прошёл\n");
    for (const [j, row] of (b?.rows ?? []).slice(0, 5).entries())
      out += `${medal[j]} ${row.nick} — ${row.moves} ${moves(row.moves)}, ${fmtMs(row.ms)}${row.streak >= 2 ? ` 🔥${row.streak}` : ""}\n`;
  }
  return out + "\nСыграйте сегодняшнюю игру и попадите в таблицу 👇";
}

const HELP = "🦊 «Охота на лис» — логическая игра по мотивам журнала «Наука и жизнь» 1985 года.\n\n" +
  "В лесу прячутся лисы. Нажмите на дерево: если там лиса — она найдена, если нет — цифра покажет, " +
  "сколько лис на той же горизонтали, вертикали и диагоналях. Найдите всех лис за как можно меньше ходов.\n\n" +
  "📅 Игра дня — одна расстановка для всех, в общую таблицу идёт первая попытка.\n" +
  "🏆 /top — таблица игры дня\n⏰ /remind — напоминания об игре дня\n⭐ /donate — поддержать игру\n🧹 /clear — очистить переписку\n\nИграть можно здесь или в браузере: " + SITE;

const NONCE_RE = "[a-f0-9]{32}";
const NONCE = new RegExp(`^${NONCE_RE}$`);
const OK_CB = new RegExp(`^ok:(${NONCE_RE}):(\\d+)$`);       // the confirm button: code and the time of /start
const START = new RegExp(`^/start\\s+(${NONCE_RE})\\s*$`);
const nameOf = (u: { first_name?: string; last_name?: string }) => [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
// a confirmed sign-in code: the poll from the game turns it into a session (old ones are cleared on the way)
// (Mini App → browser codes are kept as "h:<nonce>": a link can only ever sign in as that Telegram's own player)
async function saveLogin(nonce: string, u: { id: number; first_name?: string; last_name?: string; username?: string }, at = new Date()) {
  const [, { error }] = await Promise.all([
    db.from("tg_logins").delete().lt("created_at", new Date(Date.now() - 864e5).toISOString()),
    db.from("tg_logins").upsert({ nonce, tg_id: u.id, tg_name: nameOf(u), tg_user: u.username ?? null, created_at: at.toISOString() }),
  ]);
  return !error;
}

const admin = () => createClient(SB_URL, SERVICE, { auth: { persistSession: false, autoRefreshToken: false } });
const db = admin();
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "Content-Type": "application/json" } });
const tg = (method: string, body: unknown) =>
  fetch(`https://api.telegram.org/bot${BOT}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }).then((r) => r.json());

// Telegram profile photo → avatars/<uid>.jpg; returns the version number or null
async function copyPhoto(tgId: number, uid: string): Promise<number | null> {
  try {
    const ph = await tg("getUserProfilePhotos", { user_id: tgId, limit: 1 });
    const sizes = ph?.result?.photos?.[0];
    if (!sizes?.length) return null;
    const pick = sizes.find((s: { width: number }) => s.width >= 160) ?? sizes[sizes.length - 1];
    const f = await tg("getFile", { file_id: pick.file_id });
    if (!f?.result?.file_path) return null;
    const img = await fetch(`https://api.telegram.org/file/bot${BOT}/${f.result.file_path}`).then((r) => r.arrayBuffer());
    const { error } = await db.storage.from("avatars").upload(`${uid}.jpg`, img, { contentType: "image/jpeg", upsert: true });
    return error ? null : Date.now();
  } catch {
    return null;
  }
}

const bearerOf = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
async function userOf(req: Request): Promise<{ id: string; email?: string } | null> {
  const b = bearerOf(req);
  if (b.split(".").length !== 3) return null;
  const { data } = await db.auth.getUser(b);
  return data?.user ?? null;
}

// Mini App: check Telegram's signature of initData (HMAC with the bot token)
async function hmac(key: ArrayBuffer | Uint8Array, data: string) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
}
async function checkInitData(initData: string): Promise<{ user?: any; why?: string }> {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return { why: "nohash" };
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), BOT);
  const calc = [...await hmac(secret, check)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (calc !== hash) return { why: "hash" };
  if (Date.now() / 1000 - Number(p.get("auth_date") || 0) > 86400) return { why: "old" };
  try { return { user: JSON.parse(p.get("user") || "null") }; } catch { return { why: "user" }; }
}

// find (or create, or attach to the caller's nick) the player for this Telegram account and open a session
async function loginAs(tgId: number, tgName: string | null, tgUser: string | null, caller: { id: string; email?: string } | null) {
  const email = `tg${tgId}@fox-hunt.github.io`;
  const { data: link } = await db.from("tg_links").select("user_id").eq("tg_id", tgId).maybeSingle();
  let uid: string | undefined = link?.user_id;
  let made: { user?: { id: string }; properties?: { hashed_token?: string } } | null = null;   // a sign-in link made on the way
  const fresh = !uid;                                       // linked just now
  if (!uid) {
    // "this e-mail is taken": the player exists already (a parallel sign-in, or a link row that was lost)
    const taken = (e: { code?: string } | null) => e?.code === "email_exists";
    if (caller && !caller.email) {                          // keep this device's nick and results
      const { error } = await db.auth.admin.updateUserById(caller.id, { email, email_confirm: true });
      if (!error) uid = caller.id;
      else if (!taken(error)) return json({ error: "link" }, 500);
    }
    if (!uid) {
      const { data: c, error } = await db.auth.admin.createUser({ email, email_confirm: true });
      uid = c?.user?.id;
      if (!uid && taken(error)) {
        made = (await db.auth.admin.generateLink({ type: "magiclink", email })).data;
        uid = made?.user?.id;
      }
      if (!uid) return json({ error: "create" }, 500);
    }
    const { data: ins, error: le } = await db.from("tg_links").upsert({ tg_id: tgId, user_id: uid, tg_user: tgUser }, { onConflict: "tg_id", ignoreDuplicates: true }).select("user_id");
    if (le) return json({ error: "link" }, 500);
    if (!ins?.length) {                                     // a parallel sign-in linked first: use its player
      const { data: won } = await db.from("tg_links").select("user_id").eq("tg_id", tgId).maybeSingle();
      if (!won) return json({ error: "link" }, 500);
      uid = won.user_id;
    }
  } else if (tgUser) {
    await db.from("tg_links").update({ tg_user: tgUser }).eq("tg_id", tgId);
  }

  // a fresh session for that player (magic link made and used right here, no e-mail is sent)
  const gl = made?.user?.id === uid ? made : (await db.auth.admin.generateLink({ type: "magiclink", email })).data;
  if (!gl?.properties?.hashed_token) return json({ error: "link" }, 500);
  const { data: v, error: ve } = await admin().auth.verifyOtp({ type: "magiclink", token_hash: gl.properties.hashed_token });
  if (ve || !v?.session) return json({ error: "session" }, 500);

  // Telegram photo as the avatar, unless the player already has one
  // — only when Telegram gets linked: a photo the player removed later must not come back on the next sign-in
  // (a player without a nick has no profile yet: the client keeps the photo until the nick is chosen)
  const { data: prof } = await db.from("profiles").select("avatar_v").eq("id", uid).maybeSingle();
  let photo: number | null = null;
  if (fresh && !prof?.avatar_v) {
    photo = await copyPhoto(tgId, uid!);
    if (photo && prof) await db.from("profiles").update({ avatar_v: photo }).eq("id", uid);
  }
  const s = v.session;
  return json({
    status: "ok", tg_id: tgId, name: tgName, username: tgUser, photo,
    session: { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, expires_in: s.expires_in },
  });
}

// ---------- daily reminders (times are Moscow time) ----------
const HOURS = [9, 13, 19, 21];
const mskNow = () => new Date(Date.now() + 3 * 3600e3);
const remindText = (h: number | null) => h == null
  ? "🔕 Напоминания выключены.\n\nХотите, чтобы бот напоминал об игре дня, если вы её ещё не сыграли? Выберите время (по Москве):"
  : `⏰ Бот напомнит об игре дня в ${h}:00 по Москве — только если вы её ещё не сыграли.\n\nДругое время или выключить:`;
const remindKeys = (h: number | null) => ({ inline_keyboard: [
  HOURS.map((x) => ({ text: (x === h ? "✓ " : "") + `${x}:00`, callback_data: `rh:${x}` })),
  [{ text: h == null ? "✓ Выключены" : "🔕 Выключить", callback_data: "rh:off" }],
  [{ text: "🦊 Играть", web_app: { url: SITE } }],
] });
const days = (n: number) => n % 10 === 1 && n % 100 !== 11 ? "день" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "дня" : "дней";
const hunters = (n: number) => n % 10 === 1 && n % 100 !== 11 ? "охотник" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "охотника" : "охотников";
function reminder(d: { linked: boolean; streak: number; first: boolean }, players: number) {
  let t = d.linked ? "🦊 Игра дня ждёт! Вы ещё не охотились сегодня." : "🦊 В лесу новая игра дня — одна расстановка для всех.";
  t += players ? `\n🏆 В таблице уже ${players} ${hunters(players)} — попробуйте их обойти.` : "\n🏆 Таблица пока пуста — можно стать первым!";
  if (d.streak >= 2) t += `\n🔥 Ваша серия: ${d.streak} ${days(d.streak)} подряд — не прерывайте!`;
  if (d.first) t += "\n\nТеперь бот будет напоминать раз в день, если игра дня ещё не сыграна. Не нужно — нажмите «🔕 Отключить напоминания» ниже.";
  return { text: t, reply_markup: { inline_keyboard: [
    [{ text: "🦊 Играть", web_app: { url: SITE } }],
    [{ text: "🔕 Отключить напоминания", callback_data: "rh:off" }],
    [{ text: "⏰ Другое время", callback_data: "remind" }],
  ] } };
}
// called every hour by pg_cron; body.hour / body.chat — for a manual check
async function sendReminders(body: { hour?: number; chat?: number }) {
  const now = mskNow(), day = now.toISOString().slice(0, 10), hour = body.hour ?? now.getUTCHours();
  const { data, error } = await db.rpc("tg_remind_due", { p_hour: hour, p_day: day });
  if (error) return json({ error: error.message }, 500);
  let due: { chat: number; linked: boolean; streak: number; first: boolean }[] = data?.due ?? [];
  if (body.chat) due = due.filter((d) => d.chat === body.chat);
  const sent: number[] = [], blocked: number[] = [];
  for (const d of due) {
    const r = await tg("sendMessage", { chat_id: d.chat, ...reminder(d, data?.players ?? 0) }).catch(() => null);
    if (r?.ok) sent.push(d.chat);
    else if (r?.error_code === 403) blocked.push(d.chat);       // the player stopped the bot
  }
  if (sent.length || blocked.length) await db.rpc("tg_remind_sent", { p_sent: sent, p_blocked: blocked, p_day: day });
  return json({ hour, day, due: due.length, sent: sent.length, blocked: blocked.length });
}
async function remindSettings(chat: number, set?: number | null, edit?: number) {
  const { data } = await db.rpc("tg_remind", { p_chat: chat, p_hour: set ?? null, p_set: set !== undefined });
  const h = data?.hour ?? null;
  const msg = { chat_id: chat, text: remindText(h), reply_markup: remindKeys(h) };
  if (edit) await tg("editMessageText", { ...msg, message_id: edit }).catch(() => null);
  else await tg("sendMessage", msg);
}

// ---------- donations in Telegram Stars (no payment provider: the bot takes them itself) ----------
const TIPS = [50, 100, 250];
const TIP_MAX = 10000;
const TIP = /^tip:(\d+)$/;
const DONATE_TEXT = "⭐ Поддержать «Охоту на лис»\n\nИгра бесплатная и без рекламы. Если она вам нравится, можно поддержать её звёздами Telegram — " +
  "это добровольно и ничего не меняет в игре: таблица и значки у всех одинаковые.\n\nСколько звёзд?";
const DONATE_KEYS = { inline_keyboard: [
  [...TIPS.map((n) => ({ text: `⭐ ${n}`, callback_data: `tip:${n}` })), { text: "✏️ Своя сумма", callback_data: "tip:own" }],
] };
const ASK_OWN = `Сколько звёзд хотите подарить игре? Напишите число от 1 до ${TIP_MAX} ответом на это сообщение.`;
const PAYSUPPORT = "Вопросы по оплате звёздами: если что-то пошло не так или вы хотите вернуть звёзды, напишите одним сообщением\n" +
  "/paysupport и ваш вопрос\n\nБот передаст его разработчику игры, ответ придёт сюда же. Telegram по таким платежам помочь не может: ими занимается разработчик.";
const who = (u: { id: number; first_name?: string; last_name?: string; username?: string }) =>
  [nameOf(u), u.username ? "@" + u.username : null].filter(Boolean).join(" ") + ` (id:${u.id})`;
const ASKED = /\(id:(\d+)\)/;               // the player's id in a question forwarded to the developer
const msk = (iso: string) => new Date(Date.parse(iso) + 3 * 3600e3).toISOString();      // "2026-10-16T19:05…" in Moscow time
const fmtDay = (iso: string) => { const t = msk(iso); return `${t.slice(8, 10)}.${t.slice(5, 7)}.${t.slice(2, 4)} ${t.slice(11, 16)}`; };
// for the developer only: who, when and how much
async function donationsReport(): Promise<string> {
  const { data, error } = await db.from("donations").select("tg_id, tg_user, name, stars, created_at").order("created_at", { ascending: false });
  if (error) return "Не удалось загрузить: " + error.message;
  if (!data?.length) return "⭐ Донатов пока нет.";
  const sum = (r: { stars: number }[]) => r.reduce((a, d) => a + d.stars, 0);
  const month = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 7);
  const thisMonth = data.filter((d: { created_at: string }) => msk(d.created_at).slice(0, 7) === month);
  let out = `⭐ Донаты: всего ${sum(data)} ⭐ (${data.length}), в этом месяце ${sum(thisMonth)} ⭐ (${thisMonth.length})\n\nПоследние:\n`;
  for (const d of data.slice(0, 30))
    out += `${fmtDay(d.created_at)} — ${d.stars} ⭐ — ${[d.name, d.tg_user ? "@" + d.tg_user : null].filter(Boolean).join(" ") || "id " + d.tg_id}\n`;
  return out + "\nВсе записи — таблица donations в Supabase. Звёзды на балансе бота: @BotFather → бот → Balance.";
}
const sendTip = (chat: number, n: number) => tg("sendInvoice", {
  chat_id: chat, title: "Поддержка игры «Охота на лис»",
  description: `Добровольная поддержка разработки — ${n} ⭐. Спасибо! 🦊`,
  payload: `tip:${n}`, currency: "XTR", prices: [{ label: "Поддержка игры", amount: n }],
});
const askOwn = (chat: number) => tg("sendMessage", {
  chat_id: chat, text: ASK_OWN, reply_markup: { force_reply: true, input_field_placeholder: "например, 30" },
});
// a number of stars typed by the player: a valid one gets an invoice, anything else — the question again
async function ownTip(chat: number, text: string) {
  const n = Number(text.trim().replace(/[\s⭐]/g, ""));
  if (Number.isInteger(n) && n >= 1 && n <= TIP_MAX) await sendTip(chat, n);
  else await askOwn(chat);
}

async function botCommand(cmd: string, chat: number, lastId: number) {
  if (cmd === "donate") {
    await tg("sendMessage", { chat_id: chat, text: DONATE_TEXT, reply_markup: DONATE_KEYS });
  } else if (cmd === "donations" && chat === OWNER) {
    await tg("sendMessage", { chat_id: chat, text: await donationsReport() });
  } else if (cmd === "paysupport") {
    await tg("sendMessage", { chat_id: chat, text: PAYSUPPORT });
  } else if (cmd === "remind") {
    await remindSettings(chat);
  } else if (cmd === "top") {
    await tg("sendMessage", { chat_id: chat, text: await dayTop(), reply_markup: MENU });
  } else if (cmd === "help") {
    await tg("sendMessage", { chat_id: chat, text: HELP, reply_markup: MENU, link_preview_options: { is_disabled: true } });
  } else if (cmd === "clear") {
    // the reply goes first: its id is the newest in the chat, so everything above it gets deleted
    // (the button may sit under an old message). Bots may delete messages of the last 48 hours; ids go one after another
    const sent = await tg("sendMessage", { chat_id: chat, text: "🧹 Чат очищен. Сообщения старше 48 часов Telegram удалить боту не даёт: их можно убрать через «Очистить историю» в меню чата.", reply_markup: MENU });
    const top = Math.max(lastId, (sent?.result?.message_id ?? 0) - 1);
    for (let to = top; to > 0 && to > top - 1000; to -= 100)      // one batch at a time: parallel ones get throttled by Telegram
      await tg("deleteMessages", { chat_id: chat, message_ids: Array.from({ length: Math.min(100, to) }, (_, i) => to - i) }).catch(() => null);
  } else {
    await tg("sendMessage", {
      chat_id: chat,
      text: "Привет! Я бот игры «Охота на лис» 🦊\nНажмите «Играть», и игра откроется прямо здесь. Вход и общая таблица — автоматически.",
      reply_markup: MENU,
    });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  // one-time setup from the browser: …/functions/v1/tg?setup=<TG_SECRET>
  if (req.method === "GET") {
    if (!SECRET || url.searchParams.get("setup") !== SECRET) return json({ error: "not found" }, 404);
    const hook = await tg("setWebhook", { url: `${SB_URL}/functions/v1/tg`, secret_token: SECRET, allowed_updates: ["message", "callback_query", "pre_checkout_query"] });
    const menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Играть", web_app: { url: SITE } } });
    const cmds = await tg("setMyCommands", { commands: [
      { command: "play", description: "Открыть игру" },
      { command: "top", description: "Таблица игры дня" },
      { command: "help", description: "Как играть" },
      { command: "remind", description: "Напоминания об игре дня" },
      { command: "donate", description: "Поддержать игру звёздами" },
      { command: "clear", description: "Очистить переписку с ботом" },
      { command: "paysupport", description: "Вопросы по оплате звёздами" },
    ] });
    await tg("setMyDescription", { description: "🦊 Логическая игра «Охота на лис»: найдите лис в лесу по пеленгу.\n\nИгра дня — одна расстановка для всех, общая таблица, серии и значки. Нажмите «Играть»!" });
    await tg("setMyShortDescription", { short_description: "Логическая игра «Охота на лис» 🦊 Игра дня, общая таблица и значки" });
    const me = await tg("getMe", {});
    const info = await tg("getWebhookInfo", {});
    return json({ webhook: hook, menu, commands: cmds, bot: me?.result?.username, updates: info?.result?.allowed_updates, pending: info?.result?.pending_update_count, last_error: info?.result?.last_error_message ?? null });
  }

  // the hourly reminder run (pg_cron → here, with TG_SECRET)
  if (req.method === "POST" && SECRET && req.headers.get("x-fox-cron") === SECRET) {
    return await sendReminders(await req.json().catch(() => ({})));
  }

  // Telegram webhook
  // (always answers 200: an error would make Telegram send the same update again and again)
  if (SECRET && req.headers.get("x-telegram-bot-api-secret-token") === SECRET) {
    try {
      const u = await req.json().catch(() => ({}));
      const pq = u?.pre_checkout_query;
      if (pq) {                                            // Telegram asks before taking the stars: must answer within 10 s
        const tip = String(pq.invoice_payload || "").match(TIP);
        const fine = !!tip && pq.currency === "XTR" && pq.total_amount === Number(tip[1]);
        await tg("answerPreCheckoutQuery", fine ? { pre_checkout_query_id: pq.id, ok: true }
          : { pre_checkout_query_id: pq.id, ok: false, error_message: "Этот счёт устарел — нажмите /donate ещё раз" });
        return json({ ok: true });
      }
      const cq = u?.callback_query;
      if (cq?.message) {                                   // a button under a bot message
        const ok = String(cq.data || "").match(OK_CB);
        if (ok) {                                          // the player confirmed the sign-in
          if (cq.message.chat.type !== "private" || cq.from.id !== cq.message.chat.id) {   // only in the player's own chat with the bot
            await tg("answerCallbackQuery", { callback_query_id: cq.id });
            return json({ ok: true });
          }
          // the 15 minutes count from /start (its time is in the button), so an old prompt can't revive a code
          const at = new Date(Number(ok[2]) * 1000);
          if (Date.now() - at.getTime() > 15 * 60e3) {
            await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Ссылка устарела — нажмите «Войти через Telegram» в игре ещё раз", show_alert: true });
            return json({ ok: true });
          }
          // the button goes first: only the press that removed it saves the code (a double tap, or a press
          // after the code was used, finds the message already edited and changes nothing)
          const where = { chat_id: cq.message.chat.id, message_id: cq.message.message_id };
          const edited = await tg("editMessageText", { ...where, text: "✅ Готово! Вернитесь в игру «Охота на лис», вход выполнится сам.\n\nНа iPhone: «◀ Safari» в левом верхнем углу." }).catch(() => null);
          const saved = edited?.ok === true && await saveLogin(ok[1], cq.from, at);
          if (edited?.ok && !saved)                            // the button is gone but nothing was saved: bring it back
            await tg("editMessageText", { ...where, text: cq.message.text ?? "Войти в игру «Охота на лис»?", reply_markup: { inline_keyboard: [[{ text: "✅ Да, это я — войти", callback_data: cq.data }]] } }).catch(() => null);
          await tg("answerCallbackQuery", { callback_query_id: cq.id, text: saved || !edited?.ok ? undefined : "Не получилось, попробуйте ещё раз" }).catch(() => null);
          return json({ ok: true });
        }
        const tip = String(cq.data || "").match(/^tip:(\d+|own)$/);
        if (tip) {
          await tg("answerCallbackQuery", { callback_query_id: cq.id });
          if (tip[1] === "own") await askOwn(cq.message.chat.id);
          else if (TIPS.includes(Number(tip[1]))) await sendTip(cq.message.chat.id, Number(tip[1]));
          return json({ ok: true });
        }
        const rh = String(cq.data || "").match(/^rh:(\d{1,2}|off)$/);
        if (rh) {                                          // reminder time / off
          const h = rh[1] === "off" ? null : Number(rh[1]);
          await tg("answerCallbackQuery", { callback_query_id: cq.id, text: h == null ? "Напоминания выключены" : `Напомню в ${h}:00 по Москве` });
          // under a reminder the message stays: settings come as a new message; in the settings message — edited in place
          const inSettings = cq.message.reply_markup?.inline_keyboard?.some((r: { callback_data?: string }[]) => r.some((b) => b.callback_data === "rh:9"));
          await remindSettings(cq.message.chat.id, h != null && HOURS.includes(h) ? h : null, inSettings ? cq.message.message_id : undefined);
          return json({ ok: true });
        }
        await tg("answerCallbackQuery", { callback_query_id: cq.id });
        await botCommand(String(cq.data || ""), cq.message.chat.id, cq.message.message_id);
        return json({ ok: true });
      }
      const m = u?.message;
      const paid = m?.successful_payment;
      if (paid && m.from) {                                // the stars are taken: remember and thank
        // (upsert by the charge id: Telegram may send the same update twice)
        const { error } = await db.from("donations").upsert({ charge_id: paid.telegram_payment_charge_id, tg_id: m.from.id, tg_user: m.from.username ?? null, name: nameOf(m.from), stars: paid.total_amount }, { onConflict: "charge_id", ignoreDuplicates: true });
        if (error) console.error("donation", paid.telegram_payment_charge_id, error.message);
        await tg("sendMessage", { chat_id: m.chat.id, text: `🦊 Спасибо за поддержку — ${paid.total_amount} ⭐! Это очень помогает игре.`, reply_markup: PLAY });
        await tg("sendMessage", { chat_id: OWNER, text: `⭐ +${paid.total_amount} от ${who(m.from)}\nВсе донаты: /donations` }).catch(() => null);
        return json({ ok: true });
      }
      if (!m?.text || !m.from) return json({ ok: true });
      if (m.chat.type === "private")                       // remember the chat: reminders go to those who wrote to the bot
        try { await db.rpc("tg_seen", { p_chat: m.chat.id, p_user: m.from.username ?? null }); } catch { /* not critical */ }
      const start = m.chat.type === "private" && m.text.match(START);   // m.date: when /start was sent
      if (start) {
        // ask first: a link with someone else's code must not sign that person into this Telegram account
        await tg("sendMessage", {
          chat_id: m.chat.id,
          text: "Войти в игру «Охота на лис» с этим Telegram?\n\nПодтверждайте, только если вы сами только что нажали «Войти через Telegram» в игре. Если ссылку прислал кто-то другой — не нажимайте.",
          reply_markup: { inline_keyboard: [[{ text: "✅ Да, это я — войти", callback_data: `ok:${start[1]}:${m.date}` }]] },
        });
      } else if (m.reply_to_message?.from?.is_bot && m.reply_to_message.text === ASK_OWN) {   // the answer to «Своя сумма»
        await ownTip(m.chat.id, m.text);
      } else if (m.chat.id === OWNER && m.reply_to_message?.from?.is_bot && ASKED.test(m.reply_to_message.text ?? "")) {   // the developer answers a question
        const to = Number(m.reply_to_message.text.match(ASKED)[1]);
        const r = await tg("sendMessage", { chat_id: to, text: "💬 Ответ разработчика игры:\n\n" + m.text });
        await tg("sendMessage", { chat_id: OWNER, text: r?.ok ? "✅ Ответ отправлен" : "Не отправилось: " + (r?.description ?? "ошибка") });
      } else if (/^\/paysupport(@\w+)?\s+\S/i.test(m.text)) {               // a question about a payment → to the developer
        await tg("sendMessage", { chat_id: OWNER, text: `💬 Вопрос по оплате от ${who(m.from)}:\n\n${m.text.replace(/^\/paysupport(@\w+)?\s+/i, "")}\n\n(ответьте на это сообщение — ответ уйдёт игроку)` });
        await tg("sendMessage", { chat_id: m.chat.id, text: "✅ Вопрос передан разработчику, ответ придёт сюда." });
      } else if (/^\/donate(@\w+)?\s+\S/i.test(m.text)) {                  // «/donate 300»
        await ownTip(m.chat.id, m.text.replace(/^\/donate(@\w+)?/i, ""));
      } else {
        await botCommand((m.text.match(/^\/(\w+)/)?.[1] ?? "").toLowerCase(), m.chat.id, m.message_id);
      }
    } catch (e) {
      console.error("webhook", e);
    }
    return json({ ok: true });
  }

  // the game: { action: "webapp", initData } — Mini App sign-in; { action: "photo" } — avatar from Telegram; { nonce } — poll a login
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.action === "webapp") {                       // opened inside Telegram: sign in at once
      const chk = await checkInitData(String(body.initData || ""));
      const u = chk.user;
      if (!u?.id) return json({ error: "initdata", why: chk.why ?? "user" }, 401);
      return await loginAs(u.id, nameOf(u), u.username ?? null, await userOf(req));
    }
    if (body.action === "handoff") {                      // Mini App → browser: a one-time login for the same Telegram account
      const chk = await checkInitData(String(body.initData || ""));
      const u = chk.user;
      if (!u?.id || !NONCE.test(body.nonce ?? "")) return json({ error: "initdata", why: chk.why ?? "nonce" }, 401);
      // only a Telegram that already has a player: a handoff link must never attach someone else's Telegram to the opener's nick
      const { data: has, error: he } = await db.from("tg_links").select("tg_id").eq("tg_id", u.id).maybeSingle();
      if (he) return json({ error: "save" }, 500);
      if (!has) return json({ error: "notg" }, 400);
      return (await saveLogin("h:" + body.nonce, u)) ? json({ ok: true }) : json({ error: "save" }, 500);
    }
    if (body.action === "photo") {
      const uid = (await userOf(req))?.id;
      if (!uid) return json({ error: "auth" }, 401);
      const { data: link } = await db.from("tg_links").select("tg_id").eq("user_id", uid).maybeSingle();
      if (!link) return json({ error: "notg" }, 400);
      const photo = await copyPhoto(link.tg_id, uid);
      if (!photo) return json({ error: "nophoto" }, 404);
      await db.from("profiles").update({ avatar_v: photo }).eq("id", uid);
      return json({ photo });
    }
    const { nonce, handoff } = body;
    if (!NONCE.test(nonce ?? "")) return json({ error: "bad" }, 400);
    const { data: L } = await db.from("tg_logins").delete().eq("nonce", handoff ? "h:" + nonce : nonce).select().maybeSingle();   // taken and removed at once: one session per nonce
    if (!L) return json({ status: "wait" });
    if (Date.now() - Date.parse(L.created_at) > 15 * 60e3) return json({ status: "expired" });

    // a handoff code never attaches the opener's account: it only signs in as the Telegram's own player
    let res: Response | null = null;
    try {
      res = await loginAs(L.tg_id, L.tg_name, L.tg_user, handoff ? null : await userOf(req));
    } finally {
      if (!res?.ok) await db.from("tg_logins").upsert(L);  // failed or crashed half-way: keep the code, the game's next poll tries again
    }
    return res;
  }

  return json({ error: "not found" }, 404);
});
