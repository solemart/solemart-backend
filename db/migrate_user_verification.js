// db/migrate_user_verification.js
// Adds identity + address verification tracking to users.
// Used to gate rentals: a user must be fully verified once before renting.

const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    console.log('Adding verification columns to users…');

    await db.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS id_verified           BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS id_verified_at         TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS id_verification_session VARCHAR(255),  -- Stripe Identity session id
        ADD COLUMN IF NOT EXISTS id_verified_name       VARCHAR(200),   -- name returned by Stripe Identity
        ADD COLUMN IF NOT EXISTS id_verified_dob        DATE,
        ADD COLUMN IF NOT EXISTS address_verified       BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS address_verified_at     TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS address_proof_url       TEXT,           -- stored proof-of-address doc (base64 or URL)
        ADD COLUMN IF NOT EXISTS address_proof_extracted JSONB,          -- OCR result: { name, address, postcode, date }
        ADD COLUMN IF NOT EXISTS address_proof_status    VARCHAR(20) DEFAULT 'none',  -- none | pending | auto_approved | manual_review | approved | rejected
        ADD COLUMN IF NOT EXISTS verification_notes      TEXT
    `);
    console.log('  ✓ user verification columns added');

    // A "fully verified to rent" view-friendly flag is computed as id_verified AND address_verified
    // We add an index for quickly finding users pending manual review.
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_users_address_proof_pending
        ON users(address_proof_status)
        WHERE address_proof_status IN ('pending','manual_review')
    `);
    console.log('  ✓ pending-review index created');

    console.log('✅ Migration complete.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  } finally {
    await db.end();
  }
}

migrate();
