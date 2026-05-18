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
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
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

module.exports = router;
