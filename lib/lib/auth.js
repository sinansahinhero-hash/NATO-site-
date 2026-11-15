import { Router } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { db, auth, wrap, bad, cookieOpts, getPerms, CLIENT_ID, REDIRECT, DISCORD_CLIENT_SECRET, SESSION_SECRET, OWNER_ID } from "./core.js";

export const router = Router();

router.get("/auth/discord", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("nato_state", state, { ...cookieOpts, maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "identify email guilds",
    state
  });
  res.redirect("https://discord.com/oauth2/authorize?" + params.toString());
});

router.get("/auth/discord/callback", wrap(async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.cookies.nato_state) {
    return res.status(400).send("Geçersiz giriş isteği. Siteye dönüp tekrar dene.");
  }
  res.clearCookie("nato_state", cookieOpts);
  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT
      })
    });
    const token = await tokenRes.json();
    if (!token.access_token) throw new Error("Token alınamadı: " + JSON.stringify(token));
    const headers = { Authorization: `Bearer ${token.access_token}` };
    const me = await (await fetch("https://discord.com/api/users/@me", { headers })).json();
    const guilds = await (await fetch("https://discord.com/api/users/@me/guilds", { headers })).json();
    if (!me.id) throw new Error("Kullanıcı alınamadı");

    await db.query(
      `INSERT INTO users (id, username, avatar, email, guilds)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET username=$2, avatar=$3, email=$4, guilds=$5`,
      [me.id, me.username, me.avatar, me.email,
       JSON.stringify(Array.isArray(guilds) ? guilds.map(g => ({ id: g.id, name: g.name })) : [])]
    );

    const session = jwt.sign({ uid: me.id }, SESSION_SECRET, { expiresIn: "7d" });
    res.cookie("nato_session", session, { ...cookieOpts, maxAge: 7 * 24 * 3600 * 1000 });
    res.redirect("/");
  } catch (e) {
    console.error(e);
    res.status(500).send("Discord girişi başarısız oldu. Siteye dönüp tekrar dene.");
  }
}));

router.post("/logout", (req, res) => {
  res.clearCookie("nato_session", cookieOpts);
  res.json({ ok: true });
});

router.get("/me", auth, wrap(async (req, res) => {
  const { rows } = await db.query("SELECT * FROM users WHERE id=$1", [req.uid]);
  const u = rows[0];
  if (!u) return bad(res, "Hesap bulunamadı.", 401);
  const owner = u.id === OWNER_ID;
  const canManage = owner || (await db.query("SELECT 1 FROM rank_perms WHERE user_id=$1 LIMIT 1", [u.id])).rowCount > 0;
  const canDelegate = owner || (await db.query("SELECT 1 FROM rank_perms WHERE user_id=$1 AND can_delegate LIMIT 1", [u.id])).rowCount > 0;
  res.json({
    id: u.id,
    username: u.username,
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
    mcEdition: u.mc_edition,
    mcName: u.mc_name,
    isOwner: owner,
    canManage,
    canDelegate,
    perms: await getPerms(u.id)
  });
}));

router.post("/minecraft", auth, wrap(async (req, res) => {
  const edition = req.body.edition;
  const name = String(req.body.name || "").trim();
  const rules = { java: /^[A-Za-z0-9_]{3,16}$/, bedrock: /^[A-Za-z0-9 ]{1,15}$/ };
  if (!rules[edition]) return bad(res, "Sürüm Java veya Bedrock olmalı.");
  if (!rules[edition].test(name)) {
    return bad(res, edition === "java"
      ? "Java adı 3-16 karakter olmalı; harf, rakam ve alt çizgi kullanılabilir."
      : "Bedrock adı 1-15 karakter olmalı; harf, rakam ve boşluk kullanılabilir.");
  }
  const cur = await db.query("SELECT mc_name FROM users WHERE id=$1", [req.uid]);
  if (cur.rows[0]?.mc_name) return bad(res, "Minecraft adın kilitli. Değiştirmek için yönetimle iletişime geç.", 403);
  try {
    await db.query("UPDATE users SET mc_edition=$1, mc_name=$2 WHERE id=$3", [edition, name, req.uid]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "23505") return bad(res, "Bu Minecraft adı başka bir hesapta kayıtlı.", 409);
    throw e;
  }
}));
