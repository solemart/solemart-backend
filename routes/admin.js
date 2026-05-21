const express = require('express');
const { body, validationResult } = require('express-validator');
const db      = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const emailService = require('../services/email');
const { logActivity } = require('../services/activityLog');
const router  = express.Router();

// All admin routes require authentication + staff or admin role
router.use(authenticate, requireRole('staff', 'admin'));

// ── GET /api/admin/dashboard ──────────────────────────────────
router.get('/dashboard', async (req, res, next) => {
  try {
    const [shoes, orders, cleans, submissions, revenue] = await Promise.all([
      db.query(`SELECT status, COUNT(*) FROM shoes GROUP BY status`),
      db.query(`SELECT status, COUNT(*) FROM orders GROUP BY status`),
      db.query(`SELECT status, COUNT(*) FROM clean_bookings GROUP BY status`),
      db.query(`SELECT status, COUNT(*) FROM listing_submissions GROUP BY status`),
      db.query(`SELECT
                  SUM(platform_fee) AS total_platform_fees,
                  SUM(total)        AS gross_revenue,
                  COUNT(*)          AS total_orders
                FROM orders WHERE paid_at IS NOT NULL`),
    ]);

    res.json({
      shoes:       shoes.rows,
      orders:      orders.rows,
      cleans:      cleans.rows,
      submissions: submissions.rows,
      revenue:     revenue.rows[0],
    });
  } catch (err) { next(err); }
});

