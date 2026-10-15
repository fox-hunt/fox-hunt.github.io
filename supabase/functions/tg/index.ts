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
const APP_LINK = "https://t.me/FoxHuntGameBot?startapp";
const SHARE = "https://t.me/share/url?url=" + encodeURIComponent(APP_LINK) +
  "&text=" + encodeURIComponent("🦊 Сыграй в «Охоту на лис» — логическая игра: найди всех лис в лесу! Игра дня одна для всех, давай сравним результаты.");
const PLAY = { inline_keyboard: [[{ text: "🦊 Играть", web_app: { url: SITE } }]] };
const MENU = { inline_keyboard: [
  [{ text: "🦊 Играть", web_app: { url: SITE } }],
  [{ text: "🏆 Таблица дня", callback_data: "top" }, { text: "❓ Как играть", callback_data: "help" }],
  [{ text: "📤 Поделиться игрой", url: SHARE }, { text: "🧹 Очистить чат", callback_data: "clear" }],
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
  "🏆 /top — таблица игры дня\n🧹 /clear — очистить переписку\n\nИграть можно здесь или в браузере: " + SITE;

const NONCE = /^[a-f0-9]{32}$/;
const nameOf = (u: { first_name?: string; last_name?: string }) => [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
// a confirmed sign-in code: the poll from the game turns it into a session (old ones are cleared on the way)
async function saveLogin(nonce: string, u: { id: number; first_name?: string; last_name?: string; username?: string }, at = new Date()) {
  await db.from("tg_logins").delete().lt("created_at", new Date(Date.now() - 864e5).toISOString());
  const { error } = await db.from("tg_logins").upsert({ nonce, tg_id: u.id, tg_name: nameOf(u), tg_user: u.username ?? null, created_at: at.toISOString() });
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
        const { data: gl } = await db.auth.admin.generateLink({ type: "magiclink", email });
        uid = gl?.user?.id;
      }
      if (!uid) return json({ error: "create" }, 500);
    }
    const { error: le } = await db.from("tg_links").upsert({ tg_id: tgId, user_id: uid, tg_user: tgUser }, { onConflict: "tg_id", ignoreDuplicates: true });
    if (le) return json({ error: "link" }, 500);
    const { data: won } = await db.from("tg_links").select("user_id").eq("tg_id", tgId).maybeSingle();
    if (!won) return json({ error: "link" }, 500);
    uid = won.user_id;                                      // a parallel sign-in may have linked first: use its player
  } else if (tgUser) {
    await db.from("tg_links").update({ tg_user: tgUser }).eq("tg_id", tgId);
  }

  // a fresh session for that player (magic link made and used right here, no e-mail is sent)
  const { data: gl, error: ge } = await db.auth.admin.generateLink({ type: "magiclink", email });
  if (ge || !gl?.properties?.hashed_token) return json({ error: "link" }, 500);
  const { data: v, error: ve } = await admin().auth.verifyOtp({ type: "magiclink", token_hash: gl.properties.hashed_token });
  if (ve || !v?.session) return json({ error: "session" }, 500);

  // Telegram photo as the avatar, unless the player already has one
  const { data: prof } = await db.from("profiles").select("avatar_v").eq("id", uid).maybeSingle();
  let photo: number | null = null;
  if (!prof?.avatar_v) {
    photo = await copyPhoto(tgId, uid!);
    if (photo && prof) await db.from("profiles").update({ avatar_v: photo }).eq("id", uid);
  }
  const s = v.session;
  return json({
    status: "ok", tg_id: tgId, name: tgName, username: tgUser, photo,
    session: { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, expires_in: s.expires_in },
  });
}

