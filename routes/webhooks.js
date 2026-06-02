const express = require('express');
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db      = require('../config/db');
const { logActivity } = require('../services/activityLog');
const emailService = require('../services/email');
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

      // ── Payment succeeded → CREATE the order (only paid orders ever exist) ──
      case 'payment_intent.succeeded': {
        const pi = event.data.object;
        const m = pi.metadata || {};

        // Only handle order payments here (donations handled in checkout.session.completed)
        if (m.kind !== 'order') break;

        // Idempotency: if we've already created this order, do nothing
        const existing = await db.query(
          `SELECT id FROM orders WHERE stripe_payment_intent_id = $1`, [pi.id]
        );
        if (existing.rows.length) {
          await logActivity(null, 'payment.succeeded.dup', 'order', existing.rows[0].id, {});
          break;
        }

        const isRent = m.order_type === 'rent';
        // Create the order row now that payment is confirmed
        const { rows } = await db.query(
          `INSERT INTO orders
             (reference, customer_id, shoe_id, order_type, status,
              unit_price, rental_days, subtotal, platform_fee, total,
              delivery_line1, delivery_line2, delivery_city, delivery_county, delivery_postcode,
              stripe_payment_intent_id, rental_start_date, rental_end_date, paid_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
           RETURNING *`,
          [
            m.reference, m.customer_id, m.shoe_id, m.order_type,
            isRent ? 'active_rental' : 'cleaning',     // paid rental is live; purchase goes to pre-dispatch clean
            parseFloat(m.unit_price || '0'),
            m.rental_days ? parseInt(m.rental_days) : null,
            parseFloat(m.subtotal || '0'),
            parseFloat(m.platform_fee || '0'),
            parseFloat(m.total || '0'),
            m.delivery_line1 || null, m.delivery_line2 || null,
            m.delivery_city || null, m.delivery_county || null, m.delivery_postcode || null,
            pi.id,
            m.rental_start || null, m.rental_end || null,
          ]
        );
        const order = rows[0];

        // Move the reserved shoe to its real sold/rented state + bump lifecycle count
        await db.query(
          `UPDATE shoes SET status = $1,
             rental_count = rental_count + $2,
             updated_at = NOW()
           WHERE id = $3`,
          [isRent ? 'rented' : 'sold', isRent ? 1 : 0, m.shoe_id]
        );

        // Owner payout (net of platform fee)
        await db.query(
          `INSERT INTO payouts (owner_id, order_id, amount, payout_type, status)
           SELECT s.owner_id, $1, $2, $3, 'pending'
           FROM shoes s WHERE s.id = $4`,
          [order.id, (order.subtotal * 0.85).toFixed(2),
           isRent ? 'rental' : 'sale', m.shoe_id]
        );

        // Confirmation email (now that payment is real)
        try {
          const { rows: uRows } = await db.query(`SELECT * FROM users WHERE id = $1`, [m.customer_id]);
          const { rows: sRows } = await db.query(`SELECT * FROM shoes WHERE id = $1`, [m.shoe_id]);
          if (uRows[0] && sRows[0]) emailService.sendOrderConfirmation(uRows[0], order, sRows[0]).catch(() => {});
        } catch {}

        await logActivity(null, 'order.paid', 'order', order.id, { amount: pi.amount, reference: m.reference });
        break;
      }

      // ── Payment failed → release the reserved shoe (no order was created) ──
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        const m = pi.metadata || {};
        if (m.kind === 'order' && m.shoe_id) {
          await db.query(
            `UPDATE shoes SET status = 'listed', updated_at = NOW()
             WHERE id = $1 AND status = 'reserved'`,
            [m.shoe_id]
          );
          await logActivity(null, 'order.payment_failed', 'shoe', m.shoe_id, { reference: m.reference });
        }
        break;
      }

      // ── Payment intent canceled/expired → release the reserved shoe ──
      case 'payment_intent.canceled': {
        const pi = event.data.object;
        const m = pi.metadata || {};
        if (m.kind === 'order' && m.shoe_id) {
          await db.query(
            `UPDATE shoes SET status = 'listed', updated_at = NOW()
             WHERE id = $1 AND status = 'reserved'`,
            [m.shoe_id]
          );
        }
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

      // ── Checkout session completed ──
      case 'checkout.session.completed': {
        const session = event.data.object;
        const m = session.metadata || {};

        // ORDER payments (website hosted-checkout) — create the paid orders now
        if (m.kind === 'order' && session.payment_status === 'paid') {
          // Idempotency: skip if any order already exists for this session's PI
          const piId = session.payment_intent;
          const existing = await db.query(
            `SELECT id FROM orders WHERE stripe_payment_intent_id = $1 LIMIT 1`, [piId]
          );
          if (existing.rows.length) break;

          let payload = [];
          let deliv = {};
          try { payload = JSON.parse(m.orders || '[]'); } catch {}
          try { deliv = JSON.parse(m.delivery || '{}'); } catch {}

          for (const o of payload) {
            const isRent = o.ot === 'rent';
            const reference = 'ORD-' + Math.random().toString(36).slice(2, 5).toUpperCase() + '-' + Date.now().toString().slice(-4);
            const rentalStart = isRent ? new Date() : null;
            const rentalEnd = isRent ? new Date(Date.now() + (o.rd || 7) * 86400000) : null;

            const { rows } = await db.query(
              `INSERT INTO orders
                 (reference, customer_id, shoe_id, order_type, status,
                  unit_price, rental_days, subtotal, platform_fee, total,
                  delivery_line1, delivery_line2, delivery_city, delivery_postcode,
                  stripe_payment_intent_id, rental_start_date, rental_end_date, paid_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW())
               RETURNING *`,
              [
                reference, m.user_id, o.sid, o.ot,
                isRent ? 'active_rental' : 'cleaning',
                o.up, isRent ? o.rd : null, o.st, o.pf, o.tot,
                deliv.l1 || null, deliv.l2 || null, deliv.c || 'London', deliv.pc || null,
                piId, rentalStart, rentalEnd,
              ]
            );
            const order = rows[0];

            // Shoe → sold/rented + lifecycle bump
            await db.query(
              `UPDATE shoes SET status = $1, rental_count = rental_count + $2, updated_at = NOW() WHERE id = $3`,
              [isRent ? 'rented' : 'sold', isRent ? 1 : 0, o.sid]
            );
            // Owner payout
            await db.query(
              `INSERT INTO payouts (owner_id, order_id, amount, payout_type, status)
               SELECT s.owner_id, $1, $2, $3, 'pending' FROM shoes s WHERE s.id = $4`,
              [order.id, (order.subtotal * 0.85).toFixed(2), isRent ? 'rental' : 'sale', o.sid]
            );
            // Confirmation email
            try {
              const { rows: u } = await db.query(`SELECT * FROM users WHERE id = $1`, [m.user_id]);
              const { rows: s } = await db.query(`SELECT * FROM shoes WHERE id = $1`, [o.sid]);
              if (u[0] && s[0]) emailService.sendOrderConfirmation(u[0], order, s[0]).catch(() => {});
            } catch {}
            await logActivity(null, 'order.paid', 'order', order.id, { reference });
          }
          break;
        }

        // DONATION prepaid-label payments
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

      // ── Checkout session expired/abandoned → release reserved shoes ──
      case 'checkout.session.expired': {
        const session = event.data.object;
        const m = session.metadata || {};
        if (m.kind === 'order') {
          let payload = [];
          try { payload = JSON.parse(m.orders || '[]'); } catch {}
          for (const o of payload) {
            await db.query(
              `UPDATE shoes SET status = 'listed', updated_at = NOW() WHERE id = $1 AND status = 'reserved'`,
              [o.sid]
            );
          }
          await logActivity(null, 'checkout.expired', 'user', m.user_id, { items: payload.length });
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
