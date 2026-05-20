const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    // Drop the old constraint
    await db.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check`);
    // Add the new constraint with pending_payment
    await db.query(`
      ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (status IN (
        'pending_payment',
        'confirmed',
        'cleaning',
        'dispatched',
        'delivered',
        'active_rental',
        'return_initiated',
        'return_requested',
        'returned',
        'completed',
        'cancelled',
        'refunded'
      ))
    `);
    console.log('✅ orders_status_check updated to include pending_payment');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await db.end();
  }
}

migrate();
