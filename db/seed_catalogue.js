// db/seed_catalogue.js
// ════════════════════════════════════════════════════════════════════════════
//  CATALOGUE SEED — clears existing shoe data and generates 100+ realistic
//  shoes spanning every dimension: brand, category, gender, listing type,
//  condition, wear grade, and status. Prices follow the live pricing engine
//  (rent = 15% of RRP × grade multiplier ÷ 7; buy = RRP × buy multiplier).
//
//  Each shoe gets: a unique shoe_code (KSM-BRAND-XXXX), qr_payload, a cover
//  photo, lifecycle counters consistent with its wear grade, and timestamps.
//
//  USAGE:
//    DATABASE_URL=… node db/seed_catalogue.js            (dry run — counts only)
//    DATABASE_URL=… node db/seed_catalogue.js --confirm   (actually wipe + seed)
//
//  SAFETY: only deletes shoe-related data (shoes, photos, and shoe-linked
//  orders/reviews/payouts). Does NOT touch real customer accounts, platform
//  settings, donations, or clean bookings. Re-runnable.
// ════════════════════════════════════════════════════════════════════════════

const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

// A bcrypt-format password hash for the demo owner accounts. These owners
// exist only to OWN catalogue shoes (login isn't needed for the catalogue to
// work). If you want to log in as one, reset its password via create_admin.js
// or the admin panel rather than relying on this placeholder hash.
const OWNER_PASSWORD_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

const CONFIRM = process.argv.includes('--confirm');

// ── Reference data ──────────────────────────────────────────────────────────
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rand = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const suffix = () => Array.from({ length: 4 }, () => rand(CHARS.split(''))).join('');

// Brand → models, RRP range, typical category
const CATALOGUE = [
  { brand: 'Nike', cat: 'Trainers', models: [
    ['Air Max 90', 130, 160], ['Air Force 1 Low', 100, 120], ['Dunk Low Retro', 110, 130],
    ['Air Jordan 1 Mid', 125, 150], ['Pegasus 40', 115, 135], ['Blazer Mid 77', 95, 110],
    ['Air Max 97', 165, 185], ['React Infinity', 145, 165], ['Cortez', 80, 95],
  ]},
  { brand: 'Adidas', cat: 'Trainers', models: [
    ['Samba OG', 90, 110], ['Gazelle', 85, 100], ['Stan Smith', 80, 95],
    ['Ultraboost Light', 170, 190], ['Forum Low', 95, 115], ['Campus 00s', 90, 105],
    ['Superstar', 85, 100], ['NMD R1', 130, 150],
  ]},
  { brand: 'New Balance', cat: 'Trainers', models: [
    ['550', 110, 130], ['2002R', 130, 150], ['9060', 150, 170], ['574', 85, 100],
    ['990v6', 185, 210], ['327', 95, 115],
  ]},
  { brand: 'Dr. Martens', cat: 'Boots', models: [
    ['1460 8-Eye', 160, 185], ['1461 3-Eye', 150, 170], ['Chelsea 2976', 170, 190],
    ['Jadon Platform', 195, 220],
  ]},
  { brand: 'Timberland', cat: 'Boots', models: [
    ['6-Inch Premium', 190, 220], ['Chukka', 140, 165], ['Euro Hiker', 160, 185],
  ]},
  { brand: 'Converse', cat: 'Trainers', models: [
    ['Chuck 70 High', 80, 95], ['All Star Low', 60, 75], ['Run Star Hike', 110, 130],
  ]},
  { brand: 'Vans', cat: 'Trainers', models: [
    ['Old Skool', 70, 85], ['Sk8-Hi', 80, 95], ['Authentic', 55, 70], ['Knu Skool', 85, 100],
  ]},
  { brand: 'ASICS', cat: 'Trainers', models: [
    ['Gel-Kayano 14', 150, 175], ['GT-2160', 130, 150], ['Gel-1130', 110, 130],
  ]},
  { brand: 'Salomon', cat: 'Trainers', models: [
    ['XT-6', 175, 200], ['Speedcross 6', 130, 150], ['ACS Pro', 180, 210],
  ]},
  { brand: 'Birkenstock', cat: 'Sandals', models: [
    ['Arizona', 75, 95], ['Boston Clog', 110, 130], ['Gizeh', 70, 90],
  ]},
  { brand: 'Clarks', cat: 'Boots', models: [
    ['Desert Boot', 95, 115], ['Wallabee', 130, 150],
  ]},
  { brand: 'Jimmy Choo', cat: 'Heels', models: [
    ['Romy 100', 450, 550], ['Love 85', 480, 580],
  ]},
  { brand: 'Christian Louboutin', cat: 'Heels', models: [
    ['So Kate 120', 595, 695], ['Pigalle 100', 545, 645],
  ]},
  { brand: 'Manolo Blahnik', cat: 'Heels', models: [
    ['Hangisi 105', 795, 895], ['BB Pump 105', 545, 625],
  ]},
];

