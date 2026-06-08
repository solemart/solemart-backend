const express = require('express');
const { body, validationResult } = require('express-validator');
const db      = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const emailService = require('../services/email');
const { logActivity } = require('../services/activityLog');
const router  = express.Router();

// ── KSM shoe code ─────────────────────────────────────────────────────────────
// Format: KSM-BRAND-{size}{GenderInitial}-{4 digits}   e.g. KSM-NIKE-9M-4821
// Gender initial: Men's→M, Women's→W, Unisex→U, Kids→K. Size keeps half sizes (9.5).
// Checks the DB for collisions and retries. Never throws — always returns a code.
async function generateKsmCode(brand, size, gender) {
  const bc = String(brand || 'KSM').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'KSM';
  const g  = { "men's": 'M', mens: 'M', men: 'M', "women's": 'W', womens: 'W', women: 'W',
               unisex: 'U', kids: 'K', kid: 'K', children: 'K' }[String(gender || '').toLowerCase()] || 'U';
  const sz = String(size || '').replace(/[^0-9.]/g, '') || '0';
  for (let attempt = 0; attempt < 12; attempt++) {
    const digits = String(Math.floor(1000 + Math.random() * 9000)); // always 4 digits
    const code = `KSM-${bc}-${sz}${g}-${digits}`;
    try {
      const { rows } = await db.query('SELECT 1 FROM shoes WHERE shoe_code = $1 LIMIT 1', [code]);
      if (!rows.length) return code;
    } catch (e) {
      return code; // if the uniqueness check itself fails, use the code anyway
    }
  }
  return `KSM-${bc}-${sz}${g}-${String(Math.floor(1000 + Math.random() * 9000))}`;
}

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
    const { stage } = req.query; // authenticating | cleaning | submitted | all | donations

    // Donations-only filter
    if (stage === 'donations') {
      const { rows: donations } = await db.query(
        `SELECT id, reference, donor_name, donor_email, donor_phone,
                shoe_description, pair_count, notes,
                collection_line1, collection_line2, collection_city,
                collection_county, collection_postcode,
                status, created_at, label_url
         FROM donations
         WHERE status NOT IN ('completed','rejected','cancelled')
         ORDER BY created_at ASC`
      );
      return res.json(donations.map(d => ({
        ...d,
        submission_type: 'donation',
        first_name: d.donor_name,
        brand: 'Donation',
        model: d.shoe_description,
        size: `${d.pair_count} pair${d.pair_count > 1 ? 's' : ''}`,
        submitted_at: d.created_at,
      })));
    }

    // Submissions = anything pre-listing (not yet on the catalogue)
    let where = `s.status IN ('awaiting_approval','submitted','in_transit','authenticating','cleaning','rejected')`;
    if (stage && stage !== 'all') where = `s.status = '${stage}'`;

    const { rows: shoeSubmissions } = await db.query(
      `SELECT s.*, u.first_name, u.last_name, u.email,
              ls.reference AS submission_ref, ls.collection_postcode,
              COALESCE(
                (SELECT json_agg(json_build_object('id', sp.id, 'url', sp.url, 'caption', sp.caption, 'is_cover', COALESCE(sp.is_cover, FALSE), 'uploaded_by_role', sp.uploaded_by_role) ORDER BY COALESCE(sp.is_cover, FALSE) DESC, sp.sort_order)
                 FROM shoe_photos sp WHERE sp.shoe_id = s.id),
                '[]'::json
              ) AS owner_photos
       FROM shoes s
       JOIN users u ON u.id = s.owner_id
       LEFT JOIN submission_shoes ss ON ss.shoe_id = s.id
       LEFT JOIN listing_submissions ls ON ls.id = ss.submission_id
       WHERE ${where}
       ORDER BY s.created_at ASC`,
    );

    // Also include unprocessed donations in the unified queue
    let donations = [];
    if (!stage || stage === 'all') {
      try {
        const { rows } = await db.query(
          `SELECT id, reference, donor_name, donor_email, shoe_description,
                  pair_count, status, created_at, collection_postcode, label_url
           FROM donations
           WHERE status NOT IN ('completed','rejected','cancelled')
           ORDER BY created_at ASC`
        );
        donations = rows.map(d => ({
          id:                 d.id,
          submission_type:    'donation',
          submission_ref:     d.reference,
          first_name:         d.donor_name,
          last_name:          '',
          email:              d.donor_email,
          brand:              'Donation',
          model:              d.shoe_description,
          size:               `${d.pair_count} pair${d.pair_count > 1 ? 's' : ''}`,
          status:             d.status,
          submitted_at:       d.created_at,
          collection_postcode: d.collection_postcode,
          emoji:              '💚',
          owner_photos:       [],
          label_url:          d.label_url,
          pair_count:         d.pair_count,
        }));
      } catch (e) {
        // Donations table optional — silent fallback
      }
    }

    // Also include active clean-only bookings — these live in the Cleaning sub-tab
    // alongside rental-return shoes (which have status='cleaning' on the shoes table)
    let cleanBookings = [];
    if (!stage || stage === 'all' || stage === 'cleaning') {
      try {
        const { rows } = await db.query(
          `SELECT cb.*, u.first_name AS user_first_name, u.last_name AS user_last_name
           FROM clean_bookings cb
           LEFT JOIN users u ON u.id = cb.customer_id
           WHERE cb.status NOT IN ('returned','cancelled')
             AND cb.payment_status = 'paid'
           ORDER BY cb.booked_at ASC`
        );
        cleanBookings = rows.map(cb => ({
          id:                 cb.id,
          submission_type:    'clean_only',
          submission_ref:     cb.reference,
          first_name:         cb.contact_name || cb.user_first_name || 'Customer',
          last_name:          cb.user_last_name || '',
          email:              cb.contact_email,
          phone:              cb.contact_phone,
          brand:              cb.service_name || 'Cleaning',
          model:              cb.shoe_description,
          size:               `${cb.pair_count} pair${cb.pair_count > 1 ? 's' : ''}`,
          // Map clean-booking statuses to a unified status that the UI understands
          // booked/collected → still in transit
          // in_progress → cleaning sub-tab
          // complete → ready to return to customer (still cleaning sub-tab, different action)
          status: (cb.status === 'booked' || cb.status === 'collected')
                    ? 'in_transit'
                    : (cb.status === 'in_progress' || cb.status === 'complete')
                      ? 'cleaning'
                      : cb.status,
          internal_status:    cb.status, // raw booking status for action button logic
          submitted_at:       cb.booked_at,
          collection_postcode: cb.return_postcode,
          emoji:              '🧹',
          owner_photos:       [],
          label_url:          cb.label_url,
          pair_count:         cb.pair_count,
          service_type:       cb.service_type,
          total_price:        cb.total_price,
          return_address: {
            line1:    cb.return_line1,
            line2:    cb.return_line2,
            city:     cb.return_city,
            county:   cb.return_county,
            postcode: cb.return_postcode,
          },
        }));
      } catch (e) {
        console.warn('Clean bookings table query failed:', e.message);
      }
    }

    res.json([...shoeSubmissions, ...donations, ...cleanBookings].sort((a, b) =>
      new Date(a.submitted_at) - new Date(b.submitted_at)));
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

    // Generate a KSM code on first listing if missing (new format includes size+gender).
    // generateKsmCode never throws, so this can never abort the listing.
    let extraUpdate = '';
    let extraValues = [];
    const newStatus = req.body.status;
    if (newStatus === 'listed' && !before.shoe_code) {
      const code = await generateKsmCode(
        req.body.brand  || before.brand,
        req.body.size   || before.size,
        req.body.gender || before.gender
      );
      if (code) {
        extraUpdate = ', shoe_code = $' + (updates.length + 2);
        extraValues.push(code);
      }
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
              s.brand, s.model, s.emoji, s.size AS shoe_size, s.shoe_code,
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
    let where, params = [];
    if (status && status !== 'all') {
      params.push(status);
      where = `s.status = $${params.length}`;
    } else {
      // "All" in Live Catalogue means active live shoes only:
      // listed, rented, sold — NOT returned_to_owner (those belong in Returns)
      // and NOT submitted/in_transit/authenticating/cleaning/rejected (those belong in Submissions)
      where = `s.status IN ('listed','rented','sold')`;
    }
    const { rows } = await db.query(
      `SELECT s.*,
              u.first_name, u.last_name, u.email AS owner_email,
              u.first_name || ' ' || u.last_name AS owner_display,
              ls.reference AS submission_ref, ls.collection_postcode,
              (SELECT sp.url FROM shoe_photos sp WHERE sp.shoe_id = s.id
                ORDER BY sp.is_cover DESC, sp.sort_order ASC, sp.uploaded_at ASC LIMIT 1) AS cover_url
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

// POST /api/admin/shoes — admin registers a new shoe
router.post('/shoes', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const {
      brand, model, size, colour, category, gender, condition,
      rrp, rent_price, buy_price, owner_id, owner_email,
      description, assessed_wear_grade,
      barcode, listing_type, status,
      library_photo_id, photos,
    } = req.body;

    // Validation
    if (!brand || !model || !size) {
      return res.status(400).json({ error: 'Brand, model and size are required' });
    }

    // Find or use specified owner
    let ownerIdToUse = owner_id;
    if (!ownerIdToUse && owner_email) {
      const { rows } = await db.query(`SELECT id FROM users WHERE email = $1`, [owner_email]);
      if (!rows.length) {
        return res.status(404).json({ error: `No user found with email ${owner_email}` });
      }
      ownerIdToUse = rows[0].id;
    }
    if (!ownerIdToUse) {
      ownerIdToUse = req.user.id; // default to admin
    }

    // Normalise condition to one of the two valid values
    const normalisedCondition = condition === 'New' ? 'New' : 'Pre-owned';

    // Default to 'awaiting_approval' for admin-registered shoes — they need final approval before listing
    const initialStatus = status || 'awaiting_approval';
    const isListing = initialStatus === 'listed';

    // Only generate a KSM code if creating as listed (new format includes size+gender)
    let shoeCode = null;
    if (isListing) {
      shoeCode = await generateKsmCode(brand, size, gender);
    }

    // Probe which columns actually exist in the shoes table (defensive against partial migrations)
    let hasShoeCode = false, hasLibraryPhotoId = false;
    try {
      const { rows: cols } = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'shoes'`
      );
      const colNames = cols.map(c => c.column_name);
      hasShoeCode = colNames.includes('shoe_code');
      hasLibraryPhotoId = colNames.includes('library_photo_id');
    } catch (e) { /* fallback - assume nothing */ }

    // Build INSERT dynamically — only include columns that exist
    let columns = ['owner_id', 'brand', 'model', 'size', 'colour', 'category', 'gender', 'condition',
                   'rrp', 'rent_price', 'buy_price', 'description',
                   'assessed_wear_grade', 'listing_type', 'status'];
    let values  = [ownerIdToUse, brand, model, size, colour || null, category || null,
                   gender || 'Unisex', normalisedCondition,
                   rrp || null, rent_price || null, buy_price || null,
                   description || null,
                   assessed_wear_grade || null, listing_type || 'both', initialStatus];

    // Default emoji (legacy column may or may not exist; harmless if it does)
    columns.push('emoji'); values.push('👟');

    if (hasShoeCode && shoeCode) {
      columns.push('shoe_code', 'listed_at');
      values.push(shoeCode);
      values.push(new Date());
    } else if (hasShoeCode) {
      // include null for shoe_code so query doesn't drift later
    }
    if (hasLibraryPhotoId && library_photo_id) {
      columns.push('library_photo_id');
      values.push(library_photo_id);
    }

    const placeholders = values.map((_, i) => '$' + (i + 1)).join(',');
    const colList = columns.join(',');

    let createdShoe;
    try {
      const { rows } = await db.query(
        `INSERT INTO shoes (${colList}) VALUES (${placeholders}) RETURNING *`,
        values
      );
      createdShoe = rows[0];
    } catch (e) {
      console.error('Shoe INSERT failed:', e.message, 'columns:', colList);
      return res.status(500).json({ error: `Database insert failed: ${e.message}` });
    }

    // Save uploaded photos (base64 data URLs) — store as shoe_photos rows
    if (Array.isArray(photos) && photos.length) {
      for (let i = 0; i < photos.length; i++) {
        try {
          await db.query(
            `INSERT INTO shoe_photos (shoe_id, url, caption, sort_order, is_cover, uploaded_by_role)
             VALUES ($1, $2, $3, $4, $5, 'admin')`,
            [createdShoe.id, photos[i], `Photo ${i + 1}`, i, i === 0]
          );
        } catch (e) {
          // Fallback for old schema without is_cover/uploaded_by_role columns
          try {
            await db.query(
              `INSERT INTO shoe_photos (shoe_id, url, caption, sort_order)
               VALUES ($1, $2, $3, $4)`,
              [createdShoe.id, photos[i], `Photo ${i + 1}`, i]
            );
          } catch (e2) {
            console.warn('Photo save failed (idx ' + i + '):', e2.message);
          }
        }
      }
    }

    // Log to submission_events
    try {
      await db.query(
        `INSERT INTO submission_events (shoe_id, event_type, status_after, actor_id, actor_role, notes)
         VALUES ($1, $2, $3, $4, 'kosmos', $5)`,
        [createdShoe.id, isListing ? 'listed' : 'submitted', initialStatus, req.user.id,
         isListing ? `Listed directly by ${req.user.email || 'admin'}`
                   : `Created by Kosmos admin — awaiting approval`]
      );
    } catch (e) { /* table may not exist on older deploys */ }

    // Activity log
    try {
      await db.query(
        `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
         VALUES ($1, $2, 'shoe', $3, $4)`,
        [req.user.id, isListing ? 'admin_listed_shoe' : 'admin_created_submission',
         createdShoe.id, JSON.stringify({ shoe_code: shoeCode, brand, model, barcode: barcode || null,
                                          photo_count: (photos || []).length })]
      );
    } catch (e) { /* log table optional */ }

    res.status(201).json(createdShoe);
  } catch (err) {
    console.error('POST /admin/shoes ERROR:', err);
    res.status(500).json({ error: err.message || 'Unexpected error registering shoe' });
  }
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

