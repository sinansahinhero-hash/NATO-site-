import jwt from "jsonwebtoken";
import pg from "pg";

const clean = v => String(v ?? "").trim().replace(/^["']|["']$/g, "");

export const CLIENT_ID = "1538105408911187999";
export const REDIRECT = "https://natox-mauve.vercel.app/api/auth/discord/callback";
export const DISCORD_CLIENT_SECRET = clean(process.env.DISCORD_CLIENT_SECRET);
export const DATABASE_URL = clean(process.env.DATABASE_URL);
export const SESSION_SECRET = clean(process.env.SESSION_SECRET);
export const OWNER_ID = clean(process.env.OWNER_ID);

for (const [k, v] of Object.entries({ DISCORD_CLIENT_SECRET, DATABASE_URL, SESSION_SECRET, OWNER_ID })) {
  if (!v) throw new Error("Eksik ortam değişkeni: " + k);
}

export const db = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });

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
  CREATE TABLE IF NOT EXISTS servers (
    guild_id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS org_groups (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    branch TEXT NOT NULL,
    sort INT NOT NULL DEFAULT 100
  );
  CREATE TABLE IF NOT EXISTS group_roles (
    id SERIAL PRIMARY KEY,
    group_key TEXT NOT NULL REFERENCES org_groups(key) ON DELETE CASCADE,
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    UNIQUE (group_key, guild_id, role_id)
  );
  CREATE TABLE IF NOT EXISTS ranks (
    id SERIAL PRIMARY KEY,
    group_key TEXT NOT NULL REFERENCES org_groups(key) ON DELETE CASCADE,
    name TEXT NOT NULL,
    sort INT NOT NULL DEFAULT 100,
    UNIQUE (group_key, name)
  );
  CREATE TABLE IF NOT EXISTS rank_roles (
    id SERIAL PRIMARY KEY,
    rank_id INT NOT NULL REFERENCES ranks(id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    UNIQUE (rank_id, guild_id, role_id)
  );
  CREATE TABLE IF NOT EXISTS user_ranks (
    user_id TEXT NOT NULL REFERENCES users(id),
    rank_id INT NOT NULL REFERENCES ranks(id) ON DELETE CASCADE,
    guilds TEXT[] NOT NULL DEFAULT '{}',
    given_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (user_id, rank_id)
  );
  CREATE TABLE IF NOT EXISTS rank_perms (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    group_key TEXT NOT NULL REFERENCES org_groups(key) ON DELETE CASCADE,
    rank_id INT REFERENCES ranks(id) ON DELETE CASCADE,
    can_delegate BOOLEAN NOT NULL DEFAULT false,
    granted_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  );
`);

/* ===== İLK KURULUM: mevcut 14 grup ve ana sunucu rolleri ===== */
const SEED = [
  ["kara", "Kara Kuvvetleri", "Kara Kuvvetleri", "1434904371245748297"],
  ["boru", "Kara Kuvvetleri", "BÖRÜ", "1440426272537841664"],
  ["kho", "Kara Kuvvetleri", "Komando Harp Okulu", "1440425587276779611"],
  ["muhabere", "Kara Kuvvetleri", "Muhabere Arama Kurtarma", "1570885776886079578"],
  ["sinir", "Sınır Müfettişleri", "Sınır Müfettişleri", "1434904514506260623"],
  ["denetim", "Sınır Müfettişleri", "Denetim Birimi", "1570886354185887834"],
  ["gardiyan", "Sınır Müfettişleri", "Gardiyan Muhafızlar", "1496922483113066536"],
  ["ozel", "Özel Kuvvetler", "Özel Kuvvetler", "1434904099698249768"],
  ["okb", "Özel Kuvvetler", "Özel Koruma Birliği", "1496921364924203159"],
  ["sat", "Özel Kuvvetler", "Su Altı Taarruz", "1496921210506707097"],
  ["omega", "Özel Kuvvetler", "OMEGA", "1570887178983309464"],
  ["inzibat", "Askerî İnzibat", "Askerî İnzibat", "1434904969290584195"],
  ["yildirim", "Askerî İnzibat", "Yıldırım Orduları", "1440429449727180901"],
  ["kizil", "Askerî İnzibat", "Kızıl Sağ El", "1568917863979421807"]
];
const seeded = (await db.query("SELECT count(*)::int AS n FROM org_groups")).rows[0].n;
if (seeded === 0) {
  const MAIN = "1422629910211592296";
  await db.query("INSERT INTO servers (guild_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [MAIN, "NATO Ana Sunucu"]);
  let i = 0;
  for (const [key, branch, label, role] of SEED) {
    await db.query("INSERT INTO org_groups (key, label, branch, sort) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [key, label, branch, ++i * 10]);
    await db.query("INSERT INTO group_roles (group_key, guild_id, role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [key, MAIN, role]);
  }
}

/* ===== ORTAK YARDIMCILAR ===== */
export const CATS = { ban: "Ban Affı", destek: "Discord Destek", askeri: "Askerî Şikayet", ulusal: "Ulusal Şikayet" };
export const ALL_PERMS = [...Object.keys(CATS), "gruplar"];
export const cookieOpts = { httpOnly: true, secure: true, sameSite: "lax", path: "/" };
export const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
export const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });
export const isId = v => /^\d{17,20}$/.test(String(v || ""));

export function auth(req, res, next) {
  try {
    req.uid = jwt.verify(req.cookies.nato_session, SESSION_SECRET).uid;
    next();
  } catch {
    res.status(401).json({ error: "Giriş yapmalısın." });
  }
}

export function ownerOnly(req, res, next) {
  if (req.uid !== OWNER_ID) return bad(res, "Bu bölüm sadece sahibe açık.", 403);
  next();
}

export async function getPerms(uid) {
  if (uid === OWNER_ID) return ALL_PERMS;
  const r = await db.query("SELECT perms FROM staff WHERE discord_id=$1", [uid]);
  return r.rows[0]?.perms || [];
}

// Bir kişinin bir gruptaki rütbe yetkileri
export async function rankScope(uid, groupKey) {
  if (uid === OWNER_ID) return { any: true, all: true, ranks: new Set(), delAll: true, del: new Set() };
  const { rows } = await db.query("SELECT rank_id, can_delegate FROM rank_perms WHERE user_id=$1 AND group_key=$2", [uid, groupKey]);
  const s = { any: rows.length > 0, all: false, ranks: new Set(), delAll: false, del: new Set() };
  for (const r of rows) {
    if (r.rank_id === null) {
      s.all = true;
      if (r.can_delegate) s.delAll = true;
    } else {
      s.ranks.add(r.rank_id);
      if (r.can_delegate) s.del.add(r.rank_id);
    }
  }
  return s;
}
export const canGive = (s, rankId) => s.all || s.ranks.has(Number(rankId));
export const canDel = (s, rankId) => s.delAll || s.del.has(Number(rankId));

export async function canManageGroup(uid, groupKey) {
  if (uid === OWNER_ID) return true;
  if ((await getPerms(uid)).includes("gruplar")) return true;
  return (await rankScope(uid, groupKey)).any;
}

// Discord ID, Minecraft adı ya da Discord adından kullanıcı ID'si bulur
export async function resolveTarget(raw, requireUser = true) {
  const t = String(raw || "").trim();
  if (!t) return null;
  if (isId(t)) {
    if (!requireUser) return t;
    const r = await db.query("SELECT id FROM users WHERE id=$1", [t]);
    return r.rows[0]?.id || null;
  }
  const r = await db.query("SELECT id FROM users WHERE lower(mc_name)=lower($1) OR lower(username)=lower($1) LIMIT 1", [t]);
  return r.rows[0]?.id || null;
}