async function botCommand(cmd: string, chat: number, lastId: number) {
  if (cmd === "top") {
    await tg("sendMessage", { chat_id: chat, text: await dayTop(), reply_markup: MENU });
  } else if (cmd === "help") {
    await tg("sendMessage", { chat_id: chat, text: HELP, reply_markup: MENU, link_preview_options: { is_disabled: true } });
  } else if (cmd === "clear") {
    // the reply goes first: its id is the newest in the chat, so everything above it gets deleted
    // (the button may sit under an old message). Bots may delete messages of the last 48 hours; ids go one after another
    const sent = await tg("sendMessage", { chat_id: chat, text: "🧹 Чат очищен. Сообщения старше 48 часов Telegram удалить боту не даёт: их можно убрать через «Очистить историю» в меню чата.", reply_markup: MENU });
    const top = Math.max(lastId, (sent?.result?.message_id ?? 0) - 1);
    const jobs = [];
    for (let to = top; to > 0 && to > top - 1000; to -= 100)
      jobs.push(tg("deleteMessages", { chat_id: chat, message_ids: Array.from({ length: Math.min(100, to) }, (_, i) => to - i) }).catch(() => null));
    await Promise.all(jobs);
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
    const hook = await tg("setWebhook", { url: `${SB_URL}/functions/v1/tg`, secret_token: SECRET, allowed_updates: ["message", "callback_query"] });
    const menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Играть", web_app: { url: SITE } } });
    const cmds = await tg("setMyCommands", { commands: [
      { command: "play", description: "Открыть игру" },
      { command: "top", description: "Таблица игры дня" },
      { command: "help", description: "Как играть" },
      { command: "clear", description: "Очистить переписку с ботом" },
    ] });
    await tg("setMyDescription", { description: "🦊 Логическая игра «Охота на лис»: найдите лис в лесу по пеленгу.\n\nИгра дня — одна расстановка для всех, общая таблица, серии и значки. Нажмите «Играть»!" });
    await tg("setMyShortDescription", { short_description: "Логическая игра «Охота на лис» 🦊 Игра дня, общая таблица и значки" });
    const me = await tg("getMe", {});
    const info = await tg("getWebhookInfo", {});
    return json({ webhook: hook, menu, commands: cmds, bot: me?.result?.username, updates: info?.result?.allowed_updates, pending: info?.result?.pending_update_count, last_error: info?.result?.last_error_message ?? null });
  }

  // Telegram webhook
  // (always answers 200: an error would make Telegram send the same update again and again)
  if (SECRET && req.headers.get("x-telegram-bot-api-secret-token") === SECRET) {
    try {
      const u = await req.json().catch(() => ({}));
      const cq = u?.callback_query;
      if (cq?.message) {                                   // a button under a bot message
        const ok = String(cq.data || "").match(/^ok:([a-f0-9]{32}):(\d+)$/);
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
          const saved = await saveLogin(ok[1], cq.from, at);
          await tg("answerCallbackQuery", { callback_query_id: cq.id, text: saved ? undefined : "Не получилось, попробуйте ещё раз" });
          if (saved) await tg("editMessageText", {
            chat_id: cq.message.chat.id, message_id: cq.message.message_id,
            text: "✅ Готово! Вернитесь в игру «Охота на лис», вход выполнится сам.\n\nНа iPhone: «◀ Safari» в левом верхнем углу.",
          });
          return json({ ok: true });
        }
        await tg("answerCallbackQuery", { callback_query_id: cq.id });
        await botCommand(String(cq.data || ""), cq.message.chat.id, cq.message.message_id);
        return json({ ok: true });
      }
      const m = u?.message;
      if (!m?.text || !m.from) return json({ ok: true });
      const start = m.chat.type === "private" && m.text.match(/^\/start\s+([a-f0-9]{32})\s*$/);   // m.date: when /start was sent
      if (start) {
        // ask first: a link with someone else's code must not sign that person into this Telegram account
        await tg("sendMessage", {
          chat_id: m.chat.id,
          text: "Войти в игру «Охота на лис» с этим Telegram?\n\nПодтверждайте, только если вы сами только что нажали «Войти через Telegram» в игре. Если ссылку прислал кто-то другой — не нажимайте.",
          reply_markup: { inline_keyboard: [[{ text: "✅ Да, это я — войти", callback_data: `ok:${start[1]}:${m.date}` }]] },
        });
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
      return (await saveLogin(body.nonce, u)) ? json({ ok: true }) : json({ error: "save" }, 500);
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
    const { nonce } = body;
    if (!NONCE.test(nonce ?? "")) return json({ error: "bad" }, 400);
    const { data: L } = await db.from("tg_logins").delete().eq("nonce", nonce).select().maybeSingle();   // taken and removed at once: one session per nonce
    if (!L) return json({ status: "wait" });
    if (Date.now() - Date.parse(L.created_at) > 15 * 60e3) return json({ status: "expired" });

    return await loginAs(L.tg_id, L.tg_name, L.tg_user, await userOf(req));   // on failure the game says so and offers to try again
  }

  return json({ error: "not found" }, 404);
});
