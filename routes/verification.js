// routes/verification.js
// Rental ID + address verification.
//   1. Stripe Identity — government ID + selfie liveness (Stripe stores the sensitive docs)
//   2. Proof of address — uploaded doc, OCR-extracted, postcode cross-checked
// A user must pass BOTH once before they can rent.

const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');
const { lookupPostcode, normalisePostcode } = require('../services/postcode');

let stripe = null;
try {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
} catch (e) {
  console.warn('Stripe not initialised in verification routes:', e.message);
}

// ── GET /api/verification/status — where does this user stand? ──────────────────
router.get('/status', authenticate, async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id_verified, id_verified_at, address_verified, address_verified_at,
              address_proof_status, verification_notes
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    res.json({
      id_verified:        u.id_verified || false,
      address_verified:   u.address_verified || false,
      address_proof_status: u.address_proof_status || 'none',
      fully_verified:     (u.id_verified && u.address_verified) || false,
      notes:              u.verification_notes || null,
    });
  } catch (err) { next(err); }
});

// ── POST /api/verification/identity/start — create a Stripe Identity session ────
router.post('/identity/start', authenticate, async (req, res, next) => {
  try {
    if (!stripe) {
      return res.status(503).json({ error: 'Identity verification is not configured yet' });
    }

    // Already verified? Don't charge for another session.
    const { rows } = await db.query(`SELECT id_verified FROM users WHERE id = $1`, [req.user.id]);
    if (rows[0]?.id_verified) {
      return res.json({ already_verified: true });
    }

    const session = await stripe.identity.verificationSessions.create({
      type: 'document',
      metadata: { user_id: req.user.id },
      options: {
        document: {
          require_matching_selfie: true,   // liveness — stops stolen IDs
          require_live_capture: true,
          allowed_types: ['driving_license', 'passport', 'id_card'],
        },
      },
      // After completion Stripe redirects here; client polls /status
      return_url: `${process.env.SITE_URL || 'https://beautifullyordered.co.uk'}/?page=account&tab=verify&id_done=1`,
    });

    // Save the session id so the webhook can match it back
    await db.query(
      `UPDATE users SET id_verification_session = $1 WHERE id = $2`,
      [session.id, req.user.id]
    );

    res.json({ client_secret: session.client_secret, url: session.url, session_id: session.id });
  } catch (err) {
    console.error('Identity start error:', err);
    res.status(500).json({ error: err.message || 'Could not start verification' });
  }
});

// ── POST /api/verification/identity/check — poll Stripe to confirm result ───────
// (Belt-and-braces alongside the webhook; lets the client confirm immediately.)
router.post('/identity/check', authenticate, async (req, res, next) => {
  try {
    if (!stripe) return res.status(503).json({ error: 'Not configured' });

    const { rows } = await db.query(
      `SELECT id_verification_session FROM users WHERE id = $1`, [req.user.id]
    );
    const sessionId = rows[0]?.id_verification_session;
    if (!sessionId) return res.status(400).json({ error: 'No verification session found' });

    const session = await stripe.identity.verificationSessions.retrieve(sessionId, {
      expand: ['verified_outputs'],
    });

    if (session.status === 'verified') {
      const out = session.verified_outputs || {};
      const fullName = out.first_name && out.last_name
        ? `${out.first_name} ${out.last_name}` : null;
      const dob = out.dob ? `${out.dob.year}-${String(out.dob.month).padStart(2,'0')}-${String(out.dob.day).padStart(2,'0')}` : null;

      await db.query(
        `UPDATE users
         SET id_verified = TRUE, id_verified_at = NOW(),
             id_verified_name = $1, id_verified_dob = $2
         WHERE id = $3`,
        [fullName, dob, req.user.id]
      );
      return res.json({ status: 'verified', name: fullName });
    }

    res.json({ status: session.status }); // requires_input | processing | canceled
  } catch (err) {
    console.error('Identity check error:', err);
    res.status(500).json({ error: err.message || 'Could not check verification' });
  }
});

