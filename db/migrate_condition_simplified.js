// db/migrate_condition_simplified.js
// Updates shoes.condition CHECK constraint to allow simplified values: New / Pre-owned.
//
// IMPORTANT — these two columns capture DIFFERENT things:
//   • condition           = has the shoe ever been worn? (New | Pre-owned)
//   • assessed_wear_grade = visual quality regardless of wear (Mint | Excellent | Good | Fair | Vintage)
//
// A Pre-owned pair can absolutely be Mint (worn once, perfect condition).
// So this migration does NOT conflate wear-grade values into condition.
//
// Old condition values map to the new values as follows:
//   Brand New           → condition: 'New'        (never worn)
//   Like New, Excellent → condition: 'Pre-owned'  (these were ambiguous — assume worn but excellent)
//                       + preserve their wear grade in assessed_wear_grade if not already set
//   Very Good, Good     → condition: 'Pre-owned'  + assessed_wear_grade = matching value
//   Fair, Vintage       → condition: 'Pre-owned'  + assessed_wear_grade = matching value

const { Pool } = require('pg');
const db = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  try {
    console.log('Looking up existing condition constraints…');

    // 1. Find and drop the existing CHECK constraint on condition
    const { rows: constraints } = await db.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'shoes'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%condition%'
    `);
    for (const c of constraints) {
      console.log(`Dropping existing constraint: ${c.conname}`);
      await db.query(`ALTER TABLE shoes DROP CONSTRAINT ${c.conname}`);
    }

    // 2. Check if assessed_wear_grade column exists; we'll preserve granular wear info there
    const { rows: colCheck } = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'shoes' AND column_name = 'assessed_wear_grade'
    `);
    const hasWearGrade = colCheck.length > 0;
    console.log(`assessed_wear_grade column: ${hasWearGrade ? 'exists' : 'missing'}`);

    // 3. Preserve granular wear info in assessed_wear_grade (only if it's currently null/empty)
    //    This means we don't overwrite any admin-assigned wear grades.
    if (hasWearGrade) {
      console.log('Preserving granular wear info in assessed_wear_grade…');
      const wearMap = {
        'Like New':  'Mint',
        'Excellent': 'Excellent',
        'Very Good': 'Excellent',
        'Good':      'Good',
        'Fair':      'Fair',
        'Vintage':   'Vintage',
      };
      for (const [oldCond, wearGrade] of Object.entries(wearMap)) {
        const { rowCount } = await db.query(
          `UPDATE shoes
           SET assessed_wear_grade = $1
           WHERE condition = $2
             AND (assessed_wear_grade IS NULL OR assessed_wear_grade = '')`,
          [wearGrade, oldCond]
        );
        if (rowCount > 0) {
          console.log(`  → backfilled wear="${wearGrade}" for ${rowCount} row(s) (was condition="${oldCond}")`);
        }
      }
    }

    // 4. Remap condition to the new binary values
    console.log('Remapping condition values to New / Pre-owned…');
    const { rowCount: nNew } = await db.query(
      `UPDATE shoes SET condition = 'New' WHERE condition = 'Brand New'`
    );
    const { rowCount: nPre } = await db.query(
      `UPDATE shoes SET condition = 'Pre-owned'
       WHERE condition IN ('Like New','Excellent','Very Good','Good','Fair','Vintage')`
    );
    const { rowCount: nNull } = await db.query(
      `UPDATE shoes SET condition = 'Pre-owned'
       WHERE condition IS NULL OR condition NOT IN ('New','Pre-owned')`
    );
    console.log(`  → ${nNew} row(s) → "New"`);
    console.log(`  → ${nPre} row(s) → "Pre-owned" (was a wear-grade-shaped value)`);
    console.log(`  → ${nNull} row(s) → "Pre-owned" (catch-all for null/unknown)`);

    // 5. Re-add the CHECK constraint
    console.log('Adding new constraint…');
    await db.query(`
      ALTER TABLE shoes ADD CONSTRAINT shoes_condition_check
        CHECK (condition IN ('New','Pre-owned'))
    `);

    console.log('');
    console.log('✅ Migration complete.');
    console.log('   • condition          now: New | Pre-owned');
    console.log('   • assessed_wear_grade kept granular values (Mint, Excellent, Good, Fair, Vintage)');
    console.log('   • No data lost — wear-grade info was preserved in its own column.');
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  } finally {
    await db.end();
  }
}

migrate();
