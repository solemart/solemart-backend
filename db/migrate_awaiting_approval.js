const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    // Drop existing CHECK constraint and recreate with new status value
    // First find the constraint name
    const { rows: constraints } = await db.query(`
      SELECT conname FROM pg_constraint
      WHERE conrelid = 'shoes'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%status%'
    `);

    for (const c of constraints) {
      console.log(`Dropping constraint: ${c.conname}`);
      await db.query(`ALTER TABLE shoes DROP CONSTRAINT ${c.conname}`);
    }

    // Re-add with all the valid statuses including awaiting_approval
    await db.query(`
      ALTER TABLE shoes ADD CONSTRAINT shoes_status_check CHECK (status IN (
        'awaiting_approval',
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

    console.log('✅ Status constraint updated — awaiting_approval is now valid');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await db.end();
  }
}

migrate();
