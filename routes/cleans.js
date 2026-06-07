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

const SERVICE_NAMES = {
  express:     'Express Refresh',
  deep:        'Deep Clean',
  restoration: 'Restoration',
};

// Sensible fallbacks used only if a setting row hasn't been seeded yet.
const CLEAN_DEFAULTS = { express: 12, deep: 24, restoration: 55, label: 5.95 };

// Read current cleaning prices + label fee from platform_settings (admin-editable).
async function getCleanPricing(){
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM platform_settings
        WHERE key IN ('clean_price_express','clean_price_deep','clean_price_restoration','clean_label_fee')`
    );
    const m = {};
    rows.forEach(r => { const n = parseFloat(r.value); if (!isNaN(n)) m[r.key] = n; });
    return {
      express:     m.clean_price_express     ?? CLEAN_DEFAULTS.express,
      deep:        m.clean_price_deep        ?? CLEAN_DEFAULTS.deep,
      restoration: m.clean_price_restoration ?? CLEAN_DEFAULTS.restoration,
      label:       m.clean_label_fee         ?? CLEAN_DEFAULTS.label,
    };
  } catch (e) {
    console.warn('getCleanPricing failed, using defaults:', e.message);
    return { ...CLEAN_DEFAULTS };
  }
}

// ── GET /api/cleans/pricing  (public — powers the booking wizard) ─────────────
// Defined before '/:id' so it isn't captured by the id route.
router.get('/pricing', async (req, res, next) => {
  try {
    const p = await getCleanPricing();
    res.json({
      services: [
        { type: 'express',     name: 'Express Refresh', price: p.express },
        { type: 'deep',        name: 'Deep Clean',      price: p.deep },
        { type: 'restoration', name: 'Restoration',     price: p.restoration },
      ],
      label_fee: p.label,
    });
  } catch (err) { next(err); }
});

// ── POST /api/cleans  (anyone can book) ───────────────────────
router.post('/', optionalAuth, [
  body('service_type').isIn(['express','deep','restoration','restore']).withMessage('Invalid service type'),
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
      delivery_method, estimated_weight,
    } = req.body;

    const svcType      = (service_type === 'restore') ? 'restoration' : service_type;
    const pricing      = await getCleanPricing();
    const pricePerPair = pricing[svcType];
    const serviceName  = SERVICE_NAMES[svcType] || 'Clean';
    const pairs        = parseInt(pair_count);
    const deliveryMethod = delivery_method === 'label' ? 'label' : 'post';
    const estWeight    = (estimated_weight != null && estimated_weight !== '') ? parseFloat(estimated_weight) : null;
    const labelFee     = deliveryMethod === 'label' ? pricing.label : 0;
    const totalPrice   = (pricePerPair * pairs) + labelFee;
    const reference    = genRef();

    // Record how the customer is sending the shoes (and any label fee) in notes,
    // so the studio knows what to expect — no schema change required.
    const deliveryTag = deliveryMethod === 'label'
      ? `[Prepaid label requested · est. ${estWeight != null ? estWeight.toFixed(1) + 'kg' : 'n/a'} · label fee £${labelFee.toFixed(2)}]`
      : `[Customer posting themselves]`;
    const combinedNotes = [deliveryTag, notes].filter(Boolean).join('\n');

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
        shoe_description, pairs,
        svcType, serviceName,
        pricePerPair, totalPrice,
        preferred_date || null, combinedNotes || null,
        return_line1, return_line2 || null,
        return_city || null, return_county || null, return_postcode,
      ]
    );

    const booking = rows[0];

    // Generate label (non-fatal — a label failure must never sink a booking)
    let labelUrl = null;
    try {
      labelUrl = await labelService.generateCleanLabel({
        reference,
        contact: { name: contact_name, email: contact_email },
        returnAddress: {
          line1: return_line1, line2: return_line2,
          city: return_city, county: return_county, postcode: return_postcode,
        },
        service: serviceName,
        pairCount: pairs,
        total: `£${totalPrice.toFixed(2)}`,
      });
    } catch (e) {
      console.error('Clean label generation failed (non-fatal):', e.message);
    }
    if (labelUrl) {
      await db.query('UPDATE clean_bookings SET label_url = $1 WHERE id = $2', [labelUrl, booking.id]);
    }

    // Send confirmation email with label (non-blocking)
    emailService.sendCleanBookingConfirmation({
      name: contact_name, email: contact_email,
    }, booking, labelUrl).catch(console.error);

    try {
      await logActivity(req.user?.id, 'clean.booked', 'clean_booking', booking.id, {
        reference, service_type: svcType, pair_count: pairs,
      });
    } catch (e) { console.warn('logActivity failed (non-fatal):', e.message); }

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

// ── One-time seed: ensure the cleaning-price settings exist ───────────────────
// Runs on startup via the app's own DB connection (the one that actually targets
// your live database), so there's no need to run SQL by hand. Idempotent — does
// nothing if the rows already exist, and is non-fatal if anything goes wrong.
(async () => {
  try {
    await db.query(
      `INSERT INTO platform_settings (key, value, description) VALUES
         ('clean_price_express',     '12'::jsonb,   'Express Refresh — price per pair'),
         ('clean_price_deep',        '24'::jsonb,   'Deep Clean — price per pair'),
         ('clean_price_restoration', '55'::jsonb,   'Restoration — price per pair'),
         ('clean_label_fee',         '5.95'::jsonb, 'Prepaid shipping label fee for clean bookings')
       ON CONFLICT (key) DO NOTHING`
    );
    console.log('Cleaning-price settings ensured.');
  } catch (e) {
    console.warn('Clean settings seed skipped:', e.message);
  }
})();

module.exports = router;
