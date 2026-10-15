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
const BOT = Deno.env.get("TG_BOT_TOKEN") ?? "";
const SECRET = Deno.env.get("TG_SECRET") ?? "";
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  // one-time setup from the browser: …/functions/v1/tg?setup=<TG_SECRET>
  if (req.method === "GET") {
    if (!SECRET || url.searchParams.get("setup") !== SECRET) return json({ error: "not found" }, 404);
    const hook = await tg("setWebhook", { url: `${SB_URL}/functions/v1/tg`, secret_token: SECRET, allowed_updates: ["message"] });
    const me = await tg("getMe", {});
    return json({ webhook: hook, bot: me?.result?.username });
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
        text: "Привет! Я бот игры «Охота на лис» 🦊\nЧтобы войти, нажмите «Войти через Telegram» в настройках игры.",
        reply_markup: { inline_keyboard: [[{ text: "🦊 Играть", url: SITE }]] },
      });
    }
    return json({ ok: true });
  }

  // the game: { action: "photo" } — take the avatar from Telegram again; otherwise { nonce } — poll a login
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.action === "photo") {
      const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const { data } = bearer.split(".").length === 3 ? await db.auth.getUser(bearer) : { data: null };
      const uid = data?.user?.id;
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

    // the player already on this device (an account without Telegram), if any
    let caller: { id: string; email?: string } | null = null;
    const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    if (bearer.split(".").length === 3) {
      const { data } = await db.auth.getUser(bearer);
      caller = data?.user ?? null;
    }

    const email = `tg${L.tg_id}@fox-hunt.github.io`;
    const { data: link } = await db.from("tg_links").select("user_id").eq("tg_id", L.tg_id).maybeSingle();
    let uid: string | undefined = link?.user_id;
    let linked = false;
    if (!uid) {
      if (caller && !caller.email) {
        uid = caller.id;                                    // keep this device's nick and results
        const { error } = await db.auth.admin.updateUserById(uid, { email, email_confirm: true });
        if (error) return json({ error: "link" }, 500);
      } else {
        const { data: c, error } = await db.auth.admin.createUser({ email, email_confirm: true });
        if (error || !c.user) return json({ error: "create" }, 500);
        uid = c.user.id;
      }
      await db.from("tg_links").insert({ tg_id: L.tg_id, user_id: uid, tg_user: L.tg_user });
      linked = true;
    } else if (L.tg_user) {
      await db.from("tg_links").update({ tg_user: L.tg_user }).eq("tg_id", L.tg_id);
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
      photo = await copyPhoto(L.tg_id, uid!);
      if (photo && prof) await db.from("profiles").update({ avatar_v: photo }).eq("id", uid);
    }

    const s = v.session;
    return json({
      status: "ok", linked, name: L.tg_name, username: L.tg_user, photo,
      session: { access_token: s.access_token, refresh_token: s.refresh_token, expires_at: s.expires_at, expires_in: s.expires_in },
    });
  }

  return json({ error: "not found" }, 404);
});