const COLOURS = ['White', 'Black', 'White / Black', 'Triple White', 'Grey / White', 'Navy',
  'Beige / Gum', 'Green / Cream', 'Red / White', 'Tan', 'Brown', 'Pastel Pink',
  'University Blue', 'Sail / Gum', 'Olive', 'Burgundy', 'Silver'];

const SIZES_UNISEX = ['5', '6', '6.5', '7', '7.5', '8', '8.5', '9', '9.5', '10', '11', '12'];
const SIZES_WOMENS = ['3', '3.5', '4', '4.5', '5', '5.5', '6', '6.5', '7', '8'];

// Wear grade → { is_pre_loved, condition, assessed grade, rental_count range, buy mult, gradeMult }
const GRADE_BUY_MULT = { Mint: 1.00, Excellent: 0.70, Good: 0.45, Fair: 0.28, Vintage: 0.16 };
const GRADE_RENT_MULT = { Mint: 1.00, Excellent: 0.85, Good: 0.65, Fair: 0.45, Vintage: 0.30 };
const GRADES = [
  { g: 'Mint',      preLoved: false, cond: 'New',       rentals: [0, 0],   weight: 30 },
  { g: 'Excellent', preLoved: true,  cond: 'Pre-owned', rentals: [1, 4],   weight: 30 },
  { g: 'Good',      preLoved: true,  cond: 'Pre-owned', rentals: [5, 10],  weight: 22 },
  { g: 'Fair',      preLoved: true,  cond: 'Pre-owned', rentals: [11, 16], weight: 12 },
  { g: 'Vintage',   preLoved: true,  cond: 'Pre-owned', rentals: [17, 22], weight: 6 },
];
function pickGrade() {
  const total = GRADES.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const x of GRADES) { if ((r -= x.weight) <= 0) return x; }
  return GRADES[0];
}

// Status distribution — mostly listed (so the catalogue looks full), some across the pipeline
const STATUSES = [
  { s: 'listed', weight: 70 },
  { s: 'rented', weight: 10 },
  { s: 'sold', weight: 6 },
  { s: 'cleaning', weight: 4 },
  { s: 'authenticating', weight: 4 },
  { s: 'in_transit', weight: 3 },
  { s: 'submitted', weight: 3 },
];
function pickStatus() {
  const total = STATUSES.reduce((s, x) => s + x.weight, 0);
  let r = Math.random() * total;
  for (const x of STATUSES) { if ((r -= x.weight) <= 0) return x.s; }
  return 'listed';
}

const LISTING_TYPES = ['both', 'both', 'both', 'rent', 'buy']; // weighted toward 'both'
const GENDERS = ['Unisex', "Men's", "Women's"];
const AUTH_GRADES = ['A+', 'A', 'A', 'B+', 'B'];

// Cover photo: a deterministic placeholder so cards render (swap for real R2 later)
function coverPhoto(brand, model, idx) {
  const seed = encodeURIComponent(`${brand}-${model}-${idx}`);
  // picsum gives a stable image per seed; size tuned for cards
  return `https://picsum.photos/seed/${seed}/600/600`;
}

function brandCode(brand) {
  return brand.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'KSM';
}

