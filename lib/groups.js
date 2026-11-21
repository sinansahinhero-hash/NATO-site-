import { Router } from "express";
import { db, auth, ownerOnly, wrap, bad, isId, OWNER_ID, getPerms, rankScope, canGive, canDel, canManageGroup, resolveTarget } from "./core.js";
import { addLog } from "./logs.js";

export const router = Router();
const ints = v => (Array.isArray(v) ? v : []).map(Number).filter(Number.isInteger);
const num = v => Number(v) || 0;
const slug = s => String(s).replace(/İ/g, "i").toLowerCase()
  .replace(/ç/g, "c").replace(/ğ/g, "g").replace(/ı/g, "i").replace(/ö/g, "o").replace(/ş/g, "s").replace(/ü/g, "u")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "grup";

/* ===== GRUPLAR VE İSTEKLER ===== */
router.get("/groups", auth, wrap(async (req, res) => {
  const g = (await db.query("SELECT key, label, branch FROM org_groups ORDER BY sort, label")).rows;
  const mine = (await db.query("SELECT group_key, status FROM group_requests WHERE user_id=$1", [req.uid])).rows;
  const m = Object.fromEntries(mine.map(r => [r.group_key, r.status]));
  res.json(g.map(x => ({ ...x, status: m[x.key] || null })));
}));

router.post("/groups/:key/request", auth, wrap(async (req, res) => {
  const g = await db.query("SELECT 1 FROM org_groups WHERE key=$1", [req.params.key]);
  if (!g.rowCount) return bad(res, "Böyle bir grup yok.", 404);
  const u = (await db.query("SELECT mc_name FROM users WHERE id=$1", [req.uid])).rows[0];
  if (!u?.mc_name) return bad(res, "Önce Minecraft adını kaydetmelisin.");
  const r = await db.query(
    `INSERT INTO group_requests (user_id, group_key) VALUES ($1,$2)
     ON CONFLICT (user_id, group_key) DO UPDATE SET status='pending'
     WHERE group_requests.status='rejected' RETURNING id`, [req.uid, req.params.key]);
  if (r.rowCount) await addLog("request", req.uid, req.uid, req.params.key, null);
  res.json({ ok: true });
}));

router.get("/groups/pending", auth, wrap(async (req, res) => {
  const perms = await getPerms(req.uid);
  let keys = null;
  if (!(req.uid === OWNER_ID || perms.includes("gruplar"))) {
    const r = await db.query("SELECT DISTINCT group_key FROM rank_perms WHERE user_id=$1", [req.uid]);
    keys = r.rows.map(x => x.group_key);
    if (!keys.length) return res.json([]);
  }
  const { rows } = await db.query(
    `SELECT r.id, g.label, u.username, u.mc_name FROM group_requests r
     JOIN users u ON u.id = r.user_id JOIN org_groups g ON g.key = r.group_key
     WHERE r.status='pending' AND ($1::text[] IS NULL OR r.group_key = ANY($1::text[]))
     ORDER BY r.id`, [keys]);
  res.json(rows.map(r => ({ id: r.id, username: r.username, mcName: r.mc_name, group: r.label })));
}));

router.post("/groups/requests/:id", auth, wrap(async (req, res) => {
  const r = (await db.query("SELECT group_key, user_id FROM group_requests WHERE id=$1 AND status='pending'", [num(req.params.id)])).rows[0];
  if (!r) return bad(res, "İstek bulunamadı.", 404);
  if (!(await canManageGroup(req.uid, r.group_key))) return bad(res, "Yetkin yok.", 403);
  const d = req.body.decision;
  if (!["approved", "rejected"].includes(d)) return bad(res, "Geçersiz karar.");
  await db.query("UPDATE group_requests SET status=$1, decided_by=$2 WHERE id=$3", [d, req.uid, num(req.params.id)]);
  await addLog(d === "approved" ? "approve" : "reject", req.uid, r.user_id, r.group_key, null);
  res.json({ ok: true });
}));

router.post("/groups/:key/kick", auth, wrap(async (req, res) => {
  const key = req.params.key;
  if (!(await canManageGroup(req.uid, key))) return bad(res, "Yetkin yok.", 403);
  const target = await resolveTarget(req.body.userId, true);
  if (!target) return bad(res, "Kullanıcı bulunamadı.", 404);
  await db.query("DELETE FROM group_requests WHERE user_id=$1 AND group_key=$2", [target, key]);
  await db.query("DELETE FROM user_ranks WHERE user_id=$1 AND rank_id IN (SELECT id FROM ranks WHERE group_key=$2)", [target, key]);
  await addLog("kick", req.uid, target, key, null);
  res.json({ ok: true });
}));

