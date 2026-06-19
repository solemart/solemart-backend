const express = require('express');
const db      = require('../config/db');
const { authenticate, optionalAuth, requireRole } = require('../middleware/auth');
const router  = express.Router();

// ════════════════════════════════════════════════════════════════════════════
// PHASE 0 · STEP 2a — Generic asset model + LIVE SYNC + asset-backed reads
//
// Step 1 stood up the model additively. Step 2a:
//   • keeps `assets` a faithful, LIVE mirror of `shoes` via a trigger, so the
//     read endpoints below never serve stale data. The trigger is wrapped in an
//     exception handler — a sync error can NEVER abort a shoe write, so the
//     existing app (submissions, intake, admin edits) is never put at risk.
//   • exposes asset-backed browse + detail endpoints that reproduce the exact
//     shapes the website expects. Nothing calls them yet (the site still uses
//     /api/shoes) — deploy, compare /api/assets vs /api/shoes, then flip reads.
//
// Photos/reviews are still read from the live shoe_photos/reviews tables (their
// shoe_id == asset id, because assets reuse shoes.id) so they're always current
// without needing photo-table triggers.
// ════════════════════════════════════════════════════════════════════════════

const UK_SIZES = ['3','3.5','4','4.5','5','5.5','6','6.5','7','7.5','8','8.5','9','9.5','10','10.5','11','11.5','12','13'];

