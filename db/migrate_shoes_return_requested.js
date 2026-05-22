const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    await db.query(`ALTER TABLE shoes DROP CONSTRAINT IF EXISTS shoes_status_check`);
    await db.query(`
      ALTER TABLE shoes ADD CONSTRAINT shoes_status_check CHECK (status IN (
        'submitted',
        'in_transit',
        'authenticating',
        'cleaning',
        'listed',
        'rented',
        'sold',
        'rejected',
        'returned_to_owner',
        'return_requested'
      ))
    `);
    console.log('✅ shoes_status_check updated to include return_requested');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await db.end();
  }
}

migrate();