/* ===== PROFİLLER ===== */
async function buildProfile(viewer, userId) {
  const u = (await db.query("SELECT id, username, avatar, mc_name, mc_edition FROM users WHERE id=$1", [userId])).rows[0];
  if (!u) return null;
  const mem = (await db.query(
    `SELECT q.group_key AS key, g.label, g.branch FROM group_requests q
     JOIN org_groups g ON g.key = q.group_key
     WHERE q.user_id=$1 AND q.status='approved' ORDER BY g.sort`, [userId])).rows;
  const rk = (await db.query(
    `SELECT ur.rank_id, ur.guilds, r.name, r.group_key FROM user_ranks ur
     JOIN ranks r ON r.id = ur.rank_id WHERE ur.user_id=$1 ORDER BY r.sort, r.name`, [userId])).rows;
  const srv = Object.fromEntries((await db.query("SELECT guild_id, name FROM servers")).rows.map(s => [s.guild_id, s.name]));
  const perms = await getPerms(viewer);
  const staffAll = viewer === OWNER_ID || perms.includes("gruplar");
  const groups = [];
  for (const g of mem) {
    const scope = await rankScope(viewer, g.key);
    groups.push({
      key: g.key, label: g.label, branch: g.branch,
      canKick: staffAll || scope.any,
      ranks: rk.filter(r => r.group_key === g.key).map(r => ({
        id: r.rank_id, name: r.name,
        guilds: (r.guilds || []).map(id => srv[id] || id),
        canTake: canGive(scope, r.rank_id)
      }))
    });
  }
  return {
    id: u.id, username: u.username,
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null,
    mcName: u.mc_name, mcEdition: u.mc_edition, groups
  };
}

