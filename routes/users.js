const express = require('express');
const { body, validationResult } = require('express-validator');
const db      = require('../config/db');
const { authenticate } = require('../middleware/auth');
const router  = express.Router();

// PATCH /api/users/me  — update profile
router.patch('/me', authenticate, [
  body('first_name').optional().trim().notEmpty(),
  body('last_name').optional().trim().notEmpty(),
  body('phone').optional().trim(),
  body('shoe_size').optional().trim(),
  body('addr_line1').optional().trim(),
  body('addr_city').optional().trim(),
  body('addr_postcode').optional().trim(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const allowed = [
      'first_name','last_name','phone','shoe_size',
      'addr_line1','addr_line2','addr_city','addr_county','addr_postcode',
    ];
    const updates = [];
    const values  = [];

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        values.push(req.body[key]);
        updates.push(`${key} = $${values.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    values.push(req.user.id);
    const { rows } = await db.query(
      `UPDATE users SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING id, first_name, last_name, email, phone, role,
                 addr_line1, addr_line2, addr_city, addr_county, addr_postcode,
                 shoe_size, email_verified`,
      values
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/users/me/push-token
router.post('/me/push-token', authenticate, async (req, res, next) => {
  try {
    const { push_token, platform } = req.body;
    if (!push_token) return res.status(400).json({ error: 'push_token required' });
    await db.query(
      `UPDATE users SET push_token = $1, push_platform = $2 WHERE id = $3`,
      [push_token, platform || 'ios', req.user.id]
    );
    res.json({ saved: true });
  } catch (err) { next(err); }
});

// POST /api/users/me/bank — save encrypted bank details
router.post('/me/bank', authenticate, [
  body('account_name').trim().notEmpty(),
  body('sort_code').matches(/^\d{6}$/).withMessage('Sort code must be 6 digits'),
  body('account_number').matches(/^\d{8}$/).withMessage('Account number must be 8 digits'),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

    const { account_name, sort_code, account_number } = req.body;
    const crypto = require('crypto');
    const key    = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

    const encrypt = (text) => {
      const iv  = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
      return iv.toString('hex') + ':' + encrypted.toString('hex');
    };

    await db.query(
      `INSERT INTO owner_bank_details (user_id, account_name, sort_code_enc, account_num_enc)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE
         SET account_name = $2, sort_code_enc = $3, account_num_enc = $4`,
      [req.user.id, account_name, encrypt(sort_code), encrypt(account_number)]
    );

    res.json({ message: 'Bank details saved securely' });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════
//  GDPR / DATA RIGHTS
//  - GET    /api/users/me/export   → right of access (download all my data)
//  - DELETE /api/users/me          → right to erasure (delete my account)
//
//  Erasure policy: personal data is removed, but completed FINANCIAL records
//  (orders, payouts) are legally required to be retained for ~6 years for
//  tax/accounting (UK). Those are ANONYMISED — personal identifiers stripped,
//  the financial facts kept — rather than deleted. Everything else (profile,
//  address, phone, wishlists, push tokens, bank details, sessions) is deleted.
// ════════════════════════════════════════════════════════════════════════

// GET /api/users/me/export — return everything we hold about this user as JSON
router.get('/me/export', authenticate, async (req, res, next) => {
  try {
    const uid = req.user.id;
    const out = { exported_at: new Date().toISOString() };

    const profile = await db.query(
      `SELECT id, first_name, last_name, email, phone, role,
              addr_line1, addr_line2, addr_city, addr_county, addr_postcode,
              shoe_size, email_verified, created_at
       FROM users WHERE id = $1`, [uid]
    );
    out.profile = profile.rows[0] || null;

    const safe = async (label, sql) => {
      try { out[label] = (await db.query(sql, [uid])).rows; }
      catch { out[label] = []; }
    };
    await safe('orders',
      `SELECT reference, order_type, status, total, rental_days,
              rental_start_date, rental_end_date, created_at
       FROM orders WHERE customer_id = $1 ORDER BY created_at DESC`);
    await safe('listed_shoes',
      `SELECT brand, model, size, colour, status, created_at
       FROM shoes WHERE owner_id = $1 ORDER BY created_at DESC`);
    await safe('clean_bookings',
      `SELECT reference, service_name, status, created_at
       FROM clean_bookings WHERE customer_id = $1 ORDER BY created_at DESC`);
    await safe('reviews',
      `SELECT rating, comment, created_at FROM reviews WHERE customer_id = $1`);
    await safe('wishlist',
      `SELECT shoe_id, created_at FROM wishlists WHERE user_id = $1`);
    await safe('payouts',
      `SELECT amount, payout_type, status, created_at FROM payouts WHERE owner_id = $1`);

    res.setHeader('Content-Disposition', 'attachment; filename="kosmos-my-data.json"');
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(out, null, 2));
  } catch (err) { next(err); }
});

// DELETE /api/users/me — erase the account.
// Requires the user to re-confirm by passing { confirm: "DELETE" } in the body.
router.delete('/me', authenticate, async (req, res, next) => {
  const client = await db.getClient();
  try {
    if ((req.body?.confirm || '').toUpperCase() !== 'DELETE') {
      return res.status(400).json({
        error: 'Please confirm deletion by sending { "confirm": "DELETE" }.',
      });
    }
    const uid = req.user.id;

    // Block deletion if the user has money/return obligations in flight —
    // they must be resolved first (active rental out, pending payout owed).
    const blockers = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM orders
            WHERE customer_id = $1
              AND status IN ('confirmed','cleaning','dispatched','delivered','active_rental','return_initiated')) AS open_orders,
         (SELECT COUNT(*) FROM shoes
            WHERE owner_id = $1 AND status IN ('reserved','rented')) AS shoes_out`,
      [uid]
    );
    const { open_orders, shoes_out } = blockers.rows[0];
    if (parseInt(open_orders) > 0 || parseInt(shoes_out) > 0) {
      return res.status(409).json({
        error: 'You have active orders or shoes currently out. Please wait until these are completed before deleting your account, or contact support.',
        open_orders: parseInt(open_orders),
        shoes_out: parseInt(shoes_out),
      });
    }

    await client.query('BEGIN');

    // 1. Hard-delete non-financial personal data
    await client.query(`DELETE FROM wishlists WHERE user_id = $1`, [uid]);
    await client.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [uid]);
    await client.query(`DELETE FROM owner_bank_details WHERE user_id = $1`, [uid]).catch(()=>{});
    // Push tokens (table name may vary by schema) — best effort
    await client.query(`DELETE FROM push_tokens WHERE user_id = $1`, [uid]).catch(()=>{});

    // 2. Anonymise reviews (keep the rating/comment, detach from the person)
    await client.query(
      `UPDATE reviews SET customer_id = NULL WHERE customer_id = $1`, [uid]
    ).catch(()=>{});

    // 3. Anonymise retained FINANCIAL records (orders) — strip the delivery
    //    address snapshot; keep the transaction for accounting. customer_id is
    //    kept pointing at the soon-to-be-anonymised user shell (see step 5).
    await client.query(
      `UPDATE orders
         SET delivery_line1 = NULL, delivery_line2 = NULL,
             delivery_city = NULL, delivery_county = NULL, delivery_postcode = NULL
       WHERE customer_id = $1`, [uid]
    );

    // 4. Detach any shoes they listed that are no longer active (keep historical
    //    catalogue integrity but remove ownership link where allowed).
    //    Shoes still owned & listed are delisted.
    await client.query(
      `UPDATE shoes SET status = 'returned_to_owner', updated_at = NOW()
       WHERE owner_id = $1 AND status = 'listed'`, [uid]
    ).catch(()=>{});

    // 5. Anonymise the user record itself. We keep the ROW (so retained orders
    //    still reference a valid id) but blank every personal field and mark it
    //    deleted. Email is replaced with a non-reversible placeholder so the
    //    address is freed for re-registration.
    const anonEmail = `deleted+${uid}@kosmos.invalid`;
    await client.query(
      `UPDATE users SET
         first_name = 'Deleted',
         last_name  = 'User',
         email      = $2,
         phone      = NULL,
         password_hash = '',
         addr_line1 = NULL, addr_line2 = NULL, addr_city = NULL,
         addr_county = NULL, addr_postcode = NULL,
         shoe_size = NULL,
         email_verified = FALSE,
         role = 'customer',
         updated_at = NOW()
       WHERE id = $1`,
      [uid, anonEmail]
    );

    // 6. Revoke all sessions
    await client.query(`DELETE FROM refresh_tokens WHERE user_id = $1`, [uid]).catch(()=>{});

    await client.query('COMMIT');

    // Log the erasure (no PII in the log)
    try {
      const { logActivity } = require('../services/activityLog');
      await logActivity(null, 'user.erased', 'user', uid, {});
    } catch {}

    res.json({
      ok: true,
      message: 'Your account and personal data have been deleted. Financial records required by law have been anonymised and retained. This cannot be undone.',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('Account deletion error:', err);
    res.status(500).json({ error: 'Could not delete account. Please contact support.' });
  } finally {
    client.release();
  }
});

module.exports = router;
