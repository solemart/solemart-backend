const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    await db.query(`
      INSERT INTO platform_settings (key, value, description) VALUES
        ('delivery_fee_amount',     '4.99',  'Delivery fee in GBP when below threshold'),
        ('free_delivery_threshold', '50.00', 'Orders at/above this amount get free delivery')
      ON CONFLICT (key) DO NOTHING;
    `);
    console.log('✅ Delivery settings added');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await db.end();
  }
}

migrate();