async function run() {
  try {
    console.log(CONFIRM ? '🔴 LIVE — wiping shoe data and seeding catalogue\n' : '🟡 DRY RUN — add --confirm to apply\n');

    const shoeCount = (await db.query('SELECT COUNT(*) FROM shoes')).rows[0].count;
    console.log(`Current shoes in DB: ${shoeCount}`);

    if (!CONFIRM) {
      console.log('\nWould: delete all shoes + shoe photos + shoe-linked orders/reviews/payouts,');
      console.log('       create ~6 house owner accounts, and insert 110 shoes across all');
      console.log('       brands, categories, genders, listing types, conditions, grades, statuses.');
      console.log('\nRe-run with --confirm to apply.');
      return;
    }

    // ── 1. Clear shoe-related data (FK-safe order) ──
    console.log('Clearing existing shoe data…');
    await db.query(`DELETE FROM reviews WHERE shoe_id IS NOT NULL`).catch(() => {});
    await db.query(`DELETE FROM payouts WHERE order_id IN (SELECT id FROM orders WHERE shoe_id IS NOT NULL)`).catch(() => {});
    await db.query(`DELETE FROM orders WHERE shoe_id IS NOT NULL`).catch(() => {});
    await db.query(`DELETE FROM shoe_photos`).catch(() => {});
    await db.query(`UPDATE shoes SET donation_id = NULL`).catch(() => {});
    await db.query(`DELETE FROM submission_shoes`).catch(() => {});
    await db.query(`DELETE FROM shoes`);
    console.log('  ✓ cleared');

    // ── 2. Create house owner accounts ──
    console.log('Creating owner accounts…');
    const ownerHash = OWNER_PASSWORD_HASH;
    const owners = [
      ['Mike', 'Stephens', 'mike@example.com', '22 Brick Lane', 'London', 'E1 6RF'],
      ['Sophie', 'Clarke', 'sophie@example.com', '8 Camden High Street', 'London', 'NW1 8QH'],
      ['James', 'Okafor', 'james@example.com', '45 Deansgate', 'Manchester', 'M3 2AY'],
      ['Amara', 'Bello', 'amara@example.com', '12 Park Row', 'Leeds', 'LS1 5HD'],
      ['Tom', 'Whitfield', 'tom@example.com', '90 Queen Street', 'Bristol', 'BS1 4JP'],
      ['Lena', 'Novak', 'lena@example.com', '3 George Street', 'Edinburgh', 'EH2 2PB'],
    ];
    const ownerIds = [];
    for (const [first, last, email, line1, city, pc] of owners) {
      const { rows } = await db.query(
        `INSERT INTO users (first_name, last_name, email, password_hash, role, email_verified, addr_line1, addr_city, addr_postcode)
         VALUES ($1,$2,$3,$4,'owner',TRUE,$5,$6,$7)
         ON CONFLICT (email) DO UPDATE SET role='owner' RETURNING id`,
        [first, last, email, ownerHash, line1, city, pc]
      );
      ownerIds.push(rows[0].id);
    }
    console.log(`  ✓ ${ownerIds.length} owners ready`);

    // ── 3. Build a flat list of model entries, then generate 110 shoes ──
    const TARGET = 110;
    const allModels = [];
    CATALOGUE.forEach(b => b.models.forEach(m => allModels.push({ brand: b.brand, cat: b.cat, model: m[0], rrpMin: m[1], rrpMax: m[2] })));

    // Detect how this schema stores qr_payload. Some schemas use jsonb, others
    // plain text. Reusing one placeholder for shoe_code + qr_payload is what
    // triggered "inconsistent types deduced for parameter $22" — the two columns
    // resolved to different types. We now use separate placeholders AND format
    // the qr_payload value to match whatever this column actually is.
    let qrIsJson = false;
    try {
      const t = await db.query(
        `SELECT data_type FROM information_schema.columns
          WHERE table_name = 'shoes' AND column_name = 'qr_payload'`
      );
      qrIsJson = ['json', 'jsonb'].includes(t.rows[0]?.data_type);
    } catch { /* fall back to text */ }
    console.log(`  qr_payload column type: ${qrIsJson ? 'json/jsonb' : 'text'}`);

    console.log(`Generating ${TARGET} shoes…`);
    const usedCodes = new Set();
    let inserted = 0;

    for (let i = 0; i < TARGET; i++) {
      const base = rand(allModels);
      const grade = pickGrade();
      const status = pickStatus();
      const listingType = rand(LISTING_TYPES);
      const isHeel = base.cat === 'Heels';
      const gender = isHeel ? "Women's" : rand(GENDERS);
      const size = (gender === "Women's" || isHeel) ? rand(SIZES_WOMENS) : rand(SIZES_UNISEX);
      const colour = rand(COLOURS);
      const rrp = randInt(base.rrpMin, base.rrpMax);
      const rentalCount = randInt(grade.rentals[0], grade.rentals[1]);
      const cleanCount = Math.max(rentalCount, grade.preLoved ? 1 : 0);
      const listingCount = grade.preLoved ? randInt(1, 3) : 1;

      // Pricing per the live engine
      const dailyRate = Math.round(((rrp * 0.15 * GRADE_RENT_MULT[grade.g]) / 7) * 100) / 100;
      const buyPrice = Math.round(rrp * GRADE_BUY_MULT[grade.g] * 100) / 100;

      // Unique shoe code
      let code;
      do { code = `KSM-${brandCode(base.brand)}-${suffix()}`; } while (usedCodes.has(code));
      usedCodes.add(code);

      // qr_payload value, matched to the column type detected before the loop
      const qrPayload = qrIsJson ? JSON.stringify({ code, type: 'shoe' }) : code;

      const ownerId = rand(ownerIds);
      const authScore = randInt(82, 99);
      const authGrade = rand(AUTH_GRADES);
      const isListed = ['listed', 'rented', 'sold'].includes(status);
      const listedAt = isListed ? new Date(Date.now() - randInt(1, 120) * 86400000) : null;
      const createdAt = new Date(Date.now() - randInt(2, 200) * 86400000);

      const desc = `${grade.preLoved ? 'Pre-loved' : 'Brand new'} ${base.brand} ${base.model} in ${colour}. ` +
        `${grade.g === 'Mint' ? 'Unworn, pristine condition.' : `Professionally cleaned and authenticated — graded ${grade.g}.`} ` +
        `Authenticated in-house (score ${authScore}/100).`;

      const { rows } = await db.query(
        `INSERT INTO shoes (
           owner_id, brand, model, size, colour, category, gender, description, emoji,
           listing_type, rrp, rent_price, buy_price,
           condition, status,
           auth_score, auth_grade, auth_at,
           assessed_wear_grade, is_pre_loved,
           rental_count, clean_count, listing_count,
           shoe_code, qr_payload, qr_generated_at,
           submitted_at, listed_at, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,'👟',
           $9,$10,$11,$12,
           $13,$14,
           $15,$16,NOW(),
           $17,$18,
           $19,$20,$21,
           $22,$23,NOW(),
           $24,$25,$26,NOW()
         ) RETURNING id`,
        [
          ownerId, base.brand, base.model, size, colour, base.cat, gender, desc,
          listingType, rrp,
          (listingType === 'buy' ? null : dailyRate),
          (listingType === 'rent' ? null : buyPrice),
          grade.cond, status,
          authScore, authGrade,
          grade.g, grade.preLoved,
          rentalCount, cleanCount, listingCount,
          code, qrPayload,
          createdAt, listedAt, createdAt,
        ]
      );

      // Cover photo (only meaningful for listed/processed shoes, but add to all)
      await db.query(
        `INSERT INTO shoe_photos (shoe_id, url, sort_order, is_cover, uploaded_by_role)
         VALUES ($1,$2,0,TRUE,'kosmos')`,
        [rows[0].id, coverPhoto(base.brand, base.model, i)]
      ).catch(async () => {
        // Fallback if is_cover/uploaded_by_role columns don't exist on older schemas
        await db.query(`INSERT INTO shoe_photos (shoe_id, url, sort_order) VALUES ($1,$2,0)`,
          [rows[0].id, coverPhoto(base.brand, base.model, i)]).catch(() => {});
      });

      inserted++;
      if (inserted % 25 === 0) console.log(`  …${inserted}/${TARGET}`);
    }

    console.log(`  ✓ inserted ${inserted} shoes`);

    // ── 4. Summary ──
    const summary = await db.query(`
      SELECT status, COUNT(*) FROM shoes GROUP BY status ORDER BY COUNT(*) DESC
    `);
    const byGrade = await db.query(`
      SELECT assessed_wear_grade, COUNT(*) FROM shoes GROUP BY assessed_wear_grade ORDER BY COUNT(*) DESC
    `);
    const byType = await db.query(`
      SELECT listing_type, COUNT(*) FROM shoes GROUP BY listing_type
    `);
    const listed = (await db.query(`SELECT COUNT(*) FROM shoes WHERE status='listed'`)).rows[0].count;

    console.log('\n── Summary ──');
    console.log('By status:', summary.rows.map(r => `${r.status}:${r.count}`).join('  '));
    console.log('By grade :', byGrade.rows.map(r => `${r.assessed_wear_grade}:${r.count}`).join('  '));
    console.log('By type  :', byType.rows.map(r => `${r.listing_type}:${r.count}`).join('  '));
    console.log(`\n✅ Catalogue seeded. ${listed} shoes are LIVE (status=listed) and will show in the shop.`);
  } catch (e) {
    console.error('Seed failed:', e.message);
    process.exit(1);
  } finally {
    await db.end();
  }
}

run();
