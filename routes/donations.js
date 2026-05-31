const express = require('express');
const { body, validationResult } = require('express-validator');
const db            = require('../config/db');
const { optionalAuth, authenticate, requireRole } = require('../middleware/auth');
const emailService  = require('../services/email');
const labelService  = require('../services/label');
const { logActivity } = require('../services/activityLog');
const router        = express.Router();

let stripe = null;
try { stripe = require('stripe')(process.env.STRIPE_SECRET_KEY); }
catch (e) { console.warn('Stripe not initialised in donations route:', e.message); }

const genRef = () => {
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `DON-${rand}-${Date.now().toString().slice(-4)}`;
};

// Insert a donation row from a normalised payload. Returns the created row.
async function insertDonation(payload, userId) {
  const {
    donor_name, donor_email, donor_phone,
    shoe_description, pair_count, notes,
    delivery_method = 'post', estimated_weight = null, shipping_fee = 0,
    collection_line1, collection_line2,
    collection_city, collection_county, collection_postcode,
    stripe_session_id = null, shipping_paid = false,
  } = payload;

  const reference = genRef();
  const { rows } = await db.query(
    `INSERT INTO donations
       (reference, donor_user_id, donor_name, donor_email, donor_phone,
        shoe_description, pair_count, notes,
        delivery_method, estimated_weight, shipping_fee, shipping_paid, stripe_session_id,
        collection_line1, collection_line2, collection_city,
        collection_county, collection_postcode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING *`,
    [
      reference, userId || null,
      donor_name, donor_email, donor_phone || null,
      shoe_description, parseInt(pair_count), notes || null,
      delivery_method, estimated_weight, shipping_fee || 0, shipping_paid, stripe_session_id,
      collection_line1 || null, collection_line2 || null,
      collection_city || null, collection_county || null, collection_postcode || null,
    ]
  );
  return rows[0];
}

// ── POST /api/donations  (post-yourself OR free-collection — no payment) ──────
// The paid-label path uses /checkout instead.
router.post('/', optionalAuth, [
  body('donor_name').trim().notEmpty().withMessage('Name required'),
  body('donor_email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('shoe_description').trim().notEmpty().withMessage('Shoe description required'),
  body('pair_count').isInt({ min: 1, max: 200 }).withMessage('Pair count must be 1–200'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const method = req.body.delivery_method || 'post';

    // Free-collection path needs an address
    if (method === 'collect' && (!req.body.collection_line1 || !req.body.collection_postcode)) {
      return res.status(422).json({ error: 'Collection address required for collection requests' });
    }

    const donation = await insertDonation(req.body, req.user?.id);

    // Confirmation email (no label for post-yourself; collection is arranged manually)
    emailService.sendDonationConfirmation(
      { name: donation.donor_name, email: donation.donor_email },
      donation,
      null
    ).catch(console.error);

    await logActivity(req.user?.id || null, 'donation.submitted', 'donation', donation.id, {
      reference: donation.reference, pair_count: donation.pair_count,
      donor_email: donation.donor_email, method,
    });

    res.status(201).json({ donation });
  } catch (err) { next(err); }
});

// ── POST /api/donations/checkout  (paid prepaid-label path) ───────────────────
// Donor pays the shipping fee; on success the donation is created + label generated.
router.post('/checkout', optionalAuth, [
  body('donor_name').trim().notEmpty(),
  body('donor_email').isEmail().normalizeEmail(),
  body('pair_count').isInt({ min: 1, max: 200 }),
  body('shipping_fee').isFloat({ min: 0.5 }).withMessage('Invalid shipping fee'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
    if (!stripe) return res.status(503).json({ error: 'Payment is not configured yet' });

    const fee = parseFloat(req.body.shipping_fee);

    // Stash the donation details in Stripe metadata so the webhook can create the
    // donation record only after successful payment. Keep metadata compact.
    const metaPayload = {
      donor_name: req.body.donor_name,
      donor_email: req.body.donor_email,
      donor_phone: req.body.donor_phone || '',
      shoe_description: req.body.shoe_description || '',
      pair_count: String(req.body.pair_count),
      estimated_weight: String(req.body.estimated_weight || ''),
      shipping_fee: String(fee),
      notes: (req.body.notes || '').slice(0, 480),
    };

    const successUrl = `${process.env.APP_URL || 'https://beautifullyordered.co.uk'}?donation_paid=1&ref={CHECKOUT_SESSION_ID}`;
    const cancelUrl  = `${process.env.APP_URL || 'https://beautifullyordered.co.uk'}?page=donate`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: 'Kosmos donation — prepaid shipping label',
            description: `${req.body.pair_count} pairs · approx ${req.body.estimated_weight || '?'}kg`,
          },
          unit_amount: Math.round(fee * 100),
        },
        quantity: 1,
      }],
      metadata: { kind: 'donation', ...metaPayload },
      payment_intent_data: { metadata: { kind: 'donation', ...metaPayload } },
      success_url: successUrl,
      cancel_url: cancelUrl,
    });

    res.json({ checkout_url: session.url, session_id: session.id });
  } catch (err) {
    console.error('Donation checkout error:', err);
    res.status(500).json({ error: err.message || 'Could not start payment' });
  }
});

