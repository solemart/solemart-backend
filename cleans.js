const express = require('express');
const { body, validationResult } = require('express-validator');
const db            = require('../config/db');
const { authenticate, requireRole, optionalAuth } = require('../middleware/auth');
const emailService  = require('../services/email');
const labelService  = require('../services/label');
const { logActivity } = require('../services/activityLog');
const router        = express.Router();

const genRef = () => {
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `CLN-${rand}-${Date.now().toString().slice(-4)}`;
};

const SERVICES = {
  express:     { name: 'Express Refresh', price: 12 },
  deep:        { name: 'Deep Clean',      price: 24 },
  restoration: { name: 'Restoration',     price: 55 },
};

// ── POST /api/cleans  (anyone can book) ───────────────────────
router.post('/', optionalAuth, [
  body('service_type').isIn(['express','deep','restoration']).withMessage('Invalid service type'),
  body('contact_name').trim().notEmpty().withMessage('Name required'),
  body('contact_email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('shoe_description').trim().notEmpty().withMessage('Shoe details required'),
  body('pair_count').isInt({ min: 1, max: 50 }).withMessage('Pair count must be 1–50'),
  body('return_line1').trim().notEmpty().withMessage('Return address required'),
  body('return_postcode').trim().notEmpty().withMessage('Return postcode required'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const {
      service_type, contact_name, contact_email, contact_phone,
      shoe_description, pair_count, preferred_date, notes,
      return_line1, return_line2, return_city, return_county, return_postcode,
    } = req.body;

    const service      = SERVICES[service_type];
    const pricePerPair = service.price;
    const totalPrice   = pricePerPair * parseInt(pair_count);
    const reference    = genRef();

    const { rows } = await db.query(
      `INSERT INTO clean_bookings
         (reference, customer_id, contact_name, contact_email, contact_phone,
          shoe_description, pair_count, service_type, service_name,
          price_per_pair, total_price, preferred_date, notes,
          return_line1, return_line2, return_city, return_county, return_postcode)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING *`,
      [
        reference,
        req.user?.id || null,
        contact_name, contact_email, contact_phone || null,
        shoe_description, parseInt(pair_count),
        service_type, service.name,
        pricePerPair, totalPrice,
        preferred_date || null, notes || null,
        return_line1, return_line2 || null,
        return_city || null, return_county || null, return_postcode,
      ]
    );

    const booking = rows[0];

    // Generate label
    const labelUrl = await labelService.generateCleanLabel({
      reference,
      contact: { name: contact_name, email: contact_email },
      returnAddress: {
        line1: return_line1, line2: return_line2,
        city: return_city, county: return_county, postcode: return_postcode,
      },
      service: service.name,
      pairCount: parseInt(pair_count),
      total: `£${totalPrice}`,
    });

    await db.query('UPDATE clean_bookings SET label_url = $1 WHERE id = $2', [labelUrl, booking.id]);

    // Send confirmation email with label
    emailService.sendCleanBookingConfirmation({
      name: contact_name, email: contact_email,
    }, booking, labelUrl).catch(console.error);

    await logActivity(req.user?.id, 'clean.booked', 'clean_booking', booking.id, {
      reference, service_type, pair_count,
    });

    res.status(201).json({ booking: { ...booking, label_url: labelUrl } });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/cleans  (customer's own bookings) ────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM clean_bookings
       WHERE customer_id = $1
       ORDER BY booked_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/cleans/:id ───────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM clean_bookings
       WHERE id = $1 AND (customer_id = $2 OR $3 IN ('admin','staff'))`,
      [req.params.id, req.user.id, req.user.role]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── DELETE /api/cleans/:id  (cancel booking) ─────────────────
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT * FROM clean_bookings WHERE id = $1 AND customer_id = $2`,
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Booking not found' });
    if (rows[0].status !== 'booked') {
      return res.status(409).json({ error: 'Booking cannot be cancelled at this stage' });
    }
    await db.query(
      `UPDATE clean_bookings SET status = 'cancelled' WHERE id = $1`,
      [req.params.id]
    );
    res.json({ message: 'Booking cancelled' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
