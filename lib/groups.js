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

Bot kodunun tamamı aşağıda. Yapıştırırken kod kutusunun kopyala simgesini kullan. NATO_botlari reposunda iki dosyayı da eski içeriklerini silerek değiştir.

1. package.json
json
{
  "name": "nato-botlari",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": { "start": "node index.js" },
  "engines": { "node": ">=18" },
  "dependencies": {
    "discord.js": "^14.16.3",
    "express": "^4.19.2",
    "pg": "^8.12.0"
  }
}
2. index.js
js
const express = require('express');
const { Pool } = require('pg');
const { Client, GatewayIntentBits, Events, MessageFlags, EmbedBuilder } = require('discord.js');

const VERSION = '20-11-A';

const clean = v => String(v || '').trim().replace(/^["']|["']$/g, '');
const DISCORD_BOT_TOKEN = clean(process.env.DISCORD_BOT_TOKEN);
const DATABASE_URL = clean(process.env.DATABASE_URL);
const PORT = process.env.PORT || 3000;

if (!DISCORD_BOT_TOKEN || !DATABASE_URL) {
  console.error('Eksik ortam değişkeni: DISCORD_BOT_TOKEN ve DATABASE_URL gerekli.');
  process.exit(1);
}

// Sunucuya yeni katılan, sitede kayıtlı kişiyi otomatik günceller.
const AUTO_SYNC_ON_JOIN = true;

const db = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 3 });

/* ===== WEB SUNUCU (barındırma açık kalsın diye) ===== */
const app = express();
app.get('/', (req, res) => res.send('NATO bot çalışıyor. Sürüm: ' + VERSION));
app.listen(PORT, () => console.log('[WEB] Port:', PORT, 'Sürüm', VERSION));

/* ===== BOT ===== */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
});

client.once(Events.ClientReady, async () => {
  console.log(`[BOT] Giriş yapıldı: ${client.user.tag}`);
  try {
    await client.application.commands.set([
      { name: 'update', description: 'Site hesabındaki grup ve rütbelere göre rollerini ve takma adını günceller.' }
    ]);
    console.log('[BOT] /update komutu kaydedildi.');
  } catch (e) {
    console.error('[BOT] Komut kaydedilemedi:', e.message);
  }
  // Eski sürümden kalan sunucuya özel komutları temizle (çift /update görünmesin)
  for (const g of client.guilds.cache.values()) {
    try { await g.commands.set([]); } catch {}
  }
});

/* ===== VERİ ===== */
async function loadConfig() {
  const servers = (await db.query('SELECT guild_id FROM servers')).rows.map(r => r.guild_id);
  const groupRoles = (await db.query('SELECT group_key, guild_id, role_id FROM group_roles')).rows;
  const rankRoles = (await db.query('SELECT rank_id, guild_id, role_id FROM rank_roles')).rows;
  return { servers, groupRoles, rankRoles };
}

async function loadUser(userId) {
  const u = (await db.query('SELECT mc_name FROM users WHERE id=$1', [userId])).rows[0];
  if (!u || !u.mc_name) return null;
  const groups = (await db.query(
    "SELECT group_key FROM group_requests WHERE user_id=$1 AND status='approved'", [userId]
  )).rows.map(r => r.group_key);
  const ranks = (await db.query('SELECT rank_id, guilds FROM user_ranks WHERE user_id=$1', [userId])).rows;
  const summary = (await db.query(
    `SELECT g.label, COALESCE(string_agg(r.name, ', ' ORDER BY r.sort), '') AS ranks
     FROM group_requests q
     JOIN org_groups g ON g.key = q.group_key
     LEFT JOIN user_ranks ur ON ur.user_id = q.user_id
     LEFT JOIN ranks r ON r.id = ur.rank_id AND r.group_key = q.group_key
     WHERE q.user_id=$1 AND q.status='approved'
     GROUP BY g.label, g.sort ORDER BY g.sort`, [userId]
  )).rows;
  return { mcName: u.mc_name, groups, ranks, summary };
}

// Bir sunucu için olması gereken roller (desired) ve botun yönettiği tüm roller (managed)
function planFor(cfg, user, guildId) {
  const managed = new Set();
  const desired = new Set();
  for (const r of cfg.groupRoles) {
    if (r.guild_id !== guildId) continue;
    managed.add(r.role_id);
    if (user.groups.includes(r.group_key)) desired.add(r.role_id);
  }
  for (const r of cfg.rankRoles) {
    if (r.guild_id !== guildId) continue;
    managed.add(r.role_id);
    const ur = user.ranks.find(x => x.rank_id === r.rank_id);
    if (ur && (!ur.guilds.length || ur.guilds.includes(guildId))) desired.add(r.role_id);
  }
  return { managed, desired };
}

