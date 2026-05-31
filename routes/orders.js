const express = require('express');
const { body, validationResult } = require('express-validator');
const db            = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const emailService  = require('../services/email');
const stripeService = require('../services/stripe');
const { logActivity } = require('../services/activityLog');
const router        = express.Router();

const genRef = (prefix) => {
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${prefix}-${rand}-${Date.now().toString().slice(-4)}`;
};

// ── POST /api/orders  (create order — rent or buy) ────────────
router.post('/', authenticate, [
  body('shoe_id').isUUID().withMessage('Valid shoe ID required'),
  body('order_type').isIn(['rent','buy']).withMessage('order_type must be rent or buy'),
  body('rental_days').if(body('order_type').equals('rent'))
    .isInt({ min: 1, max: 30 }).withMessage('rental_days required for rentals'),
  body('delivery_line1').trim().notEmpty().withMessage('Delivery address required'),
  body('delivery_postcode').trim().notEmpty().withMessage('Delivery postcode required'),
], async (req, res, next) => {
  const client = await db.getClient();
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const {
      shoe_id, order_type, rental_days,
      delivery_line1, delivery_line2,
      delivery_city, delivery_county, delivery_postcode,
    } = req.body;

    // RENTAL VERIFICATION GATE — a renter must be ID + address verified once.
    // Enforced server-side so it can't be bypassed by tampering with the client.
    if (order_type === 'rent') {
      try {
        const { rows: vRows } = await client.query(
          `SELECT id_verified, address_verified FROM users WHERE id = $1`,
          [req.user.id]
        );
        const v = vRows[0] || {};
        if (!v.id_verified || !v.address_verified) {
          return res.status(403).json({
            error: 'verification_required',
            message: 'Identity and address verification are required before renting.',
            id_verified: v.id_verified || false,
            address_verified: v.address_verified || false,
          });
        }
      } catch (e) {
        // If verification columns don't exist yet (migration not run), fail safe → block rental
        console.warn('Verification check failed:', e.message);
        return res.status(403).json({ error: 'verification_required', message: 'Verification system unavailable.' });
      }
    }

    // Fetch the shoe and verify it's available
    const { rows: shoeRows } = await client.query(
      'SELECT * FROM shoes WHERE id = $1',
      [shoe_id]
    );
    if (!shoeRows.length) return res.status(404).json({ error: 'Shoe not found' });

    let shoe = shoeRows[0];

    // FIFO ALLOCATION
    // If the chosen shoe is no longer available (someone else just bought it),
    // OR even if it IS available, prefer the oldest-listed pair in the same variant group.
    // This ensures inventory rotates fairly across owners and the "stock count" stays accurate.
    if (shoe.status !== 'listed') {
      // Try to find another pair in the same variant group
      const { rows: fallbackRows } = await client.query(
        `SELECT * FROM shoes
         WHERE status = 'listed'
           AND LOWER(brand) = LOWER($1)
           AND LOWER(model) = LOWER($2)
           AND LOWER(COALESCE(size,'')) = LOWER(COALESCE($3,''))
           AND LOWER(COALESCE(colour,'')) = LOWER(COALESCE($4,''))
           AND LOWER(COALESCE(assessed_wear_grade,'')) = LOWER(COALESCE($5,''))
         ORDER BY listed_at ASC NULLS LAST
         LIMIT 1`,
        [shoe.brand, shoe.model, shoe.size, shoe.colour, shoe.assessed_wear_grade]
      );
      if (fallbackRows.length) {
        shoe = fallbackRows[0];
      } else {
        return res.status(409).json({ error: 'Shoe is no longer available' });
      }
    } else {
      // Optimisation: still use FIFO ordering — pick oldest if there are multiple
      const { rows: oldestRows } = await client.query(
        `SELECT * FROM shoes
         WHERE status = 'listed'
           AND LOWER(brand) = LOWER($1)
           AND LOWER(model) = LOWER($2)
           AND LOWER(COALESCE(size,'')) = LOWER(COALESCE($3,''))
           AND LOWER(COALESCE(colour,'')) = LOWER(COALESCE($4,''))
           AND LOWER(COALESCE(assessed_wear_grade,'')) = LOWER(COALESCE($5,''))
         ORDER BY listed_at ASC NULLS LAST
         LIMIT 1`,
        [shoe.brand, shoe.model, shoe.size, shoe.colour, shoe.assessed_wear_grade]
      );
      if (oldestRows.length) shoe = oldestRows[0];
    }

    // From here on, use the allocated shoe's actual id for everything
    const allocatedShoeId = shoe.id;

    if (order_type === 'rent' && !['rent','both'].includes(shoe.listing_type)) {
      return res.status(409).json({ error: 'This shoe is not available for rent' });
    }
    if (order_type === 'buy' && !['buy','both'].includes(shoe.listing_type)) {
      return res.status(409).json({ error: 'This shoe is not available to buy' });
    }

    // Pricing
    const unitPrice = order_type === 'rent' ? shoe.rent_price : shoe.buy_price;
    const subtotal  = order_type === 'rent' ? unitPrice * rental_days : unitPrice;
    const platformFee = parseFloat((subtotal * 0.15).toFixed(2));
    const total     = parseFloat((subtotal + platformFee).toFixed(2));

    await client.query('BEGIN');

    // Reserve the allocated shoe
    await client.query(
      `UPDATE shoes SET status = $1, updated_at = NOW() WHERE id = $2`,
      [order_type === 'rent' ? 'rented' : 'sold', allocatedShoeId]
    );

    // Create Stripe payment intent (optional — only if Stripe is configured)
    let paymentIntent = { id: null, client_secret: null };
    let stripeCustomerId = null;
    let ephemeralKeySecret = null;
    if (process.env.STRIPE_SECRET_KEY) {
      try {
        const { stripe } = require('../services/stripe');

        // Get or create Stripe Customer for this user
        const { rows: userRows } = await client.query(
          `SELECT stripe_customer_id, email, first_name, last_name FROM users WHERE id = $1`,
          [req.user.id]
        );
        const user = userRows[0];
        stripeCustomerId = user.stripe_customer_id;
        if (!stripeCustomerId) {
          const customer = await stripe.customers.create({
            email: user.email,
            name: `${user.first_name} ${user.last_name}`,
            metadata: { kosmos_user_id: req.user.id },
          });
          stripeCustomerId = customer.id;
          await client.query(
            `UPDATE users SET stripe_customer_id = $1 WHERE id = $2`,
            [stripeCustomerId, req.user.id]
          );
        }

        // Get owner Stripe Connect account for split payment
        const { rows: ownerRows } = await client.query(
          `SELECT stripe_account_id FROM users WHERE id = $1`,
          [shoe.owner_id]
        );
        const ownerStripeId = ownerRows[0]?.stripe_account_id;

        // Create payment intent with Customer attached so card is saved for later
        const piParams = {
          amount: Math.round(total * 100),
          currency: 'gbp',
          customer: stripeCustomerId,
          setup_future_usage: order_type === 'rent' ? 'off_session' : undefined,
          metadata: { shoe_id: allocatedShoeId, order_type, customer_id: req.user.id },
          automatic_payment_methods: { enabled: true },
        };

        // Apply Connect split if owner has Stripe account — use dynamic settings
        if (ownerStripeId) {
          const settings = require('../services/settings');
          const platformFeePercent = await settings.getPlatformFeePercent();
          const cleaningFeeAmount  = await settings.getCleaningFeeAmount();
          const cleaningFee = order_type === 'rent' ? Math.round(cleaningFeeAmount * 100) : 0;
          const netAmount = piParams.amount - cleaningFee;
          const platformFeePence = Math.round(netAmount * (platformFeePercent / 100));
          piParams.transfer_data = { destination: ownerStripeId, amount: netAmount - platformFeePence };
          piParams.application_fee_amount = platformFeePence + cleaningFee;
        }

        const pi = await stripe.paymentIntents.create(piParams);
        paymentIntent = { id: pi.id, client_secret: pi.client_secret };

        // Create ephemeral key for Payment Sheet
        const ephemeralKey = await stripe.ephemeralKeys.create(
          { customer: stripeCustomerId },
          { apiVersion: '2024-06-20' }
        );
        ephemeralKeySecret = ephemeralKey.secret;
      } catch (e) {
        console.warn('Stripe payment intent failed (continuing without):', e.message);
      }
    }

    const reference = genRef('ORD');
    const rentalStart = order_type === 'rent' ? new Date() : null;
    const rentalEnd   = order_type === 'rent'
      ? new Date(Date.now() + rental_days * 86400000) : null;

    const { rows } = await client.query(
      `INSERT INTO orders
         (reference, customer_id, shoe_id, order_type, status,
          unit_price, rental_days, subtotal, platform_fee, total,
          delivery_line1, delivery_line2, delivery_city, delivery_county, delivery_postcode,
          stripe_payment_intent_id, rental_start_date, rental_end_date)
       VALUES ($1,$2,$3,$4,'confirmed',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [
        reference, req.user.id, allocatedShoeId, order_type,
        unitPrice, rental_days || null, subtotal, platformFee, total,
        delivery_line1, delivery_line2 || null,
        delivery_city || null, delivery_county || null, delivery_postcode,
        paymentIntent.id,
        rentalStart, rentalEnd,
      ]
    );

    // Increment listing lifecycle count
    await client.query(
      `UPDATE shoes SET rental_count = rental_count + $1, updated_at = NOW() WHERE id = $2`,
      [order_type === 'rent' ? 1 : 0, allocatedShoeId]
    );

    await client.query('COMMIT');

    await logActivity(req.user.id, 'order.created', 'order', rows[0].id, {
      reference, order_type, total,
    });

    emailService.sendOrderConfirmation(req.user, rows[0], shoe).catch(console.error);

    res.status(201).json({
      order: rows[0],
      reference: rows[0].reference,
      client_secret: paymentIntent.client_secret,
      customer_id: stripeCustomerId,
      ephemeral_key: ephemeralKeySecret,
      amount: total,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

// ── GET /api/orders  (customer's own orders) ──────────────────
router.get('/', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT o.*,
              s.brand, s.model, s.emoji, s.size, s.condition, s.auth_grade,
              r.id AS review_id
       FROM orders o
       JOIN shoes s ON s.id = o.shoe_id
       LEFT JOIN reviews r ON r.order_id = o.id
       WHERE o.customer_id = $1
       ORDER BY o.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ── GET /api/orders/:id ───────────────────────────────────────
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT o.*, s.brand, s.model, s.emoji, s.size, s.condition, s.auth_grade,
              s.rent_price, s.buy_price, s.description
       FROM orders o
       JOIN shoes s ON s.id = o.shoe_id
       WHERE o.id = $1 AND (o.customer_id = $2 OR $3 IN ('admin','staff'))`,
      [req.params.id, req.user.id, req.user.role]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/orders/:id/return  (customer initiates return) ──
router.post('/:id/return', authenticate, async (req, res, next) => {
  const client = await db.getClient();
  try {
    const { rows } = await client.query(
      'SELECT * FROM orders WHERE id = $1 AND customer_id = $2',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = rows[0];

    if (!['active_rental','delivered'].includes(order.status)) {
      return res.status(409).json({ error: 'Order is not in a returnable state' });
    }

    await client.query('BEGIN');
    await client.query(
      `UPDATE orders SET status = 'return_initiated', updated_at = NOW() WHERE id = $1`,
      [order.id]
    );
    // Shoe goes back to cleaning state
    await client.query(
      `UPDATE shoes SET status = 'cleaning', updated_at = NOW() WHERE id = $1`,
      [order.shoe_id]
    );
    await client.query('COMMIT');

    await logActivity(req.user.id, 'order.return_initiated', 'order', order.id);
    emailService.sendReturnInitiated(req.user, order).catch(console.error);

    res.json({ message: 'Return initiated. Check your email for the return label.' });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
