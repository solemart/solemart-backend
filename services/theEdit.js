// services/theEdit.js — Auto-curate weekly featured shoes
// Defensive: degrades gracefully when optional columns/tables aren't there yet.
const db = require('../config/db');

let logger;
try {
  logger = require('../config/logger');
} catch (e) {
  // Fallback if logger isn't available
  logger = { info: console.log, warn: console.warn, error: console.error };
}

// ── Date helpers ──────────────────────────────────────────────────────────────

// Get the most recent Thursday at 06:00 UTC as "week_start"
function getCurrentEditWeek() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 4=Thu
  const daysSinceThursday = (day - 4 + 7) % 7;
  const thursday = new Date(now);
  thursday.setUTCDate(now.getUTCDate() - daysSinceThursday);
  thursday.setUTCHours(6, 0, 0, 0);
  if (daysSinceThursday === 0 && now < thursday) {
    thursday.setUTCDate(thursday.getUTCDate() - 7);
  }
  return thursday.toISOString().slice(0, 10);
}

function getNextEditRefresh() {
  const now = new Date();
  const day = now.getUTCDay();
  const daysUntilThursday = (4 - day + 7) % 7 || 7;
  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysUntilThursday);
  next.setUTCHours(6, 0, 0, 0);
  return next;
}

// ── Column probing (run once, cached) ─────────────────────────────────────────

