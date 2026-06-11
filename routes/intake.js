// ============================================================
//  routes/intake.js — admin "eBay-style" bulk intake
//  - GET  /api/admin/intake/brands?q=        brand autocomplete
//  - GET  /api/admin/intake/models?brand=&q= model autocomplete (+ suggested RRP)
//  - POST /api/admin/intake/bulk             create a submission from a size/grade grid
//  All routes require staff/admin (enforced by router.use below).
// ============================================================
const express = require('express');
const { body, validationResult } = require('express-validator');
const db = require('../config/db');
const { authenticate, requireRole } = require('../middleware/auth');
const { logActivity } = require('../services/activityLog');
const router = express.Router();

router.use(authenticate, requireRole('staff', 'admin'));

// ── Reference data ──────────────────────────────────────────
// Curated brand → models (+ RRP range) for autocomplete & RRP auto-fill.
// (Mirrors the seed catalogue; models drive the second-step suggestions.)
const CATALOGUE = [
  { brand: 'Nike', models: [['Air Max 90',130,160],['Air Force 1 Low',100,120],['Dunk Low Retro',110,130],['Air Jordan 1 Mid',125,150],['Pegasus 40',115,135],['Blazer Mid 77',95,110],['Air Max 97',165,185],['React Infinity',145,165],['Cortez',80,95]] },
  { brand: 'Adidas', models: [['Samba OG',90,110],['Gazelle',85,100],['Stan Smith',80,95],['Ultraboost Light',170,190],['Forum Low',95,115],['Campus 00s',90,105],['Superstar',85,100],['NMD R1',130,150]] },
  { brand: 'New Balance', models: [['550',110,130],['2002R',130,150],['9060',150,170],['574',85,100],['990v6',185,210],['327',95,115]] },
  { brand: 'Dr. Martens', models: [['1460 8-Eye',160,185],['1461 3-Eye',150,170],['Chelsea 2976',170,190],['Jadon Platform',195,220]] },
  { brand: 'Timberland', models: [['6-Inch Premium',190,220],['Chukka',140,165],['Euro Hiker',160,185]] },
  { brand: 'Converse', models: [['Chuck 70 High',80,95],['All Star Low',60,75],['Run Star Hike',110,130]] },
  { brand: 'Vans', models: [['Old Skool',70,85],['Sk8-Hi',80,95],['Authentic',55,70],['Knu Skool',85,100]] },
  { brand: 'ASICS', models: [['Gel-Kayano 14',150,175],['GT-2160',130,150],['Gel-1130',110,130]] },
  { brand: 'Salomon', models: [['XT-6',175,200],['Speedcross 6',130,150],['ACS Pro',180,210]] },
  { brand: 'Birkenstock', models: [['Arizona',75,95],['Boston Clog',110,130],['Gizeh',70,90]] },
  { brand: 'Clarks', models: [['Desert Boot',95,115],['Wallabee',130,150]] },
  { brand: 'Jimmy Choo', models: [['Romy 100',450,550],['Love 85',480,580]] },
  { brand: 'Christian Louboutin', models: [['So Kate 120',595,695],['Pigalle 100',545,645]] },
  { brand: 'Manolo Blahnik', models: [['Hangisi 105',795,895],['BB Pump 105',545,625]] },
];

// Wider brand list so the autocomplete feels like a real catalogue.
const BRAND_LIST = [
  'Nike','Adidas','Jordan','New Balance','Converse','Vans','Puma','Reebok','ASICS','Salomon',
  'Hoka','On','Saucony','Brooks','Mizuno','Under Armour','Fila','Diadora','Lacoste','Skechers',
  'Crocs','Birkenstock','Dr. Martens','Timberland','Clarks','UGG','Hunter','Vivobarefoot','Veja','Allbirds',
  'Common Projects','Golden Goose','Axel Arigato','Maison Margiela','Rick Owens','Balenciaga','Gucci','Prada','Louis Vuitton','Dior',
  'Saint Laurent','Valentino','Versace','Givenchy','Burberry','Alexander McQueen','Off-White','Bottega Veneta','Loewe','Amiri',
  'Christian Louboutin','Jimmy Choo','Manolo Blahnik','Stuart Weitzman','Aquazzura','Gianvito Rossi','Steve Madden','Aldo','Dune London','Kurt Geiger',
  "Church's",'Loake','Grenson','Crockett & Jones','Barker','Cheaney','Red Wing','Wolverine','Caterpillar','Palladium',
  'Merrell','Keen','The North Face','Columbia','Arc\u2019teryx','Scarpa','La Sportiva','Ecco','Geox','Camper',
  'Toms','Sperry','Cole Haan','Bally','Tod\u2019s','Hogan','Superga','Onitsuka Tiger','Karhu','Hummel',
];

