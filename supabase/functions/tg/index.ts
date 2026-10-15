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
  let linked = false;
  if (!uid) {
    if (caller && !caller.email) {
      uid = caller.id;                                      // keep this device's nick and results
      const { error } = await db.auth.admin.updateUserById(uid, { email, email_confirm: true });
      if (error) return json({ error: "link" }, 500);
    } else {
      const { data: c, error } = await db.auth.admin.createUser({ email, email_confirm: true });
      if (error || !c.user) return json({ error: "create" }, 500);
      uid = c.user.id;
    }
    await db.from("tg_links").insert({ tg_id: tgId, user_id: uid, tg_user: tgUser });
    linked = true;
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
    status: "ok", linked, tg_id: tgId, name: tgName, username: tgUser, photo,
    session: { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, expires_in: s.expires_in },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  // one-time setup from the browser: …/functions/v1/tg?setup=<TG_SECRET>
  if (req.method === "GET") {
    if (!SECRET || url.searchParams.get("setup") !== SECRET) return json({ error: "not found" }, 404);
    const hook = await tg("setWebhook", { url: `${SB_URL}/functions/v1/tg`, secret_token: SECRET, allowed_updates: ["message"] });
    const menu = await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Играть", web_app: { url: SITE } } });
    const me = await tg("getMe", {});
    return json({ webhook: hook, menu, bot: me?.result?.username });
  }

  // Telegram webhook
  if (SECRET && req.headers.get("x-telegram-bot-api-secret-token") === SECRET) {
    const u = await req.json().catch(() => ({}));
    const m = u?.message;
    if (!m?.text || !m.from) return json({ ok: true });
    const start = m.text.match(/^\/start\s+([a-f0-9]{32})\s*$/);
    if (start) {
      await db.from("tg_logins").upsert({
        nonce: start[1], tg_id: m.from.id,
        tg_name: [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") || null,
        tg_user: m.from.username ?? null,
      });
      await tg("sendMessage", {
        chat_id: m.chat.id,
        text: "✅ Готово! Вернитесь в игру «Охота на лис», вход выполнится сам.\n\nНа iPhone: «◀ Safari» в левом верхнем углу.",
      });
    } else {
      await tg("sendMessage", {
        chat_id: m.chat.id,
        text: "Привет! Я бот игры «Охота на лис» 🦊\nНажмите «Играть», и игра откроется прямо здесь. Вход и общая таблица — автоматически.",
        reply_markup: { inline_keyboard: [[{ text: "🦊 Играть", web_app: { url: SITE } }]] },
      });
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
      const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || null;
      return await loginAs(u.id, name, u.username ?? null, await userOf(req));
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
    if (!/^[a-f0-9]{32}$/.test(nonce ?? "")) return json({ error: "bad" }, 400);
    const { data: L } = await db.from("tg_logins").select("*").eq("nonce", nonce).maybeSingle();
    if (!L) return json({ status: "wait" });
    await db.from("tg_logins").delete().eq("nonce", nonce);
    if (Date.now() - Date.parse(L.created_at) > 15 * 60e3) return json({ status: "expired" });

    return await loginAs(L.tg_id, L.tg_name, L.tg_user, await userOf(req));
  }

  return json({ error: "not found" }, 404);
});