(async () => {
  // ── schema (idempotent, additive) ──────────────────────────────────────────
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        parent_id       uuid REFERENCES categories(id) ON DELETE SET NULL,
        key             text UNIQUE NOT NULL,
        name            text NOT NULL,
        emoji           text,
        lifecycle       jsonb   NOT NULL DEFAULT '{}'::jsonb,
        rental_rules    jsonb   NOT NULL DEFAULT '{}'::jsonb,
        verify_required boolean NOT NULL DEFAULT false,
        is_active       boolean NOT NULL DEFAULT true,
        sort_order      int     NOT NULL DEFAULT 0,
        created_at      timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS category_attributes (
        id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        category_id uuid NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
        key         text NOT NULL,
        label       text NOT NULL,
        type        text NOT NULL DEFAULT 'text',
        options     jsonb NOT NULL DEFAULT '[]'::jsonb,
        unit        text,
        required    boolean NOT NULL DEFAULT false,
        filterable  boolean NOT NULL DEFAULT false,
        sort_order  int     NOT NULL DEFAULT 0,
        UNIQUE (category_id, key)
      );
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS assets (
        id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_id      uuid NOT NULL,
        category_id   uuid REFERENCES categories(id) ON DELETE SET NULL,
        title         text NOT NULL DEFAULT '',
        description   text,
        status        text NOT NULL DEFAULT 'draft',
        listing_type  text NOT NULL DEFAULT 'sale',
        trust_level   text NOT NULL DEFAULT 'self',
        buy_price     numeric,
        rent_price    numeric,
        deposit       numeric,
        currency      text NOT NULL DEFAULT 'GBP',
        attributes    jsonb NOT NULL DEFAULT '{}'::jsonb,
        photos        jsonb NOT NULL DEFAULT '[]'::jsonb,
        emoji         text,
        published_at  timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now(),
        updated_at    timestamptz NOT NULL DEFAULT now()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_assets_category   ON assets(category_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_assets_owner      ON assets(owner_id);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_assets_status     ON assets(status);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_assets_attributes ON assets USING gin (attributes);`);

    // ── seed Footwear category + attributes (idempotent) ──────────────────────
    await db.query(
      `INSERT INTO categories (key, name, emoji, verify_required, sort_order)
       VALUES ('footwear', 'Footwear', '👟', false, 0)
       ON CONFLICT (key) DO NOTHING;`
    );
    await db.query(
      `WITH f AS (SELECT id FROM categories WHERE key = 'footwear')
       INSERT INTO category_attributes (category_id, key, label, type, options, unit, required, filterable, sort_order)
       SELECT f.id, v.key, v.label, v.type, v.options::jsonb, v.unit, v.required, v.filterable, v.sort_order
       FROM f, (VALUES
         ('brand',      'Brand',      'text',   '[]',                                            NULL,  true,  true,  1),
         ('model',      'Model',      'text',   '[]',                                            NULL,  true,  true,  2),
         ('size',       'Size',       'select', $1,                                              'UK',  true,  true,  3),
         ('colour',     'Colour',     'text',   '[]',                                            NULL,  false, true,  4),
         ('condition',  'Condition',  'select', '["New","Like new","Excellent","Good","Fair"]', NULL,  false, true,  5),
         ('wear_grade', 'Wear grade', 'text',   '[]',                                            NULL,  false, false, 6),
         ('gender',     'Gender',     'select', '["Mens","Womens","Unisex","Kids"]',            NULL,  false, true,  7),
         ('type',       'Shoe type',  'text',   '[]',                                            NULL,  false, true,  8),
         ('rrp',        'RRP',        'number', '[]',                                            'GBP', false, false, 9)
       ) AS v(key, label, type, options, unit, required, filterable, sort_order)
       ON CONFLICT (category_id, key) DO NOTHING;`,
      [JSON.stringify(UK_SIZES)]
    );

    // ── shoe-shaped projection of assets (so the read queries below stay close
    //    to the proven /api/shoes SQL → minimal transcription risk) ────────────
    await db.query(`
      CREATE OR REPLACE VIEW asset_shoes AS
      SELECT
        a.id,
        a.owner_id,
        a.attributes->>'brand'                                    AS brand,
        a.attributes->>'model'                                    AS model,
        a.attributes->>'size'                                     AS size,
        a.attributes->>'colour'                                   AS colour,
        a.attributes->>'type'                                     AS category,
        a.attributes->>'gender'                                   AS gender,
        a.attributes->>'condition'                                AS condition,
        a.attributes->>'wear_grade'                               AS assessed_wear_grade,
        a.emoji,
        a.description,
        a.listing_type,
        NULLIF(a.attributes->>'rrp','')::numeric                  AS rrp,
        a.rent_price,
        a.buy_price,
        COALESCE(NULLIF(a.attributes->>'rental_count','')::int,0) AS rental_count,
        a.published_at                                            AS listed_at,
        a.status,
        a.title,
        cat.key                                                   AS category_key,
        cat.name                                                  AS category_name
      FROM assets a LEFT JOIN categories cat ON cat.id = a.category_id;
    `);

    // ── live sync: shoes → assets. Exception-guarded so it can NEVER break a
    //    shoe write. Only fires on meaningful column changes (not view_count). ─
    await db.query(`
      CREATE OR REPLACE FUNCTION sync_shoe_to_asset() RETURNS trigger AS $fn$
      BEGIN
        BEGIN
          IF (TG_OP = 'DELETE') THEN
            DELETE FROM assets WHERE id = OLD.id;
            RETURN OLD;
          END IF;
          INSERT INTO assets
            (id, owner_id, category_id, title, description, status, listing_type,
             trust_level, buy_price, rent_price, currency, attributes, emoji,
             published_at, created_at, updated_at)
          VALUES (
            NEW.id, NEW.owner_id,
            (SELECT id FROM categories WHERE key = 'footwear'),
            TRIM(CONCAT_WS(' ', NEW.brand, NEW.model)),
            NEW.description, COALESCE(NEW.status,'draft'),
            COALESCE(NEW.listing_type,'sale'), 'self',
            NEW.buy_price, NEW.rent_price, 'GBP',
            jsonb_strip_nulls(jsonb_build_object(
              'brand', NEW.brand, 'model', NEW.model, 'size', NEW.size,
              'colour', NEW.colour, 'condition', NEW.condition,
              'wear_grade', NEW.assessed_wear_grade, 'gender', NEW.gender,
              'type', NEW.category, 'rrp', NEW.rrp, 'rental_count', NEW.rental_count
            )),
            NEW.emoji, NEW.listed_at, COALESCE(NEW.created_at, now()), now()
          )
          ON CONFLICT (id) DO UPDATE SET
            owner_id     = EXCLUDED.owner_id,
            title        = EXCLUDED.title,
            description  = EXCLUDED.description,
            status       = EXCLUDED.status,
            listing_type = EXCLUDED.listing_type,
            buy_price    = EXCLUDED.buy_price,
            rent_price   = EXCLUDED.rent_price,
            attributes   = assets.attributes || EXCLUDED.attributes,
            emoji        = EXCLUDED.emoji,
            published_at = EXCLUDED.published_at,
            updated_at   = now();
        EXCEPTION WHEN OTHERS THEN
          RAISE WARNING 'sync_shoe_to_asset failed for %: %', COALESCE(NEW.id, OLD.id), SQLERRM;
        END;
        RETURN COALESCE(NEW, OLD);
      END;
      $fn$ LANGUAGE plpgsql;
    `);
    await db.query(`DROP TRIGGER IF EXISTS trg_asset_sync_ins ON shoes;`);
    await db.query(`DROP TRIGGER IF EXISTS trg_asset_sync_del ON shoes;`);
    await db.query(`DROP TRIGGER IF EXISTS trg_asset_sync_upd ON shoes;`);
    await db.query(`CREATE TRIGGER trg_asset_sync_ins AFTER INSERT ON shoes FOR EACH ROW EXECUTE FUNCTION sync_shoe_to_asset();`);
    await db.query(`CREATE TRIGGER trg_asset_sync_del AFTER DELETE ON shoes FOR EACH ROW EXECUTE FUNCTION sync_shoe_to_asset();`);
    await db.query(`
      CREATE TRIGGER trg_asset_sync_upd
      AFTER UPDATE OF brand, model, size, colour, category, gender, condition,
        assessed_wear_grade, rrp, rent_price, buy_price, listing_type, emoji,
        description, status, owner_id, rental_count, listed_at
      ON shoes FOR EACH ROW EXECUTE FUNCTION sync_shoe_to_asset();
    `);

    console.log('[assets] model + view + live sync trigger ready');
  } catch (e) {
    console.error('[assets] schema/seed/sync setup failed:', e.message);
  }

  // ── one-time backfill shoes → assets (idempotent, best-effort) ──────────────
  try {
    const { rowCount } = await db.query(`
      INSERT INTO assets
        (id, owner_id, category_id, title, description, status, listing_type,
         trust_level, buy_price, rent_price, currency, attributes, photos,
         emoji, published_at, created_at, updated_at)
      SELECT
        s.id, s.owner_id,
        (SELECT id FROM categories WHERE key = 'footwear'),
        TRIM(CONCAT_WS(' ', s.brand, s.model)),
        s.description, COALESCE(s.status, 'draft'),
        COALESCE(s.listing_type, 'sale'), 'self',
        s.buy_price, s.rent_price, 'GBP',
        jsonb_strip_nulls(jsonb_build_object(
          'brand', s.brand, 'model', s.model, 'size', s.size, 'colour', s.colour,
          'condition', s.condition, 'wear_grade', s.assessed_wear_grade,
          'gender', s.gender, 'type', s.category, 'rrp', s.rrp,
          'rental_count', s.rental_count
        )),
        COALESCE((
          SELECT jsonb_agg(jsonb_build_object('url', p.url, 'caption', p.caption,
                           'sort_order', p.sort_order, 'is_cover', p.is_cover)
                 ORDER BY p.sort_order)
          FROM shoe_photos p WHERE p.shoe_id = s.id
        ), '[]'::jsonb),
        s.emoji, s.listed_at, COALESCE(s.created_at, now()), now()
      FROM shoes s
      WHERE NOT EXISTS (SELECT 1 FROM assets a WHERE a.id = s.id);
    `);
    if (rowCount > 0) console.log(`[assets] backfilled ${rowCount} shoe(s) into assets`);

    // patch any rows backfilled by Step 1 that predate the 'type' attribute
    await db.query(`
      UPDATE assets a
         SET attributes = a.attributes || jsonb_build_object('type', s.category)
        FROM shoes s
       WHERE s.id = a.id AND s.category IS NOT NULL AND NOT (a.attributes ? 'type');
    `);
  } catch (e) {
    console.error('[assets] backfill skipped:', e.message);
  }
})();

// ════════════════════════════════════════════════════════════════════════════
// Asset-backed reads — faithful drop-ins for the public /api/shoes reads.
// (Still additive: the website keeps calling /api/shoes until Step 2b.)
// ════════════════════════════════════════════════════════════════════════════

// GET /api/assets — public browse (grouped by brand/model/colour), == /api/shoes
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const { q, type, condition, size, sort = 'newest', page = 1, limit = 100 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const params = [];
    const conditions = [`s.status = 'listed'`];
    if (q) {
      params.push(`%${q}%`);
      conditions.push(`(s.brand ILIKE $${params.length} OR s.model ILIKE $${params.length} OR s.colour ILIKE $${params.length})`);
    }
    if (type && type !== 'all') {
      params.push(type);
      conditions.push(`(s.listing_type = $${params.length} OR s.listing_type = 'both')`);
    }
    if (condition) { params.push(condition); conditions.push(`s.condition = $${params.length}`); }
    if (size)      { params.push(size);      conditions.push(`s.size = $${params.length}`); }

    const sortMap = {
      newest: 'g.last_listed_at DESC NULLS LAST', oldest: 'g.first_listed_at ASC',
      'price-asc': 'COALESCE(g.rent_price, g.buy_price) ASC', 'price-desc': 'COALESCE(g.rent_price, g.buy_price) DESC',
      'rrp-asc': 'g.rrp ASC NULLS LAST', 'rrp-desc': 'g.rrp DESC NULLS LAST',
      brand: 'g.brand ASC, g.model ASC', stock: 'g.stock_count DESC',
    };
    const orderBy = sortMap[sort] || sortMap.newest;
    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const result = await db.query(
      `WITH grouped AS (
         SELECT
           LOWER(s.brand) AS group_brand_key, LOWER(s.model) AS group_model_key,
           LOWER(COALESCE(s.colour, '')) AS group_colour_key,
           MIN(s.brand) AS brand, MIN(s.model) AS model, MIN(s.size) AS size,
           MIN(s.colour) AS colour, MIN(s.category) AS category, MIN(s.gender) AS gender,
           MIN(s.condition) AS condition, MIN(s.assessed_wear_grade) AS assessed_wear_grade,
           MIN(s.emoji) AS emoji, MIN(s.description) AS description, MIN(s.listing_type) AS listing_type,
           MIN(s.rrp) AS rrp, MIN(s.rent_price) AS rent_price, MIN(s.buy_price) AS buy_price,
           MIN(COALESCE(s.rental_count, 0)) AS rental_min, MAX(COALESCE(s.rental_count, 0)) AS rental_max,
           COUNT(*) AS stock_count,
           array_remove(array_agg(DISTINCT s.size), NULL) AS sizes_available,
           MIN(s.listed_at) AS first_listed_at, MAX(s.listed_at) AS last_listed_at,
           MIN(s.title) AS title, MIN(s.category_key) AS category_key, MIN(s.category_name) AS category_name,
           (array_agg(s.id ORDER BY s.listed_at ASC NULLS LAST))[1] AS representative_id
         FROM asset_shoes s
         ${whereClause}
         GROUP BY group_brand_key, group_model_key, group_colour_key,
                  CASE WHEN s.category_key IS NULL OR s.category_key = 'footwear' THEN NULL ELSE s.id END
       )
       SELECT g.*,
              ROUND(AVG(r.stars), 1) AS avg_rating, COUNT(r.id) AS review_count,
              COALESCE(
                (SELECT url FROM shoe_photos p WHERE p.shoe_id = g.representative_id ORDER BY p.sort_order LIMIT 1),
                (SELECT CASE WHEN jsonb_typeof(a.photos->0) = 'object' THEN a.photos->0->>'url'
                             WHEN jsonb_typeof(a.photos->0) = 'string' THEN a.photos->>0 END
                   FROM assets a WHERE a.id = g.representative_id)
              ) AS primary_photo
       FROM grouped g
       LEFT JOIN reviews r ON r.shoe_id = g.representative_id
       GROUP BY g.group_brand_key, g.group_model_key, g.group_colour_key,
                g.brand, g.model, g.size, g.colour, g.category, g.gender, g.condition, g.assessed_wear_grade,
                g.emoji, g.description, g.listing_type, g.rrp, g.rent_price, g.buy_price,
                g.rental_min, g.rental_max, g.stock_count, g.sizes_available,
                g.first_listed_at, g.last_listed_at, g.representative_id,
                g.title, g.category_key, g.category_name
       ORDER BY ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, parseInt(limit), offset]
    );

    const shoes = result.rows.map(r => ({
      id: r.representative_id, brand: r.brand, model: r.model, size: r.size,
      sizes_available: (r.sizes_available && r.sizes_available.length) ? r.sizes_available : (r.size ? [r.size] : []),
      colour: r.colour, category: r.category, gender: r.gender, condition: r.condition,
      assessed_wear_grade: r.assessed_wear_grade,
      rental_count: parseInt(r.rental_min ?? 0), rental_min: parseInt(r.rental_min ?? 0), rental_max: parseInt(r.rental_max ?? 0),
      emoji: r.emoji, description: r.description, listing_type: r.listing_type,
      rrp: r.rrp, rent_price: r.rent_price, buy_price: r.buy_price, listed_at: r.first_listed_at,
      stock_count: parseInt(r.stock_count), avg_rating: r.avg_rating ? parseFloat(r.avg_rating) : null,
      review_count: parseInt(r.review_count || 0), primary_photo: r.primary_photo,
      category_key: r.category_key, category_name: r.category_name, title: r.title,
    }));

    let totalCount = 0;
    try {
      const countRes = await db.query(
        `SELECT COUNT(*) FROM (
           SELECT 1 FROM asset_shoes s ${whereClause}
           GROUP BY LOWER(s.brand), LOWER(s.model), LOWER(COALESCE(s.colour,'')),
                    CASE WHEN s.category_key IS NULL OR s.category_key = 'footwear' THEN NULL ELSE s.id END
         ) g`, params);
      totalCount = parseInt(countRes.rows[0].count);
    } catch (e) { totalCount = shoes.length; }

    res.json({ shoes, pagination: { total: totalCount, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(totalCount / parseInt(limit)) } });
  } catch (err) {
    console.error('GET /api/assets error:', err);
    res.status(500).json({ error: err.message || 'Could not load assets' });
  }
});