let _columnCache = null;
async function getAvailableColumns() {
  if (_columnCache) return _columnCache;
  try {
    const { rows } = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('shoes', 'the_edit')
    `);
    const cols = new Set(rows.map(r => r.column_name));
    _columnCache = {
      hasViewCount:   cols.has('view_count'),
      hasAssessed:    cols.has('assessed_wear_grade'),
      hasShoeCode:    cols.has('shoe_code'),
      hasTheEditTable: rows.some(r => r.column_name === 'shoe_ids'),
      hasBreakdown:   cols.has('breakdown'),
    };
  } catch (e) {
    logger.warn('Column probe failed, assuming minimal schema:', e.message);
    _columnCache = {
      hasViewCount: false, hasAssessed: false, hasShoeCode: false,
      hasTheEditTable: false, hasBreakdown: false,
    };
  }
  return _columnCache;
}

// ── Curation logic ────────────────────────────────────────────────────────────

async function curateEdit() {
  const cols = await getAvailableColumns();

  // BEST — most expensive listed shoes (no auth_grade dependency)
  const { rows: bestRows } = await db.query(`
    SELECT id FROM shoes
    WHERE status = 'listed'
      AND COALESCE(rrp, buy_price, 0) >= 80
    ORDER BY COALESCE(rrp, buy_price) DESC NULLS LAST, listed_at DESC NULLS LAST
    LIMIT 4
  `);
  const bestIds = bestRows.map(r => r.id);

  // NEWEST — most recently listed (exclude best)
  let newestSql = `
    SELECT id FROM shoes
    WHERE status = 'listed'
  `;
  const newestParams = [];
  if (bestIds.length) {
    newestSql += ` AND id != ALL($1::uuid[])`;
    newestParams.push(bestIds);
  }
  newestSql += ` ORDER BY listed_at DESC NULLS LAST LIMIT 4`;
  const { rows: newestRows } = await db.query(newestSql, newestParams);
  const newestIds = newestRows.map(r => r.id);

  // POPULAR — most viewed if column exists, else fall back to oldest still-listed
  const excludeIds = [...bestIds, ...newestIds];
  let popularSql;
  const popularParams = [];
  if (cols.hasViewCount) {
    popularSql = `
      SELECT id FROM shoes
      WHERE status = 'listed'
    `;
    if (excludeIds.length) {
      popularSql += ` AND id != ALL($1::uuid[])`;
      popularParams.push(excludeIds);
    }
    popularSql += ` ORDER BY view_count DESC NULLS LAST, listed_at DESC NULLS LAST LIMIT 4`;
  } else {
    // No view_count yet — fall back to oldest listed (rotating freshness pool)
    popularSql = `
      SELECT id FROM shoes
      WHERE status = 'listed'
    `;
    if (excludeIds.length) {
      popularSql += ` AND id != ALL($1::uuid[])`;
      popularParams.push(excludeIds);
    }
    popularSql += ` ORDER BY listed_at ASC NULLS LAST LIMIT 4`;
  }
  const { rows: popularRows } = await db.query(popularSql, popularParams);
  const popularIds = popularRows.map(r => r.id);

  const breakdown = {
    best:    bestIds,
    newest:  newestIds,
    popular: popularIds,
  };
  const allIds = [...bestIds, ...newestIds, ...popularIds];

  return { ids: allIds, breakdown };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getCurrentEdit() {
  const weekStart = getCurrentEditWeek();
  const cols = await getAvailableColumns();

  // If the_edit table doesn't exist, just return a freshly curated set on the fly
  if (!cols.hasTheEditTable) {
    try {
      const { ids, breakdown } = await curateEdit();
      return {
        week_start: weekStart,
        shoe_ids: ids,
        breakdown,
        next_refresh: getNextEditRefresh(),
        ephemeral: true, // signals not persisted
      };
    } catch (e) {
      logger.warn('Could not curate Edit (no table, curate also failed):', e.message);
      return { week_start: weekStart, shoe_ids: [], breakdown: {}, next_refresh: getNextEditRefresh() };
    }
  }

  // Table exists — try to read or curate+save
  try {
    const { rows } = await db.query(
      `SELECT shoe_ids, breakdown, published_at FROM the_edit WHERE week_start = $1`,
      [weekStart]
    );
    if (rows.length) {
      return { week_start: weekStart, ...rows[0], next_refresh: getNextEditRefresh() };
    }
  } catch (e) {
    logger.warn('the_edit read failed:', e.message);
  }

  // No edit for this week yet — curate and persist
  logger.info(`Curating fresh Edit for ${weekStart}`);
  let curated;
  try {
    curated = await curateEdit();
  } catch (e) {
    logger.warn('Curate failed:', e.message);
    return { week_start: weekStart, shoe_ids: [], breakdown: {}, next_refresh: getNextEditRefresh() };
  }
  const { ids, breakdown } = curated;

  if (!ids.length) {
    return { week_start: weekStart, shoe_ids: [], breakdown: {}, next_refresh: getNextEditRefresh() };
  }

  try {
    await db.query(
      `INSERT INTO the_edit (week_start, shoe_ids, breakdown)
       VALUES ($1, $2::uuid[], $3)
       ON CONFLICT (week_start) DO UPDATE
         SET shoe_ids = EXCLUDED.shoe_ids, breakdown = EXCLUDED.breakdown`,
      [weekStart, ids, breakdown]
    );
  } catch (e) {
    logger.warn('the_edit save failed (returning curated anyway):', e.message);
  }

  return {
    week_start: weekStart,
    shoe_ids: ids,
    breakdown,
    published_at: new Date(),
    next_refresh: getNextEditRefresh(),
  };
}

// Force re-curate (admin override)
async function recurateEdit() {
  const weekStart = getCurrentEditWeek();
  const { ids, breakdown } = await curateEdit();
  try {
    await db.query(
      `INSERT INTO the_edit (week_start, shoe_ids, breakdown, published_at)
       VALUES ($1, $2::uuid[], $3, NOW())
       ON CONFLICT (week_start) DO UPDATE
         SET shoe_ids = EXCLUDED.shoe_ids,
             breakdown = EXCLUDED.breakdown,
             published_at = NOW()`,
      [weekStart, ids, breakdown]
    );
  } catch (e) {
    logger.warn('Recurate save failed:', e.message);
  }
  return { week_start: weekStart, shoe_ids: ids, breakdown };
}

module.exports = {
  curateEdit,
  getCurrentEdit,
  recurateEdit,
  getCurrentEditWeek,
  getNextEditRefresh,
};