router.get("/profiles", auth, wrap(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json([]);
  const like = "%" + q.replace(/[%_\\]/g, "") + "%";
  const { rows } = await db.query(
    `SELECT id, username, avatar, mc_name FROM users
     WHERE mc_name IS NOT NULL AND (mc_name ILIKE $1 OR username ILIKE $1 OR id=$2)
     ORDER BY mc_name LIMIT 20`, [like, q]);
  res.json(rows.map(u => ({
    id: u.id, username: u.username, mcName: u.mc_name,
    avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png` : null
  })));
}));

router.get("/profiles/:id", auth, wrap(async (req, res) => {
  const id = req.params.id === "me" ? req.uid : String(req.params.id);
  const p = await buildProfile(req.uid, id);
  if (!p) return bad(res, "Profil bulunamadı.", 404);
  res.json(p);
}));

/* ===== RÜTBE YÖNETİMİ ===== */
router.get("/manage/overview", auth, wrap(async (req, res) => {
  const groups = (await db.query("SELECT key, label, branch FROM org_groups ORDER BY sort, label")).rows;
  const servers = (await db.query('SELECT guild_id AS "guildId", name FROM servers ORDER BY name')).rows;
  const out = [];
  for (const g of groups) {
    const s = await rankScope(req.uid, g.key);
    if (!s.any) continue;
    const ranks = (await db.query("SELECT id, name FROM ranks WHERE group_key=$1 ORDER BY sort, name", [g.key])).rows;
    out.push({
      ...g,
      delegateAny: s.delAll || s.del.size > 0,
      ranks: ranks.filter(r => canGive(s, r.id)).map(r => ({ id: r.id, name: r.name, canDelegate: canDel(s, r.id) }))
    });
  }
  res.json({ groups: out, servers });
}));

async function checkRanks(res, req, groupKey, rankIds) {
  if (!rankIds.length) { bad(res, "En az bir rütbe seç."); return false; }
  const ok = (await db.query("SELECT id FROM ranks WHERE group_key=$1 AND id = ANY($2::int[])", [groupKey, rankIds])).rowCount;
  if (ok !== rankIds.length) { bad(res, "Geçersiz rütbe."); return false; }
  const scope = await rankScope(req.uid, groupKey);
  if (!rankIds.every(id => canGive(scope, id))) { bad(res, "Bu rütbe için yetkin yok.", 403); return false; }
  return true;
}

router.post("/manage/rank/give", auth, wrap(async (req, res) => {
  const groupKey = String(req.body.groupKey || "");
  const rankIds = ints(req.body.rankIds);
  const guildIds = (Array.isArray(req.body.guildIds) ? req.body.guildIds : []).map(String);
  if (!(await checkRanks(res, req, groupKey, rankIds))) return;
  const target = await resolveTarget(req.body.target, true);
  if (!target) return bad(res, "Kullanıcı bulunamadı. Kişi siteye en az bir kez giriş yapmış olmalı.", 404);
  let where = "";
  if (guildIds.length) {
    const sr = (await db.query("SELECT name FROM servers WHERE guild_id = ANY($1::text[])", [guildIds])).rows;
    if (sr.length !== guildIds.length) return bad(res, "Geçersiz sunucu.");
    where = " · " + sr.map(s => s.name).join(", ");
  }
  await db.query(
    `INSERT INTO group_requests (user_id, group_key, status, decided_by) VALUES ($1,$2,'approved',$3)
     ON CONFLICT (user_id, group_key) DO UPDATE SET status='approved', decided_by=$3`, [target, groupKey, req.uid]);
  for (const id of rankIds) {
    await db.query(
      `INSERT INTO user_ranks (user_id, rank_id, guilds, given_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, rank_id) DO UPDATE SET guilds=$3, given_by=$4`, [target, id, guildIds, req.uid]);
  }
  const names = (await db.query("SELECT name FROM ranks WHERE id = ANY($1::int[]) ORDER BY sort", [rankIds])).rows.map(r => r.name);
  await addLog("rank_give", req.uid, target, groupKey, names.join(", ") + where);
  res.json({ ok: true });
}));

router.post("/manage/rank/take", auth, wrap(async (req, res) => {
  const groupKey = String(req.body.groupKey || "");
  const rankIds = ints(req.body.rankIds);
  if (!(await checkRanks(res, req, groupKey, rankIds))) return;
  const target = await resolveTarget(req.body.target, true);
  if (!target) return bad(res, "Kullanıcı bulunamadı.", 404);
  await db.query("DELETE FROM user_ranks WHERE user_id=$1 AND rank_id = ANY($2::int[])", [target, rankIds]);
  const names = (await db.query("SELECT name FROM ranks WHERE id = ANY($1::int[]) ORDER BY sort", [rankIds])).rows.map(r => r.name);
  await addLog("rank_take", req.uid, target, groupKey, names.join(", "));
  res.json({ ok: true });
}));

/* ===== RÜTBE YETKİLERİ (kim kime ne verebilir) ===== */
router.get("/manage/perms", auth, wrap(async (req, res) => {
  const key = String(req.query.group || "");
  const owner = req.uid === OWNER_ID;
  const { rows } = await db.query(
    `SELECT p.id, p.user_id, p.can_delegate, r.name AS rank_name, u.username, u.mc_name
     FROM rank_perms p LEFT JOIN ranks r ON r.id = p.rank_id LEFT JOIN users u ON u.id = p.user_id
     WHERE p.group_key=$1 AND ($2::boolean OR p.granted_by=$3) ORDER BY p.id`, [key, owner, req.uid]);
  res.json(rows.map(r => ({
    id: r.id, userId: r.user_id, canDelegate: r.can_delegate,
    rankName: r.rank_name, username: r.username, mcName: r.mc_name
  })));
}));

router.post("/manage/perms", auth, wrap(async (req, res) => {
  const key = String(req.body.groupKey || "");
  const owner = req.uid === OWNER_ID;
  const g = await db.query("SELECT 1 FROM org_groups WHERE key=$1", [key]);
  if (!g.rowCount) return bad(res, "Böyle bir grup yok.", 404);
  const target = await resolveTarget(req.body.target, false);
  if (!target) return bad(res, "Geçerli bir Discord ID ya da kayıtlı bir isim yaz.");
  if (target === OWNER_ID) return bad(res, "Sahibin yetkisi zaten tam.");
  const rankIds = ints(req.body.rankIds);
  const canDelegate = owner && !!req.body.canDelegate;
  if (rankIds.length) {
    const ok = (await db.query("SELECT id FROM ranks WHERE group_key=$1 AND id = ANY($2::int[])", [key, rankIds])).rowCount;
    if (ok !== rankIds.length) return bad(res, "Geçersiz rütbe.");
  }
  if (!owner) {
    const scope = await rankScope(req.uid, key);
    if (!rankIds.length) {
      if (!scope.delAll) return bad(res, "Tüm rütbeler için yetki verme hakkın yok.", 403);
    } else if (!rankIds.every(id => canDel(scope, id))) {
      return bad(res, "Seçtiğin rütbelerden bazıları için yetki verme hakkın yok.", 403);
    }
  }
  for (const rid of (rankIds.length ? rankIds : [null])) {
    await db.query("DELETE FROM rank_perms WHERE user_id=$1 AND group_key=$2 AND COALESCE(rank_id,0)=COALESCE($3::int,0)", [target, key, rid]);
    await db.query("INSERT INTO rank_perms (user_id, group_key, rank_id, can_delegate, granted_by) VALUES ($1,$2,$3,$4,$5)", [target, key, rid, canDelegate, req.uid]);
  }
  res.json({ ok: true });
}));

router.delete("/manage/perms/:id", auth, wrap(async (req, res) => {
  const row = (await db.query("SELECT granted_by FROM rank_perms WHERE id=$1", [num(req.params.id)])).rows[0];
  if (!row) return bad(res, "Kayıt bulunamadı.", 404);
  if (req.uid !== OWNER_ID && row.granted_by !== req.uid) return bad(res, "Bu yetkiyi sen vermedin.", 403);
  await db.query("DELETE FROM rank_perms WHERE id=$1", [num(req.params.id)]);
  res.json({ ok: true });
}));

/* ===== GRUP AYARLARI (sadece sahip) ===== */
router.get("/admin/config", auth, ownerOnly, wrap(async (req, res) => {
  const servers = (await db.query('SELECT guild_id AS "guildId", name FROM servers ORDER BY name')).rows;
  const groups = (await db.query("SELECT key, label, branch, sort FROM org_groups ORDER BY sort, label")).rows;
  const gr = (await db.query("SELECT id, group_key, guild_id, role_id FROM group_roles ORDER BY id")).rows;
  const ranks = (await db.query("SELECT id, group_key, name, sort FROM ranks ORDER BY sort, name")).rows;
  const rr = (await db.query("SELECT id, rank_id, guild_id, role_id FROM rank_roles ORDER BY id")).rows;
  const role = x => ({ id: x.id, guildId: x.guild_id, roleId: x.role_id });
  res.json({
    servers,
    groups: groups.map(g => ({
      ...g,
      roles: gr.filter(x => x.group_key === g.key).map(role),
      ranks: ranks.filter(r => r.group_key === g.key).map(r => ({
        id: r.id, name: r.name, sort: r.sort,
        roles: rr.filter(x => x.rank_id === r.id).map(role)
      }))
    }))
  });
}));

router.post("/admin/servers", auth, ownerOnly, wrap(async (req, res) => {
  const guildId = String(req.body.guildId || "").trim();
  const name = String(req.body.name || "").trim();
  if (!isId(guildId)) return bad(res, "Geçerli bir sunucu ID yaz (17-20 haneli sayı).");
  if (name.length < 2 || name.length > 60) return bad(res, "Sunucu adı 2-60 karakter olmalı.");
  await db.query("INSERT INTO servers (guild_id, name) VALUES ($1,$2) ON CONFLICT (guild_id) DO UPDATE SET name=$2", [guildId, name]);
  res.json({ ok: true });
}));

router.delete("/admin/servers/:id", auth, ownerOnly, wrap(async (req, res) => {
  await db.query("DELETE FROM group_roles WHERE guild_id=$1", [req.params.id]);
  await db.query("DELETE FROM rank_roles WHERE guild_id=$1", [req.params.id]);
  await db.query("DELETE FROM servers WHERE guild_id=$1", [req.params.id]);
  res.json({ ok: true });
}));

router.post("/admin/groups", auth, ownerOnly, wrap(async (req, res) => {
  let key = String(req.body.key || "").trim().toLowerCase();
  const label = String(req.body.label || "").trim();
  const branch = String(req.body.branch || "").trim();
  if (label.length < 2 || label.length > 60) return bad(res, "Grup adı 2-60 karakter olmalı.");
  if (branch.length < 2 || branch.length > 60) return bad(res, "Branş adı 2-60 karakter olmalı.");
  if (!key) {
    const base = slug(label);
    key = base;
    let n = 2;
    while ((await db.query("SELECT 1 FROM org_groups WHERE key=$1", [key])).rowCount) key = `${base}-${n++}`;
  } else if (!/^[a-z0-9_-]{2,30}$/.test(key)) {
    return bad(res, "Anahtar 2-30 karakter olmalı; küçük harf, rakam, - ve _ kullanılabilir.");
  }
  const mx = (await db.query("SELECT COALESCE(MAX(sort),0)::int AS m FROM org_groups")).rows[0].m;
  const sort = Number(req.body.sort) || mx + 10;
  await db.query(
    `INSERT INTO org_groups (key, label, branch, sort) VALUES ($1,$2,$3,$4)
     ON CONFLICT (key) DO UPDATE SET label=$2, branch=$3, sort=$4`, [key, label, branch, sort]);
  res.json({ ok: true });
}));

router.delete("/admin/groups/:key", auth, ownerOnly, wrap(async (req, res) => {
  await db.query("DELETE FROM group_requests WHERE group_key=$1", [req.params.key]);
  await db.query("DELETE FROM org_groups WHERE key=$1", [req.params.key]);
  res.json({ ok: true });
}));

router.post("/admin/group-roles", auth, ownerOnly, wrap(async (req, res) => {
  const { groupKey, guildId, roleId } = req.body;
  if (!isId(roleId)) return bad(res, "Geçerli bir rol ID yaz (17-20 haneli sayı).");
  if (!(await db.query("SELECT 1 FROM servers WHERE guild_id=$1", [guildId])).rowCount) return bad(res, "Önce sunucuyu ekle.");
  if (!(await db.query("SELECT 1 FROM org_groups WHERE key=$1", [groupKey])).rowCount) return bad(res, "Grup bulunamadı.", 404);
  await db.query("INSERT INTO group_roles (group_key, guild_id, role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [groupKey, guildId, String(roleId).trim()]);
  res.json({ ok: true });
}));

router.delete("/admin/group-roles/:id", auth, ownerOnly, wrap(async (req, res) => {
  await db.query("DELETE FROM group_roles WHERE id=$1", [num(req.params.id)]);
  res.json({ ok: true });
}));

router.post("/admin/ranks", auth, ownerOnly, wrap(async (req, res) => {
  const groupKey = String(req.body.groupKey || "");
  const name = String(req.body.name || "").trim();
  const guildId = String(req.body.guildId || "").trim();
  const roleId = String(req.body.roleId || "").trim();
  if (name.length < 2 || name.length > 60) return bad(res, "Rütbe adı 2-60 karakter olmalı.");
  if (!(await db.query("SELECT 1 FROM org_groups WHERE key=$1", [groupKey])).rowCount) return bad(res, "Grup bulunamadı.", 404);
  if (roleId) {
    if (!isId(roleId)) return bad(res, "Geçerli bir rol ID yaz (17-20 haneli sayı).");
    if (!(await db.query("SELECT 1 FROM servers WHERE guild_id=$1", [guildId])).rowCount) return bad(res, "Önce sunucuyu seç.");
  }
  const mx = (await db.query("SELECT COALESCE(MAX(sort),0)::int AS m FROM ranks WHERE group_key=$1", [groupKey])).rows[0].m;
  const sort = Number(req.body.sort) || mx + 10;
  const r = (await db.query(
    `INSERT INTO ranks (group_key, name, sort) VALUES ($1,$2,$3)
     ON CONFLICT (group_key, name) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [groupKey, name, sort])).rows[0];
  if (roleId) {
    await db.query("INSERT INTO rank_roles (rank_id, guild_id, role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [r.id, guildId, roleId]);
  }
  res.json({ ok: true });
}));

router.delete("/admin/ranks/:id", auth, ownerOnly, wrap(async (req, res) => {
  await db.query("DELETE FROM ranks WHERE id=$1", [num(req.params.id)]);
  res.json({ ok: true });
}));

router.post("/admin/rank-roles", auth, ownerOnly, wrap(async (req, res) => {
  const rankId = num(req.body.rankId);
  const { guildId, roleId } = req.body;
  if (!isId(roleId)) return bad(res, "Geçerli bir rol ID yaz (17-20 haneli sayı).");
  if (!(await db.query("SELECT 1 FROM servers WHERE guild_id=$1", [guildId])).rowCount) return bad(res, "Önce sunucuyu ekle.");
  if (!(await db.query("SELECT 1 FROM ranks WHERE id=$1", [rankId])).rowCount) return bad(res, "Rütbe bulunamadı.", 404);
  await db.query("INSERT INTO rank_roles (rank_id, guild_id, role_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [rankId, guildId, String(roleId).trim()]);
  res.json({ ok: true });
}));

router.delete("/admin/rank-roles/:id", auth, ownerOnly, wrap(async (req, res) => {
  await db.query("DELETE FROM rank_roles WHERE id=$1", [num(req.params.id)]);
  res.json({ ok: true });
}));
