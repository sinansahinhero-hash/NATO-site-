import { Router } from "express";
import { db, auth, ownerOnly, wrap, bad, CATS, ALL_PERMS, getPerms, OWNER_ID } from "./core.js";

export const router = Router();

/* ===== YETKİLİLER (sadece sahip) ===== */
router.get("/admin/staff", auth, ownerOnly, wrap(async (req, res) => {
  const { rows } = await db.query(
    `SELECT s.discord_id, s.perms, u.username FROM staff s
     LEFT JOIN users u ON u.id = s.discord_id ORDER BY s.created_at`);
  res.json(rows.map(r => ({ id: r.discord_id, perms: r.perms, username: r.username })));
}));

router.post("/admin/staff", auth, ownerOnly, wrap(async (req, res) => {
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

router.delete("/admin/staff/:id", auth, ownerOnly, wrap(async (req, res) => {
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

router.get("/tickets", auth, wrap(async (req, res) => {
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

router.post("/tickets", auth, wrap(async (req, res) => {
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

router.get("/tickets/:id", auth, wrap(async (req, res) => {
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

router.post("/tickets/:id/messages", auth, wrap(async (req, res) => {
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

router.post("/tickets/:id/action", auth, wrap(async (req, res) => {
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
