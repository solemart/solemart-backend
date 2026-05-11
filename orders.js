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

    // Fetch the shoe and verify it's available
    const { rows: shoeRows } = await client.query(
      'SELECT * FROM shoes WHERE id = $1',
      [shoe_id]
    );
    if (!shoeRows.length) return res.status(404).json({ error: 'Shoe not found' });

    const shoe = shoeRows[0];
    if (shoe.status !== 'listed') {
      return res.status(409).json({ error: 'Shoe is not currently available' });
    }
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

    // Reserve the shoe
    await client.query(
      `UPDATE shoes SET status = $1, updated_at = NOW() WHERE id = $2`,
      [order_type === 'rent' ? 'rented' : 'sold', shoe_id]
    );

    // Create Stripe payment intent
    const paymentIntent = await stripeService.createPaymentIntent({
      amount: Math.round(total * 100), // pence
      currency: 'gbp',
      metadata: { shoe_id, order_type, customer_id: req.user.id },
    });

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
        reference, req.user.id, shoe_id, order_type,
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
      [order_type === 'rent' ? 1 : 0, shoe_id]
    );

    await client.query('COMMIT');

    await logActivity(req.user.id, 'order.created', 'order', rows[0].id, {
      reference, order_type, total,
    });

    emailService.sendOrderConfirmation(req.user, rows[0], shoe).catch(console.error);

    res.status(201).json({
      order: rows[0],
      clientSecret: paymentIntent.client_secret, // frontend uses this with Stripe.js
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
