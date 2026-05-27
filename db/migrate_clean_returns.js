const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    await db.query(`
      ALTER TABLE clean_bookings
        ADD COLUMN IF NOT EXISTS return_tracking_number VARCHAR(100),
        ADD COLUMN IF NOT EXISTS return_carrier         VARCHAR(50),
        ADD COLUMN IF NOT EXISTS return_label_created_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS delivered_at           TIMESTAMPTZ
    `);
    console.log('✅ clean_bookings return-tracking columns added');

    // Also tighten an index for queue queries
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_clean_bookings_status_active
        ON clean_bookings(status, booked_at)
        WHERE status NOT IN ('returned','cancelled')
    `);
    console.log('✅ Active clean_bookings index created');

    console.log('Migration complete.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  } finally {
    await db.end();
  }
}

migrate();