async function syncMember(guild, member, user, cfg) {
  const { managed, desired } = planFor(cfg, user, guild.id);
  const out = { added: [], removed: [], notes: [], nick: null };

  const missing = [...desired].filter(id => !guild.roles.cache.has(id));
  if (missing.length) out.notes.push(`Sunucuda bulunamayan rol ID: ${missing.join(', ')}`);

  const toAdd = [...desired].filter(id => guild.roles.cache.has(id) && !member.roles.cache.has(id));
  const toRemove = [...managed].filter(id => !desired.has(id) && guild.roles.cache.has(id) && member.roles.cache.has(id));

  if (toAdd.length) {
    try { await member.roles.add(toAdd, 'NATO /update'); out.added = toAdd; }
    catch { out.notes.push('Roller verilemedi (botun rolü verilecek rollerin üstünde olmalı).'); }
  }
  if (toRemove.length) {
    try { await member.roles.remove(toRemove, 'NATO /update'); out.removed = toRemove; }
    catch { out.notes.push('Roller alınamadı (botun rolü bu rollerin üstünde olmalı).'); }
  }

  if (member.id === guild.ownerId) {
    out.notes.push('Sunucu sahibinin takma adı değiştirilemez.');
  } else if (member.nickname !== user.mcName) {
    try { await member.setNickname(user.mcName, 'NATO /update'); out.nick = user.mcName; }
    catch { out.notes.push('Takma ad değişmedi (botun rolü yeterince yüksek mi?).'); }
  }
  return out;
}

/* ===== /update ===== */
const lastUse = new Map();

client.on(Events.InteractionCreate, async (i) => {
  if (!i.isChatInputCommand() || i.commandName !== 'update') return;

  const now = Date.now();
  if (now - (lastUse.get(i.user.id) || 0) < 30000) {
    return i.reply({ content: 'Biraz bekle, bu komutu 30 saniyede bir kullanabilirsin.', flags: MessageFlags.Ephemeral });
  }
  lastUse.set(i.user.id, now);

  await i.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const user = await loadUser(i.user.id);
    if (!user) {
      return i.editReply('Sitede hesabın ya da Minecraft adın kayıtlı değil. Önce siteye Discord ile giriş yapıp Minecraft adını kaydet.');
    }
    const cfg = await loadConfig();

    const embed = new EmbedBuilder()
      .setColor(0xffb800)
      .setTitle('NATO · Güncelleme')
      .setDescription(`**${user.mcName}** hesabın güncellendi.`)
      .setThumbnail(i.user.displayAvatarURL())
      .setTimestamp()
      .setFooter({ text: 'NATO' });

    embed.addFields({
      name: 'Gruplar ve rütbeler',
      value: (user.summary.length
        ? user.summary.map(s => `• **${s.label}**${s.ranks ? ' — ' + s.ranks : ''}`).join('\n')
        : 'Henüz onaylı bir grubun yok. Sitedeki Gruplar bölümünden istek atabilirsin.').slice(0, 1000)
    });

    let touched = 0;
    for (const guildId of cfg.servers) {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) continue;
      let member;
      try { member = await guild.members.fetch(i.user.id); } catch { continue; }
      touched++;
      const r = await syncMember(guild, member, user, cfg);
      const lines = [];
      if (r.added.length) lines.push('✅ Verildi: ' + r.added.map(id => `<@&${id}>`).join(' '));
      if (r.removed.length) lines.push('➖ Alındı: ' + r.removed.map(id => `<@&${id}>`).join(' '));
      if (r.nick) lines.push(`✏️ Takma ad: ${r.nick}`);
      r.notes.forEach(n => lines.push('⚠️ ' + n));
      embed.addFields({ name: guild.name, value: (lines.join('\n') || 'Değişiklik yok, zaten güncel.').slice(0, 1000) });
    }

    if (!touched) return i.editReply('Bot ile ortak olduğun, NATO sistemine kayıtlı bir sunucu bulunamadı.');
    await i.editReply({ embeds: [embed] });
  } catch (e) {
    console.error('[UPDATE] Hata:', e);
    await i.editReply('Bir hata oluştu. Birkaç dakika sonra tekrar dene.');
  }
});

