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

      // ── Identity verification verified ───────────────────────
      case 'identity.verification_session.verified': {
        const session = event.data.object;
        const userId = session.metadata?.user_id;
        if (userId) {
          // Pull verified outputs (name, dob)
          let fullName = null, dob = null;
          try {
            const out = session.verified_outputs || {};
            if (out.first_name && out.last_name) fullName = `${out.first_name} ${out.last_name}`;
            if (out.dob) dob = `${out.dob.year}-${String(out.dob.month).padStart(2,'0')}-${String(out.dob.day).padStart(2,'0')}`;
          } catch (e) {}
          await db.query(
            `UPDATE users
             SET id_verified = TRUE, id_verified_at = NOW(),
                 id_verified_name = COALESCE($1, id_verified_name),
                 id_verified_dob = COALESCE($2::date, id_verified_dob)
             WHERE id = $3`,
            [fullName, dob, userId]
          );
          await logActivity(userId, 'identity.verified', 'user', userId, {});
        }
        break;
      }

      // ── Identity verification requires input (failed/needs retry) ──
      case 'identity.verification_session.requires_input': {
        const session = event.data.object;
        const userId = session.metadata?.user_id;
        if (userId) {
          await logActivity(userId, 'identity.requires_input', 'user', userId,
            { reason: session.last_error?.reason || null });
        }
        break;
      }

      // ── Checkout session completed (donation prepaid-label payments) ──
      case 'checkout.session.completed': {
        const session = event.data.object;
        const m = session.metadata || {};
        if (m.kind === 'donation' && session.payment_status === 'paid') {
          // Idempotency — skip if we already created this donation
          const existing = await db.query(
            `SELECT id FROM donations WHERE stripe_session_id = $1`, [session.id]
          );
          if (!existing.rows.length) {
            const genRef = () => {
              const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
              return `DON-${rand}-${Date.now().toString().slice(-4)}`;
            };
            const reference = genRef();
            const { rows } = await db.query(
              `INSERT INTO donations
                 (reference, donor_name, donor_email, donor_phone, shoe_description,
                  pair_count, notes, delivery_method, estimated_weight, shipping_fee,
                  shipping_paid, stripe_session_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'label',$8,$9,TRUE,$10)
               RETURNING *`,
              [
                reference, m.donor_name, m.donor_email, m.donor_phone || null,
                m.shoe_description || 'Donation', parseInt(m.pair_count) || 1, m.notes || null,
                m.estimated_weight ? parseFloat(m.estimated_weight) : null,
                m.shipping_fee ? parseFloat(m.shipping_fee) : 0, session.id,
              ]
            );
            const donation = rows[0];

            // Generate prepaid label via Royal Mail (graceful fallback if not configured)
            let labelUrl = null, trackingNumber = null, rmOrderId = null;
            try {
              const labelService = require('../services/label');
              const labelResult = await labelService.generateDonationLabel({
                reference, donor: { name: m.donor_name, email: m.donor_email },
                collectionAddress: null, pairCount: parseInt(m.pair_count) || 1,
                weightGrams: m.estimated_weight ? Math.round(parseFloat(m.estimated_weight) * 1000) : null,
              });
              labelUrl = labelResult ? String(labelResult) : null;
              trackingNumber = labelResult && labelResult.trackingNumber ? labelResult.trackingNumber : null;
              rmOrderId = labelResult && labelResult.orderIdentifier ? String(labelResult.orderIdentifier) : null;
              if (labelUrl) {
                await db.query(
                  'UPDATE donations SET label_url = $1, tracking_number = $2, rm_order_id = $3 WHERE id = $4',
                  [labelUrl, trackingNumber, rmOrderId, donation.id]
                );
              }
            } catch (e) { console.warn('Donation label gen failed:', e.message); }

            // Email donor the label
            try {
              const emailService = require('../services/email');
              await emailService.sendDonationConfirmation(
                { name: m.donor_name, email: m.donor_email }, donation, labelUrl
              );
            } catch (e) { console.warn('Donation email failed:', e.message); }

            await logActivity(null, 'donation.paid', 'donation', donation.id, {
              reference, shipping_fee: m.shipping_fee,
            });
          }
        }
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
