const express = require('express');
const { body, validationResult } = require('express-validator');
const db      = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logActivity } = require('../services/activityLog');
const router  = express.Router();

const PLATFORMS = ['ebay','vinted','depop'];
const PLATFORM_NAMES = { ebay:'eBay', vinted:'Vinted', depop:'Depop' };

// ── POST /api/channels/opt-in  (owner opts their shoe into platforms) ──
router.post('/opt-in', authenticate, [
  body('shoe_id').isUUID(),
  body('platforms').isArray({ min: 1 }),
  body('platforms.*').isIn(PLATFORMS),
  body('prices').isObject(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { shoe_id, platforms, prices } = req.body;

    // Verify shoe belongs to this owner
    const { rows: shoeRows } = await db.query(
      'SELECT owner_id, brand, model, status FROM shoes WHERE id = $1',
      [shoe_id]
    );
    if (!shoeRows.length) return res.status(404).json({ error: 'Shoe not found' });
    if (shoeRows[0].owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Not your shoe' });
    }

    const created = [];
    for (const platform of platforms) {
      const price = prices[platform] ? parseFloat(prices[platform]) : null;
      const { rows } = await db.query(
        `INSERT INTO channel_listings
           (shoe_id, platform, status, platform_price)
         VALUES ($1, $2, 'pending', $3)
         ON CONFLICT (shoe_id, platform) DO UPDATE
           SET status = 'pending', platform_price = $3, updated_at = NOW()
         RETURNING *`,
        [shoe_id, platform, price]
      );
      created.push(rows[0]);
    }

    await logActivity(req.user.id, 'channel.opted_in', 'shoe', shoe_id, {
      platforms, shoe: `${shoeRows[0].brand} ${shoeRows[0].model}`,
    });

    res.status(201).json({ channel_listings: created });
  } catch (err) { next(err); }
});

// ── GET /api/channels/shoe/:shoeId  (get channel status for a shoe) ──
router.get('/shoe/:shoeId', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT cl.*, s.owner_id FROM channel_listings cl
       JOIN shoes s ON s.id = cl.shoe_id
       WHERE cl.shoe_id = $1`,
      [req.params.shoeId]
    );
    // Allow owner or staff
    if (rows.length && rows[0].owner_id !== req.user.id && !['staff','admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorised' });
    }
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/channels/pending  (admin — all pending channel listings) ──
router.get('/pending', authenticate, requireRole('staff','admin'), async (req, res, next) => {
  try {
    const { platform } = req.query;
    let where = `cl.status = 'pending'`;
    const params = [];
    if (platform) { params.push(platform); where += ` AND cl.platform = $${params.length}`; }

    const { rows } = await db.query(
      `SELECT cl.*, s.brand, s.model, s.emoji, s.size, s.condition,
              s.auth_grade, s.buy_price, s.rent_price,
              u.first_name, u.last_name, u.email
       FROM channel_listings cl
       JOIN shoes s ON s.id = cl.shoe_id
       JOIN users u ON u.id = s.owner_id
       WHERE ${where}
       ORDER BY cl.opted_in_at ASC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/channels/all  (admin — all channel listings with filters) ──
router.get('/all', authenticate, requireRole('staff','admin'), async (req, res, next) => {
  try {
    const { platform, status } = req.query;
    const conditions = [];
    const params = [];
    if (platform) { params.push(platform); conditions.push(`cl.platform = $${params.length}`); }
    if (status)   { params.push(status);   conditions.push(`cl.status = $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await db.query(
      `SELECT cl.*, s.brand, s.model, s.emoji, s.size, s.condition,
              s.auth_grade, s.buy_price, s.rent_price, s.status AS shoe_status,
              u.first_name, u.last_name
       FROM channel_listings cl
       JOIN shoes s ON s.id = cl.shoe_id
       JOIN users u ON u.id = s.owner_id
       ${where}
       ORDER BY cl.opted_in_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── PATCH /api/channels/:id  (admin — update listing status) ──
router.patch('/:id', authenticate, requireRole('staff','admin'), [
  body('status').isIn(['listed','sold','delisted','failed']),
  body('platform_listing_url').optional().trim(),
  body('platform_listing_id').optional().trim(),
  body('platform_price').optional().isFloat({ min: 0 }),
  body('notes').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { status, platform_listing_url, platform_listing_id, platform_price, notes } = req.body;

    const updates = [`status = $1`, `updated_at = NOW()`];
    const values = [status];

    if (platform_listing_url !== undefined) { values.push(platform_listing_url); updates.push(`platform_listing_url = $${values.length}`); }
    if (platform_listing_id !== undefined)  { values.push(platform_listing_id);  updates.push(`platform_listing_id = $${values.length}`); }
    if (platform_price !== undefined)       { values.push(platform_price);        updates.push(`platform_price = $${values.length}`); }
    if (notes !== undefined)                { values.push(notes);                 updates.push(`notes = $${values.length}`); }

    // Set timestamp fields based on status
    if (status === 'listed') updates.push('listed_at = NOW()');
    if (status === 'sold')   updates.push('sold_at = NOW()');

    values.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE channel_listings SET ${updates.join(', ')}
       WHERE id = $${values.length} RETURNING *`,
      values
    );

    if (!rows.length) return res.status(404).json({ error: 'Listing not found' });

    // If sold on external platform, mark shoe as sold
    if (status === 'sold') {
      await db.query(
        `UPDATE shoes SET status = 'sold', updated_at = NOW() WHERE id = $1`,
        [rows[0].shoe_id]
      );
    }

    await logActivity(req.user.id, `channel.${status}`, 'channel_listing', rows[0].id, {
      platform: rows[0].platform, platform_listing_url,
    });

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── DELETE /api/channels/:id/opt-out  (owner opts out) ──
router.delete('/:id/opt-out', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT cl.*, s.owner_id FROM channel_listings cl
       JOIN shoes s ON s.id = cl.shoe_id
       WHERE cl.id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].owner_id !== req.user.id && !['staff','admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Not authorised' });
    }
    if (rows[0].status === 'listed') {
      return res.status(409).json({ error: 'Cannot opt out while listing is live — contact us to delist first' });
    }
    await db.query('DELETE FROM channel_listings WHERE id = $1', [req.params.id]);
    res.json({ message: 'Opted out successfully' });
  } catch (err) { next(err); }
});

module.exports = router;