// GET /api/assets/categories — the category tree
router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, parent_id, key, name, emoji, verify_required, is_active, sort_order
         FROM categories WHERE is_active = true ORDER BY sort_order, name`
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── Category engine (staff/admin) — define categories + their fields, no code
//    changes needed to add Watches, Bags, Cameras, … ─────────────────────────
function slug(s) { return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); }

// POST /api/assets/categories — create a category
router.post('/categories', authenticate, requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.name) return res.status(400).json({ error: 'name required' });
    const key = slug(b.key || b.name);
    if (!key) return res.status(400).json({ error: 'invalid key' });
    const { rows: [cat] } = await db.query(
      `INSERT INTO categories (key, name, emoji, parent_id, verify_required, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (key) DO NOTHING RETURNING *`,
      [key, b.name, b.emoji || null, b.parent_id || null, !!b.verify_required, b.sort_order || 0]);
    if (!cat) return res.status(409).json({ error: 'A category with that key already exists' });
    res.status(201).json(cat);
  } catch (err) { next(err); }
});

// PATCH /api/assets/categories/:id — update a category
router.patch('/categories/:id', authenticate, requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    const fields = [];
    const params = [];
    const set = (sql, val) => { params.push(val); fields.push(sql.replace('?', `$${params.length}`)); };
    if (b.name !== undefined)            set('name = ?', b.name);
    if (b.emoji !== undefined)           set('emoji = ?', b.emoji);
    if (b.verify_required !== undefined) set('verify_required = ?', !!b.verify_required);
    if (b.is_active !== undefined)       set('is_active = ?', !!b.is_active);
    if (b.sort_order !== undefined)      set('sort_order = ?', b.sort_order);
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    const { rows: [cat] } = await db.query(`UPDATE categories SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    if (!cat) return res.status(404).json({ error: 'Not found' });
    res.json(cat);
  } catch (err) { next(err); }
});

