const express = require('express');
const db      = require('../config/db');
const { authenticate } = require('../middleware/auth');
const router  = express.Router();

// ──────────────────────────────────────────────────────────────────────────────
// Self-seeding: a per-listing chat thread between Kosmos (staff) and the owner.
// shoe_id is stored as TEXT and matched with shoes.id::text so it works whether
// shoes.id is a uuid or not. Runs once on startup (idempotent).
// ──────────────────────────────────────────────────────────────────────────────
(async () => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS listing_messages (
        id            BIGSERIAL PRIMARY KEY,
        shoe_id       TEXT        NOT NULL,
        sender_id     TEXT,
        sender_role   TEXT        NOT NULL,            -- 'kosmos' or 'owner'
        body          TEXT        NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        read_by_owner BOOLEAN     NOT NULL DEFAULT false,
        read_by_staff BOOLEAN     NOT NULL DEFAULT false
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_listing_messages_shoe ON listing_messages(shoe_id);`);
    console.log('[messages] listing_messages table ready');
  } catch (e) {
    console.error('[messages] seed failed:', e.message);
  }
})();

const isStaff = (user) => ['admin', 'staff'].includes(user.role);

// Confirm the user may see this listing's thread (owner of the shoe, or staff)
async function accessCheck(shoeId, user) {
  const { rows: [shoe] } = await db.query(
    `SELECT owner_id FROM shoes WHERE id::text = $1`, [String(shoeId)]
  );
  if (!shoe) return { ok: false, code: 404 };
  if (!isStaff(user) && shoe.owner_id !== user.id) return { ok: false, code: 403 };
  return { ok: true, staff: isStaff(user) };
}

// ── GET /api/messages — list this user's threads (with unread counts) ─────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const staff = isStaff(req.user);
    const sql = `
      SELECT m.shoe_id,
             s.brand, s.model, s.size, s.emoji,
             (array_agg(m.body       ORDER BY m.created_at DESC))[1] AS last_body,
             (array_agg(m.sender_role ORDER BY m.created_at DESC))[1] AS last_role,
             MAX(m.created_at) AS last_at,
             COUNT(*) FILTER (
               WHERE ${staff ? 'm.read_by_staff' : 'm.read_by_owner'} = false
                 AND m.sender_role <> '${staff ? 'kosmos' : 'owner'}'
             )::int AS unread
      FROM listing_messages m
      JOIN shoes s ON s.id::text = m.shoe_id
      ${staff ? '' : 'WHERE s.owner_id = $1'}
      GROUP BY m.shoe_id, s.brand, s.model, s.size, s.emoji
      ORDER BY MAX(m.created_at) DESC`;
    const { rows } = staff
      ? await db.query(sql)
      : await db.query(sql, [req.user.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/messages/:shoeId — the thread, and mark it read for this viewer ──
router.get('/:shoeId', authenticate, async (req, res, next) => {
  try {
    const acc = await accessCheck(req.params.shoeId, req.user);
    if (!acc.ok) return res.status(acc.code).json({ error: acc.code === 404 ? 'Not found' : 'Not authorised' });

    const { rows } = await db.query(
      `SELECT id, sender_role, body, created_at
         FROM listing_messages
        WHERE shoe_id = $1
        ORDER BY created_at ASC`,
      [String(req.params.shoeId)]
    );

    // Mark the other side's messages as read for whoever is viewing
    if (acc.staff) {
      await db.query(
        `UPDATE listing_messages SET read_by_staff = true
          WHERE shoe_id = $1 AND sender_role <> 'kosmos' AND read_by_staff = false`,
        [String(req.params.shoeId)]
      );
    } else {
      await db.query(
        `UPDATE listing_messages SET read_by_owner = true
          WHERE shoe_id = $1 AND sender_role <> 'owner' AND read_by_owner = false`,
        [String(req.params.shoeId)]
      );
    }
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/messages/:shoeId — send a message into the thread ──────────────
router.post('/:shoeId', authenticate, async (req, res, next) => {
  try {
    const body = (req.body && req.body.body || '').toString().trim();
    if (!body) return res.status(400).json({ error: 'Message required' });
    if (body.length > 4000) return res.status(400).json({ error: 'Message too long' });

    const acc = await accessCheck(req.params.shoeId, req.user);
    if (!acc.ok) return res.status(acc.code).json({ error: acc.code === 404 ? 'Not found' : 'Not authorised' });

    const role = acc.staff ? 'kosmos' : 'owner';
    const { rows: [msg] } = await db.query(
      `INSERT INTO listing_messages (shoe_id, sender_id, sender_role, body, read_by_owner, read_by_staff)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, sender_role, body, created_at`,
      [String(req.params.shoeId), req.user.id, role, body, role === 'owner', role === 'kosmos']
    );
    res.json(msg);
  } catch (err) { next(err); }
});

module.exports = router;
