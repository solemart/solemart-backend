const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key         VARCHAR(100) PRIMARY KEY,
        value       JSONB NOT NULL,
        description TEXT,
        updated_by  UUID REFERENCES users(id),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      );

      INSERT INTO platform_settings (key, value, description) VALUES
        ('platform_fee_percent',    '15',    'Platform commission percentage (deducted from owner share)'),
        ('cleaning_fee_amount',     '8.00',  'Per-rental cleaning fee in GBP (deducted from rental income)'),
        ('rental_default_days',     '7',     'Default rental duration in days'),
        ('late_fee_grace_hours',    '0',     'Grace period in hours before late fees apply'),
        ('late_fee_cap_multiplier', '1.0',   'Late fee cap as multiplier of shoe buy_price (1.0 = up to full value)'),
        ('owner_share_percent',     '85',    'Owner share percentage (auto-calculated as 100 - platform fee)'),
        ('free_delivery',           'true',  'Whether delivery is free for customers'),
        ('treasures_max_price',     '80',    'Maximum buy price for shoes shown in Treasures section'),
        ('min_rental_days',         '7',     'Minimum rental period in days'),
        ('max_rental_days',         '28',    'Maximum rental period in days')
      ON CONFLICT (key) DO NOTHING;
    `);
    console.log('✅ platform_settings table created and seeded with defaults');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await db.end();
  }
}

migrate();
