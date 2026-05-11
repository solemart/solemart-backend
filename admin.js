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
              email_verified, created_at
       FROM users ORDER BY created_at DESC LIMIT 200`
    );
    res.json(rows);
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

module.exports = router;
