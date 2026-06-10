// ============================================================
//  reviews.js
// ============================================================
const express = require('express');
const { body, validationResult } = require('express-validator');
const db      = require('../config/db');
const { authenticate } = require('../middleware/auth');
const router  = express.Router();

// POST /api/reviews — must be tied to an order the customer placed
router.post('/', authenticate, [
  body('stars').isInt({ min: 1, max: 5 }),
  body('body').trim().isLength({ min: 3 }).withMessage('Review must be at least 3 characters'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { order_id, stars, body: reviewBody } = req.body;

    // Reviews require a real order — you can only review what you rented or bought
    if (!order_id) {
      return res.status(400).json({ error: 'You can only review shoes you have rented or bought' });
    }

    const { rows: orderRows } = await db.query(
      `SELECT * FROM orders WHERE id = $1 AND customer_id = $2`,
      [order_id, req.user.id]
    );
    if (!orderRows.length) {
      return res.status(403).json({ error: 'You can only review your own orders' });
    }
    const resolvedShoeId = orderRows[0].shoe_id;

    const { rows } = await db.query(
      `INSERT INTO reviews (order_id, shoe_id, customer_id, stars, body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (order_id) DO UPDATE SET stars = $4, body = $5
       RETURNING *`,
      [order_id, resolvedShoeId, req.user.id, stars, reviewBody]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// GET /api/reviews/shoe/:shoeId
router.get('/shoe/:shoeId', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT r.stars, r.body, r.created_at,
              u.first_name || ' ' || LEFT(u.last_name, 1) || '.' AS reviewer
       FROM reviews r JOIN users u ON u.id = r.customer_id
       WHERE r.shoe_id = $1 ORDER BY r.created_at DESC`,
      [req.params.shoeId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
