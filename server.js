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
const channelRoutes     = require('./routes/channels');
const webhookRoutes     = require('./routes/webhooks');
const errorHandler      = require('./middleware/errorHandler');
const logger            = require('./config/logger');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin: '*',
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  optionsSuccessStatus: 200,
}));
app.options('*', cors());

app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }), webhookRoutes);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('combined', {
    stream: { write: (msg) => logger.info(msg.trim()) },
  }));
}

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many auth attempts.' },
});

app.use('/api', globalLimiter);
app.use('/api/auth', authLimiter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', env: process.env.NODE_ENV, ts: new Date().toISOString() });
});

app.use('/api/auth',        authRoutes);
app.use('/api/users',       userRoutes);
app.use('/api/shoes',       shoeRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/orders',      orderRoutes);
app.use('/api/cleans',      cleanRoutes);
app.use('/api/revi


