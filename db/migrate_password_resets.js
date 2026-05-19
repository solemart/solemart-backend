const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS password_resets (
        user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        code       VARCHAR(6) NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_password_resets_code ON password_resets(code);
    `);
    console.log('✅ password_resets table created');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await db.end();
  }
}

migrate();
