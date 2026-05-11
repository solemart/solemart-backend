const express   = require('express');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { body, validationResult } = require('express-validator');

const db             = require('../config/db');
const { authenticate } = require('../middleware/auth');
const emailService   = require('../services/email');
const router         = express.Router();

const generateAccessToken = (user) =>
  jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );

const generateRefreshToken = async (userId) => {
  const token = uuid();
  const hash  = await bcrypt.hash(token, 6);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  await db.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hash, expiresAt]
  );
  return token;
};

// POST /api/auth/register
router.post('/register', [
  body('first_name').trim().notEmpty(),
  body('last_name').trim().notEmpty(),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
    const { first_name, last_name, email, password } = req.body;
    const password_hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS) || 12);
    const { rows } = await db.query(
      `INSERT INTO users (first_name, last_name, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, first_name, last_name, email, role`,
      [first_name, last_name, email, password_hash]
    );
    const user = rows[0];
    const accessToken  = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user.id);
    emailService.sendWelcome(user).catch(console.error);
    res.status(201).json({ user, accessToken, refreshToken });
  } catch (err) { next(err); }
});

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });
    const { email, password } = req.body;
    const { rows } = await db.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    const accessToken  = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user.id);
    const { password_hash, ...safeUser } = user;
    res.json({ user: safeUser, accessToken, refreshToken });
  } catch (err) { next(err); }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'Refresh token required' });
    const { rows } = await db.query(
      `SELECT rt.*, u.id as uid, u.role, u.email, u.first_name, u.last_name
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.expires_at > NOW() AND rt.revoked = FALSE
       ORDER BY rt.created_at DESC LIMIT 50`
    );
    let matchedRow = null;
    for (const row of rows) {
      if (await bcrypt.compare(refreshToken, row.token_hash)) { matchedRow = row; break; }
    }
    if (!matchedRow) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE id = $1', [matchedRow.id]);
    const user = { id: matchedRow.uid, role: matchedRow.role, email: matchedRow.email, first_name: matchedRow.first_name, last_name: matchedRow.last_name };
    const newAccessToken  = generateAccessToken(user);
    const newRefreshToken = await generateRefreshToken(user.id);
    res.json({ accessToken: newAccessToken, refreshToken: newRefreshToken });
  } catch (err) { next(err); }
});

// POST /api/auth/logout
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    await db.query('UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1', [req.user.id]);
    res.json({ message: 'Logged out successfully' });
  } catch (err) { next(err); }
});

// GET /api/auth/me
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
  } catch (err) { next(err); }
});

module.exports = router;
