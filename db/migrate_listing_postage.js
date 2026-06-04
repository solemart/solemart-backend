// db/migrate_listing_postage.js
// ════════════════════════════════════════════════════════════════════════════
//  LISTING POSTAGE CHOICE
//  Owners listing shoes can now choose how to send them in:
//    - 'post'  : post it themselves (free)
//    - 'label' : we issue a prepaid label; the fee is recovered per the
//                'listing_label_charge_method' setting (default: deduct from
//                their first payout). Admin can switch to 'upfront' later.
// ════════════════════════════════════════════════════════════════════════════

const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    console.log('Listing postage migration starting…');

    // 1. Submission columns: chosen method + the label fee captured at submit time
    await db.query(`
      ALTER TABLE listing_submissions
        ADD COLUMN IF NOT EXISTS delivery_method VARCHAR(20) DEFAULT 'post',
        ADD COLUMN IF NOT EXISTS label_fee NUMERIC(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS label_fee_paid BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS estimated_weight NUMERIC(10,2)
    `);
    console.log('  ✓ listing_submissions: delivery_method, label_fee, label_fee_paid, estimated_weight');

    // 2. Default settings (only inserted if not already present).
    //    platform_settings.value is JSONB, so values must be JSON-encoded:
    //    a number is 4.99, a string is "payout_deduction" (with quotes).
    await db.query(`
      INSERT INTO platform_settings (key, value)
      VALUES
        ('listing_label_fee', '4.99'::jsonb),
        ('listing_label_charge_method', '"payout_deduction"'::jsonb)
      ON CONFLICT (key) DO NOTHING
    `);
    console.log("  ✓ settings: listing_label_fee (4.99), listing_label_charge_method (payout_deduction)");

    console.log('✅ Listing postage migration complete.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  } finally {
    await db.end();
  }
}

migrate();