// GET /api/assets/categories/:id/attributes — a category's field definitions (drives forms/filters)
router.get('/categories/:id/attributes', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT id, key, label, type, options, unit, required, filterable, sort_order
         FROM category_attributes WHERE category_id = $1 ORDER BY sort_order`, [req.params.id]);
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/assets/categories/:id/attributes — add/replace a field on a category
router.post('/categories/:id/attributes', authenticate, requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.label && !b.key) return res.status(400).json({ error: 'label or key required' });
    const key = slug(b.key || b.label);
    const type = ['text', 'number', 'select', 'multiselect', 'boolean', 'date'].includes(b.type) ? b.type : 'text';
    const { rows: [attr] } = await db.query(
      `INSERT INTO category_attributes (category_id, key, label, type, options, unit, required, filterable, sort_order)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)
       ON CONFLICT (category_id, key) DO UPDATE SET
         label = EXCLUDED.label, type = EXCLUDED.type, options = EXCLUDED.options,
         unit = EXCLUDED.unit, required = EXCLUDED.required, filterable = EXCLUDED.filterable, sort_order = EXCLUDED.sort_order
       RETURNING *`,
      [req.params.id, key, b.label || key, type, JSON.stringify(Array.isArray(b.options) ? b.options : []),
       b.unit || null, !!b.required, b.filterable !== false, b.sort_order || 0]);
    res.status(201).json(attr);
  } catch (err) { next(err); }
});

// DELETE /api/assets/categories/:catId/attributes/:attrId
router.delete('/categories/:catId/attributes/:attrId', authenticate, requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    await db.query(`DELETE FROM category_attributes WHERE id = $1 AND category_id = $2`, [req.params.attrId, req.params.catId]);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// GET /api/assets/manage — staff list of non-footwear listings (for publish)
router.get('/manage', authenticate, requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT a.id, a.title, a.status, a.listing_type, a.buy_price, a.rent_price, a.created_at,
              c.key AS category_key, c.name AS category_name, c.emoji,
              (a.photos ->> 0) AS primary_photo
         FROM assets a JOIN categories c ON c.id = a.category_id
        WHERE c.key <> 'footwear'
        ORDER BY a.created_at DESC LIMIT 200`);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/assets/:id — public single listing
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    // category-aware: non-footwear assets render from their own attributes/photos
    const { rows: [meta] } = await db.query(
      `SELECT a.category_id, c.key AS category_key FROM assets a
         LEFT JOIN categories c ON c.id = a.category_id WHERE a.id::text = $1`, [String(req.params.id)]);
    if (meta && meta.category_key && meta.category_key !== 'footwear') {
      const { rows: [asset] } = await db.query(
        `SELECT a.*, c.key AS category_key, c.name AS category_name,
                u.first_name || ' ' || LEFT(u.last_name, 1) || '.' AS owner_display,
                (SELECT ROUND(AVG(stars), 1) FROM reviews WHERE shoe_id = a.id) AS avg_rating,
                (SELECT COUNT(*)             FROM reviews WHERE shoe_id = a.id) AS review_count
           FROM assets a
           LEFT JOIN categories c ON c.id = a.category_id
           JOIN users u ON u.id = a.owner_id
          WHERE a.id::text = $1 AND a.status IN ('listed','published','available')`, [String(req.params.id)]);
      if (!asset) return res.status(404).json({ error: 'Not found' });
      const { rows: defs } = await db.query(
        `SELECT key, label, type, unit, sort_order FROM category_attributes
          WHERE category_id = $1 ORDER BY sort_order`, [asset.category_id]);
      asset.attribute_defs = defs;
      asset.is_generic = true;
      return res.json(asset);
    }
    // footwear path (unchanged) ─────────────────────────────────────────────
    const { rows } = await db.query(
      `SELECT s.*,
              u.first_name || ' ' || LEFT(u.last_name, 1) || '.' AS owner_display,
              (SELECT ROUND(AVG(stars), 1) FROM reviews WHERE shoe_id = s.id) AS avg_rating,
              (SELECT COUNT(*)             FROM reviews WHERE shoe_id = s.id) AS review_count
         FROM asset_shoes s
         JOIN users u ON u.id = s.owner_id
        WHERE s.id::text = $1 AND s.status = 'listed'`,
      [String(req.params.id)]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const shoe = rows[0];

    let variants = [];
    let rentalMin = shoe.rental_count || 0;
    let rentalMax = shoe.rental_count || 0;
    try {
      const { rows: vrows } = await db.query(
        `SELECT MIN(size) AS size,
                (array_agg(id ORDER BY listed_at ASC NULLS LAST))[1] AS id,
                COALESCE(rental_count,0) AS rental_count,
                MIN(rent_price) AS rent_price, MIN(buy_price) AS buy_price,
                condition, COUNT(*)::int AS stock
         FROM asset_shoes
         WHERE status = 'listed'
           AND LOWER(brand) = LOWER($1) AND LOWER(model) = LOWER($2)
           AND LOWER(COALESCE(colour,'')) = LOWER(COALESCE($3,''))
         GROUP BY LOWER(COALESCE(size,'')), COALESCE(rental_count,0), condition
         ORDER BY NULLIF(regexp_replace(COALESCE(MIN(size),''), '[^0-9.]', '', 'g'), '')::numeric NULLS LAST, MIN(size), COALESCE(rental_count,0)`,
        [shoe.brand, shoe.model, shoe.colour]
      );
      variants = vrows.map(v => ({
        id: v.id, size: v.size, rental_count: parseInt(v.rental_count || 0),
        rent_price: v.rent_price, buy_price: v.buy_price, condition: v.condition, stock: v.stock,
      }));
      if (variants.length) {
        rentalMin = variants.reduce((m, v) => Math.min(m, v.rental_count), variants[0].rental_count);
        rentalMax = variants.reduce((m, v) => Math.max(m, v.rental_count), 0);
        shoe.stock_count = variants.reduce((a, v) => a + (v.stock || 0), 0) || 1;
      }
    } catch (e) {
      variants = [{ id: shoe.id, size: shoe.size, rental_count: shoe.rental_count || 0, rent_price: shoe.rent_price, buy_price: shoe.buy_price, condition: shoe.condition, stock: 1 }];
      shoe.stock_count = 1;
    }

    // keep the existing "popular" curation fed (view_count lives on shoes; ids match)
    db.query(`UPDATE shoes SET view_count = COALESCE(view_count, 0) + 1, last_viewed_at = NOW() WHERE id = $1`, [shoe.id]).catch(() => {});

    const photos = await db.query(
      'SELECT id, url, caption, sort_order FROM shoe_photos WHERE shoe_id = $1 ORDER BY sort_order', [shoe.id]);
    const reviews = await db.query(
      `SELECT r.stars, r.body, r.created_at,
              u.first_name || ' ' || LEFT(u.last_name, 1) || '.' AS reviewer
         FROM reviews r JOIN users u ON u.id = r.customer_id
        WHERE r.shoe_id = $1 ORDER BY r.created_at DESC LIMIT 10`, [shoe.id]);

    res.json({ ...shoe, photos: photos.rows, reviews: reviews.rows, variants, rental_min: rentalMin, rental_max: rentalMax });
  } catch (err) { next(err); }
});

