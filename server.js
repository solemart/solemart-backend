require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');

const authRoutes        = require('./routes/auth');
const userRoutes        = require('./routes/users');
const shoeRoutes        = require('./routes/shoes');
const submissionRoutes  = require('./routes/submissions');
const orderRoutes       = require('./routes/orders');
const cleanRoutes       = require('./routes/cleans');
const reviewRoutes      = require('./routes/reviews');
const adminRoutes       = require('./routes/admin');
const payoutRoutes      = require('./routes/payouts');
const postcodeRoutes    = require('./routes/postcodes');
const webhookRoutes     = require('./routes/webhooks');
const errorHandler      = require('./middleware/errorHandler');
const logger            = require('./config/logger');

const app  = express();
const PORT = process.env.PORT || 3001;

// ── SECURITY ──────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGINS?.split(',') || '*',
  credentials: true,
}));

// ── STRIPE WEBHOOKS (raw body needed before JSON parser) ──────
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), webhookRoutes);

// ── BODY PARSING ──────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── LOGGING ───────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (msg) => logger.info(msg.trim()) },
  }));
}

// ── RATE LIMITING ─────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      parseInt(process.env.AUTH_RATE_LIMIT_MAX) || 10,
  message:  { error: 'Too many auth attempts — please try again later.' },
});

app.use('/api', globalLimiter);
app.use('/api/auth', authLimiter);

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV, ts: new Date().toISOString() });
});

// ── ROUTES ────────────────────────────────────────────────────
app.use('/api/auth',        authRoutes);
app.use('/api/users',       userRoutes);
app.use('/api/shoes',       shoeRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/orders',      orderRoutes);
app.use('/api/cleans',      cleanRoutes);
app.use('/api/reviews',     reviewRoutes);
app.use('/api/admin',       adminRoutes);
app.use('/api/payouts',     payoutRoutes);
app.use('/api/postcodes',   postcodeRoutes);

// ── 404 HANDLER ───────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── ERROR HANDLER ─────────────────────────────────────────────
app.use(errorHandler);

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`SoleMart API running on port ${PORT} [${process.env.NODE_ENV}]`);
});

module.exports = app;