// POST /api/admin/shoes/:id/return-review — scan a returned shoe's QR (rental OR sold)
// Both rentals and purchases can come back. A passed return goes to the Reviewing
// tab (the 'authenticating' stage) to be re-checked, then cleaned and re-listed.
// outcome 'pass' → shoe to 'authenticating' (Reviewing tab)
// outcome 'fail' → shoe to 'rejected' (owner notified)
// The returning customer is asked to leave a review.
router.post('/shoes/:id/return-review', requireRole('staff', 'admin'), async (req, res, next) => {
  const client = await db.connect();
  try {
    const outcome = req.body.outcome || 'pass';
    const notes = req.body.notes;
    if (!['pass', 'fail'].includes(outcome)) {
      return res.status(400).json({ error: 'Outcome must be pass or fail' });
    }
    // Passed returns go to the Reviewing tab (authenticating); failed → rejected
    const newStatus = outcome === 'pass' ? 'authenticating' : 'rejected';

    await client.query('BEGIN');

    // 1. Verify shoe exists + get owner info
    const { rows: [shoe] } = await client.query(
      `SELECT s.*, u.first_name, u.email AS owner_email
       FROM shoes s JOIN users u ON u.id = s.owner_id
       WHERE s.id = $1`,
      [req.params.id]
    );
    if (!shoe) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shoe not found' });
    }

    // 2. Find the most recent active order for this shoe — RENTAL or PURCHASE.
    //    Rentals: active_rental/delivered/etc. Purchases: cleaning/dispatched/delivered/completed.
    let updatedOrderId = null;
    let reviewCustomerId = null;
    let reviewOrderRef = null;
    let returnedType = null;
    const { rows: activeOrders } = await client.query(
      `SELECT id, reference, customer_id, order_type, status FROM orders
       WHERE shoe_id = $1
         AND status IN (
           'confirmed','cleaning','dispatched','delivered',
           'active_rental','return_initiated','returned','completed'
         )
       ORDER BY created_at DESC
       LIMIT 1`,
      [req.params.id]
    );
    if (activeOrders.length) {
      updatedOrderId = activeOrders[0].id;
      reviewCustomerId = activeOrders[0].customer_id;
      reviewOrderRef = activeOrders[0].reference;
      returnedType = activeOrders[0].order_type;
      // Mark the order returned + stamp the review request (once).
      await client.query(
        `UPDATE orders
         SET status = 'returned', actual_return_date = NOW(),
             review_requested_at = COALESCE(review_requested_at, NOW()),
             updated_at = NOW()
         WHERE id = $1`,
        [updatedOrderId]
      );
    }

    // 3. Update shoe status → authenticating (Reviewing) or rejected
    await client.query(
      `UPDATE shoes SET status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, req.params.id]
    );

    // 4. Owner-visible timeline note
    try {
      const kind = returnedType === 'buy' ? 'purchase' : 'rental';
      const ownerNotes = outcome === 'pass'
        ? `Returned ${kind} received — back in Reviewing for re-check. ${notes || ''}`.trim()
        : `Returned ${kind} with issues — rejected. ${notes || ''}`.trim();
      await client.query(
        `INSERT INTO submission_events (shoe_id, event_type, status_after, actor_id, actor_role, notes, visible_to_owner)
         VALUES ($1, $2, $3, $4, 'kosmos', $5, TRUE)`,
        [req.params.id, `return_${outcome}`, newStatus, req.user.id, ownerNotes]
      );
    } catch (e) { /* optional table */ }

    // 5. Activity feed
    await client.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, $2, 'shoe', $3, $4)`,
      [req.user.id, `return_${outcome}`, req.params.id,
       JSON.stringify({ order_id: updatedOrderId, order_type: returnedType, notes: notes || null, new_status: newStatus })]
    );

    await client.query('COMMIT');

    // 6. Email the customer a review request (non-blocking, outside the txn)
    if (outcome === 'pass' && reviewCustomerId) {
      (async () => {
        try {
          const { rows: cust } = await db.query(`SELECT * FROM users WHERE id = $1`, [reviewCustomerId]);
          if (cust[0] && emailService.sendReviewRequest) {
            emailService.sendReviewRequest(cust[0], shoe, reviewOrderRef).catch(() => {});
          }
        } catch {}
      })();
    }

    res.json({
      ok: true,
      shoe_id: req.params.id,
      order_id: updatedOrderId,
      new_status: newStatus,
      review_requested: outcome === 'pass' && !!reviewCustomerId,
      outcome,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('POST /admin/shoes/:id/return-review error:', err);
    res.status(500).json({ error: err.message || 'Could not process return' });
  } finally {
    client.release();
  }
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

    // Get current shoe to identify its variant group
    const { rows: [target] } = await db.query(
      `SELECT brand, model, size, colour, assessed_wear_grade FROM shoes WHERE id = $1`,
      [req.params.id]
    );
    if (!target) return res.status(404).json({ error: 'Shoe not found' });

    // Price sync: apply to ALL listed pairs in the same variant group
    // (Brand + Model + Size + Colour + Wear Grade — prices stay in sync per the architecture)
    updates.push(`updated_at = NOW()`);
    const variantParams = [target.brand, target.model, target.size, target.colour, target.assessed_wear_grade];
    const { rows } = await db.query(
      `UPDATE shoes SET ${updates.join(', ')}
       WHERE status = 'listed'
         AND LOWER(brand) = LOWER($${n++})
         AND LOWER(model) = LOWER($${n++})
         AND LOWER(COALESCE(size,'')) = LOWER(COALESCE($${n++},''))
         AND LOWER(COALESCE(colour,'')) = LOWER(COALESCE($${n++},''))
         AND LOWER(COALESCE(assessed_wear_grade,'')) = LOWER(COALESCE($${n++},''))
       RETURNING *`,
      [...values, ...variantParams]
    );

    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, 'price_updated', 'shoe', $2, $3)`,
      [req.user.id, req.params.id, JSON.stringify({ ...req.body, synced_count: rows.length })]
    );

    res.json({ updated_count: rows.length, shoes: rows });
  } catch (err) { next(err); }
});

// PATCH /api/admin/shoes/:id/details — update non-price details (any field)
router.patch('/shoes/:id/details', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const allowed = ['brand','model','size','colour','category','gender','condition',
                     'description','emoji','assessed_wear_grade','status'];
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

// ──────────────────────────────────────────────────────────────────────────────
// DONATIONS — admin updates + convert to shoe submissions
// ──────────────────────────────────────────────────────────────────────────────

router.patch('/donations/:id', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { status } = req.body;
    const allowedStatuses = ['pending','collected','processing','completed','rejected','cancelled'];
    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const { rows } = await db.query(
      `UPDATE donations SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Donation not found' });

    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, $2, 'donation', $3, $4)`,
      [req.user.id, 'donation_status_changed', req.params.id, JSON.stringify({ status })]
    );

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/admin/donations/:id/convert — turn a donation into shoe submissions
router.post('/donations/:id/convert', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { rows: [donation] } = await db.query(
      `SELECT * FROM donations WHERE id = $1`,
      [req.params.id]
    );
    if (!donation) return res.status(404).json({ error: 'Donation not found' });

    // Find or create the donor as a user (so they own the resulting shoes)
    let donorId;
    const { rows: existing } = await db.query(
      `SELECT id FROM users WHERE email = $1`,
      [donation.donor_email]
    );
    if (existing.length) {
      donorId = existing[0].id;
    } else {
      // Create a passive account for the donor (they can claim it later if they sign up)
      const { rows: newUser } = await db.query(
        `INSERT INTO users (email, first_name, last_name, role, source)
         VALUES ($1, $2, $3, 'customer', 'donation') RETURNING id`,
        [donation.donor_email, donation.donor_name || 'Donor', '']
      );
      donorId = newUser[0].id;
    }

    // Create N shoe submissions (one per pair donated)
    const created = [];
    for (let i = 0; i < (donation.pair_count || 1); i++) {
      const { rows } = await db.query(
        `INSERT INTO shoes (
          owner_id, brand, model, size, condition,
          listing_type, status, description, emoji
        ) VALUES ($1, 'Donation', $2, 'TBC', 'TBC', 'both', 'submitted', $3, '💚')
        RETURNING id`,
        [donorId,
         `Donated pair ${i + 1} of ${donation.pair_count}`,
         `From donation ${donation.reference}: ${donation.shoe_description}`]
      );
      created.push(rows[0].id);

      // Try to log submission event if table exists
      try {
        await db.query(
          `INSERT INTO submission_events (shoe_id, event_type, status_after, actor_id, actor_role, notes)
           VALUES ($1, 'submitted', 'submitted', $2, 'kosmos', $3)`,
          [rows[0].id, req.user.id, `Converted from donation ${donation.reference}`]
        );
      } catch (e) {}
    }

    // Mark donation as processed
    await db.query(
      `UPDATE donations SET status = 'completed' WHERE id = $1`,
      [donation.id]
    );

    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, 'donation_converted', 'donation', $2, $3)`,
      [req.user.id, donation.id, JSON.stringify({ created_count: created.length, shoe_ids: created })]
    );

    res.json({ ok: true, created: created.length, shoe_ids: created });
  } catch (err) {
    console.error('Donation convert error:', err);
    next(err);
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// CLEAN BOOKINGS — admin lifecycle: collected → in_progress → complete → returned
// ──────────────────────────────────────────────────────────────────────────────

// PATCH /api/admin/clean-bookings/:id/status — change a clean booking's status
router.patch('/clean-bookings/:id/status', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    const valid = ['booked','collected','in_progress','complete','returned','cancelled'];
    if (!valid.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Status-specific timestamp columns
    const tsCol = {
      collected: 'collected_at',
      complete:  'completed_at',
      returned:  'returned_at',
    }[status];

    const setClause = tsCol
      ? `status = $1, ${tsCol} = COALESCE(${tsCol}, NOW())`
      : `status = $1`;

    const { rows } = await db.query(
      `UPDATE clean_bookings SET ${setClause} WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Clean booking not found' });

    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, $2, 'clean_booking', $3, $4)`,
      [req.user.id, `clean_${status}`, req.params.id, JSON.stringify({ notes: notes || null })]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error('Clean booking status update error:', err);
    next(err);
  }
});

// POST /api/admin/clean-bookings/:id/return-to-customer
// Marks booking complete → generates return label → notifies customer → starts tracking
router.post('/clean-bookings/:id/return-to-customer', requireRole('staff', 'admin'), async (req, res, next) => {
  const client = await db.connect();
  try {
    const { tracking_number, carrier, label_url, notes } = req.body;

    await client.query('BEGIN');

    // Get booking with customer info
    const { rows: [booking] } = await client.query(
      `SELECT cb.*,
              u.email AS user_email, u.first_name AS user_first
       FROM clean_bookings cb
       LEFT JOIN users u ON u.id = cb.customer_id
       WHERE cb.id = $1`,
      [req.params.id]
    );
    if (!booking) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Clean booking not found' });
    }

    // Generate return label (placeholder — wire to a real carrier API later)
    // For now: use the URL admin provided, or auto-generate a placeholder reference
    let finalTrackingNumber = tracking_number || null;
    let finalLabelUrl       = label_url || booking.label_url || null;
    let finalCarrier        = carrier || 'royal-mail';

    if (!finalTrackingNumber) {
      // Generate a placeholder tracking number — replace with real carrier integration later
      finalTrackingNumber = `KSM${booking.reference.replace(/[^0-9A-Z]/gi,'').toUpperCase().slice(0,8)}${Math.floor(Math.random()*9000+1000)}`;
    }
    if (!finalLabelUrl) {
      // Placeholder label URL — TODO: integrate Royal Mail / ShipEngine API
      finalLabelUrl = `https://api.kosmos.co.uk/labels/clean-return/${booking.id}.pdf`;
    }

    // Update the booking: set tracking + status=complete (ready for delivery)
    await client.query(
      `UPDATE clean_bookings
       SET status = 'complete',
           label_url = $1,
           return_tracking_number = $2,
           return_carrier = $3,
           return_label_created_at = NOW(),
           completed_at = COALESCE(completed_at, NOW())
       WHERE id = $4`,
      [finalLabelUrl, finalTrackingNumber, finalCarrier, req.params.id]
    );

    // Notify the customer — send email if possible
    const recipientEmail = booking.user_email || booking.contact_email;
    const recipientName  = booking.user_first || booking.contact_name || 'there';
    try {
      const { sendEmail } = require('../services/email');
      const trackingLink = `${process.env.SITE_URL || 'https://beautifullyordered.co.uk'}/?page=account&tab=cleans&track=${booking.id}`;
      await sendEmail({
        to: recipientEmail,
        subject: `Your clean is on its way back — ${booking.reference}`,
        html: `
          <p>Hi ${recipientName},</p>
          <p>Your shoes have been cleaned to our standard and are on their way back to you.</p>
          <p><strong>Tracking number:</strong> ${finalTrackingNumber}<br/>
          <strong>Carrier:</strong> ${finalCarrier === 'royal-mail' ? 'Royal Mail' : finalCarrier}</p>
          <p>Track your return: <a href="${trackingLink}">${trackingLink}</a></p>
          ${notes ? `<p><em>Notes from our team:</em> ${notes}</p>` : ''}
          <p>Thanks for choosing Kosmos.<br/>— Beautifully Ordered</p>
        `,
      });
    } catch (e) {
      console.warn('Email send skipped:', e.message);
    }

    // Activity log
    await client.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, 'clean_return_dispatched', 'clean_booking', $2, $3)`,
      [req.user.id, req.params.id,
       JSON.stringify({ tracking_number: finalTrackingNumber, carrier: finalCarrier, notified: !!recipientEmail })]
    );

    await client.query('COMMIT');

    res.json({
      ok: true,
      tracking_number: finalTrackingNumber,
      carrier: finalCarrier,
      label_url: finalLabelUrl,
      notified: !!recipientEmail,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('Clean return-to-customer error:', err);
    res.status(500).json({ error: err.message || 'Could not process return' });
  } finally {
    client.release();
  }
});

// POST /api/admin/clean-bookings/:id/mark-delivered — manual confirmation when tracking shows delivered
router.post('/clean-bookings/:id/mark-delivered', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `UPDATE clean_bookings
       SET status = 'returned',
           returned_at = COALESCE(returned_at, NOW())
       WHERE id = $1
       RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Clean booking not found' });

    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, 'clean_delivered', 'clean_booking', $2, '{}')`,
      [req.user.id, req.params.id]
    );

    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ──────────────────────────────────────────────────────────────────────────────
// SHOE PHOTOS — add / delete / set cover (display photo)
// ──────────────────────────────────────────────────────────────────────────────

// GET all photos for a shoe (admin needs metadata like is_cover, uploaded_by_role)
router.get('/shoes/:id/photos', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    let rows;
    try {
      const result = await db.query(
        `SELECT id, url, caption, sort_order, is_cover, uploaded_by_role, uploaded_at
         FROM shoe_photos
         WHERE shoe_id = $1
         ORDER BY is_cover DESC, sort_order ASC, uploaded_at ASC`,
        [req.params.id]
      );
      rows = result.rows;
    } catch (e) {
      // Old schema fallback
      const result = await db.query(
        `SELECT id, url, caption, sort_order, uploaded_at
         FROM shoe_photos
         WHERE shoe_id = $1
         ORDER BY sort_order ASC, uploaded_at ASC`,
        [req.params.id]
      );
      rows = result.rows.map((r, i) => ({ ...r, is_cover: i === 0, uploaded_by_role: null }));
    }
    res.json(rows);
  } catch (err) {
    console.error('GET shoe photos error:', err);
    next(err);
  }
});

// POST add new photo(s) to a shoe
router.post('/shoes/:id/photos', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { photos } = req.body; // array of base64 data URLs
    if (!Array.isArray(photos) || !photos.length) {
      return res.status(400).json({ error: 'No photos provided' });
    }

    // Verify shoe exists
    const { rows: [shoe] } = await db.query(`SELECT id FROM shoes WHERE id = $1`, [req.params.id]);
    if (!shoe) return res.status(404).json({ error: 'Shoe not found' });

    // Determine current max sort_order so new photos go at the end
    const { rows: [{ max_order }] } = await db.query(
      `SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM shoe_photos WHERE shoe_id = $1`,
      [req.params.id]
    );

    // Check if shoe already has a cover; if not, the first new photo becomes cover
    let hasCover = false;
    try {
      const { rows: coverCheck } = await db.query(
        `SELECT 1 FROM shoe_photos WHERE shoe_id = $1 AND is_cover = TRUE LIMIT 1`,
        [req.params.id]
      );
      hasCover = coverCheck.length > 0;
    } catch (e) { /* old schema; skip */ }

    const created = [];
    let startOrder = parseInt(max_order) + 1;
    for (let i = 0; i < photos.length; i++) {
      const shouldBeCover = !hasCover && i === 0;
      try {
        const { rows } = await db.query(
          `INSERT INTO shoe_photos (shoe_id, url, caption, sort_order, is_cover, uploaded_by_role)
           VALUES ($1, $2, $3, $4, $5, 'admin')
           RETURNING id, url, caption, sort_order, is_cover, uploaded_by_role`,
          [req.params.id, photos[i], `Photo ${startOrder + i + 1}`, startOrder + i, shouldBeCover]
        );
        created.push(rows[0]);
      } catch (e) {
        // Old schema fallback
        try {
          const { rows } = await db.query(
            `INSERT INTO shoe_photos (shoe_id, url, caption, sort_order)
             VALUES ($1, $2, $3, $4)
             RETURNING id, url, caption, sort_order`,
            [req.params.id, photos[i], `Photo ${startOrder + i + 1}`, startOrder + i]
          );
          created.push(rows[0]);
        } catch (e2) {
          console.warn('Photo add failed:', e2.message);
        }
      }
    }
    res.json({ added: created.length, photos: created });
  } catch (err) {
    console.error('Add photos error:', err);
    next(err);
  }
});

// DELETE a single photo
router.delete('/shoes/:shoeId/photos/:photoId', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    // Check if the photo being deleted is the cover — we'll need to re-assign cover after
    let wasCover = false;
    try {
      const { rows } = await db.query(
        `SELECT is_cover FROM shoe_photos WHERE id = $1 AND shoe_id = $2`,
        [req.params.photoId, req.params.shoeId]
      );
      if (rows.length) wasCover = rows[0].is_cover;
    } catch (e) { /* old schema */ }

    const { rowCount } = await db.query(
      `DELETE FROM shoe_photos WHERE id = $1 AND shoe_id = $2`,
      [req.params.photoId, req.params.shoeId]
    );
    if (!rowCount) return res.status(404).json({ error: 'Photo not found' });

    // If we just deleted the cover, promote the next-oldest photo to cover
    if (wasCover) {
      try {
        await db.query(
          `UPDATE shoe_photos SET is_cover = TRUE
           WHERE id = (
             SELECT id FROM shoe_photos
             WHERE shoe_id = $1
             ORDER BY sort_order ASC, uploaded_at ASC
             LIMIT 1
           )`,
          [req.params.shoeId]
        );
      } catch (e) { /* old schema */ }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete photo error:', err);
    next(err);
  }
});

// PATCH set a photo as the cover (display photo)
router.patch('/shoes/:shoeId/photos/:photoId/cover', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    // Set the chosen photo as cover first (verifies it exists), then clear the rest.
    // Uses plain db.query — no explicit transaction — so it works regardless of the db client shape.
    const { rowCount } = await db.query(
      `UPDATE shoe_photos SET is_cover = TRUE WHERE id = $1 AND shoe_id = $2`,
      [req.params.photoId, req.params.shoeId]
    );
    if (!rowCount) {
      return res.status(404).json({ error: 'Photo not found' });
    }
    await db.query(
      `UPDATE shoe_photos SET is_cover = FALSE WHERE shoe_id = $1 AND id <> $2`,
      [req.params.shoeId, req.params.photoId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Set cover error:', err);
    res.status(500).json({ error: err.message || 'Could not set cover' });
  }
});

// DELETE shoe (only allowed for pre-listed statuses to prevent accidental loss of live inventory)
router.delete('/shoes/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { rows: [shoe] } = await db.query(
      `SELECT id, status, brand, model, shoe_code FROM shoes WHERE id = $1`,
      [req.params.id]
    );
    if (!shoe) return res.status(404).json({ error: 'Shoe not found' });

    // Protect listed/rented/sold shoes from deletion — use status override instead
    const deletableStatuses = ['awaiting_approval','submitted','in_transit','authenticating','cleaning','rejected'];
    if (!deletableStatuses.includes(shoe.status)) {
      return res.status(409).json({
        error: `Cannot delete a shoe with status "${shoe.status}". Use Reject or change status first.`,
      });
    }

    // shoe_photos will cascade via ON DELETE CASCADE; submission_events too if configured
    await db.query(`DELETE FROM shoes WHERE id = $1`, [req.params.id]);

    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, 'shoe_deleted', 'shoe', $2, $3)`,
      [req.user.id, req.params.id,
       JSON.stringify({ brand: shoe.brand, model: shoe.model, shoe_code: shoe.shoe_code, prev_status: shoe.status })]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('Delete shoe error:', err);
    res.status(500).json({ error: err.message || 'Could not delete shoe' });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// VERIFICATION — admin review of proof-of-address documents
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/admin/verifications — list users pending proof-of-address review
router.get('/verifications', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, first_name, last_name, email,
              id_verified, id_verified_at, id_verified_name,
              address_proof_status, address_proof_extracted, address_verified,
              address_proof_url
       FROM users
       WHERE address_proof_status IN ('pending','manual_review')
       ORDER BY address_verified_at ASC NULLS FIRST, id ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/admin/verifications/:userId/decide — approve or reject the address proof
router.post('/verifications/:userId/decide', requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { decision, notes } = req.body; // 'approve' | 'reject'
    if (!['approve', 'reject'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be approve or reject' });
    }
    const approved = decision === 'approve';
    const { rows } = await db.query(
      `UPDATE users
       SET address_verified = $1,
           address_verified_at = CASE WHEN $1 THEN NOW() ELSE address_verified_at END,
           address_proof_status = $2,
           verification_notes = $3
       WHERE id = $4
       RETURNING id, first_name, last_name, email, id_verified, address_verified`,
      [approved, approved ? 'approved' : 'rejected', notes || null, req.params.userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });

    await db.query(
      `INSERT INTO activity_log (actor_id, action, entity_type, entity_id, meta)
       VALUES ($1, $2, 'user', $3, $4)`,
      [req.user.id, `address_${decision}d`, req.params.userId, JSON.stringify({ notes: notes || null })]
    );

    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