/* ===== YENİ KATILAN ===== */
client.on(Events.GuildMemberAdd, async (member) => {
  if (!AUTO_SYNC_ON_JOIN) return;
  try {
    const cfg = await loadConfig();
    if (!cfg.servers.includes(member.guild.id)) return;
    const user = await loadUser(member.id);
    if (user) await syncMember(member.guild, member, user, cfg);
  } catch (e) {
    console.error('[JOIN] Hata:', e.message);
  }
});

process.on('unhandledRejection', e => console.error('[HATA]', e));
client.on(Events.Error, e => console.error('[CLIENT HATA]', e));

client.login(DISCORD_BOT_TOKEN);

Yapıştırdıktan sonra dosyanın son satırının client.login(DISCORD_BOT_TOKEN); olduğunu kontrol et. Kod yaklaşık 190 satır.

Eklemen gereken değişkenler

Bunlar kodda değil, çalıştığı yerin (Render ya da Replit) gizli değişkenler bölümünde duracak:

İsim	Değer
DISCORD_BOT_TOKEN	Developer Portal'da NATO botunun uygulaması → Bot → Reset Token ile aldığın token
DATABASE_URL	Siteyle aynı Neon bağlantı yazısı

PORT değişkenini eklemene gerek yok, barındırma kendisi veriyor. Token'ı ve bağlantı yazısını bana yazma.

Discord ayarları

Developer Portal → NATO uygulaması → Bot sekmesi

Server Members Intent'i aç ve kaydet. Kapalıysa bot "disallowed intents" hatasıyla açılmaz.

Her NATO sunucusunda (ana sunucu, branş ve birim sunucuları)

Bot sunucuda olmalı. Davet linkinde bot ve applications.commands yetkileri bulunsun.
Botun rolünde Rolleri Yönet ve Takma Adları Yönet izinleri açık olsun.
Sunucu Ayarları → Roller bölümünde botun rolünü, vereceği tüm rollerin üstüne sürükle. Yoksa roller verilemez, bot bunu embed'de uyarı olarak yazar.
Siteden yapılacak ayar

Bot, hangi sunucuda hangi rolü vereceğini sitedeki panelden okur:

Siteye gir → Yönetim → Grup Ayarları.
Ana sunucu ve 14 grubun üye rolleri hazır gelir. Branş ve birim sunucuları için önce Sunucular kutusundan sunucuyu (ad + ID) ekle.
Her gruba rütbe ekle ve her rütbeye sunucu + rol ID bağla.

Bu ayarları yapmadan /update sadece üye rollerini ve takma adı işler.

Test
Konsolda ya da Logs'ta Sürüm 20-11-A, Giriş yapıldı ve /update komutu kaydedildi satırlarını gör.
Botun adresini tarayıcıda açınca Sürüm: 20-11-A yazmalı. Bu, yeni kodun çalıştığını kanıtlar.
Sitede bir gruba istek at, panelden onayla. Discord'da /update yaz. Sadece senin görebildiğin bir embed kartı gelmeli.
Bilmen gerekenler
Rol alma açık. Bot, panelde tanımlı rolleri yönetir: onaylı olmayanları /update'te geri alır. Panelde tanımlı olmayan rollere dokunmaz.
Gruptan atılan ya da rütbesi alınan kişinin rolleri, kendisi /update yazınca alınır.
Aynı token'ı aynı anda tek yerde çalıştır. Hem Render'da hem Replit'te açık olursa çift cevap gelir.
NATO Moderasyon botu ayrı bir token ve ayrı bir servistir. Bu kodu onun token'ıyla çalıştırma, o botun sunucu komutlarını siler.

Logs'ta hata çıkarsa kırmızı satırı yaz, token'ı yazma.

Şimdi bir takım hatalar var bunlar:

Site tarafı: Aslında hata sayılmaz sorun şu şu gurup rütbelerini falan ayarladığımız yer çok karmaşık rütbeleri eklerken sürekli kafam karışıyor onu biraz daha basit ve anlaşılır yaparmısın birde birşey unutmuşuz birtanede log diye bir bölüm yap orada hem gurup istek logları hemde rütbe verim logları olsun

Bot tarafı: bot da eksik ve hata var hata şu /update yazınca gizli mesaj atmamalı herkes görmeli sonra /update yazınca emped aynı rowifi gibi şöyle olacak 

Update 

İsim
@isim

Yeni rütbesi:

Eski rütbesi:

NATO rütbe sistemi.

Birde /verifly diye bir komut olacak onu yazınca yine aynı şekilde herkesin gördüğü bir emped atacak orada aynı rowifi gibi şu olacak 

