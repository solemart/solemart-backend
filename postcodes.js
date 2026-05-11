const express = require('express');
const router  = express.Router();

// GET /api/postcodes/:postcode
// Proxies to postcodes.io — free, no API key needed
// In production swap for Ideal Postcodes / GetAddress.io for richer data
router.get('/:postcode', async (req, res, next) => {
  try {
    const postcode = req.params.postcode.replace(/\s/g, '').toUpperCase();

    const response = await fetch(
      `${process.env.POSTCODE_API_URL || 'https://api.postcodes.io'}/postcodes/${encodeURIComponent(postcode)}`
    );

    if (!response.ok) {
      if (response.status === 404) {
        return res.status(404).json({ error: 'Postcode not found' });
      }
      throw new Error(`Postcode API returned ${response.status}`);
    }

    const data = await response.json();

    // Normalise into address-like objects
    // postcodes.io returns a single result — a real provider like GetAddress.io
    // returns multiple addresses per postcode. This stub returns one address
    // so the frontend select has something to work with.
    const result = data.result;
    const addresses = [
      {
        line1:   result.admin_ward || 'Address Line 1',
        line2:   '',
        city:    result.admin_district || result.parish || '',
        county:  result.admin_county || result.european_electoral_region || '',
        postcode: result.postcode,
      },
    ];

    res.json({ postcode: result.postcode, addresses });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
