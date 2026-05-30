// services/postcode.js
// UK postcode validation + city/county autofill via postcodes.io (free, no key, gov-backed).
// In-memory cache prevents repeat lookups for the same postcode.

const POSTCODES_API = 'https://api.postcodes.io';
const cache = new Map();
const CACHE_MAX = 1000;
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

function normalisePostcode(pc) {
  if (!pc) return '';
  return String(pc).replace(/\s+/g, '').toUpperCase();
}

function formatPostcode(pc) {
  const clean = normalisePostcode(pc);
  if (clean.length < 5) return clean;
  return clean.slice(0, -3) + ' ' + clean.slice(-3);
}

// Loose UK postcode regex — covers all standard formats (mainland + Channel Islands)
function isLikelyUKPostcode(pc) {
  const clean = normalisePostcode(pc);
  return /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(clean);
}

async function lookupPostcode(postcode) {
  const key = normalisePostcode(postcode);

  // Format check — refuse obviously invalid before hitting the API
  if (!isLikelyUKPostcode(key)) {
    return { valid: false, error: 'Invalid postcode format' };
  }

  // Cache hit
  const cached = cache.get(key);
  if (cached && Date.now() - cached.t < CACHE_TTL) {
    return cached.data;
  }

  try {
    const res = await fetch(`${POSTCODES_API}/postcodes/${encodeURIComponent(key)}`);
    if (res.status === 404) {
      const data = { valid: false, error: 'Postcode not recognised' };
      cache.set(key, { t: Date.now(), data });
      return data;
    }
    if (!res.ok) {
      return { valid: false, error: 'Postcode service unavailable' };
    }
    const json = await res.json();
    const r = json.result || {};
    const data = {
      valid: true,
      postcode: r.postcode,
      country: r.country || null,
      region: r.region || null,
      // For "City" — prefer admin_district which is what UK people call their town/borough
      city: r.admin_district || null,
      county: r.admin_county || null,
      ward: r.admin_ward || null,
      parish: r.parish || null,
      longitude: r.longitude,
      latitude: r.latitude,
    };

    // LRU eviction
    if (cache.size >= CACHE_MAX) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(key, { t: Date.now(), data });

    return data;
  } catch (e) {
    console.warn('Postcode lookup error:', e.message);
    return { valid: false, error: 'Postcode service unavailable' };
  }
}

module.exports = {
  lookupPostcode,
  normalisePostcode,
  formatPostcode,
  isLikelyUKPostcode,
};
