const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    await db.query(`ALTER TABLE payouts ADD COLUMN IF NOT EXISTS shoe_id UUID REFERENCES shoes(id)`);
    console.log('✅ Migration complete — shoe_id added to payouts');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await db.end();
  }
}

migrate();