// ── POST /api/donations/finalize-paid  (called on Stripe return as a fallback) ─
// The webhook is the source of truth, but this lets the client confirm + fetch
// the label immediately on return. Idempotent on stripe_session_id.
router.post('/finalize-paid', async (req, res, next) => {
  try {
    const { session_id } = req.body;
    if (!session_id || !stripe) return res.status(400).json({ error: 'Missing session' });

    // Already created? Return it.
    const existing = await db.query(
      `SELECT * FROM donations WHERE stripe_session_id = $1`, [session_id]
    );
    if (existing.rows.length) {
      return res.json({ donation: existing.rows[0] });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment not completed' });
    }

    const m = session.metadata || {};
    const donation = await insertDonation({
      donor_name: m.donor_name, donor_email: m.donor_email, donor_phone: m.donor_phone,
      shoe_description: m.shoe_description, pair_count: m.pair_count, notes: m.notes,
      delivery_method: 'label',
      estimated_weight: m.estimated_weight ? parseFloat(m.estimated_weight) : null,
      shipping_fee: m.shipping_fee ? parseFloat(m.shipping_fee) : 0,
      shipping_paid: true,
      stripe_session_id: session_id,
    }, null);

    // Generate the prepaid label via Royal Mail (graceful fallback if not configured)
    const labelResult = await labelService.generateDonationLabel({
      reference: donation.reference,
      donor: { name: donation.donor_name, email: donation.donor_email },
      collectionAddress: null,
      pairCount: donation.pair_count,
      weightGrams: donation.estimated_weight ? Math.round(donation.estimated_weight * 1000) : null,
    }).catch(() => null);

    const labelUrl = labelResult ? String(labelResult) : null;
    const trackingNumber = labelResult && labelResult.trackingNumber ? labelResult.trackingNumber : null;
    const rmOrderId = labelResult && labelResult.orderIdentifier ? String(labelResult.orderIdentifier) : null;

    if (labelUrl) {
      await db.query(
        'UPDATE donations SET label_url = $1, tracking_number = $2, rm_order_id = $3 WHERE id = $4',
        [labelUrl, trackingNumber, rmOrderId, donation.id]
      );
    }

    emailService.sendDonationConfirmation(
      { name: donation.donor_name, email: donation.donor_email },
      donation, labelUrl
    ).catch(console.error);

    await logActivity(null, 'donation.paid', 'donation', donation.id, {
      reference: donation.reference, shipping_fee: donation.shipping_fee,
    });

    res.json({ donation: { ...donation, label_url: labelUrl, tracking_number: trackingNumber } });
  } catch (err) {
    console.error('Finalize paid donation error:', err);
    res.status(500).json({ error: err.message || 'Could not finalize' });
  }
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
