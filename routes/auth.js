const jwt     = require('jsonwebtoken');
const db      = require('../config/db');

/**
 * Verifies the Bearer token and attaches req.user.
 * Throws 401 if missing or invalid.
 */
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = header.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Confirm user still exists and is not deleted
    const { rows } = await db.query(
      'SELECT id, email, role, first_name, last_name FROM users WHERE id = $1',
      [payload.sub]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'User no longer exists' });
    }

    req.user = rows[0];
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

/**
 * Role-based access guard.
 * Usage: requireRole('admin') or requireRole('staff', 'admin')
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  next();
};

/**
 * Optional auth — attaches req.user if token present but doesn't fail if not.
 * Useful for public routes that behave differently when logged in.
 */
const optionalAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return next();

    const token = header.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await db.query(
      'SELECT id, email, role, first_name, last_name FROM users WHERE id = $1',
      [payload.sub]
    );
    if (rows.length) req.user = rows[0];
  } catch {
    // Silently ignore invalid/expired tokens on optional routes
  }
  next();
};

module.exports = { authenticate, requireRole, optionalAuth };
