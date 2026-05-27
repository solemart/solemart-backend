// db/migrate_photo_metadata.js
// Adds is_cover (designates the display photo) and uploaded_by_role
// (tracks whether photo came from owner submission or admin registration).

const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    console.log('Adding is_cover + uploaded_by_role to shoe_photos…');

    await db.query(`
      ALTER TABLE shoe_photos
        ADD COLUMN IF NOT EXISTS is_cover         BOOLEAN DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS uploaded_by_role VARCHAR(20)
    `);

    // Partial unique index — only one cover per shoe
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_shoe_photos_one_cover
        ON shoe_photos(shoe_id)
        WHERE is_cover = TRUE
    `);

    // Backfill: for shoes that have photos but no cover set,
    // mark the lowest-sort_order photo as cover.
    console.log('Backfilling cover photos for existing shoes…');
    const { rowCount } = await db.query(`
      UPDATE shoe_photos sp
      SET is_cover = TRUE
      WHERE sp.id IN (
        SELECT DISTINCT ON (shoe_id) id
        FROM shoe_photos
        WHERE shoe_id NOT IN (SELECT shoe_id FROM shoe_photos WHERE is_cover = TRUE)
        ORDER BY shoe_id, sort_order ASC, uploaded_at ASC
      )
    `);
    console.log(`  → ${rowCount} shoe(s) given a default cover photo`);

    console.log('✅ Migration complete.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  } finally {
    await db.end();
  }
}

migrate();
