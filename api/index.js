import express from "express";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import pg from "pg";

const {
  DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, BASE_URL,
  DATABASE_URL, SESSION_SECRET, OWNER_ID
} = process.env;

for (const [k, v] of Object.entries({ DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, BASE_URL, DATABASE_URL, SESSION_SECRET, OWNER_ID })) {
  if (!v) throw new Error("Eksik ortam değişkeni: " + k);
}

const REDIRECT = `${BASE_URL}/api/auth/discord/callback`;
const db = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });

/* ===== TABLOLAR ===== */
await db.query(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    avatar TEXT,
    email TEXT,
    guilds JSONB DEFAULT '[]',
    mc_edition TEXT,
    mc_name TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_mc_name_uq ON users (lower(mc_name));
  CREATE TABLE IF NOT EXISTS staff (
    discord_id TEXT PRIMARY KEY,
    added_by TEXT,
    perms TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
  );
  ALTER TABLE staff ADD COLUMN IF NOT EXISTS perms TEXT[] DEFAULT '{}';
  CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY,
    category TEXT NOT NULL,
    subject TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'open',
    claimed_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS ticket_messages (
    id SERIAL PRIMARY KEY,
    ticket_id INT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL,
    author_name TEXT NOT NULL,
    is_staff BOOLEAN NOT NULL DEFAULT false,
    body TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS group_requests (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    group_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    decided_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (user_id, group_key)
  );
`);

/* ===== SABİTLER ===== */
const CATS = { ban: "Ban Affı", destek: "Discord Destek", askeri: "Askerî Şikayet", ulusal: "Ulusal Şikayet" };
const ALL_PERMS = [...Object.keys(CATS), "gruplar"];

const GROUPS = [
  { key: "kara", branch: "Kara Kuvvetleri", label: "Kara Kuvvetleri" },
  { key: "boru", branch: "Kara Kuvvetleri", label: "BÖRÜ" },
  { key: "kho", branch: "Kara Kuvvetleri", label: "Komando Harp Okulu" },
  { key: "muhabere", branch: "Kara Kuvvetleri", label: "Muhabere Arama Kurtarma" },
  { key: "sinir", branch: "Sınır Müfettişleri", label: "Sınır Müfettişleri" },
  { key: "denetim", branch: "Sınır Müfettişleri", label: "Denetim Birimi" },
  { key: "gardiyan", branch: "Sınır Müfettişleri", label: "Gardiyan Muhafızlar" },
  { key: "ozel", branch: "Özel Kuvvetler", label: "Özel Kuvvetler" },
  { key: "okb", branch: "Özel Kuvvetler", label: "Özel Koruma Birliği" },
  { key: "sat", branch: "Özel Kuvvetler", label: "Su Altı Taarruz" },
  { key: "omega", branch: "Özel Kuvvetler", label: "OMEGA" },
  { key: "inzibat", branch: "Askerî İnzibat", label: "Askerî İnzibat" },
  { key: "yildirim", branch: "Askerî İnzibat", label: "Yıldırım Orduları" },
  { key: "kizil", branch: "Askerî İnzibat", label: "Kızıl Sağ El" }
];

/* ===== UYGULAMA ===== */
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.use(cookieParser());

const cookieOpts = { httpOnly: true, secure: true, sameSite: "lax", path: "/" };
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

function auth(req, res, next) {
  try {
    req.uid = jwt.verify(req.cookies.nato_session, SESSION_SECRET).uid;
    next();
  } catch {
    res.status(401).json({ error: "Giriş yapmalısın." });
  }
}

async function getPerms(uid) {
  if (uid === OWNER_ID) return ALL_PERMS;
  const r = await db.query("SELECT perms FROM staff WHERE discord_id=$1", [uid]);
  return r.rows[0]?.perms || [];
}

/* ===== DISCORD GİRİŞİ ===== */
app.get("/api/auth/discord", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("nato_state", state, { ...cookieOpts, maxAge: 10 * 60 * 1000 });
  const url = new URL("https://discord.com/oauth2/authorize");
  url.search = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: "identify email guilds",
    state
  });
  res.redirect(url.toString());
});

app.get("/api/auth/discord/callback", wrap(async (req, res) => {
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
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT
      })
    });
    const token = await tokenRes.json();
    if (!token.access_token) throw new Error("Token alınamadı");
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

app.post("/api/logout", (req, res) => {
  res.clearCookie("nato_session", cookieOpts);
  res.json({ ok: true });
});

/* ===== KULLANICI ===== */
app.get("/api/me", auth, wrap(async (req, res) => {
  const { rows } = await db.query("SELECT * FROM users WHERE id=$1", [req.uid]);
  const u = rows[0];
  if (!u) return bad(res, "Hesap bulunamadı.", 401);
  res.json({
    id: u.id,
    username: u.username,
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
    mcEdition: u.mc_edition,
    mcName: u.mc_name,
    isOwner: u.id === OWNER_ID,
    perms: await getPerms(u.id)
  });
}));

app.post("/api/minecraft", auth, wrap(async (req, res) => {
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

/* ===== YÖNETİM PANELİ (sadece sahip) ===== */
function ownerOnly(req, res, next) {
  if (req.uid !== OWNER_ID) return bad(res, "Bu bölüm sadece sahibe açık.", 403);
  next();
}

app.get("/api/admin/staff", auth, ownerOnly, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT s.discord_id, s.perms, u.username FROM staff s
     LEFT JOIN users u ON u.id = s.discord_id ORDER BY s.created_at`);
  res.json(rows.map(r => ({ id: r.discord_id, perms: r.perms, username: r.username })));
}));

