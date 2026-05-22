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
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
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
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
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
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
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
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
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
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, 'setting_updated', 'platform_settings', NULL, $2)`,
      [req.user.id, JSON.stringify({ key: req.params.key, new_value: value })]
    );

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// ADMIN SHOE REGISTRATION (with scanner / manual entry)
// ──────────────────────────────────────────────────────────────────────────────

// POST /api/admin/shoes — admin registers a new shoe (bypasses owner submission flow)
router.post('/shoes', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const {
      brand, model, size, colour, category, gender, condition,
      rrp, rent_price, buy_price, owner_id, owner_email,
      description, emoji, auth_grade, assessed_wear_grade,
      barcode, listing_type,
    } = req.body;

    if (!brand || !model || !size) {
      return res.status(400).json({ error: 'brand, model and size are required' });
    }

    // Find or use specified owner
    let ownerIdToUse = owner_id;
    if (!ownerIdToUse && owner_email) {
      const { rows } = await db.query(`SELECT id FROM users WHERE email = $1`, [owner_email]);
      if (!rows.length) return res.status(404).json({ error: `No user with email ${owner_email}` });
      ownerIdToUse = rows[0].id;
    }
    if (!ownerIdToUse) {
      // Default: admin registers under their own account
      ownerIdToUse = req.user.id;
    }

    // Generate unique shoe code
    const { generateUniqueShoeCode } = require('../services/shoeCodes');
    const shoeCode = await generateUniqueShoeCode(brand);

    const { rows } = await db.query(
      `INSERT INTO shoes (
        shoe_code, owner_id, brand, model, size, colour, category, gender, condition,
        rrp, rent_price, buy_price, description, emoji, auth_grade, assessed_wear_grade,
        listing_type, status, listed_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'listed',NOW())
      RETURNING *`,
      [shoeCode, ownerIdToUse, brand, model, size, colour || null, category || null, gender || 'Unisex',
       condition || 'Excellent', rrp || null, rent_price || null, buy_price || null,
       description || null, emoji || '👟', auth_grade || 'A', assessed_wear_grade || 'Mint',
       listing_type || 'both']
    );

    // Log
    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, 'admin_registered_shoe', 'shoe', $2, $3)`,
      [req.user.id, rows[0].id, JSON.stringify({ shoe_code: shoeCode, brand, model, barcode: barcode || null })]
    );

    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// GET /api/admin/shoes/by-code/:code — lookup a shoe by its KSM code
