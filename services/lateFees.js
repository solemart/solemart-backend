// services/lateFees.js — Daily job to charge late return fees
const db = require('../config/db');
const logger = require('../config/logger');

async function processLateFees() {
  if (!process.env.STRIPE_SECRET_KEY) {
    logger.info('Late fee job skipped — Stripe not configured');
    return;
  }
  const { stripe } = require('./stripe');
  const settings = require('./settings');

  // Load dynamic settings
  const graceHours = await settings.getLateFeeGraceHours();
  const capMultiplier = await settings.getLateFeeCapMultiplier();
  const platformFeePercent = await settings.getPlatformFeePercent();

  // Find rentals past their end date + grace period
  const { rows: lateOrders } = await db.query(`
    SELECT o.*,
           s.brand, s.model, s.owner_id, s.rent_price, s.buy_price,
           u.email, u.first_name, u.stripe_customer_id,
           owner.stripe_account_id AS owner_stripe_id
    FROM orders o
    JOIN shoes s ON s.id = o.shoe_id
    JOIN users u ON u.id = o.customer_id
    LEFT JOIN users owner ON owner.id = s.owner_id
    WHERE o.order_type = 'rent'
      AND o.status = 'active_rental'
      AND o.rental_end_date < (NOW() - ($1 || ' hours')::INTERVAL)
      AND (o.late_fee_paused IS NOT TRUE)
      AND o.stripe_payment_intent_id IS NOT NULL
  `, [graceHours]);

  logger.info(`Late fee job: ${lateOrders.length} overdue rentals to process (grace: ${graceHours}h)`);

  for (const order of lateOrders) {
    try {
      // Skip if no saved payment method
      if (!order.stripe_customer_id) {
        logger.warn(`Order ${order.reference}: no Stripe customer — skipping`);
        continue;
      }

      // Calculate days late since last charge (or rental end date)
      const lastChargeAt = order.last_late_fee_at || order.rental_end_date;
      const hoursSince = (Date.now() - new Date(lastChargeAt).getTime()) / 36e5;
      const fullDaysSince = Math.floor(hoursSince / 24);

      if (fullDaysSince < 1) continue; // Less than a day since last charge

      const dailyRate = parseFloat(order.rent_price);
      const lateFeeAmount = dailyRate * fullDaysSince;

      // Cap total late fees at shoe buy_price × multiplier (replacement value)
      const alreadyCharged = parseFloat(order.late_fees_charged || 0);
      const maxFee = parseFloat(order.buy_price || order.subtotal * 3) * capMultiplier;
      const remainingCap = maxFee - alreadyCharged;
      const finalAmount = Math.min(lateFeeAmount, remainingCap);

      if (finalAmount <= 0) {
        logger.info(`Order ${order.reference}: cap reached, pausing`);
        await db.query(`UPDATE orders SET late_fee_paused = TRUE WHERE id = $1`, [order.id]);
        continue;
      }

      // Get default payment method from customer
      const customer = await stripe.customers.retrieve(order.stripe_customer_id);
      let pmId = customer.invoice_settings?.default_payment_method;

      if (!pmId) {
        // Try the first saved payment method
        const methods = await stripe.paymentMethods.list({
          customer: order.stripe_customer_id,
          type: 'card',
          limit: 1,
        });
        pmId = methods.data[0]?.id;
      }

      if (!pmId) {
        logger.warn(`Order ${order.reference}: no saved payment method`);
        continue;
      }

      // Charge the late fee — off-session
      const piParams = {
        amount: Math.round(finalAmount * 100),
        currency: 'gbp',
        customer: order.stripe_customer_id,
        payment_method: pmId,
        off_session: true,
        confirm: true,
        description: `Kosmos late return fee — ${fullDaysSince} day(s) × £${dailyRate.toFixed(2)} — ${order.reference}`,
        metadata: {
          order_id: order.id,
          order_ref: order.reference,
          late_days: fullDaysSince,
          type: 'late_fee',
        },
      };

      // Split with owner if they have Connect account
      if (order.owner_stripe_id) {
        const platformFeePence = Math.round(piParams.amount * (platformFeePercent / 100));
        piParams.transfer_data = { destination: order.owner_stripe_id, amount: piParams.amount - platformFeePence };
        piParams.application_fee_amount = platformFeePence;
      }

      const pi = await stripe.paymentIntents.create(piParams);

      // Update order with charged amount
      await db.query(`
        UPDATE orders
        SET late_fees_charged = COALESCE(late_fees_charged, 0) + $1,
            last_late_fee_at = NOW()
        WHERE id = $2
      `, [finalAmount, order.id]);

      logger.info(`Late fee charged: ${order.reference} — £${finalAmount.toFixed(2)} (${fullDaysSince} days late)`);

      // Send email notification
      try {
        const email = require('./email');
        if (email.sendLateFeeChargedEmail) {
          await email.sendLateFeeChargedEmail(order.email, order.first_name, {
            reference: order.reference,
            brand: order.brand, model: order.model,
            days: fullDaysSince, amount: finalAmount,
          });
        }
      } catch (e) { logger.warn('Late fee email failed:', e.message); }

    } catch (err) {
      logger.error(`Late fee failed for ${order.reference}: ${err.message}`);
      // If card was declined, pause future charges and notify admin
      if (err.code === 'authentication_required' || err.code === 'card_declined') {
        await db.query(`UPDATE orders SET late_fee_paused = TRUE WHERE id = $1`, [order.id]);
      }
    }
  }
}

module.exports = { processLateFees };
