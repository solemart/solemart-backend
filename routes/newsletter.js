// routes/newsletter.js — Newsletter signups
const express = require('express');
const { body, validationResult } = require('express-validator');
const db      = require('../config/db');
const logger  = require('../config/logger');
const router  = express.Router();

// POST /api/newsletter/subscribe — public endpoint
router.post('/subscribe', [
  body('email').isEmail().normalizeEmail(),
  body('source').optional().isString(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ error: 'Invalid email' });

    const { email, source } = req.body;

    // Create table if it doesn't exist
    await db.query(`
      CREATE TABLE IF NOT EXISTS newsletter_subscribers (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email        VARCHAR(255) UNIQUE NOT NULL,
        source       VARCHAR(100),
        confirmed    BOOLEAN DEFAULT TRUE,
        unsubscribed BOOLEAN DEFAULT FALSE,
        ip_address   VARCHAR(45),
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        unsubscribed_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_newsletter_email ON newsletter_subscribers(email);
    `);

    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.connection?.remoteAddress || null;

    await db.query(
      `INSERT INTO newsletter_subscribers (email, source, ip_address)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET unsubscribed = FALSE, unsubscribed_at = NULL`,
      [email, source || 'website', ip]
    );

    logger.info(`Newsletter subscription: ${email} (source: ${source || 'website'})`);

    // Send welcome email via Resend (best effort — don't fail signup if email fails)
    try {
      const emailService = require('../services/email');
      if (emailService.sendNewsletterWelcome) {
        await emailService.sendNewsletterWelcome(email);
      }
    } catch (e) {
      logger.warn('Newsletter welcome email failed:', e.message);
    }

    res.json({ ok: true, message: "You're on the list!" });
  } catch (err) { next(err); }
});

// POST /api/newsletter/unsubscribe
router.post('/unsubscribe', [
  body('email').isEmail().normalizeEmail(),
], async (req, res, next) => {
  try {
    const { email } = req.body;
    await db.query(
      `UPDATE newsletter_subscribers SET unsubscribed = TRUE, unsubscribed_at = NOW() WHERE email = $1`,
      [email]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