// Grade → pricing multipliers + the rental_count/condition that make wearGrade()
// resolve to this exact grade once the pair is listed.
const GRADE_RENT_MULT = { Mint: 1.00, Excellent: 0.85, Good: 0.65, Fair: 0.45, Vintage: 0.30 };
const GRADE_BUY_MULT  = { Mint: 1.00, Excellent: 0.70, Good: 0.45, Fair: 0.28, Vintage: 0.16 };
const GRADE_META = {
  Mint:      { rental_count: 0,  condition: 'New' },
  Excellent: { rental_count: 3,  condition: 'Pre-owned' },
  Good:      { rental_count: 7,  condition: 'Pre-owned' },
  Fair:      { rental_count: 13, condition: 'Pre-owned' },
  Vintage:   { rental_count: 18, condition: 'Pre-owned' },
};
const VALID_GRADES = Object.keys(GRADE_META);

const genRef = (prefix) => {
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase();
  const ts = Date.now().toString().slice(-4);
  return `${prefix}-${rand}-${ts}`;
};
const round2 = (n) => Math.round(n * 100) / 100;
function priceFor(rrp, grade) {
  return {
    rent: round2((rrp * 0.15 * (GRADE_RENT_MULT[grade] || 1)) / 7),
    buy:  round2(rrp * (GRADE_BUY_MULT[grade] || 1)),
  };
}

// ── GET /brands?q= ───────────────────────────────────────────
router.get('/brands', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    let counts = {};
    try {
      const { rows } = await db.query(
        `SELECT brand, COUNT(*)::int AS n FROM shoes
         WHERE brand IS NOT NULL AND TRIM(brand) <> ''
         GROUP BY brand ORDER BY n DESC LIMIT 300`
      );
      rows.forEach(r => { counts[r.brand] = r.n; });
    } catch (_) { /* table/column issue → fall back to the static list only */ }

    // Merge DB brands (by frequency) with the curated list
    const seen = new Set();
    const merged = [];
    const push = (name, n) => {
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push({ brand: name, n: n || 0 });
    };
    Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach(b => push(b, counts[b]));
    [...BRAND_LIST, ...CATALOGUE.map(c => c.brand)].forEach(b => push(b, counts[b] || 0));

    let list = merged;
    if (q) list = list.filter(x => x.brand.toLowerCase().includes(q));
    list.sort((a, b) => (b.n - a.n) || a.brand.localeCompare(b.brand));
    res.json({ brands: list.slice(0, 100).map(x => x.brand) });
  } catch (err) { next(err); }
});

// ── GET /models?brand=&q= ────────────────────────────────────
router.get('/models', async (req, res, next) => {
  try {
    const brand = (req.query.brand || '').trim();
    const q = (req.query.q || '').trim().toLowerCase();
    if (!brand) return res.json({ models: [] });

    const out = {}; // lower(model) -> { model, rrp, n }
    const add = (model, rrp, n) => {
      if (!model) return;
      const key = String(model).toLowerCase();
      if (!out[key]) out[key] = { model, rrp: rrp || null, n: n || 0 };
      else { if (rrp && !out[key].rrp) out[key].rrp = rrp; out[key].n += (n || 0); }
    };

    // Curated models for this brand (+ midpoint RRP)
    const cat = CATALOGUE.find(c => c.brand.toLowerCase() === brand.toLowerCase());
    if (cat) cat.models.forEach(([m, lo, hi]) => add(m, Math.round((lo + hi) / 2), 0));

    // Models already listed under this brand (by frequency, with avg RRP)
    try {
      const { rows } = await db.query(
        `SELECT model, COUNT(*)::int AS n, ROUND(AVG(NULLIF(rrp,0)))::int AS rrp
         FROM shoes WHERE LOWER(brand) = LOWER($1) AND model IS NOT NULL AND TRIM(model) <> ''
         GROUP BY model ORDER BY n DESC LIMIT 100`,
        [brand]
      );
      rows.forEach(r => add(r.model, r.rrp, r.n));
    } catch (_) { /* ignore — curated list still works */ }

    let list = Object.values(out);
    if (q) list = list.filter(x => x.model.toLowerCase().includes(q));
    list.sort((a, b) => (b.n - a.n) || a.model.localeCompare(b.model));
    res.json({ models: list.slice(0, 20).map(x => ({ model: x.model, rrp: x.rrp })) });
  } catch (err) { next(err); }
});