router.get('/shoes/by-code/:code', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*,
              u.first_name, u.last_name, u.email AS owner_email,
              u.first_name || ' ' || u.last_name AS owner_display
       FROM shoes s
       JOIN users u ON u.id = s.owner_id
       WHERE s.shoe_code = $1`,
      [req.params.code.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ error: 'Shoe not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/admin/shoes/:id/prices — update prices and key fields
router.patch('/shoes/:id/prices', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { rent_price, buy_price, rrp, listing_type } = req.body;
    const updates = [];
    const values = [];
    let n = 1;
    if (rent_price !== undefined) { updates.push(`rent_price = $${n++}`); values.push(rent_price); }
    if (buy_price !== undefined)  { updates.push(`buy_price = $${n++}`);  values.push(buy_price); }
    if (rrp !== undefined)        { updates.push(`rrp = $${n++}`);        values.push(rrp); }
    if (listing_type !== undefined && ['rent','buy','both'].includes(listing_type)) {
      updates.push(`listing_type = $${n++}`); values.push(listing_type);
    }
    if (!updates.length) return res.status(400).json({ error: 'No price changes specified' });

    updates.push(`updated_at = NOW()`);
    values.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE shoes SET ${updates.join(', ')} WHERE id = $${n} RETURNING *`,
      values
    );

    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, 'price_updated', 'shoe', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify(req.body)]
    );

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// PATCH /api/admin/shoes/:id/details — update non-price details (any field)
router.patch('/shoes/:id/details', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const allowed = ['brand','model','size','colour','category','gender','condition',
                     'description','emoji','auth_grade','assessed_wear_grade','status'];
    const updates = [];
    const values = [];
    let n = 1;
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        updates.push(`${key} = $${n++}`);
        values.push(req.body[key]);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No changes specified' });

    updates.push(`updated_at = NOW()`);
    values.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE shoes SET ${updates.join(', ')} WHERE id = $${n} RETURNING *`,
      values
    );

    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, 'shoe_details_updated', 'shoe', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify(req.body)]
    );

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// REPORTS — PDF (professional formatted for accounting)
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/admin/reports/:type/pdf?from=&to= — professional PDF report
router.get('/reports/:type/pdf', requireRole('admin'), async (req, res, next) => {
  try {
    const PDFDocument = require('pdfkit');
    const type = req.params.type;
    const { from, to } = req.query;
    const fromDate = from ? new Date(from) : new Date(Date.now() - 90 * 86400000);
    const toDate   = to   ? new Date(to)   : new Date();
    const periodLabel = `${fromDate.toLocaleDateString('en-GB')} – ${toDate.toLocaleDateString('en-GB')}`;

    const doc = new PDFDocument({ size: 'A4', margin: 40, info: { Title: `Kosmos ${type} report`, Author: 'Beautifully Ordered Ltd' } });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="kosmos-${type}-${fromDate.toISOString().slice(0,10)}.pdf"`);
    doc.pipe(res);

    // ── Header ───────────────────────────────────────────────────────────
    doc.fontSize(22).fillColor('#0f0e0c').font('Helvetica-Bold').text('KOSMOS', { align: 'left' });
    doc.fontSize(9).fillColor('#b89a5a').font('Helvetica').text('BEAUTIFULLY ORDERED', { characterSpacing: 3 });
    doc.moveDown(0.5);
    doc.fontSize(16).fillColor('#0f0e0c').font('Helvetica-Bold').text(`${type.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase())} Report`);
    doc.fontSize(10).fillColor('#7a7468').font('Helvetica').text(`Period: ${periodLabel}`);
    doc.fontSize(8).fillColor('#a09a8e').text(`Generated: ${new Date().toLocaleString('en-GB')} · Beautifully Ordered Ltd · Co. No. 17231554`);
    doc.moveTo(40, doc.y + 8).lineTo(555, doc.y + 8).strokeColor('#e0d8c8').stroke();
    doc.moveDown(1.5);

    // ── Body by report type ──────────────────────────────────────────────
    if (type === 'revenue-summary') {
      const { rows: summary } = await db.query(`
        SELECT
          COUNT(*) AS orders,
          SUM(CASE WHEN o.order_type='rent' THEN 1 ELSE 0 END) AS rentals,
          SUM(CASE WHEN o.order_type='buy'  THEN 1 ELSE 0 END) AS sales,
          COALESCE(SUM(o.total), 0) AS gmv,
          COALESCE(SUM(o.platform_fee), 0) AS platform_rev,
          COALESCE(SUM(o.late_fees_charged), 0) AS late_fees
        FROM orders o
        WHERE o.created_at BETWEEN $1 AND $2
          AND o.status NOT IN ('cancelled','refunded','pending_payment')
      `, [fromDate, toDate]);
      const s = summary[0] || {};

      // Big summary boxes
      const stats = [
        { label: 'TOTAL GMV',       value: `£${parseFloat(s.gmv||0).toFixed(2)}`,        color: '#0f0e0c' },
        { label: 'PLATFORM REVENUE', value: `£${parseFloat(s.platform_rev||0).toFixed(2)}`, color: '#b89a5a' },
        { label: 'ORDERS',          value: parseInt(s.orders||0),                       color: '#0f0e0c' },
        { label: 'LATE FEES',        value: `£${parseFloat(s.late_fees||0).toFixed(2)}`,  color: '#0f0e0c' },
      ];
      let x = 40;
      stats.forEach(stat => {
        doc.rect(x, doc.y, 120, 60).strokeColor('#e0d8c8').stroke();
        doc.fontSize(8).fillColor('#a09a8e').text(stat.label, x + 10, doc.y + 8, { width: 100, characterSpacing: 1 });
        doc.fontSize(16).fillColor(stat.color).font('Helvetica-Bold').text(String(stat.value), x + 10, doc.y + 4, { width: 100 });
        doc.font('Helvetica');
        x += 130;
      });
      doc.y += 70;
      doc.moveDown(1);

      // Breakdown table
      doc.fontSize(11).fillColor('#0f0e0c').font('Helvetica-Bold').text('Breakdown');
      doc.moveDown(0.5);
      const breakdown = [
        ['Rentals',  parseInt(s.rentals || 0)],
        ['Sales',    parseInt(s.sales || 0)],
        ['Total GMV', `£${parseFloat(s.gmv || 0).toFixed(2)}`],
        ['Platform fees (15%)', `£${parseFloat(s.platform_rev || 0).toFixed(2)}`],
        ['Late fees charged',   `£${parseFloat(s.late_fees || 0).toFixed(2)}`],
      ];
      doc.fontSize(10).font('Helvetica');
      breakdown.forEach(([k, v]) => {
        doc.fillColor('#7a7468').text(k, 40, doc.y, { continued: true });
        doc.fillColor('#0f0e0c').font('Helvetica-Bold').text(String(v), { align: 'right' });
        doc.font('Helvetica');
      });

      // Per-day mini table
      doc.moveDown(1.5);
      const { rows: daily } = await db.query(`
        SELECT DATE(created_at) AS date, COUNT(*) AS orders, COALESCE(SUM(total),0) AS gmv, COALESCE(SUM(platform_fee),0) AS rev
        FROM orders WHERE created_at BETWEEN $1 AND $2
          AND status NOT IN ('cancelled','refunded','pending_payment')
        GROUP BY DATE(created_at) ORDER BY DATE(created_at) DESC LIMIT 30
      `, [fromDate, toDate]);

      if (daily.length) {
        doc.fontSize(11).fillColor('#0f0e0c').font('Helvetica-Bold').text('Daily Activity (last 30 days)');
        doc.moveDown(0.5);
        doc.fontSize(9).fillColor('#a09a8e').font('Helvetica-Bold');
        doc.text('Date',        40,  doc.y, { continued: true, width: 120 });
        doc.text('Orders',      160, doc.y, { continued: true, width: 80 });
        doc.text('GMV',         240, doc.y, { continued: true, width: 100 });
        doc.text('Platform Rev', 340, doc.y);
        doc.moveTo(40, doc.y + 4).lineTo(555, doc.y + 4).stroke('#e0d8c8');
        doc.moveDown(0.5);
        doc.font('Helvetica').fillColor('#0f0e0c');
        daily.forEach(d => {
          doc.text(new Date(d.date).toLocaleDateString('en-GB'), 40, doc.y, { continued: true, width: 120 });
          doc.text(d.orders, 160, doc.y, { continued: true, width: 80 });
          doc.text(`£${parseFloat(d.gmv).toFixed(2)}`, 240, doc.y, { continued: true, width: 100 });
          doc.text(`£${parseFloat(d.rev).toFixed(2)}`, 340, doc.y);
        });
      }
    }

    else if (type === 'orders') {
      const { rows } = await db.query(`
        SELECT o.reference, o.created_at, o.order_type, o.status, o.total, o.platform_fee,
               s.brand, s.model, s.shoe_code,
               u.email AS customer_email
        FROM orders o
        LEFT JOIN shoes s ON s.id = o.shoe_id
        LEFT JOIN users u ON u.id = o.customer_id
        WHERE o.created_at BETWEEN $1 AND $2
        ORDER BY o.created_at DESC LIMIT 200
      `, [fromDate, toDate]);

      doc.fontSize(10).fillColor('#7a7468').text(`${rows.length} orders shown (max 200 — download CSV for full data)`);
      doc.moveDown(1);
      doc.fontSize(8).fillColor('#a09a8e').font('Helvetica-Bold');
      doc.text('Ref',      40,  doc.y, { continued: true, width: 70 });
      doc.text('Date',     110, doc.y, { continued: true, width: 70 });
      doc.text('Type',     180, doc.y, { continued: true, width: 40 });
      doc.text('Shoe',     220, doc.y, { continued: true, width: 180 });
      doc.text('Total',    400, doc.y, { continued: true, width: 60 });
      doc.text('Status',   460, doc.y);
      doc.moveTo(40, doc.y + 4).lineTo(555, doc.y + 4).stroke('#e0d8c8');
      doc.moveDown(0.5);
      doc.font('Helvetica').fillColor('#0f0e0c').fontSize(8);
      rows.forEach(r => {
        if (doc.y > 770) { doc.addPage(); }
        doc.text(r.reference || '—', 40, doc.y, { continued: true, width: 70 });
        doc.text(new Date(r.created_at).toLocaleDateString('en-GB'), 110, doc.y, { continued: true, width: 70 });
        doc.text(r.order_type, 180, doc.y, { continued: true, width: 40 });
        doc.text(`${r.brand||''} ${r.model||''}`.slice(0, 26), 220, doc.y, { continued: true, width: 180 });
        doc.text(`£${parseFloat(r.total||0).toFixed(2)}`, 400, doc.y, { continued: true, width: 60 });
        doc.text(r.status, 460, doc.y);
      });
    }

    else if (type === 'shoes') {
      const { rows } = await db.query(`
        SELECT shoe_code, brand, model, size, rent_price, buy_price, rrp, status, listed_at
        FROM shoes WHERE created_at BETWEEN $1 AND $2 ORDER BY created_at DESC LIMIT 200
      `, [fromDate, toDate]);

      doc.fontSize(10).fillColor('#7a7468').text(`${rows.length} shoes shown (max 200 — download CSV for full data)`);
      doc.moveDown(1);
      doc.fontSize(8).fillColor('#a09a8e').font('Helvetica-Bold');
      doc.text('Code',  40,  doc.y, { continued: true, width: 100 });
      doc.text('Brand', 140, doc.y, { continued: true, width: 80 });
      doc.text('Model', 220, doc.y, { continued: true, width: 130 });
      doc.text('Size',  350, doc.y, { continued: true, width: 40 });
      doc.text('Rent',  390, doc.y, { continued: true, width: 50 });
      doc.text('Buy',   440, doc.y, { continued: true, width: 50 });
      doc.text('Status', 490, doc.y);
      doc.moveTo(40, doc.y + 4).lineTo(555, doc.y + 4).stroke('#e0d8c8');
      doc.moveDown(0.5);
      doc.font('Helvetica').fillColor('#0f0e0c').fontSize(8);
      rows.forEach(r => {
        if (doc.y > 770) { doc.addPage(); }
        doc.text(r.shoe_code || '—', 40, doc.y, { continued: true, width: 100 });
        doc.text((r.brand||'').slice(0,12), 140, doc.y, { continued: true, width: 80 });
        doc.text((r.model||'').slice(0,20), 220, doc.y, { continued: true, width: 130 });
        doc.text(r.size||'', 350, doc.y, { continued: true, width: 40 });
        doc.text(r.rent_price ? `£${r.rent_price}` : '—', 390, doc.y, { continued: true, width: 50 });
        doc.text(r.buy_price  ? `£${r.buy_price}`  : '—', 440, doc.y, { continued: true, width: 50 });
        doc.text(r.status, 490, doc.y);
      });
    }

    else {
      doc.fontSize(12).fillColor('#7a7468').text(`PDF format not yet available for "${type}". Please use CSV export.`);
    }

    // Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.fontSize(7).fillColor('#a09a8e').text(
        `Beautifully Ordered Ltd · Co. No. 17231554 · beautifullyordered.co.uk · Page ${i + 1}/${range.count}`,
        40, 810, { align: 'center', width: 515 }
      );
    }

    doc.end();
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// REPORTS — CSV exports
// ──────────────────────────────────────────────────────────────────────────────