// ════════════════════════════════════════════════════════════════════════════
// Generic WRITE path (Step 3) — create & manage assets in ANY category.
//
// Footwear is intentionally NOT writable here: it keeps flowing through the
// existing /api/shoes + submissions/intake path (→ sync trigger → assets), so
// nothing footwear changes. These endpoints are guarded against the footwear
// category to avoid a split brain. They exist so new categories (watches, bags,
// …) have a real write path into the generic model.
// ════════════════════════════════════════════════════════════════════════════

function isStaff(user) { return user && (user.role === 'staff' || user.role === 'admin'); }

async function categoryKeyOf(categoryId) {
  const { rows: [c] } = await db.query(`SELECT key FROM categories WHERE id = $1`, [categoryId]);
  return c ? c.key : null;
}

// missing required attributes for a category (drives category-aware validation)
async function missingRequired(categoryId, attributes) {
  const { rows } = await db.query(
    `SELECT key, label, required FROM category_attributes WHERE category_id = $1`, [categoryId]);
  return rows
    .filter(a => a.required && (attributes == null || attributes[a.key] == null || attributes[a.key] === ''))
    .map(a => a.label || a.key);
}

// POST /api/assets — create a listing (owner) in a non-footwear category
router.post('/', authenticate, async (req, res, next) => {
  try {
    const b = req.body || {};
    let cat;
    if (b.category_id)      ({ rows: [cat] } = await db.query(`SELECT id, key FROM categories WHERE id = $1`, [b.category_id]));
    else if (b.category_key) ({ rows: [cat] } = await db.query(`SELECT id, key FROM categories WHERE key = $1`, [b.category_key]));
    if (!cat) return res.status(400).json({ error: 'Unknown category' });
    if (cat.key === 'footwear') return res.status(400).json({ error: 'Footwear is listed through the existing shoe flow' });

    if (!['sale', 'rental', 'both'].includes(b.listing_type))
      return res.status(400).json({ error: 'listing_type must be sale, rental or both' });

    const attributes = b.attributes && typeof b.attributes === 'object' ? b.attributes : {};
    const missing = await missingRequired(cat.id, attributes);
    if (missing.length) return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });

    const status = (isStaff(req.user) && b.status) ? b.status : 'draft';
    const photos = Array.isArray(b.photos) ? b.photos : [];

    const { rows: [asset] } = await db.query(
      `INSERT INTO assets
         (owner_id, category_id, title, description, status, listing_type,
          buy_price, rent_price, deposit, attributes, photos, emoji, published_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,
               CASE WHEN $5 IN ('listed','published','available') THEN now() ELSE NULL END)
       RETURNING *`,
      [req.user.id, cat.id, (b.title || '').trim(), b.description || null, status, b.listing_type,
       b.buy_price ?? null, b.rent_price ?? null, b.deposit ?? null,
       JSON.stringify(attributes), JSON.stringify(photos), b.emoji || null]
    );
    res.status(201).json(asset);
  } catch (err) { next(err); }
});