app.post("/api/admin/staff", auth, ownerOnly, wrap(async (req, res) => {
  const id = String(req.body.discordId || "").trim();
  const perms = (Array.isArray(req.body.perms) ? req.body.perms : []).filter(p => ALL_PERMS.includes(p));
  if (!/^\d{17,20}$/.test(id)) return bad(res, "Geçerli bir Discord ID yaz (17-20 haneli sayı).");
  if (id === OWNER_ID) return bad(res, "Sahibin yetkisi zaten tam.");
  if (!perms.length) return bad(res, "En az bir yetki seç.");
  await db.query(
    `INSERT INTO staff (discord_id, added_by, perms) VALUES ($1,$2,$3)
     ON CONFLICT (discord_id) DO UPDATE SET perms=$3`, [id, req.uid, perms]);
  res.json({ ok: true });
}));

app.delete("/api/admin/staff/:id", auth, ownerOnly, wrap(async (req, res) => {
  await db.query("DELETE FROM staff WHERE discord_id=$1", [req.params.id]);
  res.json({ ok: true });
}));

/* ===== DESTEK TALEPLERİ ===== */
async function loadTicketAccess(req, res) {
  const { rows } = await db.query("SELECT * FROM tickets WHERE id=$1", [Number(req.params.id) || 0]);
  const t = rows[0];
  if (!t) { bad(res, "Talep bulunamadı.", 404); return null; }
  const perms = await getPerms(req.uid);
  const canStaff = perms.includes(t.category);
  if (t.owner_id !== req.uid && !canStaff) { bad(res, "Talep bulunamadı.", 404); return null; }
  return { t, canStaff };
}

app.get("/api/tickets", auth, wrap(async (req, res) => {
  const cats = (await getPerms(req.uid)).filter(p => CATS[p]);
  const { rows } = await db.query(
    `SELECT t.id, t.category, t.subject, t.status, t.owner_id, t.created_at,
            u.username, u.mc_name, c.username AS claimed_name
     FROM tickets t JOIN users u ON u.id = t.owner_id
     LEFT JOIN users c ON c.id = t.claimed_by
     WHERE t.owner_id = $1 OR t.category = ANY($2)
     ORDER BY t.id DESC LIMIT 100`, [req.uid, cats]);
  res.json(rows.map(r => ({
    id: r.id, category: r.category, categoryName: CATS[r.category], subject: r.subject,
    status: r.status, owner: r.username, mcName: r.mc_name, claimedBy: r.claimed_name, createdAt: r.created_at
  })));
}));

app.post("/api/tickets", auth, wrap(async (req, res) => {
  const category = req.body.category;
  const subject = String(req.body.subject || "").trim();
  const body = String(req.body.body || "").trim();
  if (!CATS[category]) return bad(res, "Geçersiz kategori.");
  if (subject.length < 3 || subject.length > 80) return bad(res, "Konu 3-80 karakter olmalı.");
  if (!body || body.length > 2000) return bad(res, "Açıklama 1-2000 karakter olmalı.");
  const u = (await db.query("SELECT username, mc_name FROM users WHERE id=$1", [req.uid])).rows[0];
  if (!u?.mc_name) return bad(res, "Önce Minecraft adını kaydetmelisin.");
  const open = await db.query("SELECT count(*)::int AS n FROM tickets WHERE owner_id=$1 AND status<>'closed'", [req.uid]);
  if (open.rows[0].n >= 3) return bad(res, "En fazla 3 açık talebin olabilir.");
  const t = (await db.query(
    "INSERT INTO tickets (category, subject, owner_id) VALUES ($1,$2,$3) RETURNING id", [category, subject, req.uid])).rows[0];
  await db.query(
    "INSERT INTO ticket_messages (ticket_id, author_id, author_name, is_staff, body) VALUES ($1,$2,$3,false,$4)",
    [t.id, req.uid, u.username, body]);
  res.json({ id: t.id });
}));

app.get("/api/tickets/:id", auth, wrap(async (req, res) => {
  const a = await loadTicketAccess(req, res); if (!a) return;
  const msgs = (await db.query(
    "SELECT author_name, is_staff, body, created_at FROM ticket_messages WHERE ticket_id=$1 ORDER BY id", [a.t.id])).rows;
  const out = {
    ticket: { id: a.t.id, category: a.t.category, categoryName: CATS[a.t.category], subject: a.t.subject, status: a.t.status, claimedBy: null },
    messages: msgs.map(m => ({ author: m.author_name, isStaff: m.is_staff, body: m.body, at: m.created_at })),
    canStaff: a.canStaff
  };
  if (a.t.claimed_by) {
    out.ticket.claimedBy = (await db.query("SELECT username FROM users WHERE id=$1", [a.t.claimed_by])).rows[0]?.username || null;
  }
  const o = (await db.query("SELECT id, username, mc_name, mc_edition, guilds FROM users WHERE id=$1", [a.t.owner_id])).rows[0];
  out.ticket.owner = o.username;
  if (a.canStaff) {
    out.ownerInfo = { id: o.id, username: o.username, mcName: o.mc_name, mcEdition: o.mc_edition, guilds: o.guilds };
  }
  res.json(out);
}));