// ── POST /api/verification/address — upload proof of address, OCR + cross-check ──
router.post('/address', authenticate, async (req, res, next) => {
  try {
    const { document_base64, delivery_postcode } = req.body;
    if (!document_base64) {
      return res.status(400).json({ error: 'No document provided' });
    }

    // Store the proof + mark pending
    await db.query(
      `UPDATE users
       SET address_proof_url = $1, address_proof_status = 'pending'
       WHERE id = $2`,
      [document_base64, req.user.id]
    );

    // Get the user's verified ID name for cross-matching
    const { rows: userRows } = await db.query(
      `SELECT id_verified_name, first_name, last_name FROM users WHERE id = $1`,
      [req.user.id]
    );
    const u = userRows[0] || {};
    const expectedName = (u.id_verified_name || `${u.first_name} ${u.last_name}`).toLowerCase().trim();

    // OCR the document
    let extracted = null;
    let ocrError = null;
    try {
      extracted = await ocrAddressDocument(document_base64);
    } catch (e) {
      ocrError = e.message;
      console.warn('OCR failed, routing to manual review:', e.message);
    }

    // Decide: auto-approve, manual review, or reject
    let status = 'manual_review'; // default — safest
    let autoApproved = false;

    if (extracted) {
      const checks = runAddressChecks(extracted, expectedName, delivery_postcode);
      if (checks.allPass) {
        status = 'auto_approved';
        autoApproved = true;
      } else if (checks.hardFail) {
        status = 'manual_review'; // never auto-reject; a human decides
      } else {
        status = 'manual_review';
      }
      await db.query(
        `UPDATE users SET address_proof_extracted = $1, address_proof_status = $2,
                          address_verified = $3, address_verified_at = CASE WHEN $3 THEN NOW() ELSE NULL END
         WHERE id = $4`,
        [JSON.stringify({ ...extracted, checks }), status, autoApproved, req.user.id]
      );
    } else {
      // No OCR — manual review
      await db.query(
        `UPDATE users SET address_proof_status = 'manual_review' WHERE id = $1`,
        [req.user.id]
      );
    }

    res.json({
      status,
      auto_approved: autoApproved,
      message: autoApproved
        ? 'Address verified automatically.'
        : 'Document received — our team will review it shortly (usually within a few hours).',
      ocr_available: !!extracted,
    });
  } catch (err) {
    console.error('Address verification error:', err);
    res.status(500).json({ error: err.message || 'Could not process document' });
  }
});

// ── Helpers ─────────────────────────────────────────────────────────────────────

// OCR via Google Cloud Vision if configured; throws otherwise (→ manual review)
async function ocrAddressDocument(base64) {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) throw new Error('OCR not configured');

  // Strip data URL prefix
  const content = base64.replace(/^data:image\/\w+;base64,/, '');

  const res = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          image: { content },
          features: [{ type: 'TEXT_DETECTION' }],
        }],
      }),
    }
  );
  if (!res.ok) throw new Error('Vision API error ' + res.status);
  const json = await res.json();
  const text = json.responses?.[0]?.fullTextAnnotation?.text || '';
  if (!text) throw new Error('No text detected');

  // Extract a UK postcode
  const pcMatch = text.match(/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i);
  const postcode = pcMatch ? normalisePostcode(pcMatch[0]) : null;

  // Extract a date (look for recent-looking dates to check the doc isn't stale)
  const dateMatch = text.match(/\b(\d{1,2})[\/\-\s](\w{3,9}|\d{1,2})[\/\-\s](\d{2,4})\b/);

  return {
    raw_text: text.slice(0, 2000),  // cap stored text
    postcode,
    date_found: dateMatch ? dateMatch[0] : null,
  };
}

// Cross-check extracted data against expected name + delivery postcode
function runAddressChecks(extracted, expectedName, deliveryPostcode) {
  const text = (extracted.raw_text || '').toLowerCase();

  // Name check — does the verified name appear in the document?
  const nameParts = expectedName.split(/\s+/).filter(p => p.length > 1);
  const nameMatch = nameParts.length > 0 && nameParts.every(part => text.includes(part));

  // Postcode check — does the doc postcode match the delivery postcode?
  const docPC = extracted.postcode ? normalisePostcode(extracted.postcode) : null;
  const delPC = deliveryPostcode ? normalisePostcode(deliveryPostcode) : null;
  const postcodeMatch = docPC && delPC && docPC === delPC;

  return {
    name_match: nameMatch,
    postcode_found: !!docPC,
    postcode_match: postcodeMatch,
    allPass: nameMatch && postcodeMatch,
    hardFail: false, // we never auto-reject; manual review handles edge cases
  };
}

module.exports = router;
