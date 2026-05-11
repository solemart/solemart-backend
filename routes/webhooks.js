const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db      = require('../config/db');
const { logActivity } = require('../services/activityLog');
const router  = express.Router();

// POST /api/webhooks/stripe
// Raw body is passed in from server.js before JSON parsing
router.post('/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {

      // ── Payment succeeded ────────────────────────────────────
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const { rows } = await db.query(
          `UPDATE orders
           SET status = 'cleaning', paid_at = NOW(), updated_at = NOW()
           WHERE stripe_payment_intent_id = $1
           RETURNING *`,
          [pi.id]
        );
        if (rows.length) {
          const order = rows[0];
          // Create owner payout record (85%)
          await db.query(
            `INSERT INTO payouts (owner_id, order_id, amount, payout_type, status)
             SELECT s.owner_id, $1, $2, $3, 'pending'
             FROM shoes s WHERE s.id = $4`,
            [order.id, (order.subtotal * 0.85).toFixed(2),
             order.order_type === 'rent' ? 'rental' : 'sale', order.shoe_id]
          );
          await logActivity(null, 'payment.succeeded', 'order', order.id, { amount: pi.amount });
        }
        break;
      }

      // ── Payment failed ───────────────────────────────────────
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        // Release the shoe back to listed
        await db.query(
          `UPDATE shoes s SET status = 'listed', updated_at = NOW()
           FROM orders o
           WHERE o.shoe_id = s.id AND o.stripe_payment_intent_id = $1`,
          [pi.id]
        );
        await db.query(
          `UPDATE orders SET status = 'cancelled', updated_at = NOW()
           WHERE stripe_payment_intent_id = $1`,
          [pi.id]
        );
        break;
      }

      // ── Refund issued ────────────────────────────────────────
      case 'charge.refunded': {
        const charge = event.data.object;
        await db.query(
          `UPDATE orders SET status = 'refunded', updated_at = NOW()
           WHERE stripe_payment_intent_id = $1`,
          [charge.payment_intent]
        );
        break;
      }

      default:
        // Unhandled event — log and ignore
        console.log(`Unhandled Stripe event: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
