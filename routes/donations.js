const express = require('express');
const { body, validationResult } = require('express-validator');
const db            = require('../config/db');
const { optionalAuth, authenticate, requireRole } = require('../middleware/auth');
const emailService  = require('../services/email');
const labelService  = require('../services/label');
const { logActivity } = require('../services/activityLog');
const router        = express.Router();

const genRef = () => {
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `DON-${rand}-${Date.now().toString().slice(-4)}`;
};

// ── POST /api/donations  (anyone can donate — no account needed) ──────────
router.post('/', optionalAuth, [
  body('donor_name').trim().notEmpty().withMessage('Name required'),
  body('donor_email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('shoe_description').trim().notEmpty().withMessage('Shoe description required'),
  body('pair_count').isInt({ min: 1, max: 100 }).withMessage('Pair count must be 1–100'),
  body('collection_line1').trim().notEmpty().withMessage('Collection address required'),
  body('collection_postcode').trim().notEmpty().withMessage('Collection postcode required'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const {
      donor_name, donor_email, donor_phone,
      shoe_description, pair_count, notes,
      collection_line1, collection_line2,
      collection_city, collection_county, collection_postcode,
    } = req.body;

    const reference = genRef();

    const { rows } = await db.query(
      `INSERT INTO donations
         (reference, donor_user_id, donor_name, donor_email, donor_phone,
          shoe_description, pair_count, notes,
          collection_line1, collection_line2, collection_city,
          collection_county, collection_postcode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        reference,
        req.user?.id || null,
        donor_name, donor_email, donor_phone || null,
        shoe_description, parseInt(pair_count), notes || null,
        collection_line1, collection_line2 || null,
        collection_city || null, collection_county || null, collection_postcode,
      ]
    );

    const donation = rows[0];

    // Generate collection label
    const labelUrl = await labelService.generateDonationLabel({
      reference,
      donor: { name: donor_name, email: donor_email },
      collectionAddress: {
        line1: collection_line1, line2: collection_line2,
        city: collection_city, county: collection_county,
        postcode: collection_postcode,
      },
      pairCount: parseInt(pair_count),
    });

    await db.query(
      'UPDATE donations SET label_url = $1 WHERE id = $2',
      [labelUrl, donation.id]
    );

    // Send confirmation email with label
    emailService.sendDonationConfirmation(
      { name: donor_name, email: donor_email },
      donation,
      labelUrl
    ).catch(console.error);

    await logActivity(req.user?.id || null, 'donation.submitted', 'donation', donation.id, {
      reference, pair_count, donor_email,
    });

    res.status(201).json({
      donation: { ...donation, label_url: labelUrl },
    });
  } catch (err) { next(err); }
});

// ── GET /api/donations  (admin — all donations) ───────────────────────────
router.get('/', authenticate, requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { status } = req.query;
    let where = '';
    const params = [];
    if (status) { params.push(status); where = `WHERE status = $1`; }

    const { rows } = await db.query(
      `SELECT * FROM donations ${where} ORDER BY submitted_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/donations/stats  (public — charity impact stats) ────────────
router.get('/stats', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(*)                          AS total_donations,
         SUM(pair_count)                   AS total_pairs,
         SUM(total_revenue)                AS total_revenue,
         COUNT(*) FILTER (WHERE status = 'profit_transferred') AS transferred_count,
         SUM(total_revenue) FILTER (WHERE status = 'profit_transferred') AS total_transferred
       FROM donations WHERE status != 'cancelled'`
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/donations/:id  (donor looks up their donation) ──────────────
router.get('/:reference', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, reference, donor_name, pair_count, status,
              shoe_description, submitted_at, collected_at, listed_at,
              charity_name, total_revenue
       FROM donations WHERE reference = $1`,
      [req.params.reference.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Donation not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── PATCH /api/donations/:id/status  (admin — update status) ─────────────
router.patch('/:id/status', authenticate, requireRole('staff', 'admin'), [
  body('status').isIn(['pending','collected','processing','listed','profit_transferred','cancelled']),
  body('total_revenue').optional().isFloat({ min: 0 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { status, total_revenue } = req.body;
    const updates = [`status = $1`, `updated_at = NOW()`];
    const values = [status];

    if (total_revenue !== undefined) {
      values.push(total_revenue);
      updates.push(`total_revenue = $${values.length}`);
    }
    if (status === 'collected')          updates.push('collected_at = NOW()');
    if (status === 'listed')             updates.push('listed_at = NOW()');
    if (status === 'profit_transferred') updates.push('transferred_at = NOW()');

    values.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE donations SET ${updates.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Donation not found' });

    await logActivity(req.user.id, `donation.${status}`, 'donation', rows[0].id);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
