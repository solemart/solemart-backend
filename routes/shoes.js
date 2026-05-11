const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const db      = require('../config/db');
const { authenticate, requireRole, optionalAuth } = require('../middleware/auth');
const { logActivity } = require('../services/activityLog');
const router  = express.Router();

// ── GET /api/shoes  (public browse) ──────────────────────────
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const {
      q,            // search query
      type,         // rent | buy | both
      condition,    // Brand New | Like New | etc.
      size,
      sort = 'newest',
      page = 1,
      limit = 20,
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = [`s.status = 'listed'`];

    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(s.brand ILIKE $${params.length} OR s.model ILIKE $${params.length} OR s.colour ILIKE $${params.length})`);
    }
    if (type && type !== 'all') {
      params.push(type);
      conditions.push(`s.listing_type = $${params.length} OR s.listing_type = 'both'`);
    }
    if (condition) {
      params.push(condition);
      conditions.push(`s.condition = $${params.length}`);
    }
    if (size) {
      params.push(size);
      conditions.push(`s.size = $${params.length}`);
    }

    const sortMap = {
      newest:     's.listed_at DESC',
      'price-asc': 'COALESCE(s.rent_price, s.buy_price) ASC',
      'price-desc':'COALESCE(s.rent_price, s.buy_price) DESC',
      auth:       's.auth_score DESC NULLS LAST',
    };
    const orderBy = sortMap[sort] || sortMap.newest;

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Fetch shoes with owner info and average rating
    const { rows } = await db.query(
      `SELECT
         s.id, s.brand, s.model, s.size, s.colour, s.category, s.gender,
         s.description, s.emoji, s.listing_type, s.rent_price, s.buy_price,
         s.condition, s.auth_grade, s.auth_score,
         s.rental_count, s.clean_count, s.listing_count, s.listed_at,
         u.first_name || ' ' || LEFT(u.last_name, 1) || '.' AS owner_display,
         ROUND(AVG(r.stars), 1) AS avg_rating,
         COUNT(r.id)            AS review_count,
         (SELECT url FROM shoe_photos p WHERE p.shoe_id = s.id ORDER BY p.sort_order LIMIT 1) AS primary_photo
       FROM shoes s
       JOIN users u ON u.id = s.owner_id
       LEFT JOIN reviews r ON r.shoe_id = s.id
       ${whereClause}
       GROUP BY s.id, u.first_name, u.last_name
       ORDER BY ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), offset]
    );

    // Total count for pagination
    const countRes = await db.query(
      `SELECT COUNT(*) FROM shoes s ${whereClause}`,
      params
    );

    res.json({
      shoes: rows,
      pagination: {
        total: parseInt(countRes.rows[0].count),
        page:  parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(parseInt(countRes.rows[0].count) / parseInt(limit)),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/shoes/:id  (public single shoe) ──────────────────
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
         s.*,
         u.first_name || ' ' || LEFT(u.last_name, 1) || '.' AS owner_display,
         ROUND(AVG(r.stars), 1) AS avg_rating,
         COUNT(r.id)            AS review_count
       FROM shoes s
       JOIN users u ON u.id = s.owner_id
       LEFT JOIN reviews r ON r.shoe_id = s.id
       WHERE s.id = $1 AND s.status = 'listed'
       GROUP BY s.id, u.first_name, u.last_name`,
      [req.params.id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Shoe not found' });

    // Fetch photos
    const photos = await db.query(
      'SELECT id, url, caption, sort_order FROM shoe_photos WHERE shoe_id = $1 ORDER BY sort_order',
      [req.params.id]
    );

    // Fetch reviews
    const reviews = await db.query(
      `SELECT r.stars, r.body, r.created_at,
              u.first_name || ' ' || LEFT(u.last_name, 1) || '.' AS reviewer
       FROM reviews r
       JOIN users u ON u.id = r.customer_id
       WHERE r.shoe_id = $1
       ORDER BY r.created_at DESC
       LIMIT 10`,
      [req.params.id]
    );

    res.json({ ...rows[0], photos: photos.rows, reviews: reviews.rows });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/shoes/mine  (owner's own listings) ───────────────
router.get('/owner/mine', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*,
              ROUND(AVG(r.stars), 1) AS avg_rating,
              COUNT(r.id)            AS review_count
       FROM shoes s
       LEFT JOIN reviews r ON r.shoe_id = s.id
       WHERE s.owner_id = $1
       GROUP BY s.id
       ORDER BY s.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── PATCH /api/shoes/:id  (owner updates listing details) ─────
router.patch('/:id', authenticate, [
  body('rent_price').optional().isFloat({ min: 0 }),
  body('buy_price').optional().isFloat({ min: 0 }),
  body('description').optional().trim(),
  body('listing_type').optional().isIn(['rent','buy','both']),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    // Confirm shoe belongs to this user (or user is admin/staff)
    const { rows: shoeRows } = await db.query('SELECT owner_id FROM shoes WHERE id = $1', [req.params.id]);
    if (!shoeRows.length) return res.status(404).json({ error: 'Shoe not found' });
    if (shoeRows[0].owner_id !== req.user.id && !['admin','staff'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not your listing' });
    }

    const allowed = ['rent_price', 'buy_price', 'description', 'listing_type'];
    const updates = [];
    const values  = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        values.push(req.body[key]);
        updates.push(`${key} = $${values.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    values.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE shoes SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length} RETURNING *`,
      values
    );

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/shoes/:id/delist  (owner requests delist) ─────
router.post('/:id/delist', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query('SELECT owner_id, status FROM shoes WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Shoe not found' });
    if (rows[0].owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not your listing' });
    }
    if (rows[0].status === 'rented') {
      return res.status(409).json({ error: 'Cannot delist a shoe that is currently rented' });
    }

    await db.query(
      `UPDATE shoes SET status = 'returned_to_owner', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    await logActivity(req.user.id, 'shoe.delisted', 'shoe', req.params.id);
    res.json({ message: 'Shoe delisted — we will arrange return to you' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
