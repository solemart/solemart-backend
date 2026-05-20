// routes/stripe.js — Stripe Connect + Payment endpoints
const express = require('express');
const db      = require('../config/db');
const { authenticate } = require('../middleware/auth');
const {
  createConnectedAccount,
  createOnboardingLink,
  getAccountStatus,
  createPaymentIntent,
  getOwnerBalance,
  getOwnerTransactions,
  constructWebhookEvent,
  stripe,
} = require('../services/stripe');

const router = express.Router();

// ── CONNECT ONBOARDING ────────────────────────────────────────────────────────

// POST /api/stripe/connect — create or retrieve Connect account, return onboarding URL
router.post('/connect', authenticate, async (req, res, next) => {
  try {
    let { rows: [user] } = await db.query(`SELECT * FROM users WHERE id=$1`, [req.user.id]);

    // Already has a Stripe account
    if (user.stripe_account_id) {
      const status = await getAccountStatus(user.stripe_account_id);
      if (status.detailsSubmitted && status.payoutsEnabled) {
        return res.json({ connected: true, status });
      }
      // Incomplete — regenerate link
      const url = await createOnboardingLink(user.stripe_account_id, user.id);
      return res.json({ connected: false, onboardingUrl: url, status });
    }

    // Create new Connect account
    const account = await createConnectedAccount(user);
    await db.query(`UPDATE users SET stripe_account_id=$1 WHERE id=$2`, [account.id, user.id]);
    const url = await createOnboardingLink(account.id, user.id);
    res.json({ connected: false, onboardingUrl: url });
  } catch (err) { next(err); }
});

// GET /api/stripe/connect/status — check if owner is connected
router.get('/connect/status', authenticate, async (req, res, next) => {
  try {
    const { rows: [user] } = await db.query(`SELECT stripe_account_id FROM users WHERE id=$1`, [req.user.id]);
    if (!user?.stripe_account_id) return res.json({ connected: false });
    const status = await getAccountStatus(user.stripe_account_id);
    res.json({ connected: status.detailsSubmitted && status.payoutsEnabled, status });
  } catch (err) { next(err); }
});

// GET /api/stripe/connect/return — redirect after onboarding
router.get('/connect/return', async (req, res) => {
  res.redirect(`${process.env.APP_URL || 'https://beautifullyordered.com'}?stripe=connected`);
});

// GET /api/stripe/connect/refresh — regenerate onboarding link
router.get('/connect/refresh', async (req, res, next) => {
  try {
    const { userId } = req.query;
    const { rows: [user] } = await db.query(`SELECT stripe_account_id FROM users WHERE id=$1`, [userId]);
    if (!user?.stripe_account_id) return res.redirect('/');
    const url = await createOnboardingLink(user.stripe_account_id, userId);
    res.redirect(url);
  } catch (err) { next(err); }
});

// ── BALANCE & TRANSACTIONS ────────────────────────────────────────────────────

// GET /api/stripe/balance — owner's current Stripe balance
router.get('/balance', authenticate, async (req, res, next) => {
  try {
    const { rows: [user] } = await db.query(`SELECT stripe_account_id FROM users WHERE id=$1`, [req.user.id]);
    if (!user?.stripe_account_id) return res.json({ available: [], pending: [] });
    const balance = await getOwnerBalance(user.stripe_account_id);
    res.json(balance);
  } catch (err) { next(err); }
});

// GET /api/stripe/transactions — owner's Stripe transaction history
router.get('/transactions', authenticate, async (req, res, next) => {
  try {
    const { rows: [user] } = await db.query(`SELECT stripe_account_id FROM users WHERE id=$1`, [req.user.id]);
    if (!user?.stripe_account_id) return res.json([]);
    const txns = await getOwnerTransactions(user.stripe_account_id);
    res.json(txns);
  } catch (err) { next(err); }
});

// ── PAYMENT INTENT ────────────────────────────────────────────────────────────

// POST /api/stripe/payment-intent — create payment for rental or purchase
router.post('/payment-intent', authenticate, async (req, res, next) => {
  try {
    const { shoeId, orderId, amount, orderType } = req.body;

    // Get shoe owner's Stripe account
    const { rows: [shoe] } = await db.query(
      `SELECT s.id, u.stripe_account_id, u.first_name
       FROM shoes s JOIN users u ON u.id = s.owner_id
       WHERE s.id = $1`,
      [shoeId]
    );

    const result = await createPaymentIntent({
      amount,
      shoeId,
      orderId,
      orderType,
      ownerStripeId: shoe?.stripe_account_id || null,
      currency: 'gbp',
    });

    res.json(result);
  } catch (err) { next(err); }
});

// ── WEBHOOK ───────────────────────────────────────────────────────────────────

// POST /api/stripe/webhook — handle Stripe events
router.post('/webhook', async (req, res) => {
  let event;
  try {
    event = constructWebhookEvent(req.body, req.headers['stripe-signature']);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {

      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const { orderId, shoeId, orderType } = pi.metadata;

        if (orderId) {
          // Update order status to confirmed
          await db.query(
            `UPDATE orders SET status='confirmed', stripe_payment_intent_id=$1 WHERE id=$2`,
            [pi.id, orderId]
          );

          // Record payout entry (for history — actual transfer handled by Stripe)
          const ownerAmount = pi.transfer_data?.amount / 100 || 0;
          if (ownerAmount > 0 && shoeId) {
            const { rows: [shoe] } = await db.query(`SELECT owner_id FROM shoes WHERE id=$1`, [shoeId]);
            if (shoe) {
              await db.query(
                `INSERT INTO payouts (owner_id, order_id, shoe_id, amount, status, payout_type)
                 VALUES ($1, $2, $3, $4, 'paid', $5)
                 ON CONFLICT DO NOTHING`,
                [shoe.owner_id, orderId, shoeId, ownerAmount, orderType === 'rent' ? 'rental' : 'sale']
              );
            }
          }
        }
        break;
      }

      case 'account.updated': {
        const account = event.data.object;
        // Update user's connect status
        if (account.metadata?.kosmos_user_id) {
          await db.query(
            `UPDATE users SET stripe_payouts_enabled=$1 WHERE id=$2`,
            [account.payouts_enabled, account.metadata.kosmos_user_id]
          );
        }
        break;
      }

      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        if (pi.metadata?.orderId) {
          await db.query(
            `UPDATE orders SET status='cancelled' WHERE id=$1`,
            [pi.metadata.orderId]
          );
        }
        break;
      }
    }
  } catch (err) {
    console.error('Webhook handler error:', err);
  }

  res.json({ received: true });
});

