require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./routes/auth');
const assetRoutes = require('./routes/assets');
const userRoutes = require('./routes/users');
const shoeRoutes = require('./routes/shoes');
const submissionRoutes = require('./routes/submissions');
const orderRoutes = require('./routes/orders');
const cleanRoutes = require('./routes/cleans');
const reviewRoutes = require('./routes/reviews');
const adminRoutes = require('./routes/admin');
const payoutRoutes = require('./routes/payouts');
const postcodeRoutes = require('./routes/postcodes');
const channelRoutes = require('./routes/channels');
const donationRoutes = require('./routes/donations');
const webhookRoutes = require('./routes/webhooks');
const wishlistRoutes = require('./routes/wishlist');
const stripeConnectRoutes = require('./routes/stripe_connect');
const newsletterRoutes = require('./routes/newsletter');
const verificationRoutes = require('./routes/verification');
const messageRoutes = require('./routes/messages');
const intakeRoutes = require('./routes/intake');
const errorHandler = require('./middleware/errorHandler');
const logger = require('./config/logger');
const app = express();
const PORT = process.env.PORT || 3001;

// Trust the platform proxy (Railway) so req.protocol reflects the real scheme.
app.set('trust proxy', 1);

// Force HTTPS in production: if a request DEFINITELY arrives over plain HTTP,
// redirect it to HTTPS so credentials/PII are never sent in clear text.
// We only redirect when x-forwarded-proto is explicitly "http" — never when the
// header is missing/ambiguous (avoids redirect loops + spurious null origins on
// proxied API calls). OPTIONS preflight requests are passed straight through.
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS') return next();
    // header may be a comma-separated list ("https,http") — take the first hop
    const fwd = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
    if (fwd === 'http') {
      return res.redirect(301, 'https://' + req.headers.host + req.originalUrl);
    }
    next();
  });
}
// Security headers, including a strong HSTS policy (2 years, include subdomains,
// preload) telling browsers to only ever connect to us over HTTPS.
app.use(helmet({
  crossOriginResourcePolicy: false,
  hsts: {
    maxAge: 63072000,        // 2 years
    includeSubDomains: true,
    preload: true,
  },
}));
const allowedOrigins = [
  'https://beautifullyordered.co.uk',
  'https://www.beautifullyordered.co.uk',
  'https://beautifullyordered.com',
  'https://www.beautifullyordered.com',
  'https://kosmos.netlify.app',
  'http://localhost:8081',
  'http://localhost:19006',
];
const path = require('path');
   app.get('/.well-known/apple-developer-domain-association.txt', (req, res) => {
     res.type('text/plain').sendFile(path.join(__dirname, 'apple-developer-domain-association.txt'));
   });
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no browser origin: native app, server-to-server,
    // and the literal string "null" that browsers send after a redirect or
    // from privacy-sandboxed contexts.
    if (!origin || origin === 'null' || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else if (/^https:\/\/.*\.netlify\.app$/.test(origin)) {
      // Any *.netlify.app preview URL
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS: ' + origin));
    }
  },
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  optionsSuccessStatus: 200,
}));
app.options('*', cors());
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), webhookRoutes);
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ limit: '25mb', extended: true }));
app.use(express.urlencoded({ extended: true }));
if (process.env.NODE_ENV !== 'test') { app.use(morgan('combined', { stream: { write: (msg) => logger.info(msg.trim()) } })); }
const globalLimiter = rateLimit({ windowMs: 15*60*1000, max: 100, standardHeaders: true, legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, message: { error: 'Too many auth attempts.' } });
app.use('/api', globalLimiter);
app.use('/api/auth', authLimiter);
app.use('/api/assets', assetRoutes);
app.get('/health', (req, res) => { res.json({ status: 'ok', env: process.env.NODE_ENV, ts: new Date().toISOString() }); });

// Public — non-sensitive settings the frontend uses for display
app.get('/api/config', async (req, res) => {
  try {
    const settings = require('./services/settings');
    const all = await settings.getSettings();
    res.json({
      platform_fee_percent:    all.platform_fee_percent,
      cleaning_fee_amount:     all.cleaning_fee_amount,
      owner_share_percent:     all.owner_share_percent,
      treasures_max_price:     all.treasures_max_price,
      min_rental_days:         all.min_rental_days,
      max_rental_days:         all.max_rental_days,
      rental_default_days:     all.rental_default_days,
      delivery_fee_amount:     all.delivery_fee_amount,
      free_delivery_threshold: all.free_delivery_threshold,
      listing_label_fee:           all.listing_label_fee || '4.99',
      listing_label_charge_method: all.listing_label_charge_method || 'payout_deduction',
    });
  } catch (e) { res.json({}); }
});
app.use('/api/auth',        authRoutes);
app.use('/api/users',       userRoutes);
app.use('/api/shoes',       shoeRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/orders',      orderRoutes);
app.use('/api/cleans',      cleanRoutes);
app.use('/api/reviews',     reviewRoutes);
app.use('/api/admin',       adminRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/admin/intake', intakeRoutes);
app.use('/api/payouts',     payoutRoutes);
app.use('/api/wishlist',   wishlistRoutes);
app.use('/api/stripe',    stripeConnectRoutes);
app.use('/api/newsletter', newsletterRoutes);
app.use('/api/verification', verificationRoutes);
app.use('/api/postcodes',   postcodeRoutes);
app.use('/api/channels',    channelRoutes);
app.use('/api/donations',   donationRoutes);
app.use((req, res) => { res.status(404).json({ error: 'Route not found' }); });
app.use(errorHandler);
// ── DAILY LATE FEE PROCESSING ─────────────────────────────────────────────────
const { processLateFees } = require('./services/lateFees');

// Run once on startup (after 30 second delay), then every 24 hours
setTimeout(() => {
  processLateFees().catch(err => logger.error('Late fee job error:', err));
  setInterval(() => {
    processLateFees().catch(err => logger.error('Late fee job error:', err));
  }, 24 * 60 * 60 * 1000);
}, 30 * 1000);

// ── WEEKLY EDIT CURATION (Thursdays 06:00 UTC) ────────────────────────────────
const theEdit = require('./services/theEdit');

function scheduleNextEditCuration() {
  const now = new Date();
  const next = new Date(now);
  const day = next.getUTCDay(); // 4 = Thursday
  let daysUntilThursday = (4 - day + 7) % 7;
  // If today is Thursday and it's already past 06:00 UTC, go to next Thursday
  if (daysUntilThursday === 0 && now.getUTCHours() >= 6) {
    daysUntilThursday = 7;
  }
  next.setUTCDate(now.getUTCDate() + daysUntilThursday);
  next.setUTCHours(6, 0, 0, 0);
  const msUntil = next.getTime() - now.getTime();
  logger.info(`Next Edit curation: ${next.toISOString()} (in ${(msUntil/3600000).toFixed(1)}h)`);
  setTimeout(async () => {
    try {
      await theEdit.recurateEdit();
      logger.info('✨ Weekly Edit auto-curated');
    } catch (e) {
      logger.error('Edit curation failed:', e);
    }
    scheduleNextEditCuration();
  }, msUntil);
}
// Kick off scheduler 60 seconds after server start
setTimeout(scheduleNextEditCuration, 60 * 1000);

app.listen(PORT, () => { logger.info(`Kosmos API running on port ${PORT} [${process.env.NODE_ENV}]`); });
module.exports = app;
