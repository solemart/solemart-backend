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
    // OAuth-only accounts have no password_hash — guide them to use their provider
    if (user && !user.password_hash) {
      return res.status(401).json({
        error: `This account uses ${user.oauth_provider ? user.oauth_provider.charAt(0).toUpperCase()+user.oauth_provider.slice(1) : 'social'} sign-in. Please use that button to log in.`,
      });
    }
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

// ══════════════════════════════════════════════════════════════
//  GOOGLE OAUTH (Sign in with Google)
// ══════════════════════════════════════════════════════════════
// Flow:
//   1. Frontend calls GET /oauth/google/status → gets the consent URL
//   2. Browser redirects to Google; user approves
//   3. Google redirects to GET /oauth/google/callback?code=...
//   4. We exchange the code for the user's identity, find-or-create
//      the account, mint our normal tokens, and redirect back to the
//      site with the tokens in the URL fragment.

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO  = 'https://www.googleapis.com/oauth2/v3/userinfo';

const backendBase = () =>
  process.env.BACKEND_URL || 'https://solemart-backend-production.up.railway.app';
const frontendBase = () =>
  process.env.APP_URL || 'https://beautifullyordered.co.uk';
const googleRedirectUri = () => `${backendBase()}/api/auth/oauth/google/callback`;

// GET /api/auth/oauth/google/status
// Tells the frontend whether Google is configured + returns the consent URL.
// Pass ?client=app to have the callback redirect back to the mobile app scheme.
router.get('/oauth/google/status', (req, res) => {
  const configured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  if (!configured) return res.json({ configured: false });

  const isApp = req.query.client === 'app';
  const params = new URLSearchParams({
    client_id:     process.env.GOOGLE_CLIENT_ID,
    redirect_uri:  googleRedirectUri(),
    response_type: 'code',
    scope:         'openid email profile',
    access_type:   'online',
    prompt:        'select_account',
    state:         isApp ? 'app' : 'web',
  });
  res.json({ configured: true, authUrl: `${GOOGLE_AUTH_URL}?${params.toString()}` });
});

// GET /api/auth/oauth/google/callback
router.get('/oauth/google/callback', async (req, res) => {
  const isApp = req.query.state === 'app';
  const appScheme = process.env.APP_SCHEME || 'kosmos';
  // Where to send the user back to: the mobile app (deep link) or the website.
  const successBase = isApp ? `${appScheme}://oauth` : `${frontendBase()}/#`;
  const fail = (msg) => isApp
    ? res.redirect(`${appScheme}://oauth?oauth_error=${encodeURIComponent(msg)}`)
    : res.redirect(`${frontendBase()}/?oauth_error=${encodeURIComponent(msg)}`);

  try {
    const { code, error } = req.query;
    if (error) return fail('Google sign-in was cancelled');
    if (!code)  return fail('No authorization code received');
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return fail('Google sign-in is not configured');
    }

    // 1. Exchange the code for tokens
    const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id:     process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri:  googleRedirectUri(),
        grant_type:    'authorization_code',
      }),
    });
    if (!tokenRes.ok) {
      const t = await tokenRes.text().catch(() => '');
      console.error('Google token exchange failed:', tokenRes.status, t);
      return fail('Could not verify Google sign-in');
    }
    const tokens = await tokenRes.json();

    // 2. Fetch the user's profile
    const infoRes = await fetch(GOOGLE_USERINFO, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!infoRes.ok) return fail('Could not read Google profile');
    const profile = await infoRes.json();
    // profile: { sub, email, email_verified, given_name, family_name, name, picture }

    const googleId   = profile.sub;
    const email       = (profile.email || '').toLowerCase();
    const emailVerified = profile.email_verified === true || profile.email_verified === 'true';
    const firstName  = profile.given_name || (profile.name || 'Member').split(' ')[0];
    const lastName   = profile.family_name || (profile.name || '').split(' ').slice(1).join(' ') || '';
    const avatar     = profile.picture || null;

    if (!email) return fail('Google did not provide an email');

    // 3. Find or create the account
    //    a) already linked by google id?
    let user = null;
    const byOauth = await db.query(
      `SELECT * FROM users WHERE oauth_provider = 'google' AND oauth_id = $1`,
      [googleId]
    );
    if (byOauth.rows.length) {
      user = byOauth.rows[0];
      // keep avatar fresh
      if (avatar && avatar !== user.avatar_url) {
        await db.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [avatar, user.id]);
      }
    } else {
      //    b) existing account with this email? → LINK (only if Google verified the email)
      const byEmail = await db.query(`SELECT * FROM users WHERE email = $1`, [email]);
      if (byEmail.rows.length) {
        if (!emailVerified) {
          return fail('Please sign in with your password to link Google to your account');
        }
        user = byEmail.rows[0];
        await db.query(
          `UPDATE users
           SET oauth_provider = 'google', oauth_id = $1,
               avatar_url = COALESCE($2, avatar_url),
               email_verified = TRUE
           WHERE id = $3`,
          [googleId, avatar, user.id]
        );
      } else {
        //  c) brand-new user
        const ins = await db.query(
          `INSERT INTO users (first_name, last_name, email, oauth_provider, oauth_id, avatar_url, email_verified)
           VALUES ($1, $2, $3, 'google', $4, $5, TRUE)
           RETURNING *`,
          [firstName, lastName, email, googleId, avatar]
        );
        user = ins.rows[0];
        // Welcome email (non-blocking)
        emailService.sendWelcome(user).catch(() => {});
      }
    }

    // 4. Mint our normal session tokens
    const accessToken  = generateAccessToken(user);
    const refreshToken = await generateRefreshToken(user.id);

    // 5. Redirect back with tokens. Website uses the URL fragment (#) so tokens
    //    never hit logs; the app uses its custom scheme (kosmos://oauth?...).
    //    For the app we use a query string because expo-linking parses query params.
    const params = new URLSearchParams({
      oauth: 'google',
      access: accessToken,
      refresh: refreshToken,
      uid: user.id,
      first: user.first_name || '',
      last: user.last_name || '',
      email: user.email,
      role: user.role,
    });
    if (isApp) {
      res.redirect(`${appScheme}://oauth?${params.toString()}`);
    } else {
      res.redirect(`${frontendBase()}/#${params.toString()}`);
    }
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    return fail('Sign-in failed, please try again');
  }
});

module.exports = router;
