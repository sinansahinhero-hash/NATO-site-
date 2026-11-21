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
