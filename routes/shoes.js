const express = require('express');
const { body, query, param, validationResult } = require('express-validator');
const db      = require('../config/db');
const { authenticate, requireRole, optionalAuth } = require('../middleware/auth');
const { logActivity } = require('../services/activityLog');
const router  = express.Router();

// ── GET /api/shoes/edit ──────────────────────────────────────
// Returns the current week's Edit (auto-curates if missing)
router.get('/edit', async (req, res, next) => {
  try {
    const theEdit = require('../services/theEdit');
    const edit = await theEdit.getCurrentEdit();
    if (!edit.shoe_ids || !edit.shoe_ids.length) {
      return res.json({ shoes: [], week_start: edit.week_start, next_refresh: edit.next_refresh });
    }

    const { rows } = await db.query(`
      SELECT s.id, s.brand, s.model, s.size, s.colour, s.category, s.gender,
             s.condition, s.assessed_wear_grade, s.auth_grade,
             s.rrp, s.rent_price, s.buy_price, s.listing_type,
             s.emoji, s.shoe_code, s.status,
             s.listed_at
      FROM shoes s
      WHERE s.id = ANY($1::uuid[])
        AND s.status = 'listed'
    `, [edit.shoe_ids]);

    // Preserve curated order + add category tag (best/newest/popular)
    const byId = {};
    rows.forEach(r => { byId[r.id] = r; });
    const ordered = [];
    if (edit.breakdown) {
      ['best','newest','popular'].forEach(cat => {
        (edit.breakdown[cat] || []).forEach(id => {
          if (byId[id]) ordered.push({ ...byId[id], edit_category: cat });
        });
      });
    } else {
      edit.shoe_ids.forEach(id => { if (byId[id]) ordered.push(byId[id]); });
    }

    res.json({
      shoes: ordered,
      week_start: edit.week_start,
      next_refresh: edit.next_refresh,
      published_at: edit.published_at,
    });
  } catch (err) { next(err); }
});

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
      limit = 100,
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
      newest:        's.listed_at DESC',
      oldest:        's.listed_at ASC',
      'price-asc':   'COALESCE(s.rent_price, s.buy_price) ASC',
      'price-desc':  'COALESCE(s.rent_price, s.buy_price) DESC',
      'rrp-asc':     's.rrp ASC',
      'rrp-desc':    's.rrp DESC',
      auth:          's.auth_score DESC NULLS LAST',
      brand:         's.brand ASC, s.model ASC',
    };
    const orderBy = sortMap[sort] || sortMap.newest;

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Fetch shoes with owner info and average rating
    const { rows } = await db.query(
      `SELECT
         s.id, s.brand, s.model, s.size, s.colour, s.category, s.gender,
         s.description, s.emoji, s.listing_type, s.rent_price, s.buy_price,
         s.rrp, s.condition, s.auth_grade, s.auth_score,
         s.rental_count, s.clean_count, s.listing_count, s.listed_at,
         s.assessed_wear_grade, s.is_pre_loved, s.donation_id,
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

    // Fire-and-forget view count increment (for "popular" curation)
    db.query(
      `UPDATE shoes SET view_count = COALESCE(view_count, 0) + 1, last_viewed_at = NOW() WHERE id = $1`,
      [req.params.id]
    ).catch(() => {});

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

// POST /api/shoes/:id/request-back — owner requests their shoe back
router.post('/:id/request-back', authenticate, async (req, res, next) => {
  try {
    const { reason } = req.body;
    const { rows: [shoe] } = await db.query(
      `SELECT * FROM shoes WHERE id = $1`,
      [req.params.id]
    );
    if (!shoe) return res.status(404).json({ error: 'Shoe not found' });
    if (shoe.owner_id !== req.user.id) return res.status(403).json({ error: 'Not your shoe' });
    if (!['listed','authenticating','cleaning'].includes(shoe.status)) {
      return res.status(409).json({ error: `Cannot request back — shoe is currently ${shoe.status.replace(/_/g, ' ')}` });
    }

    // Move to return_requested status
    await db.query(
      `UPDATE shoes SET status = 'return_requested', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    // Log activity
    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, 'owner_requested_back', 'shoe', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ reason: reason || '', shoe: `${shoe.brand} ${shoe.model}` })]
    );

    res.json({ ok: true, message: 'Return request submitted — admin will arrange collection.' });
  } catch (err) { next(err); }
});

// GET /api/shoes/:id/timeline — owner-visible submission lifecycle
router.get('/:id/timeline', authenticate, async (req, res, next) => {
  try {
    const { rows: [shoe] } = await db.query(`SELECT owner_id FROM shoes WHERE id = $1`, [req.params.id]);
    if (!shoe) return res.status(404).json({ error: 'Shoe not found' });
    // Only owner or admin can view
    if (shoe.owner_id !== req.user.id && !['admin','staff'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorised' });
    }
    const events = require('../services/submissionEvents');
    const timeline = await events.getTimeline(req.params.id);
    // Filter out admin-internal notes for owners
    const filtered = req.user.role === 'admin' || req.user.role === 'staff'
      ? timeline
      : timeline.filter(e => e.event_type !== 'internal_note' &&
                              !(e.meta && e.meta.visible_to_owner === false));
    res.json(filtered);
  } catch (err) { next(err); }
});

module.exports = router;
