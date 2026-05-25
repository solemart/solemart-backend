const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    // Generic photo library — re-usable images by brand+model+colour
    await db.query(`
      CREATE TABLE IF NOT EXISTS shoe_photo_library (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        brand       VARCHAR(100) NOT NULL,
        model       VARCHAR(200) NOT NULL,
        colour      VARCHAR(100),
        url         TEXT NOT NULL,
        caption     VARCHAR(200),
        is_primary  BOOLEAN DEFAULT FALSE,
        created_by  UUID REFERENCES users(id),
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_photo_lib_brand_model ON shoe_photo_library(brand, model);
      CREATE INDEX IF NOT EXISTS idx_photo_lib_colour     ON shoe_photo_library(brand, model, colour);
    `);
    console.log('✅ shoe_photo_library created');

    // Link from a listed shoe to the library photo used
    await db.query(`
      ALTER TABLE shoes ADD COLUMN IF NOT EXISTS library_photo_id UUID REFERENCES shoe_photo_library(id);
      ALTER TABLE shoes ADD COLUMN IF NOT EXISTS submission_id UUID REFERENCES listing_submissions(id);
    `);
    console.log('✅ shoes.library_photo_id + shoes.submission_id added');

    // Submission status events — full audit trail visible to the owner
    await db.query(`
      CREATE TABLE IF NOT EXISTS submission_events (
        id            BIGSERIAL PRIMARY KEY,
        shoe_id       UUID NOT NULL REFERENCES shoes(id) ON DELETE CASCADE,
        event_type    VARCHAR(50) NOT NULL,   -- e.g. submitted, received, reviewing, listed, rejected, note_added
        status_before VARCHAR(30),
        status_after  VARCHAR(30),
        actor_id      UUID REFERENCES users(id),
        actor_role    VARCHAR(20),            -- 'owner' or 'kosmos'
        notes         TEXT,
        meta          JSONB,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_sub_events_shoe ON submission_events(shoe_id, created_at);
    `);
    console.log('✅ submission_events created');

    console.log('Migration complete.');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await db.end();
  }
}

migrate();
