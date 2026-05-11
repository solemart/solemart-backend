const express = require('express');
const { body, validationResult } = require('express-validator');
const { v4: uuid } = require('uuid');
const db            = require('../config/db');
const { authenticate } = require('../middleware/auth');
const emailService  = require('../services/email');
const labelService  = require('../services/label');
const { logActivity } = require('../services/activityLog');
const router        = express.Router();

// Generate a human-readable reference e.g. LST-ABC-1234
const genRef = (prefix) => {
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  const ts   = Date.now().toString().slice(-4);
  return `${prefix}-${rand}-${ts}`;
};

// ── POST /api/submissions  (owner submits shoes) ──────────────
router.post('/', authenticate, [
  body('shoes').isArray({ min: 1 }).withMessage('At least one shoe required'),
  body('shoes.*.brand').trim().notEmpty(),
  body('shoes.*.model').trim().notEmpty(),
  body('shoes.*.size').trim().notEmpty(),
  body('shoes.*.listing_type').isIn(['rent','buy','both']),
  body('collection_line1').trim().notEmpty().withMessage('Collection address required'),
  body('collection_postcode').trim().notEmpty().withMessage('Collection postcode required'),
  body('referral_source').optional().trim(),
], async (req, res, next) => {
  const client = await db.getClient();
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const {
      shoes,
      collection_line1, collection_line2,
      collection_city, collection_county, collection_postcode,
      referral_source, referral_other,
    } = req.body;

    await client.query('BEGIN');

    // Create the submission record
    const reference = genRef('LST');
    const { rows: subRows } = await client.query(
      `INSERT INTO listing_submissions
         (reference, owner_id, collection_line1, collection_line2,
          collection_city, collection_county, collection_postcode,
          referral_source, referral_other)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [reference, req.user.id, collection_line1, collection_line2 || null,
       collection_city || null, collection_county || null, collection_postcode,
       referral_source || null, referral_other || null]
    );
    const submission = subRows[0];

    // Create each shoe and link to submission
    const createdShoes = [];
    for (const shoe of shoes) {
      const { rows: shoeRows } = await client.query(
        `INSERT INTO shoes
           (owner_id, brand, model, size, colour, category, gender,
            description, emoji, listing_type, rent_price, buy_price,
            condition, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'submitted')
         RETURNING *`,
        [
          req.user.id, shoe.brand, shoe.model, shoe.size,
          shoe.colour || null, shoe.category || null, shoe.gender || null,
          shoe.description || null, shoe.emoji || '👟',
          shoe.listing_type,
          shoe.rent_price ? parseFloat(shoe.rent_price) : null,
          shoe.buy_price  ? parseFloat(shoe.buy_price)  : null,
          shoe.condition  || null,
        ]
      );
      const createdShoe = shoeRows[0];
      createdShoes.push(createdShoe);

      await client.query(
        'INSERT INTO submission_shoes (submission_id, shoe_id) VALUES ($1, $2)',
        [submission.id, createdShoe.id]
      );
    }

    // Generate shipping label
    const labelUrl = await labelService.generateListingLabel({
      reference,
      owner: req.user,
      shoes: createdShoes,
      collectionAddress: {
        line1: collection_line1, line2: collection_line2,
        city: collection_city, county: collection_county,
        postcode: collection_postcode,
      },
    });

    // Update submission with label URL
    await client.query(
      'UPDATE listing_submissions SET label_url = $1 WHERE id = $2',
      [labelUrl, submission.id]
    );

    await client.query('COMMIT');

    // Log activity
    await logActivity(req.user.id, 'submission.created', 'submission', submission.id, {
      reference, shoe_count: createdShoes.length,
    });

    // Email confirmation with label (non-blocking)
    emailService.sendSubmissionConfirmation(req.user, submission, createdShoes, labelUrl).catch(console.error);

    res.status(201).json({
      submission: { ...submission, label_url: labelUrl },
      shoes: createdShoes,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ── GET /api/submissions  (owner's own submissions) ───────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ls.*,
              COUNT(ss.shoe_id) AS shoe_count
       FROM listing_submissions ls
       LEFT JOIN submission_shoes ss ON ss.submission_id = ls.id
       WHERE ls.owner_id = $1
       GROUP BY ls.id
       ORDER BY ls.submitted_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/submissions/:id ──────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT ls.* FROM listing_submissions ls
       WHERE ls.id = $1 AND (ls.owner_id = $2 OR $3 IN ('admin','staff'))`,
      [req.params.id, req.user.id, req.user.role]
    );
    if (!rows.length) return res.status(404).json({ error: 'Submission not found' });

    const shoes = await db.query(
      `SELECT s.* FROM shoes s
       JOIN submission_shoes ss ON ss.shoe_id = s.id
       WHERE ss.submission_id = $1`,
      [req.params.id]
    );

    res.json({ ...rows[0], shoes: shoes.rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
