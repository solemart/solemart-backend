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
    // Skip Edit entirely if the_edit table doesn't exist yet (migration not run)
    let edit;
    try {
      const theEdit = require('../services/theEdit');
      edit = await theEdit.getCurrentEdit();
    } catch (e) {
      console.warn('theEdit unavailable, returning empty:', e.message);
      return res.json({ shoes: [], week_start: null, next_refresh: null });
    }

    if (!edit.shoe_ids || !edit.shoe_ids.length) {
      return res.json({ shoes: [], week_start: edit.week_start, next_refresh: edit.next_refresh });
    }

    // Select only columns guaranteed to exist on the shoes table
    let rows = [];
    try {
      const result = await db.query(`
        SELECT s.id, s.brand, s.model, s.size, s.colour, s.category, s.gender,
               s.condition, s.assessed_wear_grade,
               s.rrp, s.rent_price, s.buy_price, s.listing_type,
               s.emoji, s.status, s.listed_at
        FROM shoes s
        WHERE s.id = ANY($1::uuid[])
          AND s.status = 'listed'
      `, [edit.shoe_ids]);
      rows = result.rows;
    } catch (e) {
      console.warn('Edit shoes query failed, returning empty:', e.message);
      return res.json({ shoes: [], week_start: edit.week_start, next_refresh: edit.next_refresh });
    }

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
  } catch (err) {
    console.error('GET /api/shoes/edit error:', err);
    res.json({ shoes: [], week_start: null, next_refresh: null });
  }
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
      conditions.push(`(s.listing_type = $${params.length} OR s.listing_type = 'both')`);
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
      newest:       'MAX(s.listed_at) DESC',
      oldest:       'MIN(s.listed_at) ASC',
      'price-asc':  'MIN(COALESCE(s.rent_price, s.buy_price)) ASC',
      'price-desc': 'MIN(COALESCE(s.rent_price, s.buy_price)) DESC',
      'rrp-asc':    'MIN(s.rrp) ASC',
      'rrp-desc':   'MAX(s.rrp) DESC',
      brand:        'MIN(s.brand) ASC, MIN(s.model) ASC',
      stock:        'COUNT(*) DESC',
    };
    const orderBy = sortMap[sort] || sortMap.newest;
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // GROUPED listing — one row per (brand, model, size, colour, wear_grade) combo
    // Returns stock count + the oldest pair as the representative shoe
    let rows;
    try {
      const result = await db.query(
        `WITH grouped AS (
           SELECT
             LOWER(s.brand)                       AS group_brand_key,
             LOWER(s.model)                       AS group_model_key,
             LOWER(COALESCE(s.size, ''))          AS group_size_key,
             LOWER(COALESCE(s.colour, ''))        AS group_colour_key,
             LOWER(COALESCE(s.assessed_wear_grade, '')) AS group_wear_key,
             MIN(s.brand)                          AS brand,
             MIN(s.model)                          AS model,
             MIN(s.size)                           AS size,
             MIN(s.colour)                         AS colour,
             MIN(s.category)                       AS category,
             MIN(s.gender)                         AS gender,
             MIN(s.condition)                      AS condition,
             MIN(s.assessed_wear_grade)            AS assessed_wear_grade,
             MIN(s.emoji)                          AS emoji,
             MIN(s.description)                    AS description,
             MIN(s.listing_type)                   AS listing_type,
             MIN(s.rrp)                            AS rrp,
             MIN(s.rent_price)                     AS rent_price,
             MIN(s.buy_price)                      AS buy_price,
             COUNT(*)                              AS stock_count,
             MIN(s.listed_at)                      AS first_listed_at,
             MAX(s.listed_at)                      AS last_listed_at,
             (array_agg(s.id ORDER BY s.listed_at ASC NULLS LAST))[1] AS representative_id
           FROM shoes s
           ${whereClause}
           GROUP BY group_brand_key, group_model_key, group_size_key, group_colour_key, group_wear_key
         )
         SELECT g.*,
                ROUND(AVG(r.stars), 1) AS avg_rating,
                COUNT(r.id)            AS review_count,
                (SELECT url FROM shoe_photos p WHERE p.shoe_id = g.representative_id ORDER BY p.is_cover DESC, p.sort_order LIMIT 1) AS primary_photo
         FROM grouped g
         LEFT JOIN reviews r ON r.shoe_id = g.representative_id
         GROUP BY g.group_brand_key, g.group_model_key, g.group_size_key, g.group_colour_key, g.group_wear_key,
                  g.brand, g.model, g.size, g.colour, g.category, g.gender, g.condition, g.assessed_wear_grade,
                  g.emoji, g.description, g.listing_type, g.rrp, g.rent_price, g.buy_price,
                  g.stock_count, g.first_listed_at, g.last_listed_at, g.representative_id
         ORDER BY ${orderBy}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, parseInt(limit), offset]
      );
      rows = result.rows;
    } catch (groupErr) {
      // Fallback to flat list (no variant grouping) if the grouped query fails
      // e.g. when assessed_wear_grade or other columns don't exist yet
      console.warn('Grouped browse query failed, falling back to flat list:', groupErr.message);
      const flatSort = {
        newest:       's.listed_at DESC NULLS LAST',
        oldest:       's.listed_at ASC NULLS LAST',
        'price-asc':  'COALESCE(s.rent_price, s.buy_price) ASC',
        'price-desc': 'COALESCE(s.rent_price, s.buy_price) DESC',
        'rrp-asc':    's.rrp ASC NULLS LAST',
        'rrp-desc':   's.rrp DESC NULLS LAST',
        brand:        's.brand ASC, s.model ASC',
      }[sort] || 's.listed_at DESC NULLS LAST';

      const flat = await db.query(
        `SELECT s.id AS representative_id, s.brand, s.model, s.size, s.colour, s.category,
                s.gender, s.condition, s.emoji, s.description, s.listing_type,
                s.rrp, s.rent_price, s.buy_price, s.listed_at AS first_listed_at,
                1 AS stock_count, NULL::numeric AS avg_rating, 0 AS review_count,
                NULL::text AS assessed_wear_grade,
                (SELECT url FROM shoe_photos p WHERE p.shoe_id = s.id ORDER BY p.is_cover DESC, p.sort_order LIMIT 1) AS primary_photo
         FROM shoes s ${whereClause}
         ORDER BY ${flatSort}
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, parseInt(limit), offset]
      );
      rows = flat.rows;
    }

    // Map each row → return representative_id as "id" so existing frontend code (modal, cart) still works
    const shoes = rows.map(r => ({
      id:                  r.representative_id,
      brand:               r.brand,
      model:               r.model,
      size:                r.size,
      colour:              r.colour,
      category:            r.category,
      gender:              r.gender,
      condition:           r.condition,
      assessed_wear_grade: r.assessed_wear_grade,
      emoji:               r.emoji,
      description:         r.description,
      listing_type:        r.listing_type,
      rrp:                 r.rrp,
      rent_price:          r.rent_price,
      buy_price:           r.buy_price,
      listed_at:           r.first_listed_at,
      stock_count:         parseInt(r.stock_count),
      avg_rating:          r.avg_rating ? parseFloat(r.avg_rating) : null,
      review_count:        parseInt(r.review_count || 0),
      primary_photo:       r.primary_photo,
    }));

    // Total distinct variant groups (with fallback)
    let totalCount = 0;
    try {
      const countRes = await db.query(
        `SELECT COUNT(*) FROM (
           SELECT 1 FROM shoes s ${whereClause}
           GROUP BY LOWER(s.brand), LOWER(s.model), LOWER(COALESCE(s.size,'')),
                    LOWER(COALESCE(s.colour,'')), LOWER(COALESCE(s.assessed_wear_grade,''))
         ) g`,
        params
      );
      totalCount = parseInt(countRes.rows[0].count);
    } catch (e) {
      // Fallback to flat count
      try {
        const flat = await db.query(`SELECT COUNT(*) FROM shoes s ${whereClause}`, params);
        totalCount = parseInt(flat.rows[0].count);
      } catch (e2) {
        totalCount = rows.length;
      }
    }

    res.json({
      shoes,
      pagination: {
        total: totalCount,
        page:  parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(totalCount / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error('GET /api/shoes error:', err);
    res.status(500).json({ error: err.message || 'Could not load shoes' });
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
    const shoe = rows[0];

    // Compute stock count for this variant group (defensive — column may not exist)
    try {
      const { rows: stockRows } = await db.query(
        `SELECT COUNT(*)::int AS stock_count FROM shoes
         WHERE status = 'listed'
           AND LOWER(brand) = LOWER($1)
           AND LOWER(model) = LOWER($2)
           AND LOWER(COALESCE(size,'')) = LOWER(COALESCE($3,''))
           AND LOWER(COALESCE(colour,'')) = LOWER(COALESCE($4,''))
           AND LOWER(COALESCE(assessed_wear_grade,'')) = LOWER(COALESCE($5,''))`,
        [shoe.brand, shoe.model, shoe.size, shoe.colour, shoe.assessed_wear_grade]
      );
      shoe.stock_count = stockRows[0].stock_count;
    } catch (e) {
      shoe.stock_count = 1;
    }
    rows[0] = shoe;

    // Fire-and-forget view count increment (for "popular" curation)
    db.query(
      `UPDATE shoes SET view_count = COALESCE(view_count, 0) + 1, last_viewed_at = NOW() WHERE id = $1`,
      [req.params.id]
    ).catch(() => {});

    // Fetch photos
    const photos = await db.query(
      'SELECT id, url, caption, sort_order, is_cover FROM shoe_photos WHERE shoe_id = $1 ORDER BY is_cover DESC, sort_order',
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
