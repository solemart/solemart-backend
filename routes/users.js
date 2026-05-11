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

// POST /api/users/me/bank  — save encrypted bank details
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

module.exports = router;
