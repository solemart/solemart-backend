const express = require('express');
const db      = require('../config/db');
const { logActivity } = require('../services/activityLog');
const router  = express.Router();

router.post('/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  // Stripe not configured yet
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(200).json({ received: true, note: 'Stripe not configured' });
  }

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const { rows } = await db.query(
          `UPDATE orders SET status = 'cleaning', paid_at = NOW(), updated_at = NOW()
           WHERE stripe_payment_intent_id = $1 RETURNING *`,
          [pi.id]
        );
        if (rows.length) {
          const order = rows[0];
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
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        await db.query(
          `UPDATE shoes s SET status = 'listed', updated_at = NOW()
           FROM orders o WHERE o.shoe_id = s.id AND o.stripe_payment_intent_id = $1`,
          [pi.id]
        );
        await db.query(
          `UPDATE orders SET status = 'cancelled', updated_at = NOW()
           WHERE stripe_payment_intent_id = $1`,
          [pi.id]
        );
        break;
      }
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
        console.log(`Unhandled Stripe event: ${event.type}`);
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
