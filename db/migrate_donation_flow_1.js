// db/migrate_donation_flow.js
// Adds delivery_method / estimated_weight / shipping_fee to donations,
// makes collection address columns nullable (post-yourself path has no address),
// and adds a 'paid' status concept via shipping_paid flag.

const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    console.log('Adding donation flow columns…');

    await db.query(`
      ALTER TABLE donations
        ADD COLUMN IF NOT EXISTS delivery_method   VARCHAR(20) DEFAULT 'post',  -- post | label | collect
        ADD COLUMN IF NOT EXISTS estimated_weight  NUMERIC(6,2),
        ADD COLUMN IF NOT EXISTS shipping_fee      NUMERIC(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS shipping_paid     BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS stripe_session_id VARCHAR(255),
        ADD COLUMN IF NOT EXISTS tracking_number   VARCHAR(100),
        ADD COLUMN IF NOT EXISTS rm_order_id        VARCHAR(100)
    `);
    console.log('  ✓ columns added');

    // Make collection address nullable — post-yourself donations have no collection address
    await db.query(`ALTER TABLE donations ALTER COLUMN collection_line1 DROP NOT NULL`);
    await db.query(`ALTER TABLE donations ALTER COLUMN collection_postcode DROP NOT NULL`);
    console.log('  ✓ collection address columns made nullable');

    console.log('✅ Migration complete.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  } finally {
    await db.end();
  }
}

migrate();