// PATCH /api/assets/:id — update a listing (its owner, or staff)
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const { rows: [existing] } = await db.query(
      `SELECT owner_id, category_id FROM assets WHERE id::text = $1`, [String(req.params.id)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (await categoryKeyOf(existing.category_id) === 'footwear')
      return res.status(409).json({ error: 'Footwear listings are managed via the shoe flow during transition' });
    if (!isStaff(req.user) && existing.owner_id !== req.user.id)
      return res.status(403).json({ error: 'Not authorised' });

    const b = req.body || {};
    const fields = [];
    const params = [];
    const set = (sql, val) => { params.push(val); fields.push(sql.replace('?', `$${params.length}`)); };
    if (b.title !== undefined)        set('title = ?', String(b.title).trim());
    if (b.description !== undefined)  set('description = ?', b.description);
    if (b.listing_type !== undefined) set('listing_type = ?', b.listing_type);
    if (b.buy_price !== undefined)    set('buy_price = ?', b.buy_price);
    if (b.rent_price !== undefined)   set('rent_price = ?', b.rent_price);
    if (b.deposit !== undefined)      set('deposit = ?', b.deposit);
    if (b.emoji !== undefined)        set('emoji = ?', b.emoji);
    if (b.photos !== undefined)       set('photos = ?::jsonb', JSON.stringify(Array.isArray(b.photos) ? b.photos : []));
    if (b.attributes !== undefined)   set('attributes = attributes || ?::jsonb', JSON.stringify(b.attributes || {}));
    if (isStaff(req.user) && b.status !== undefined) set('status = ?', b.status);
    if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });

    params.push(String(req.params.id));
    const { rows: [asset] } = await db.query(
      `UPDATE assets SET ${fields.join(', ')}, updated_at = now() WHERE id::text = $${params.length} RETURNING *`, params);
    res.json(asset);
  } catch (err) { next(err); }
});

// PATCH /api/assets/:id/status — staff status / lifecycle change
router.patch('/:id/status', authenticate, requireRole('staff', 'admin'), async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: 'status required' });
    const publish = ['listed', 'published', 'available'].includes(status);
    const { rows: [asset] } = await db.query(
      `UPDATE assets SET status = $1, updated_at = now(),
              published_at = CASE WHEN $2 AND published_at IS NULL THEN now() ELSE published_at END
        WHERE id::text = $3 RETURNING *`,
      [status, publish, String(req.params.id)]);
    if (!asset) return res.status(404).json({ error: 'Not found' });
    res.json(asset);
  } catch (err) { next(err); }
});

// DELETE /api/assets/:id — its owner, or staff
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const { rows: [existing] } = await db.query(
      `SELECT owner_id, category_id FROM assets WHERE id::text = $1`, [String(req.params.id)]);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (await categoryKeyOf(existing.category_id) === 'footwear')
      return res.status(409).json({ error: 'Footwear listings are managed via the shoe flow during transition' });
    if (!isStaff(req.user) && existing.owner_id !== req.user.id)
      return res.status(403).json({ error: 'Not authorised' });
    await db.query(`DELETE FROM assets WHERE id::text = $1`, [String(req.params.id)]);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
