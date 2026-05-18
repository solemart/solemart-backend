const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS wishlists (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        shoe_id    UUID NOT NULL REFERENCES shoes(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, shoe_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wishlists_user ON wishlists(user_id);
    `);
    console.log('✅ Wishlist table created');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await db.end();
  }
}

migrate();