@ismi Merhaba, ekibimizde rütbe alabilmeniz için Dıscord ve Minecraft hesabınızı dağrulamanız gerekmektedir.
[Buton olacak] içinde şu link olacak ve bizim siteye yönlendirecek https://natox-mauve.vercel.app/

Hepsini yaptım. Değişen 5 dosya var. lib/logs.js yeni, diğer dördü eski içeriğin yerine geçiyor. Kod kutusunun kopyala simgesini kullan.

Önce bilmen gerekenler

/verifly yazdığın komutu /verify yaptım (RoWifi'deki gibi). Adını değiştirmek istersen bot dosyasındaki COMMAND_VERIFY satırını düzenlemen yeter.
/update ve /verify artık herkesin göreceği mesaj atıyor. Doğrulanmamış biri /update yazarsa ona doğrudan doğrulama kartı gelir.
Rütbe ayarları 3 adıma bölündü. Sıra numarası ve anahtar gibi karıştıran alanlar kalktı.
Log kayıtları bundan sonraki işlemlerden başlar. Geçmiş işlemler kaydedilmemişti.
Dosya yükleme sırası
lib/logs.js (yeni): Repo ana sayfasındayken Add file → Create new file de, ad kutusuna lib/logs.js yaz. lib klasörünün içindeyken açtıysan sadece logs.js yaz, yoksa klasör yine iç içe geçer.
lib/groups.js, api/index.js, index.html: eski içeriği silip yenisini yapıştır.
Bot dosyası ayrı repoda (NATO_botlari). package.json değişmiyor.
1. lib/logs.js (yeni)
js
import { Router } from "express";
import { db, auth, wrap, bad, OWNER_ID, getPerms } from "./core.js";

export const router = Router();

await db.query(`
  CREATE TABLE IF NOT EXISTS logs (
    id SERIAL PRIMARY KEY,
    kind TEXT NOT NULL,
    actor_id TEXT,
    target_id TEXT,
    group_key TEXT,
    detail TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  );
`);

export async function addLog(kind, actorId, targetId, groupKey, detail) {
  try {
    await db.query(
      "INSERT INTO logs (kind, actor_id, target_id, group_key, detail) VALUES ($1,$2,$3,$4,$5)",
      [kind, actorId || null, targetId || null, groupKey || null, detail || null]
    );
  } catch (e) {
    console.error("Log yazılamadı:", e.message);
  }
}

router.get("/logs", auth, wrap(async (req, res) => {
  const perms = await getPerms(req.uid);
  const all = req.uid === OWNER_ID || perms.includes("gruplar");
  let keys = null;
  if (!all) {
    const r = await db.query("SELECT DISTINCT group_key FROM rank_perms WHERE user_id=$1", [req.uid]);
    keys = r.rows.map(x => x.group_key);
    if (!keys.length) return bad(res, "Logları görme yetkin yok.", 403);
  }
  const kind = String(req.query.kind || "all");
  const kinds = kind === "group" ? ["request", "approve", "reject", "kick"]
    : kind === "rank" ? ["rank_give", "rank_take"] : null;
  const { rows } = await db.query(
    `SELECT l.id, l.kind, l.detail, l.created_at, l.group_key,
            a.username AS actor_name, a.mc_name AS actor_mc,
            t.username AS target_name, t.mc_name AS target_mc,
            g.label AS group_label
     FROM logs l
     LEFT JOIN users a ON a.id = l.actor_id
     LEFT JOIN users t ON t.id = l.target_id
     LEFT JOIN org_groups g ON g.key = l.group_key
     WHERE ($1::text[] IS NULL OR l.group_key = ANY($1::text[]))
       AND ($2::text[] IS NULL OR l.kind = ANY($2::text[]))
     ORDER BY l.id DESC LIMIT 100`, [keys, kinds]);
  res.json(rows.map(r => ({
    id: r.id,
    kind: r.kind,
    detail: r.detail,
    at: r.created_at,
    group: r.group_label || r.group_key || "",
    actor: r.actor_mc ? `${r.actor_mc} (${r.actor_name})` : (r.actor_name || "Bilinmiyor"),
    target: r.target_mc ? `${r.target_mc} (${r.target_name})` : (r.target_name || "Bilinmiyor")
  })));
}));
2. lib/groups.js (eski içeriği silip bunu yapıştır)
js
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
      ranks: rk.filter(r => r.group_kerouter.delete("/admin/rank-roles/:id", auth, ownerOnly, wrap(async (req, res) => {
  await db.query("DELETE FROM rank_roles WHERE id=$1", [num(req.params.id)]);
  res.json({ ok: true });
}));
