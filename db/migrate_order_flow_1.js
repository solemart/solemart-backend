// db/migrate_order_flow.js
// ════════════════════════════════════════════════════════════════════════════
//  ORDER FLOW REDESIGN
//   1. Shoes get a printable QR payload (the shoe_code, e.g. KSM-NIKE-A1B2)
//   2. Orders are created ONLY after payment is confirmed (handled in code) —
//      this migration adds a 'reserved' shoe status so a shoe can be held
//      during checkout without an order existing yet.
//   3. Returned shoes (rental or sold) move back to the 'authenticating' (Reviewing)
//      stage when their QR is scanned, which also triggers a customer review request.
// ════════════════════════════════════════════════════════════════════════════

const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    console.log('Order-flow migration starting…');

    // 1. Shoe QR payload — we store the shoe_code as the QR content.
    //    (shoe_code already exists; we just ensure a column to cache the QR string
    //     and a flag for when it was last printed, for the admin Shoes tab.)
    await db.query(`
      ALTER TABLE shoes
        ADD COLUMN IF NOT EXISTS qr_payload TEXT,
        ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ
    `);
    console.log('  ✓ shoes.qr_payload / qr_generated_at added');

    // Backfill qr_payload = shoe_code for every shoe that has a code
    await db.query(`
      UPDATE shoes
      SET qr_payload = shoe_code, qr_generated_at = NOW()
      WHERE shoe_code IS NOT NULL AND (qr_payload IS NULL OR qr_payload = '')
    `);
    console.log('  ✓ backfilled qr_payload from shoe_code');

    // 2. Add 'reserved' shoe status (held during checkout, before payment confirms).
    //    Returned shoes (rental or sold) go back to the existing 'authenticating'
    //    (Reviewing) stage — no separate inspection status needed.
    //    Postgres CHECK constraints can't be altered in place, so drop & re-add.
    await db.query(`ALTER TABLE shoes DROP CONSTRAINT IF EXISTS shoes_status_check`);
    await db.query(`
      ALTER TABLE shoes ADD CONSTRAINT shoes_status_check CHECK (status IN (
        'submitted','in_transit','authenticating','cleaning',
        'listed','reserved','rented','sold',
        'rejected','returned_to_owner'
      ))
    `);
    console.log('  ✓ shoes status now includes reserved');

    // 3. Orders: no separate inspection status — a returned order is marked 'returned'.
    //    Ensure paid_at exists for the paid-only order flow.
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`);
    console.log('  ✓ orders.paid_at present');

    // 4. Track that a review has been requested for an order (so we don't double-ask)
    await db.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS review_requested_at TIMESTAMPTZ`);
    console.log('  ✓ orders.review_requested_at added');

    console.log('✅ Order-flow migration complete.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  } finally {
    await db.end();
  }
}

migrate();
