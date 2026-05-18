// ============================================================
//  wishlist.js
// ============================================================
const express = require('express');
const db      = require('../config/db');
const { authenticate } = require('../middleware/auth');
const router  = express.Router();

// GET /api/wishlist — get user's saved shoes
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*, w.created_at AS saved_at
       FROM wishlists w
       JOIN shoes s ON s.id = w.shoe_id
       WHERE w.user_id = $1
       ORDER BY w.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/wishlist/ids — just the shoe IDs (for sync)
router.get('/ids', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT shoe_id FROM wishlists WHERE user_id = $1`,
      [req.user.id]
    );
    res.json(rows.map(r => r.shoe_id));
  } catch (err) { next(err); }
});

// POST /api/wishlist/:shoeId — add to wishlist
router.post('/:shoeId', authenticate, async (req, res, next) => {
  try {
    await db.query(
      `INSERT INTO wishlists (user_id, shoe_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.id, req.params.shoeId]
    );
    res.json({ saved: true });
  } catch (err) { next(err); }
});

// DELETE /api/wishlist/:shoeId — remove from wishlist
router.delete('/:shoeId', authenticate, async (req, res, next) => {
  try {
    await db.query(
      `DELETE FROM wishlists WHERE user_id = $1 AND shoe_id = $2`,
      [req.user.id, req.params.shoeId]
    );
    res.json({ saved: false });
  } catch (err) { next(err); }
});

// POST /api/wishlist/sync — bulk sync from local storage
router.post('/sync', authenticate, async (req, res, next) => {
  try {
    const { shoeIds } = req.body;
    if (!Array.isArray(shoeIds) || !shoeIds.length) return res.json({ synced: 0 });
    for (const id of shoeIds) {
      await db.query(
        `INSERT INTO wishlists (user_id, shoe_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [req.user.id, id]
      ).catch(() => {}); // ignore invalid shoe IDs
    }
    const { rows } = await db.query(`SELECT shoe_id FROM wishlists WHERE user_id = $1`, [req.user.id]);
    res.json({ synced: shoeIds.length, ids: rows.map(r => r.shoe_id) });
  } catch (err) { next(err); }
});

module.exports = router;
