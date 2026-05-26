const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS the_edit (
        id           SERIAL PRIMARY KEY,
        week_start   DATE NOT NULL UNIQUE,
        shoe_ids     UUID[] NOT NULL,
        breakdown    JSONB,
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        published_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_edit_week ON the_edit(week_start DESC);

      -- Track shoe popularity via view count (for "most popular" category)
      ALTER TABLE shoes ADD COLUMN IF NOT EXISTS view_count INT DEFAULT 0;
      ALTER TABLE shoes ADD COLUMN IF NOT EXISTS last_viewed_at TIMESTAMPTZ;
    `);
    console.log('✅ the_edit table created + shoe view tracking columns added');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await db.end();
  }
}

migrate();
