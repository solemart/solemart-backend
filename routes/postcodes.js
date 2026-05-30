// routes/postcodes.js
// UK postcode validation + city/county autofill via postcodes.io (free).
// Public — no auth required. Used by checkout, list-shoes, clean booking,
// donation pickup and account profile forms.

const express = require('express');
const router = express.Router();
const { lookupPostcode } = require('../services/postcode');

// GET /api/postcodes/:postcode
// Returns { valid: bool, postcode, city, county, region, country, ... }
router.get('/:postcode', async (req, res) => {
  try {
    const result = await lookupPostcode(req.params.postcode);
    if (!result.valid) {
      return res.status(result.error === 'Postcode not recognised' ? 404 : 400).json(result);
    }
    res.json(result);
  } catch (e) {
    console.error('Postcode lookup error:', e);
    res.status(500).json({ valid: false, error: 'Lookup failed' });
  }
});

module.exports = router;
