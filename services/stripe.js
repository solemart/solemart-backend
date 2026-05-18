// services/stripe.js
const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const PLATFORM_FEE  = 0.15;
const CLEANING_FEE  = 800; // £8.00 in pence

// ── CREATE CONNECTED ACCOUNT ──────────────────────────────────────────────────
async function createConnectedAccount(user) {
  return await stripe.accounts.create({
    type: 'express',
    country: 'GB',
    email: user.email,
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    business_type: 'individual',
    individual: { first_name: user.first_name, last_name: user.last_name, email: user.email },
    metadata: { kosmos_user_id: user.id },
  });
}

// ── ONBOARDING LINK ───────────────────────────────────────────────────────────
async function createOnboardingLink(stripeAccountId, userId) {
  const link = await stripe.accountLinks.create({
    account: stripeAccountId,
    refresh_url: `${process.env.APP_URL}/api/stripe/connect/refresh?userId=${userId}`,
    return_url:  `${process.env.APP_URL}/api/stripe/connect/return?userId=${userId}`,
    type: 'account_onboarding',
  });
  return link.url;
}

// ── ACCOUNT STATUS ────────────────────────────────────────────────────────────
async function getAccountStatus(stripeAccountId) {
  const account = await stripe.accounts.retrieve(stripeAccountId);
  return {
    chargesEnabled:   account.charges_enabled,
    payoutsEnabled:   account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    requirements:     account.requirements,
  };
}

// ── CREATE PAYMENT INTENT ─────────────────────────────────────────────────────
async function createPaymentIntent({ amount, currency='gbp', shoeId, orderId, ownerStripeId, orderType }) {
  const amountPence    = Math.round(amount * 100);
  const cleaningPence  = orderType === 'rent' ? CLEANING_FEE : 0;
  const netAmount      = amountPence - cleaningPence;
  const platformPence  = Math.round(netAmount * PLATFORM_FEE);
  const ownerPence     = netAmount - platformPence;

  const params = {
    amount: amountPence,
    currency,
    metadata: { shoeId, orderId, orderType },
    automatic_payment_methods: { enabled: true },
  };

  if (ownerStripeId) {
    params.transfer_data        = { destination: ownerStripeId, amount: ownerPence };
    params.application_fee_amount = platformPence + cleaningPence;
  }

  const pi = await stripe.paymentIntents.create(params);
  return {
    clientSecret:    pi.client_secret,
    paymentIntentId: pi.id,
    breakdown: {
      gross:         amountPence / 100,
      cleaningFee:   cleaningPence / 100,
      platformFee:   platformPence / 100,
      ownerEarnings: ownerPence / 100,
    },
  };
}

// ── OWNER BALANCE ─────────────────────────────────────────────────────────────
async function getOwnerBalance(stripeAccountId) {
  const balance = await stripe.balance.retrieve({ stripeAccount: stripeAccountId });
  return {
    available: balance.available.map(b => ({ amount: b.amount / 100, currency: b.currency })),
    pending:   balance.pending.map(b =>   ({ amount: b.amount / 100, currency: b.currency })),
  };
}

// ── OWNER TRANSACTIONS ────────────────────────────────────────────────────────
async function getOwnerTransactions(stripeAccountId, limit=50) {
  const transfers = await stripe.transfers.list({ destination: stripeAccountId, limit });
  return transfers.data.map(t => ({
    id:       t.id,
    amount:   t.amount / 100,
    currency: t.currency,
    created:  new Date(t.created * 1000).toISOString(),
    metadata: t.metadata,
  }));
}

// ── WEBHOOK ───────────────────────────────────────────────────────────────────
function constructWebhookEvent(payload, signature) {
  return stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

module.exports = {
  stripe,
  createConnectedAccount,
  createOnboardingLink,
  getAccountStatus,
  createPaymentIntent,
  getOwnerBalance,
  getOwnerTransactions,
  constructWebhookEvent,
};