// ── GET /api/admin/queue ── intake processing queue ───────────
router.get('/queue', async (req, res, next) => {
  try {
    const { stage } = req.query; // authenticating | cleaning | submitted | all

    let where = `s.status NOT IN ('listed','sold','returned_to_owner','rejected')`;
    if (stage && stage !== 'all') where += ` AND s.status = '${stage}'`;

    const { rows } = await db.query(
      `SELECT s.*, u.first_name, u.last_name, u.email,
              ls.reference AS submission_ref, ls.collection_postcode
       FROM shoes s
       JOIN users u ON u.id = s.owner_id
       LEFT JOIN submission_shoes ss ON ss.shoe_id = s.id
       LEFT JOIN listing_submissions ls ON ls.id = ss.submission_id
       WHERE ${where}
       ORDER BY s.submitted_at ASC`,
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── POST /api/admin/shoes/:id/authenticate ────────────────────
router.post('/shoes/:id/authenticate', [
  body('auth_score').isInt({ min: 0, max: 100 }),
  body('auth_grade').isIn(['A+','A','B+','B','C','D']),
  body('auth_notes').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { auth_score, auth_grade, auth_notes } = req.body;

    const { rows } = await db.query(
      `UPDATE shoes
       SET auth_score = $1, auth_grade = $2, auth_notes = $3,
           auth_by = $4, auth_at = NOW(),
           status = 'cleaning', updated_at = NOW()
       WHERE id = $5 AND status = 'authenticating'
       RETURNING *`,
      [auth_score, auth_grade, auth_notes || null, req.user.id, req.params.id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Shoe not found or not in authenticating state' });

    await logActivity(req.user.id, 'shoe.authenticated', 'shoe', req.params.id, {
      auth_score, auth_grade,
    });

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/shoes/:id/clean ───────────────────────────
router.post('/shoes/:id/clean', [
  body('clean_method').trim().notEmpty(),
  body('clean_notes').optional().trim(),
  body('outgoing_condition').isIn(['Brand New','Like New','Very Good','Good','Fair']),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { clean_method, clean_notes, outgoing_condition } = req.body;

    const { rows } = await db.query(
      `UPDATE shoes
       SET clean_method = $1, clean_notes = $2, condition = $3,
           clean_by = $4, clean_at = NOW(),
           clean_count = clean_count + 1,
           status = 'listed', listed_at = NOW(),
           listing_count = listing_count + 1,
           updated_at = NOW()
       WHERE id = $5 AND status = 'cleaning'
       RETURNING *`,
      [clean_method, clean_notes || null, outgoing_condition, req.user.id, req.params.id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Shoe not found or not in cleaning state' });

    // Notify owner
    const ownerRes = await db.query('SELECT * FROM users WHERE id = $1', [rows[0].owner_id]);
    if (ownerRes.rows.length) {
      emailService.sendShoeListed(ownerRes.rows[0], rows[0]).catch(console.error);
    }

    await logActivity(req.user.id, 'shoe.listed', 'shoe', req.params.id);

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/shoes/:id/reject ─────────────────────────
router.post('/shoes/:id/reject', [
  body('rejection_reason').trim().notEmpty(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { rows } = await db.query(
      `UPDATE shoes
       SET status = 'rejected', rejection_reason = $1,
           rejected_by = $2, rejected_at = NOW(), updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [req.body.rejection_reason, req.user.id, req.params.id]
    );

    if (!rows.length) return res.status(404).json({ error: 'Shoe not found' });

    const ownerRes = await db.query('SELECT * FROM users WHERE id = $1', [rows[0].owner_id]);
    if (ownerRes.rows.length) {
      emailService.sendShoeRejected(ownerRes.rows[0], rows[0]).catch(console.error);
    }

    await logActivity(req.user.id, 'shoe.rejected', 'shoe', req.params.id, {
      reason: req.body.rejection_reason,
    });

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── POST /api/admin/orders/:id/dispatch ───────────────────────
router.post('/orders/:id/dispatch', [
  body('tracking_number').trim().notEmpty(),
  body('return_label_url').optional().trim(),
], async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE orders
       SET status = 'dispatched', tracking_number = $1,
           return_label_url = $2, updated_at = NOW()
       WHERE id = $3 AND status = 'cleaning'
       RETURNING *`,
      [req.body.tracking_number, req.body.return_label_url || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Order not found' });

    const customerRes = await db.query('SELECT * FROM users WHERE id = $1', [rows[0].customer_id]);
    if (customerRes.rows.length) {
      emailService.sendOrderDispatched(customerRes.rows[0], rows[0]).catch(console.error);
    }

    await logActivity(req.user.id, 'order.dispatched', 'order', rows[0].id);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/admin/users ──────────────────────────────────────
router.get('/users', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, email, role, phone,
              addr_line1, addr_line2, addr_city, addr_county, addr_postcode,
              shoe_size, email_verified, created_at
       FROM users ORDER BY created_at DESC LIMIT 500`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── PATCH /api/admin/users/:id/password  (admin resets a user's password) ──
router.patch('/users/:id/password', requireRole('admin'), [
  body('new_password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const bcrypt = require('bcryptjs');
    const password_hash = await bcrypt.hash(req.body.new_password, parseInt(process.env.BCRYPT_ROUNDS) || 12);

    const { rows } = await db.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW()
       WHERE id = $2 RETURNING id, email`,
      [password_hash, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    // Revoke all refresh tokens so user must log in again
    await db.query(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1',
      [req.params.id]
    );

    await logActivity(req.user.id, 'user.password_reset', 'user', req.params.id);

    res.json({ message: 'Password updated. All existing sessions have been revoked.' });
  } catch (err) { next(err); }
});
router.patch('/users/:id', requireRole('admin'), [
  body('first_name').optional().trim().notEmpty(),
  body('last_name').optional().trim().notEmpty(),
  body('email').optional().isEmail().normalizeEmail(),
  body('phone').optional().trim(),
  body('role').optional().isIn(['customer','owner','staff','admin']),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const allowed = ['first_name','last_name','email','phone','role'];
    const updates = [];
    const values  = [];
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        values.push(req.body[key]);
        updates.push(`${key} = $${values.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING id, first_name, last_name, email, phone, role,
                 addr_line1, addr_line2, addr_city, addr_county, addr_postcode,
                 shoe_size, email_verified, created_at`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    await logActivity(req.user.id, 'user.updated', 'user', req.params.id, {
      updated_fields: allowed.filter(k=>req.body[k]!==undefined),
    });

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/admin/activity ───────────────────────────────────
router.get('/activity', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT al.*, u.first_name, u.last_name
       FROM activity_log al
       LEFT JOIN users u ON u.id = al.actor_id
       ORDER BY al.created_at DESC LIMIT 100`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── PAYOUTS ADMIN ──────────────────────────────────────────────────────────────
router.get('/payouts', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT p.*,
         u.first_name || ' ' || u.last_name AS owner_name,
         COALESCE(s.brand, sd.brand) AS brand,
         COALESCE(s.model, sd.model) AS model
       FROM payouts p
       JOIN users u ON u.id = p.owner_id
       LEFT JOIN orders o ON o.id = p.order_id
       LEFT JOIN shoes s ON s.id = o.shoe_id
       LEFT JOIN shoes sd ON sd.id = p.shoe_id
       ORDER BY p.created_at DESC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.patch('/payouts/:id', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { status } = req.body;
    const processed_at = status === 'paid' ? new Date() : null;
    const { rows } = await db.query(
      `UPDATE payouts SET status=$1, processed_at=COALESCE($2,processed_at) WHERE id=$3 RETURNING *`,
      [status, processed_at, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── SHOES ADMIN PATCH ──────────────────────────────────────────────────────────
router.patch('/shoes/:id', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const allowed = ['status','assessed_wear_grade','rejection_reason','auth_grade','auth_score'];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (!updates.length) return res.status(400).json({ error: 'No valid fields' });
    const setClauses = updates.map(([k], i) => `${k}=$${i+2}`).join(',');
    const values = updates.map(([,v]) => v);
    const { rows } = await db.query(
      `UPDATE shoes SET ${setClauses}, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id, ...values]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── ORDERS ADMIN PATCH ─────────────────────────────────────────────────────────
router.patch('/orders/:id', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { status } = req.body;
    const { rows } = await db.query(
      `UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
      [status, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ── GET /api/admin/orders — all orders for revenue dashboard ──────────────────
router.get('/orders', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT o.*,
              s.brand, s.model, s.emoji,
              u.first_name || ' ' || u.last_name AS customer_name,
              u.email AS customer_email
       FROM orders o
       LEFT JOIN shoes s ON s.id = o.shoe_id
       LEFT JOIN users u ON u.id = o.customer_id
       ORDER BY o.created_at DESC
       LIMIT 1000`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /api/admin/shoes — all shoes (any status) for admin ───────────────────
router.get('/shoes', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { status } = req.query;
    let where = '1=1';
    const params = [];
    if (status && status !== 'all') {
      params.push(status);
      where = `s.status = $${params.length}`;
    }
    const { rows } = await db.query(
      `SELECT s.*,
              u.first_name, u.last_name, u.email AS owner_email,
              u.first_name || ' ' || u.last_name AS owner_display,
              ls.reference AS submission_ref, ls.collection_postcode
       FROM shoes s
       JOIN users u ON u.id = s.owner_id
       LEFT JOIN submission_shoes ss ON ss.shoe_id = s.id
       LEFT JOIN listing_submissions ls ON ls.id = ss.submission_id
       WHERE ${where}
       ORDER BY s.created_at DESC
       LIMIT 1000`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── CUSTOMER SERVICE ACTIONS ───────────────────────────────────────────────────

// POST /api/admin/orders/:id/refund — partial or full refund via Stripe
router.post('/orders/:id/refund', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { amount, reason, cancel } = req.body;
    const { rows: [order] } = await db.query(`SELECT * FROM orders WHERE id=$1`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // If Stripe is configured, attempt actual refund
    if (process.env.STRIPE_SECRET_KEY && order.stripe_payment_intent_id) {
      try {
        const { stripe } = require('../services/stripe');
        await stripe.refunds.create({
          payment_intent: order.stripe_payment_intent_id,
          amount: Math.round(amount * 100),
          reason: 'requested_by_customer',
          metadata: { order_id: req.params.id, reason: reason || '' },
        });
      } catch (e) {
        console.error('Stripe refund failed:', e.message);
      }
    }

    // Log to activity log
    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, details)
       VALUES ($1, 'refund_issued', 'order', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ amount, reason })]
    );

    // Cancel order if full refund
    if (cancel) {
      await db.query(`UPDATE orders SET status='cancelled', updated_at=NOW() WHERE id=$1`, [req.params.id]);
    }

    res.json({ ok: true, refunded: amount });
  } catch (err) { next(err); }
});

// POST /api/admin/orders/:id/credit — issue store credit
router.post('/orders/:id/credit', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { amount, reason } = req.body;
    const { rows: [order] } = await db.query(`SELECT customer_id FROM orders WHERE id=$1`, [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Add credit to user (assumes user_credits table exists, create if needed)
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_credits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id),
        amount NUMERIC(10,2) NOT NULL,
        reason TEXT,
        order_id UUID REFERENCES orders(id),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ
      )
    `);
    await db.query(
      `INSERT INTO user_credits (user_id, amount, reason, order_id, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '1 year')`,
      [order.customer_id, amount, reason, req.params.id]
    );

    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, details)
       VALUES ($1, 'credit_issued', 'order', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ amount, reason })]
    );

    res.json({ ok: true, credited: amount });
  } catch (err) { next(err); }
});

// POST /api/admin/orders/:id/flag — flag for review
router.post('/orders/:id/flag', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { reason } = req.body;
    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, details)
       VALUES ($1, 'order_flagged', 'order', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ reason })]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/admin/orders/:id/note — add internal note
router.post('/orders/:id/note', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { note } = req.body;
    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, details)
       VALUES ($1, 'order_note', 'order', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ note })]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── PLATFORM SETTINGS ─────────────────────────────────────────────────────────
router.get('/settings', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT key, value, description, updated_at FROM platform_settings ORDER BY key`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.patch('/settings/:key', requireRole('admin'), async (req, res, next) => {
  try {
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'value is required' });

    // Auto-calculate owner_share_percent when platform_fee_percent changes
    if (req.params.key === 'platform_fee_percent') {
      const pct = parseFloat(value);
      if (pct < 0 || pct > 100) return res.status(400).json({ error: 'Must be 0-100' });
      await db.query(
        `UPDATE platform_settings SET value = $1::jsonb, updated_by = $2, updated_at = NOW() WHERE key = 'owner_share_percent'`,
        [JSON.stringify(100 - pct), req.user.id]
      );
    }

    const { rows } = await db.query(
      `UPDATE platform_settings SET value = $1::jsonb, updated_by = $2, updated_at = NOW()
       WHERE key = $3 RETURNING *`,
      [JSON.stringify(value), req.user.id, req.params.key]
    );

    if (!rows.length) return res.status(404).json({ error: 'Setting not found' });

    // Invalidate cache
    const settings = require('../services/settings');
    settings.invalidateCache();

    // Log activity
    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, details)
       VALUES ($1, 'setting_updated', 'platform_settings', NULL, $2)`,
      [req.user.id, JSON.stringify({ key: req.params.key, new_value: value })]
    );

    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
