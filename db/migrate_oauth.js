// db/migrate_oauth.js
// Enables OAuth (Google now, Apple later):
//   - password_hash becomes nullable (OAuth users have no password)
//   - oauth_provider / oauth_id store the external identity
//   - mark email_verified true for OAuth users (provider already verified it)

const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    console.log('Enabling OAuth on users table…');

    // password_hash must allow NULL for OAuth-only accounts
    await db.query(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`);
    console.log('  ✓ password_hash now nullable');

    await db.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS oauth_provider VARCHAR(20),   -- 'google' | 'apple'
        ADD COLUMN IF NOT EXISTS oauth_id       VARCHAR(255),  -- provider's stable user id (sub)
        ADD COLUMN IF NOT EXISTS avatar_url     TEXT           -- profile picture from provider
    `);
    console.log('  ✓ oauth_provider / oauth_id / avatar_url added');

    // Fast lookup by provider identity
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_users_oauth
        ON users(oauth_provider, oauth_id)
        WHERE oauth_provider IS NOT NULL
    `);
    console.log('  ✓ oauth lookup index created');

    console.log('✅ Migration complete.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  } finally {
    await db.end();
  }
}

migrate();
