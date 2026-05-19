const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');

const db             = require('../config/db');
const { authenticate } = require('../middleware/auth');
const emailService   = require('../services/email');
const router         = express.Router();

// ── HELPERS ───────────────────────────────────────────────────
const generateAccessToken = (user) =>
  jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );

const generateRefreshToken = async (userId) => {
  const token = uuid();
  const hash  = await bcrypt.hash(token, 6); // lighter hash for refresh tokens
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);

  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hash, expiresAt]
  );
  return token;
};

// ── POST /api/auth/register ───────────────────────────────────
router.post('/register', [
  body('first_name').trim().notEmpty().withMessage('First name required'),
  body('last_name').trim().notEmpty().withMessage('Last name required'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ errors: errors.array() });
    }

    const { first_name, last_name, email, password } = req.body;
    const password_hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);

    const { rows } = await db.query(
      `INSERT INTO users (first_name, last_name, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, first_name, last_name, email, role`,
      [first_name, last_name, email, password_hash]
    );

    const user         = rows[0];
    const accessToken  = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user.id);

    // Send welcome email (non-blocking)
    emailService.sendWelcome(user).catch(console.error);

    res.status(201).json({ user, accessToken, refreshToken });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ errors: errors.array() });
    }

    const { email, password } = req.body;
    const { rows } = await db.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const accessToken  = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user.id);

    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser, accessToken, refreshToken });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(400).json({ error: 'Refresh token required' });
    }

    // Find valid, non-expired, non-revoked tokens for comparison
    const { rows } = await db.query(
      `SELECT rt.*, u.id as uid, u.role, u.email, u.first_name, u.last_name
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.expires_at > NOW() AND rt.revoked = FALSE
       ORDER BY rt.created_at DESC
       LIMIT 50`
    );

    // Find matching token by comparing hashes
    let matchedRow = null;
    for (const row of rows) {
      if (await bcrypt.compare(refreshToken, row.token_hash)) {
        matchedRow = row;
        break;
      }
    }

    if (!matchedRow) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Revoke old token (rotation)
    await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1', [matchedRow.id]);

    const user = {
      id: matchedRow.uid,
      role: matchedRow.role,
      email: matchedRow.email,
      first_name: matchedRow.first_name,
      last_name: matchedRow.last_name,
    };

    const newAccessToken  = generateAccessToken(user);
    const newRefreshToken = await generateRefreshToken(user.id);

    res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    // Revoke all refresh tokens for this user
    await db.query(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});

// ── GET /api/auth/me ──────────────────────────────────────────
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, email, phone, role,
              addr_line1, addr_line2, addr_city, addr_county, addr_postcode,
              shoe_size, email_verified, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { email } = req.body;
    const { rows } = await db.query(`SELECT id, first_name FROM users WHERE email = $1`, [email]);

    // Always return success — don't reveal whether email exists (security)
    if (rows.length) {
      const user = rows[0];
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

      await db.query(
        `INSERT INTO password_resets (user_id, code, expires_at)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET code=$2, expires_at=$3, created_at=NOW()`,
        [user.id, code, expires]
      );

      // Send the email via Resend / SMTP (best effort)
      try {
        const emailService = require('../services/email');
        await emailService.sendPasswordResetEmail(email, user.first_name, code);
      } catch (e) {
        console.error('Could not send password reset email:', e.message);
      }
    }

    res.json({ ok: true, message: 'If an account exists with that email, a reset code has been sent.' });
  } catch (err) { next(err); }
});

// ── POST /api/auth/verify-reset-code ──────────────────────────────────────────
router.post('/verify-reset-code', [
  body('email').isEmail().normalizeEmail(),
  body('code').isLength({ min: 6, max: 6 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { email, code } = req.body;
    const { rows } = await db.query(
      `SELECT pr.user_id, pr.expires_at
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE u.email = $1 AND pr.code = $2`,
      [email, code]
    );

    if (!rows.length) return res.status(400).json({ error: 'Invalid code' });
    if (new Date(rows[0].expires_at) < new Date()) return res.status(400).json({ error: 'Code expired' });

    res.json({ ok: true, userId: rows[0].user_id });
  } catch (err) { next(err); }
});

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
router.post('/reset-password', [
  body('email').isEmail().normalizeEmail(),
  body('code').isLength({ min: 6, max: 6 }),
  body('newPassword').isLength({ min: 8 }).withMessage('Password must be 8+ characters'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { email, code, newPassword } = req.body;
    const { rows } = await db.query(
      `SELECT pr.user_id, pr.expires_at
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE u.email = $1 AND pr.code = $2`,
      [email, code]
    );

    if (!rows.length) return res.status(400).json({ error: 'Invalid code' });
    if (new Date(rows[0].expires_at) < new Date()) return res.status(400).json({ error: 'Code expired' });

    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(newPassword, 10);
    await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, rows[0].user_id]);
    await db.query(`DELETE FROM password_resets WHERE user_id = $1`, [rows[0].user_id]);

    res.json({ ok: true, message: 'Password reset successfully' });
  } catch (err) { next(err); }
});

module.exports = router;
