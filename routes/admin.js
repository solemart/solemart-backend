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

    // Submissions = anything pre-listing (not yet on the catalogue)
    // Once listed/sold/returned, it's NOT a submission anymore.
    let where = `s.status IN ('submitted','in_transit','authenticating','cleaning','rejected')`;
    if (stage && stage !== 'all') where = `s.status = '${stage}'`;

    const { rows } = await db.query(
      `SELECT s.*, u.first_name, u.last_name, u.email,
              ls.reference AS submission_ref, ls.collection_postcode,
              COALESCE(
                (SELECT json_agg(json_build_object('url', sp.url, 'caption', sp.caption) ORDER BY sp.sort_order)
                 FROM shoe_photos sp WHERE sp.shoe_id = s.id),
                '[]'::json
              ) AS owner_photos
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
    const allowed = ['status','assessed_wear_grade','rejection_reason','auth_grade','auth_score',
                     'brand','model','size','colour','category','gender','condition',
                     'rrp','rent_price','buy_price','listing_type','emoji','description',
                     'library_photo_id'];
    const updates = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (!updates.length) return res.status(400).json({ error: 'No valid fields' });

    // Get current shoe state
    const { rows: [before] } = await db.query(`SELECT * FROM shoes WHERE id = $1`, [req.params.id]);
    if (!before) return res.status(404).json({ error: 'Shoe not found' });

    // Generate a KSM code on first listing if missing
    let extraUpdate = '';
    let extraValues = [];
    const newStatus = req.body.status;
    if (newStatus === 'listed' && !before.shoe_code) {
      const { generateUniqueShoeCode } = require('../services/shoeCodes');
      const code = await generateUniqueShoeCode(req.body.brand || before.brand);
      extraUpdate = ', shoe_code = $' + (updates.length + 2);
      extraValues.push(code);
    }
    // Set listed_at timestamp when transitioning to listed
    if (newStatus === 'listed' && before.status !== 'listed') {
      extraUpdate += ', listed_at = NOW()';
    }

    const setClauses = updates.map(([k], i) => `${k}=$${i+2}`).join(',');
    const values = updates.map(([,v]) => v);
    const { rows } = await db.query(
      `UPDATE shoes SET ${setClauses}${extraUpdate}, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id, ...values, ...extraValues]
    );

    // Log to submission events timeline (visible to owner)
    const events = require('../services/submissionEvents');
    let eventType = 'updated';
    if (newStatus && newStatus !== before.status) {
      if (newStatus === 'listed')             eventType = 'listed';
      else if (newStatus === 'rejected')      eventType = 'rejected';
      else if (newStatus === 'authenticating') eventType = 'review_started';
      else if (newStatus === 'cleaning')      eventType = 'cleaning_started';
      else if (newStatus === 'in_transit')    eventType = 'collected';
      else                                    eventType = 'status_changed';
    }
    await events.logEvent({
      shoeId: req.params.id,
      eventType,
      statusBefore: before.status,
      statusAfter: rows[0].status,
      actorId: req.user.id,
      actorRole: 'kosmos',
      notes: req.body.rejection_reason || req.body.note || null,
      meta: req.body,
    });

    // Activity log (admin audit)
    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, $2, 'shoe', $3, $4)`,
      [req.user.id, eventType, req.params.id, JSON.stringify({ brand: before.brand, model: before.model, ...req.body })]
    );

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/admin/shoes/:id/note — add an internal/owner-visible note
router.post('/shoes/:id/note', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { note, visible_to_owner } = req.body;
    if (!note) return res.status(400).json({ error: 'Note required' });
    const { rows: [shoe] } = await db.query(`SELECT id, status FROM shoes WHERE id = $1`, [req.params.id]);
    if (!shoe) return res.status(404).json({ error: 'Shoe not found' });

    const events = require('../services/submissionEvents');
    await events.logEvent({
      shoeId: req.params.id,
      eventType: visible_to_owner === false ? 'internal_note' : 'note_added',
      statusBefore: shoe.status,
      statusAfter: shoe.status,
      actorId: req.user.id,
      actorRole: 'kosmos',
      notes: note,
      meta: { visible_to_owner: visible_to_owner !== false },
    });

    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, 'note_added', 'shoe', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ note, visible_to_owner: visible_to_owner !== false })]
    );

    res.json({ ok: true });
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

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 60, left: 50, right: 50 },
      info: { Title: `Kosmos ${type} report`, Author: 'Beautifully Ordered Ltd' },
      bufferPages: true,
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="kosmos-${type}-${fromDate.toISOString().slice(0,10)}.pdf"`);
    doc.pipe(res);

    const PAGE_LEFT = 50;
    const PAGE_RIGHT = 545;
    const PAGE_WIDTH = PAGE_RIGHT - PAGE_LEFT;
    const COL_GOLD = '#b89a5a';
    const COL_INK = '#0f0e0c';
    const COL_MUTED = '#7a7468';
    const COL_FAINT = '#a09a8e';
    const COL_RULE = '#e0d8c8';
    const COL_CREAM = '#faf6ed';

    // ── HEADER ─────────────────────────────────────────────────────────
    doc.fontSize(24).fillColor(COL_INK).font('Helvetica-Bold').text('KOSMOS', PAGE_LEFT, 50);
    doc.fontSize(8).fillColor(COL_GOLD).font('Helvetica').text('BEAUTIFULLY ORDERED', PAGE_LEFT, 78, { characterSpacing: 3 });

    // Report title and period on right
    const reportTitle = type.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase());
    doc.fontSize(11).fillColor(COL_MUTED).font('Helvetica').text(reportTitle.toUpperCase(), PAGE_LEFT, 50, { width: PAGE_WIDTH, align: 'right', characterSpacing: 2 });
    doc.fontSize(16).fillColor(COL_INK).font('Helvetica-Bold').text('Report', PAGE_LEFT, 65, { width: PAGE_WIDTH, align: 'right' });
    doc.fontSize(9).fillColor(COL_MUTED).font('Helvetica').text(periodLabel, PAGE_LEFT, 86, { width: PAGE_WIDTH, align: 'right' });

    // Divider line
    doc.moveTo(PAGE_LEFT, 110).lineTo(PAGE_RIGHT, 110).lineWidth(0.5).strokeColor(COL_GOLD).stroke();

    doc.y = 130;

    // ── HELPERS ────────────────────────────────────────────────────────
    function sectionTitle(text) {
      if (doc.y > 720) doc.addPage();
      doc.fontSize(8).fillColor(COL_GOLD).font('Helvetica-Bold').text(text.toUpperCase(), PAGE_LEFT, doc.y, { characterSpacing: 2 });
      doc.moveTo(PAGE_LEFT, doc.y + 4).lineTo(PAGE_LEFT + 30, doc.y + 4).lineWidth(1).strokeColor(COL_GOLD).stroke();
      doc.moveDown(1);
    }

    function statCard(x, y, w, h, label, value, valueColor) {
      doc.rect(x, y, w, h).fillColor(COL_CREAM).fill();
      doc.fontSize(7).fillColor(COL_FAINT).font('Helvetica-Bold').text(label, x + 10, y + 10, { width: w - 20, characterSpacing: 1.5 });
      doc.fontSize(18).fillColor(valueColor || COL_INK).font('Helvetica-Bold').text(String(value), x + 10, y + 24, { width: w - 20 });
    }

    function keyValueRow(key, value, bold) {
      if (doc.y > 770) doc.addPage();
      const startY = doc.y;
      doc.fontSize(10).fillColor(COL_MUTED).font('Helvetica').text(key, PAGE_LEFT, startY, { width: PAGE_WIDTH * 0.6 });
      doc.fontSize(10).fillColor(COL_INK).font(bold ? 'Helvetica-Bold' : 'Helvetica').text(String(value), PAGE_LEFT, startY, { width: PAGE_WIDTH, align: 'right' });
      doc.y = startY + 16;
    }

    function tableHeader(cols, widths) {
      if (doc.y > 720) doc.addPage();
      doc.rect(PAGE_LEFT, doc.y, PAGE_WIDTH, 20).fillColor(COL_CREAM).fill();
      let x = PAGE_LEFT + 8;
      doc.fontSize(8).fillColor(COL_MUTED).font('Helvetica-Bold');
      cols.forEach((c, i) => {
        doc.text(c, x, doc.y + 6, { width: widths[i] - 8, characterSpacing: 1 });
        x += widths[i];
      });
      doc.y += 22;
    }

    function tableRow(cells, widths, isAlt) {
      if (doc.y > 770) doc.addPage();
      if (isAlt) {
        doc.rect(PAGE_LEFT, doc.y - 2, PAGE_WIDTH, 16).fillColor('#fafafa').fill();
      }
      let x = PAGE_LEFT + 8;
      doc.fontSize(9).fillColor(COL_INK).font('Helvetica');
      cells.forEach((cell, i) => {
        const str = String(cell || '—').slice(0, Math.floor((widths[i] - 8) / 5));
        doc.text(str, x, doc.y + 2, { width: widths[i] - 8 });
        x += widths[i];
      });
      doc.y += 16;
    }

    // ── BODY: REVENUE SUMMARY ──────────────────────────────────────────
    if (type === 'revenue-summary') {
      const { rows: [s] } = await db.query(`
        SELECT
          COUNT(*) AS orders,
          SUM(CASE WHEN order_type='rent' THEN 1 ELSE 0 END) AS rentals,
          SUM(CASE WHEN order_type='buy'  THEN 1 ELSE 0 END) AS sales,
          COALESCE(SUM(total), 0) AS gmv,
          COALESCE(SUM(platform_fee), 0) AS platform_rev,
          COALESCE(SUM(late_fees_charged), 0) AS late_fees,
          COALESCE(AVG(total), 0) AS aov
        FROM orders
        WHERE created_at BETWEEN $1 AND $2
          AND status NOT IN ('cancelled','refunded','pending_payment')
      `, [fromDate, toDate]);

      // ─── Headline metrics ───
      sectionTitle('Headline Metrics');
      const cardW = (PAGE_WIDTH - 30) / 4;
      const cardY = doc.y;
      statCard(PAGE_LEFT,                        cardY, cardW, 60, 'TOTAL GMV',        '£' + parseFloat(s.gmv||0).toFixed(2), COL_INK);
      statCard(PAGE_LEFT + cardW + 10,            cardY, cardW, 60, 'PLATFORM REVENUE', '£' + parseFloat(s.platform_rev||0).toFixed(2), COL_GOLD);
      statCard(PAGE_LEFT + (cardW + 10) * 2,       cardY, cardW, 60, 'ORDERS',           parseInt(s.orders||0), COL_INK);
      statCard(PAGE_LEFT + (cardW + 10) * 3,       cardY, cardW, 60, 'AVG ORDER VALUE',  '£' + parseFloat(s.aov||0).toFixed(2), COL_INK);
      doc.y = cardY + 80;

      // ─── Breakdown ───
      sectionTitle('Order Breakdown');
      keyValueRow('Rental orders',   parseInt(s.rentals || 0));
      keyValueRow('Sale orders',     parseInt(s.sales || 0));
      keyValueRow('Total orders',    parseInt(s.orders || 0), true);
      doc.moveDown(0.5);

      // ─── Revenue split ───
      sectionTitle('Revenue Split');
      const gmv = parseFloat(s.gmv || 0);
      const plat = parseFloat(s.platform_rev || 0);
      const late = parseFloat(s.late_fees || 0);
      const ownersPaid = gmv - plat;
      keyValueRow('Gross Merchandise Value (GMV)', '£' + gmv.toFixed(2));
      keyValueRow('Paid to owners (85% net of cleaning)', '£' + ownersPaid.toFixed(2));
      keyValueRow('Kosmos platform fee (15%)', '£' + plat.toFixed(2));
      keyValueRow('Late fees charged', '£' + late.toFixed(2));
      keyValueRow('Total Kosmos revenue', '£' + (plat + late).toFixed(2), true);
      doc.moveDown(0.5);

      // ─── Daily activity table ───
      const { rows: daily } = await db.query(`
        SELECT DATE(created_at) AS date, COUNT(*) AS orders,
               COALESCE(SUM(total),0) AS gmv, COALESCE(SUM(platform_fee),0) AS rev
        FROM orders WHERE created_at BETWEEN $1 AND $2
          AND status NOT IN ('cancelled','refunded','pending_payment')
        GROUP BY DATE(created_at) ORDER BY DATE(created_at) DESC LIMIT 30
      `, [fromDate, toDate]);

      if (daily.length) {
        sectionTitle('Daily Activity (last 30 days)');
        tableHeader(['Date', 'Orders', 'GMV', 'Platform Revenue'], [180, 100, 130, 135]);
        daily.forEach((d, i) => {
          tableRow([
            new Date(d.date).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }),
            d.orders,
            '£' + parseFloat(d.gmv).toFixed(2),
            '£' + parseFloat(d.rev).toFixed(2),
          ], [180, 100, 130, 135], i % 2 === 1);
        });
      }
    }

    // ── BODY: ORDERS ───────────────────────────────────────────────────
    else if (type === 'orders') {
      const { rows: orders } = await db.query(`
        SELECT o.reference, o.created_at, o.order_type, o.status, o.total, o.platform_fee,
               s.brand, s.model, s.shoe_code,
               u.email AS customer_email,
               u.first_name || ' ' || u.last_name AS customer_name
        FROM orders o
        LEFT JOIN shoes s ON s.id = o.shoe_id
        LEFT JOIN users u ON u.id = o.customer_id
        WHERE o.created_at BETWEEN $1 AND $2
        ORDER BY o.created_at DESC LIMIT 200
      `, [fromDate, toDate]);

      // Summary first
      const total = orders.reduce((a, o) => a + parseFloat(o.total || 0), 0);
      const fees = orders.reduce((a, o) => a + parseFloat(o.platform_fee || 0), 0);
      sectionTitle('Summary');
      const cardW = (PAGE_WIDTH - 20) / 3;
      const cardY = doc.y;
      statCard(PAGE_LEFT,                cardY, cardW, 60, 'ORDERS',          orders.length, COL_INK);
      statCard(PAGE_LEFT + cardW + 10,    cardY, cardW, 60, 'TOTAL VALUE',     '£' + total.toFixed(2), COL_INK);
      statCard(PAGE_LEFT + (cardW + 10)*2, cardY, cardW, 60, 'PLATFORM REVENUE', '£' + fees.toFixed(2), COL_GOLD);
      doc.y = cardY + 80;

      // Orders table
      sectionTitle(`Orders (${orders.length})`);
      tableHeader(['Reference', 'Date', 'Type', 'Customer', 'Shoe', 'Total'], [80, 70, 40, 110, 145, 50]);
      orders.forEach((o, i) => {
        tableRow([
          o.reference || '—',
          new Date(o.created_at).toLocaleDateString('en-GB',{day:'2-digit',month:'short'}),
          o.order_type,
          (o.customer_name || o.customer_email || '—').slice(0, 18),
          `${o.brand || ''} ${o.model || ''}`.slice(0, 24),
          '£' + parseFloat(o.total || 0).toFixed(2),
        ], [80, 70, 40, 110, 145, 50], i % 2 === 1);
      });
      if (orders.length === 200) {
        doc.moveDown(0.5);
        doc.fontSize(8).fillColor(COL_FAINT).text('Showing first 200 orders — download CSV for full data', PAGE_LEFT, doc.y);
      }
    }

    // ── BODY: SHOES ────────────────────────────────────────────────────
    else if (type === 'shoes') {
      const { rows: shoes } = await db.query(`
        SELECT shoe_code, brand, model, size, colour, rent_price, buy_price, rrp, status, listed_at,
               (SELECT first_name || ' ' || last_name FROM users WHERE id = shoes.owner_id) AS owner_name
        FROM shoes
        WHERE created_at BETWEEN $1 AND $2
        ORDER BY created_at DESC LIMIT 200
      `, [fromDate, toDate]);

      // Status counts
      const byStatus = {};
      shoes.forEach(s => { byStatus[s.status] = (byStatus[s.status] || 0) + 1; });

      sectionTitle('Catalogue Overview');
      const cardW = (PAGE_WIDTH - 30) / 4;
      const cardY = doc.y;
      statCard(PAGE_LEFT,                        cardY, cardW, 60, 'TOTAL',     shoes.length, COL_INK);
      statCard(PAGE_LEFT + cardW + 10,            cardY, cardW, 60, 'LISTED',    byStatus.listed || 0, '#2a9d5d');
      statCard(PAGE_LEFT + (cardW + 10) * 2,       cardY, cardW, 60, 'RENTED',    byStatus.rented || 0, '#1e6fb8');
      statCard(PAGE_LEFT + (cardW + 10) * 3,       cardY, cardW, 60, 'SOLD',      byStatus.sold || 0, COL_GOLD);
      doc.y = cardY + 80;

      sectionTitle(`Shoes (${shoes.length})`);
      tableHeader(['Code', 'Brand', 'Model', 'Size', 'Rent/day', 'Buy', 'Status'], [85, 70, 130, 30, 60, 60, 60]);
      shoes.forEach((s, i) => {
        tableRow([
          s.shoe_code || '—',
          (s.brand || '').slice(0, 11),
          (s.model || '').slice(0, 20),
          s.size || '',
          s.rent_price ? '£' + s.rent_price : '—',
          s.buy_price  ? '£' + s.buy_price  : '—',
          s.status,
        ], [85, 70, 130, 30, 60, 60, 60], i % 2 === 1);
      });
      if (shoes.length === 200) {
        doc.moveDown(0.5);
        doc.fontSize(8).fillColor(COL_FAINT).text('Showing first 200 shoes — download CSV for full data', PAGE_LEFT, doc.y);
      }
    }

    else {
      doc.fontSize(11).fillColor(COL_MUTED).text(`PDF report for "${type}" not yet available. Use CSV export instead.`, PAGE_LEFT, doc.y);
    }

    // ── FOOTER ON EVERY PAGE ───────────────────────────────────────────
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      // Footer line
      doc.moveTo(PAGE_LEFT, 790).lineTo(PAGE_RIGHT, 790).lineWidth(0.5).strokeColor(COL_RULE).stroke();
      doc.fontSize(7).fillColor(COL_FAINT).font('Helvetica').text(
        'Beautifully Ordered Ltd · Co. No. 17231554 · beautifullyordered.co.uk',
        PAGE_LEFT, 800, { align: 'left', width: PAGE_WIDTH * 0.7 }
      );
      doc.fontSize(7).fillColor(COL_FAINT).text(
        `Page ${i + 1} of ${range.count}`,
        PAGE_LEFT, 800, { align: 'right', width: PAGE_WIDTH }
      );
      doc.fontSize(7).fillColor(COL_FAINT).text(
        `Generated ${new Date().toLocaleString('en-GB')}`,
        PAGE_LEFT, 812, { align: 'left', width: PAGE_WIDTH }
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

// POST /api/admin/edit/recurate — manually re-curate this week's Edit
router.post('/edit/recurate', requireRole('admin'), async (req, res, next) => {
  try {
    const theEdit = require('../services/theEdit');
    const result = await theEdit.recurateEdit();
    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, 'edit_recurated', 'the_edit', NULL, $2)`,
      [req.user.id, JSON.stringify(result)]
    );
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// PHOTO LIBRARY — generic photos by brand+model+colour (admin-managed)
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/admin/photo-library?brand=&model=&colour=
router.get('/photo-library', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { brand, model, colour } = req.query;
    let where = '1=1';
    const params = [];
    if (brand) { params.push(brand); where += ` AND brand ILIKE $${params.length}`; }
    if (model) { params.push(model); where += ` AND model ILIKE $${params.length}`; }
    if (colour){ params.push(colour); where += ` AND colour ILIKE $${params.length}`; }
    const { rows } = await db.query(
      `SELECT id, brand, model, colour, url, caption, is_primary, created_at
       FROM shoe_photo_library
       WHERE ${where}
       ORDER BY brand, model, colour, is_primary DESC, created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/admin/photo-library — add a new generic photo (URL-based)
router.post('/photo-library', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { brand, model, colour, url, caption, is_primary } = req.body;
    if (!brand || !model || !url) {
      return res.status(400).json({ error: 'brand, model and url are required' });
    }
    const { rows } = await db.query(
      `INSERT INTO shoe_photo_library (brand, model, colour, url, caption, is_primary, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [brand, model, colour || null, url, caption || null, !!is_primary, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/admin/photo-library/:id
router.delete('/photo-library/:id', requireRole('admin'), async (req, res, next) => {
  try {
    await db.query(`DELETE FROM shoe_photo_library WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /api/admin/photo-library/match?brand=&model=&colour=
// Returns the best-matching photo for listing decisions
router.get('/photo-library/match', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { brand, model, colour } = req.query;
    if (!brand || !model) return res.json({ matches: [] });
    // Try exact colour match first
    let { rows } = await db.query(
      `SELECT * FROM shoe_photo_library
       WHERE brand ILIKE $1 AND model ILIKE $2 AND ($3::text IS NULL OR colour ILIKE $3)
       ORDER BY is_primary DESC, created_at DESC LIMIT 6`,
      [brand, model, colour || null]
    );
    // Fallback: any colour of same model
    if (!rows.length && colour) {
      const { rows: any } = await db.query(
        `SELECT * FROM shoe_photo_library
         WHERE brand ILIKE $1 AND model ILIKE $2
         ORDER BY is_primary DESC, created_at DESC LIMIT 6`,
        [brand, model]
      );
      rows = any;
    }
    res.json({ matches: rows });
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// SUBMISSION TIMELINE — full activity history for a shoe
// ──────────────────────────────────────────────────────────────────────────────

router.get('/shoes/:id/timeline', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const events = require('../services/submissionEvents');
    const timeline = await events.getTimeline(req.params.id);
    res.json(timeline);
  } catch (err) { next(err); }
});

module.exports = router;
