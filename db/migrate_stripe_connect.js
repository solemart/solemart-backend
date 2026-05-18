const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    await db.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS stripe_account_id      VARCHAR(100),
        ADD COLUMN IF NOT EXISTS stripe_payouts_enabled BOOLEAN DEFAULT FALSE;
    `);
    console.log('✅ Stripe Connect columns added to users table');
    console.log('   stripe_account_id — Stripe Express account ID');
    console.log('   stripe_payouts_enabled — whether payouts are active');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await db.end();
  }
}

migrate();
