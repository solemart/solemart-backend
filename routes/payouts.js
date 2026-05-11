// ============================================================
//  payouts.js
// ============================================================
const express = require('express');
const db      = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const router  = express.Router();

// GET /api/payouts  — owner sees their own payout history
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*, o.reference AS order_ref, s.brand, s.model
       FROM payouts p
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN shoes s ON s.id = o.shoe_id
       WHERE p.owner_id = $1
       ORDER BY p.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/payouts/summary  — totals for owner dashboard
router.get('/summary', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
         SUM(amount) FILTER (WHERE status = 'paid')    AS total_paid,
         SUM(amount) FILTER (WHERE status = 'pending') AS total_pending,
         COUNT(*)                                       AS total_payouts
       FROM payouts WHERE owner_id = $1`,
      [req.user.id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
