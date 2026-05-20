const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    await db.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(100);

      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS stripe_payment_method_id VARCHAR(100),
        ADD COLUMN IF NOT EXISTS late_fees_charged NUMERIC(10,2) DEFAULT 0,
        ADD COLUMN IF NOT EXISTS last_late_fee_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS late_fee_paused BOOLEAN DEFAULT FALSE;
    `);
    console.log('✅ Stripe customer ID and late fee columns added');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await db.end();
  }
}

migrate();