function escapeCSV(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function toCSV(headers, rows, fieldMap) {
  const csv = [headers.join(',')];
  for (const row of rows) {
    csv.push(fieldMap(row).map(escapeCSV).join(','));
  }
  return csv.join('\n');
}

// GET /api/admin/reports/:type — generate CSV reports
router.get('/reports/:type', requireRole('admin'), async (req, res, next) => {
  try {
    const type = req.params.type;
    const { from, to } = req.query;
    const fromDate = from ? new Date(from) : new Date(Date.now() - 90 * 86400000);
    const toDate   = to   ? new Date(to)   : new Date();

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="kosmos-${type}-${fromDate.toISOString().slice(0,10)}-to-${toDate.toISOString().slice(0,10)}.csv"`);

    if (type === 'orders') {
      const { rows } = await db.query(`
        SELECT o.reference, o.created_at, o.order_type, o.status,
               s.shoe_code, s.brand, s.model, s.size,
               u.email AS customer_email,
               u.first_name || ' ' || u.last_name AS customer_name,
               o.unit_price, o.rental_days, o.subtotal, o.platform_fee, o.total,
               o.delivery_postcode, o.late_fees_charged,
               owner.email AS owner_email,
               owner.first_name || ' ' || owner.last_name AS owner_name
        FROM orders o
        LEFT JOIN shoes s ON s.id = o.shoe_id
        LEFT JOIN users u ON u.id = o.customer_id
        LEFT JOIN users owner ON owner.id = s.owner_id
        WHERE o.created_at BETWEEN $1 AND $2
        ORDER BY o.created_at DESC
      `, [fromDate, toDate]);

      const csv = toCSV(
        ['Reference','Date','Type','Status','Shoe Code','Brand','Model','Size','Customer Email','Customer Name','Unit Price','Rental Days','Subtotal','Platform Fee','Total','Delivery Postcode','Late Fees','Owner Email','Owner Name'],
        rows,
        r => [r.reference, r.created_at?.toISOString().slice(0,16).replace('T',' '), r.order_type, r.status, r.shoe_code, r.brand, r.model, r.size, r.customer_email, r.customer_name, r.unit_price, r.rental_days, r.subtotal, r.platform_fee, r.total, r.delivery_postcode, r.late_fees_charged, r.owner_email, r.owner_name]
      );
      return res.send(csv);
    }

    if (type === 'shoes') {
      const { rows } = await db.query(`
        SELECT s.shoe_code, s.created_at, s.brand, s.model, s.size, s.colour, s.category, s.gender,
               s.condition, s.assessed_wear_grade, s.auth_grade, s.rrp, s.rent_price, s.buy_price,
               s.listing_type, s.status, s.listed_at,
               u.email AS owner_email,
               u.first_name || ' ' || u.last_name AS owner_name
        FROM shoes s
        JOIN users u ON u.id = s.owner_id
        WHERE s.created_at BETWEEN $1 AND $2
        ORDER BY s.created_at DESC
      `, [fromDate, toDate]);

      const csv = toCSV(
        ['Shoe Code','Created','Brand','Model','Size','Colour','Category','Gender','Condition','Wear Grade','Auth Grade','RRP','Rent Price','Buy Price','Listing Type','Status','Listed Date','Owner Email','Owner Name'],
        rows,
        r => [r.shoe_code, r.created_at?.toISOString().slice(0,10), r.brand, r.model, r.size, r.colour, r.category, r.gender, r.condition, r.assessed_wear_grade, r.auth_grade, r.rrp, r.rent_price, r.buy_price, r.listing_type, r.status, r.listed_at?.toISOString().slice(0,10) || '', r.owner_email, r.owner_name]
      );
      return res.send(csv);
    }

    if (type === 'payouts') {
      const { rows } = await db.query(`
        SELECT p.created_at, p.amount, p.status, p.paid_at,
               u.email AS owner_email,
               u.first_name || ' ' || u.last_name AS owner_name,
               s.shoe_code, s.brand, s.model
        FROM payouts p
        LEFT JOIN users u ON u.id = p.owner_id
        LEFT JOIN shoes s ON s.id = p.shoe_id
        WHERE p.created_at BETWEEN $1 AND $2
        ORDER BY p.created_at DESC
      `, [fromDate, toDate]);

      const csv = toCSV(
        ['Date','Amount','Status','Paid At','Owner Email','Owner Name','Shoe Code','Brand','Model'],
        rows,
        r => [r.created_at?.toISOString().slice(0,10), r.amount, r.status, r.paid_at?.toISOString().slice(0,10) || '', r.owner_email, r.owner_name, r.shoe_code, r.brand, r.model]
      );
      return res.send(csv);
    }

    if (type === 'users') {
      const { rows } = await db.query(`
        SELECT email, first_name, last_name, phone, role,
               addr_postcode, shoe_size, created_at,
               stripe_customer_id IS NOT NULL AS has_stripe_customer,
               stripe_account_id IS NOT NULL AS has_stripe_connect
        FROM users
        WHERE created_at BETWEEN $1 AND $2
        ORDER BY created_at DESC
      `, [fromDate, toDate]);

      const csv = toCSV(
        ['Email','First Name','Last Name','Phone','Role','Postcode','Shoe Size','Joined','Has Customer','Has Connect'],
        rows,
        r => [r.email, r.first_name, r.last_name, r.phone, r.role, r.addr_postcode, r.shoe_size, r.created_at?.toISOString().slice(0,10), r.has_stripe_customer ? 'Yes' : 'No', r.has_stripe_connect ? 'Yes' : 'No']
      );
      return res.send(csv);
    }

    if (type === 'newsletter') {
      const { rows } = await db.query(`
        SELECT email, source, confirmed, unsubscribed, created_at
        FROM newsletter_subscribers
        WHERE created_at BETWEEN $1 AND $2
        ORDER BY created_at DESC
      `, [fromDate, toDate]);

      const csv = toCSV(
        ['Email','Source','Confirmed','Unsubscribed','Joined'],
        rows,
        r => [r.email, r.source, r.confirmed ? 'Yes' : 'No', r.unsubscribed ? 'Yes' : 'No', r.created_at?.toISOString().slice(0,10)]
      );
      return res.send(csv);
    }

    if (type === 'revenue-summary') {
      const { rows } = await db.query(`
        SELECT
          DATE(o.created_at) AS date,
          COUNT(*) AS orders,
          SUM(CASE WHEN o.order_type='rent' THEN 1 ELSE 0 END) AS rentals,
          SUM(CASE WHEN o.order_type='buy'  THEN 1 ELSE 0 END) AS sales,
          SUM(o.total) AS gmv,
          SUM(o.platform_fee) AS platform_revenue,
          SUM(o.late_fees_charged) AS late_fees
        FROM orders o
        WHERE o.created_at BETWEEN $1 AND $2
          AND o.status NOT IN ('cancelled','refunded','pending_payment')
        GROUP BY DATE(o.created_at)
        ORDER BY DATE(o.created_at) DESC
      `, [fromDate, toDate]);

      const csv = toCSV(
        ['Date','Orders','Rentals','Sales','GMV','Platform Revenue','Late Fees'],
        rows,
        r => [r.date?.toISOString().slice(0,10) || r.date, r.orders, r.rentals, r.sales, r.gmv, r.platform_revenue, r.late_fees]
      );
      return res.send(csv);
    }

    return res.status(400).json({ error: 'Unknown report type. Use: orders, shoes, payouts, users, newsletter, revenue-summary' });
  } catch (err) { next(err); }
});

module.exports = router;
