// ============================================================
//  stripe.js — Stripe service wrapper
// ============================================================
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const createPaymentIntent = async ({ amount, currency = 'gbp', metadata = {} }) => {
  return stripe.paymentIntents.create({
    amount,       // in pence
    currency,
    metadata,
    automatic_payment_methods: { enabled: true },
  });
};

const createRefund = async (paymentIntentId, amountPence) => {
  return stripe.refunds.create({
    payment_intent: paymentIntentId,
    amount: amountPence,
  });
};

module.exports = { createPaymentIntent, createRefund };