// ── STRIPE CHECKOUT (web) ──────────────────────────────────────────────────────
// POST /api/stripe/checkout — create a hosted checkout session for web
router.post('/checkout', authenticate, async (req, res, next) => {
  try {
    const { items, delivery } = req.body;
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Validate items and calculate amounts
    let totalAmount = 0;
    const lineItems = [];
    const orderInputs = [];
    let hasRental = false;

    for (const item of items) {
      const { rows: [shoe] } = await db.query(`SELECT * FROM shoes WHERE id = $1`, [item.shoe_id]);
      if (!shoe) return res.status(404).json({ error: `Shoe ${item.shoe_id} not found` });
      if (shoe.status !== 'listed') return res.status(409).json({ error: `${shoe.brand} ${shoe.model} is not available` });

      const unitPrice = item.order_type === 'rent' ? parseFloat(shoe.rent_price) : parseFloat(shoe.buy_price);
      const subtotal  = item.order_type === 'rent' ? unitPrice * item.rental_days : unitPrice;
      const platformFee = parseFloat((subtotal * 0.15).toFixed(2));
      const total = parseFloat((subtotal + platformFee).toFixed(2));
      if (item.order_type === 'rent') hasRental = true;
      totalAmount += total;

      lineItems.push({
        price_data: {
          currency: 'gbp',
          product_data: {
            name: `${shoe.brand} ${shoe.model}`,
            description: item.order_type === 'rent'
              ? `${item.rental_days}-day rental · UK ${shoe.size}`
              : `Purchase · UK ${shoe.size}`,
          },
          unit_amount: Math.round(total * 100),
        },
        quantity: 1,
      });

      orderInputs.push({ shoe, item, unitPrice, subtotal, platformFee, total });
    }

    const { stripe } = require('../services/stripe');

    // Get or create Stripe Customer for this user
    const { rows: userRows } = await db.query(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
    const user = userRows[0];
    let customerId = user.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: `${user.first_name} ${user.last_name}`,
        metadata: { kosmos_user_id: req.user.id },
      });
      customerId = customer.id;
      await db.query(`UPDATE users SET stripe_customer_id = $1 WHERE id = $2`, [customerId, req.user.id]);
    }

    // Create orders with status 'pending_payment'
    const orderIds = [];
    for (const o of orderInputs) {
      const reference = 'ORD-' + Math.random().toString(36).slice(2, 5).toUpperCase() + '-' + Date.now().toString().slice(-4);
      const rentalEnd = o.item.order_type === 'rent'
        ? new Date(Date.now() + o.item.rental_days * 86400000) : null;

      const { rows } = await db.query(
        `INSERT INTO orders
          (reference, customer_id, shoe_id, order_type, status,
           unit_price, rental_days, subtotal, platform_fee, total,
           delivery_line1, delivery_line2, delivery_city, delivery_postcode,
           rental_start_date, rental_end_date)
         VALUES ($1,$2,$3,$4,'pending_payment',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [reference, req.user.id, o.shoe.id, o.item.order_type, o.unitPrice,
         o.item.order_type === 'rent' ? o.item.rental_days : null,
         o.subtotal, o.platformFee, o.total,
         delivery.line1, delivery.line2 || null, delivery.city || 'London', delivery.postcode,
         o.item.order_type === 'rent' ? new Date() : null, rentalEnd]
      );
      orderIds.push(rows[0].id);
    }

    const successUrl = `${process.env.APP_URL || 'https://beautifullyordered.com'}?stripe=success&session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = `${process.env.APP_URL || 'https://beautifullyordered.com'}?stripe=cancel`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer: customerId,
      customer_update: { address: 'auto', name: 'auto' },
      line_items: lineItems,
      // For rentals — save the card for future late fee charges
      payment_intent_data: {
        ...(hasRental ? { setup_future_usage: 'off_session' } : {}),
        metadata: { order_ids: orderIds.join(','), user_id: req.user.id },
      },
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { order_ids: orderIds.join(','), user_id: req.user.id },
    });

    res.json({ checkout_url: session.url, session_id: session.id });
  } catch (err) { next(err); }
});

// GET /api/stripe/checkout/verify?session_id=xxx
router.get('/checkout/verify', authenticate, async (req, res, next) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    const { stripe } = require('../services/stripe');
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const paid = session.payment_status === 'paid';
    // Update orders to confirmed if paid
    if (paid && session.metadata?.order_ids) {
      const orderIds = session.metadata.order_ids.split(',');
      for (const id of orderIds) {
        await db.query(
          `UPDATE orders SET status = 'confirmed', stripe_payment_intent_id = $1 WHERE id = $2`,
          [session.payment_intent, id]
        );
      }
    }
    res.json({ paid, status: session.payment_status });
  } catch (err) { next(err); }
});

module.exports = router;