// ── POST /bulk ───────────────────────────────────────────────
// body: { brand, model, colour?, category?, gender?, listing_type?, rrp, items:[{size,grade,qty}] }
router.post('/bulk', [
  body('brand').trim().notEmpty(),
  body('model').trim().notEmpty(),
  body('rrp').isFloat({ gt: 0 }),
  body('items').isArray({ min: 1 }),
  body('listing_type').optional().isIn(['rent', 'buy', 'both']),
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { brand, model, colour, category, gender } = req.body;
  const listing_type = ['rent', 'buy', 'both'].includes(req.body.listing_type) ? req.body.listing_type : 'both';
  const rrp = parseFloat(req.body.rrp);

  // Normalise + validate the grid
  const rows = [];
  for (const it of req.body.items) {
    const size = it && it.size != null ? String(it.size).trim() : '';
    const grade = it && it.grade ? String(it.grade).trim() : '';
    const qty = Math.floor(Number(it && it.qty));
    if (!size || !VALID_GRADES.includes(grade)) continue;
    if (!Number.isFinite(qty) || qty <= 0) continue;
    rows.push({ size, grade, qty: Math.min(qty, 50) });
  }
  if (!rows.length) return res.status(400).json({ error: 'Add at least one size with a quantity and grade' });
  const totalPairs = rows.reduce((a, r) => a + r.qty, 0);
  if (totalPairs > 500) return res.status(400).json({ error: 'That is over 500 pairs in one go — split it into smaller batches' });

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const reference = genRef('LST');
    const { rows: subRows } = await client.query(
      `INSERT INTO listing_submissions
         (reference, owner_id, delivery_method, label_fee, fee_deducted, referral_source)
       VALUES ($1,$2,'post',0,false,'admin_intake')
       RETURNING *`,
      [reference, req.user.id]
    );
    const submission = subRows[0];

    let created = 0;
    for (const r of rows) {
      const meta = GRADE_META[r.grade];
      const { rent, buy } = priceFor(rrp, r.grade);
      for (let k = 0; k < r.qty; k++) {
        const { rows: shoeRows } = await client.query(
          `INSERT INTO shoes
             (owner_id, brand, model, size, colour, category, gender,
              emoji, listing_type, rrp, rent_price, buy_price,
              condition, assessed_wear_grade, rental_count, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'👟',$8,$9,$10,$11,$12,$13,$14,'submitted')
           RETURNING id`,
          [req.user.id, brand, model, r.size, colour || null, category || null, gender || null,
           listing_type, rrp, rent, buy, meta.condition, r.grade, meta.rental_count]
        );
        const shoeId = shoeRows[0].id;
        await client.query(
          'INSERT INTO submission_shoes (submission_id, shoe_id) VALUES ($1,$2)',
          [submission.id, shoeId]
        );
        await client.query(
          `INSERT INTO submission_events (shoe_id, event_type, status_after, actor_id, actor_role, notes)
           VALUES ($1,'submitted','submitted',$2,$3,$4)`,
          [shoeId, req.user.id, req.user.role || 'staff',
           `Admin intake: ${brand} ${model}, UK ${r.size}, ${r.grade}`]
        );
        created++;
      }
    }

    await client.query('COMMIT');

    logActivity(req.user.id, 'submission.admin_intake', 'submission', submission.id, {
      reference, brand, model, pairs: created,
    }).catch(() => {});

    res.status(201).json({
      submission: { id: submission.id, reference },
      created,
      message: `${created} pair${created !== 1 ? 's' : ''} added to the Submissions queue`,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