app.post("/api/tickets/:id/messages", auth, wrap(async (req, res) => {
  const a = await loadTicketAccess(req, res); if (!a) return;
  const body = String(req.body.body || "").trim();
  if (!body || body.length > 2000) return bad(res, "Mesaj 1-2000 karakter olmalı.");
  if (a.t.status === "closed") return bad(res, "Talep kapalı.", 403);
  if (a.t.status === "locked" && !a.canStaff) return bad(res, "Talep kilitli.", 403);
  const u = (await db.query("SELECT username FROM users WHERE id=$1", [req.uid])).rows[0];
  await db.query(
    "INSERT INTO ticket_messages (ticket_id, author_id, author_name, is_staff, body) VALUES ($1,$2,$3,$4,$5)",
    [a.t.id, req.uid, u.username, a.canStaff && a.t.owner_id !== req.uid, body]);
  res.json({ ok: true });
}));

app.post("/api/tickets/:id/action", auth, wrap(async (req, res) => {
  const a = await loadTicketAccess(req, res); if (!a) return;
  if (!a.canStaff) return bad(res, "Bu işlem için yetkin yok.", 403);
  const q = {
    claim: ["UPDATE tickets SET claimed_by=$2 WHERE id=$1", [a.t.id, req.uid]],
    unclaim: ["UPDATE tickets SET claimed_by=NULL WHERE id=$1", [a.t.id]],
    lock: ["UPDATE tickets SET status='locked' WHERE id=$1", [a.t.id]],
    unlock: ["UPDATE tickets SET status='open' WHERE id=$1", [a.t.id]],
    close: ["UPDATE tickets SET status='closed' WHERE id=$1", [a.t.id]],
    reopen: ["UPDATE tickets SET status='open' WHERE id=$1", [a.t.id]]
  }[req.body.action];
  if (!q) return bad(res, "Geçersiz işlem.");
  await db.query(q[0], q[1]);
  res.json({ ok: true });
}));

/* ===== GRUPLAR ===== */
app.get("/api/groups", auth, wrap(async (req, res) => {
  const { rows } = await db.query("SELECT group_key, status FROM group_requests WHERE user_id=$1", [req.uid]);
  const mine = Object.fromEntries(rows.map(r => [r.group_key, r.status]));
  res.json(GROUPS.map(g => ({ ...g, status: mine[g.key] || null })));
}));

app.post("/api/groups/:key/request", auth, wrap(async (req, res) => {
  if (!GROUPS.some(g => g.key === req.params.key)) return bad(res, "Böyle bir grup yok.", 404);
  const u = (await db.query("SELECT mc_name FROM users WHERE id=$1", [req.uid])).rows[0];
  if (!u?.mc_name) return bad(res, "Önce Minecraft adını kaydetmelisin.");
  await db.query(
    `INSERT INTO group_requests (user_id, group_key) VALUES ($1,$2)
     ON CONFLICT (user_id, group_key) DO UPDATE SET status='pending'
     WHERE group_requests.status='rejected'`, [req.uid, req.params.key]);
  res.json({ ok: true });
}));

app.get("/api/groups/pending", auth, wrap(async (req, res) => {
  if (!(await getPerms(req.uid)).includes("gruplar")) return bad(res, "Yetkin yok.", 403);
  const { rows } = await db.query(
    `SELECT r.id, r.group_key, u.username, u.mc_name FROM group_requests r
     JOIN users u ON u.id = r.user_id WHERE r.status='pending' ORDER BY r.id`);
  res.json(rows.map(r => ({
    id: r.id, username: r.username, mcName: r.mc_name,
    group: GROUPS.find(g => g.key === r.group_key)?.label || r.group_key
  })));
}));

app.post("/api/groups/requests/:id", auth, wrap(async (req, res) => {
  if (!(await getPerms(req.uid)).includes("gruplar")) return bad(res, "Yetkin yok.", 403);
  const d = req.body.decision;
  if (!["approved", "rejected"].includes(d)) return bad(res, "Geçersiz karar.");
  await db.query("UPDATE group_requests SET status=$1, decided_by=$2 WHERE id=$3 AND status='pending'",
    [d, req.uid, Number(req.params.id) || 0]);
  res.json({ ok: true });
}));

/* ===== SON ===== */
app.use("/api", (req, res) => bad(res, "Bulunamadı.", 404));
app.use((e, req, res, next) => {
  console.error(e);
  res.status(500).json({ error: "Sunucu hatası. Tekrar dene." });
});

export default app;
