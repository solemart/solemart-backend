const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

function generateShoeCode(brand) {
  const brandCode = (brand || 'KSM').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing 0/O/1/I
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
  return `KSM-${brandCode}-${suffix}`;
}

async function migrate() {
  try {
    await db.query(`
      ALTER TABLE shoes
        ADD COLUMN IF NOT EXISTS shoe_code VARCHAR(40) UNIQUE;
      CREATE INDEX IF NOT EXISTS idx_shoes_code ON shoes(shoe_code);
    `);
    console.log('✅ shoe_code column added');

    // Backfill codes for existing shoes
    const { rows: existing } = await db.query(`SELECT id, brand FROM shoes WHERE shoe_code IS NULL`);
    console.log(`Backfilling ${existing.length} existing shoes…`);

    for (const shoe of existing) {
      let attempts = 0;
      while (attempts < 10) {
        const code = generateShoeCode(shoe.brand);
        try {
          await db.query(`UPDATE shoes SET shoe_code = $1 WHERE id = $2`, [code, shoe.id]);
          break;
        } catch (e) {
          if (e.code === '23505') { attempts++; continue; } // unique violation, retry
          throw e;
        }
      }
    }
    console.log('✅ All shoes have codes');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await db.end();
  }
}

migrate();
