-- ============================================================
--  SOLEMART DATABASE SCHEMA
--  PostgreSQL 15+
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
--  USERS
-- ============================================================
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name    VARCHAR(100) NOT NULL,
  last_name     VARCHAR(100) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  phone         VARCHAR(30),
  role          VARCHAR(20) NOT NULL DEFAULT 'customer'
                CHECK (role IN ('customer','owner','staff','admin')),
  -- Delivery address (verified via postcode lookup)
  addr_line1    VARCHAR(200),
  addr_line2    VARCHAR(200),
  addr_city     VARCHAR(100),
  addr_county   VARCHAR(100),
  addr_postcode VARCHAR(20),
  -- Shoe size preference
  shoe_size     VARCHAR(10),
  -- Stripe customer ID for payments
  stripe_customer_id VARCHAR(100),
  email_verified     BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- ============================================================
--  OWNER BANK DETAILS  (encrypted at rest via pgcrypto)
-- ============================================================
CREATE TABLE owner_bank_details (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_name  TEXT NOT NULL,
  -- Stored encrypted — decrypt only for payout processing
  sort_code_enc TEXT NOT NULL,
  account_num_enc TEXT NOT NULL,
  verified      BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
--  SHOES
-- ============================================================
CREATE TABLE shoes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES users(id),
  -- Core details
  brand         VARCHAR(100) NOT NULL,
  model         VARCHAR(200) NOT NULL,
  size          VARCHAR(10)  NOT NULL,
  colour        VARCHAR(100),
  category      VARCHAR(50),
  gender        VARCHAR(20) CHECK (gender IN ('Unisex','Men''s','Women''s','Kids''')),
  description   TEXT,
  emoji         VARCHAR(10) DEFAULT '👟',
  -- Listing configuration
  listing_type  VARCHAR(10) NOT NULL DEFAULT 'both'
                CHECK (listing_type IN ('rent','buy','both')),
  rent_price    NUMERIC(10,2),
  buy_price     NUMERIC(10,2),
  -- Condition & status
  condition     VARCHAR(30) CHECK (condition IN ('Brand New','Like New','Very Good','Good','Fair')),
  status        VARCHAR(20) NOT NULL DEFAULT 'submitted'
                CHECK (status IN (
                  'submitted',    -- owner submitted, awaiting collection
                  'in_transit',   -- collected, on way to studio
                  'authenticating',
                  'cleaning',
                  'listed',       -- live on platform
                  'rented',       -- currently out on rental
                  'sold',
                  'rejected',
                  'returned_to_owner'
                )),
  -- Authentication
  auth_score    SMALLINT CHECK (auth_score BETWEEN 0 AND 100),
  auth_grade    VARCHAR(5) CHECK (auth_grade IN ('A+','A','B+','B','C','D')),
  auth_notes    TEXT,
  auth_by       UUID REFERENCES users(id),  -- staff member
  auth_at       TIMESTAMPTZ,
  -- Cleaning
  clean_method  VARCHAR(100),
  clean_notes   TEXT,
  clean_by      UUID REFERENCES users(id),
  clean_at      TIMESTAMPTZ,
  -- Rejection
  rejection_reason TEXT,
  rejected_at   TIMESTAMPTZ,
  rejected_by   UUID REFERENCES users(id),
  -- Lifecycle counters
  rental_count  INTEGER DEFAULT 0,
  clean_count   INTEGER DEFAULT 0,
  listing_count INTEGER DEFAULT 0,
  -- Timestamps
  submitted_at  TIMESTAMPTZ DEFAULT NOW(),
  listed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shoes_status    ON shoes(status);
CREATE INDEX idx_shoes_owner     ON shoes(owner_id);
CREATE INDEX idx_shoes_listing   ON shoes(listing_type, status);

-- ============================================================
--  SHOE PHOTOS
-- ============================================================
CREATE TABLE shoe_photos (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shoe_id   UUID NOT NULL REFERENCES shoes(id) ON DELETE CASCADE,
  url       TEXT NOT NULL,       -- S3 / Cloudflare R2 URL
  caption   VARCHAR(200),
  sort_order SMALLINT DEFAULT 0,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
--  LISTING SUBMISSIONS
--  One submission can contain multiple shoes (multi-shoe wizard)
-- ============================================================
CREATE TABLE listing_submissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       VARCHAR(30) UNIQUE NOT NULL, -- e.g. LST-ABC-1234
  owner_id        UUID NOT NULL REFERENCES users(id),
  status          VARCHAR(20) DEFAULT 'pending'
                  CHECK (status IN ('pending','collected','processing','complete','cancelled')),
  -- Collection address (may differ from profile)
  collection_line1    VARCHAR(200),
  collection_line2    VARCHAR(200),
  collection_city     VARCHAR(100),
  collection_county   VARCHAR(100),
  collection_postcode VARCHAR(20),
  -- Delivery fee
  collection_fee  NUMERIC(10,2) DEFAULT 3.99,
  fee_deducted    BOOLEAN DEFAULT FALSE,
  -- Label
  label_url       TEXT,
  -- Referral source
  referral_source VARCHAR(100),
  referral_other  VARCHAR(200),
  -- Timestamps
  submitted_at    TIMESTAMPTZ DEFAULT NOW(),
  collected_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

-- Many shoes per submission
CREATE TABLE submission_shoes (
  submission_id UUID NOT NULL REFERENCES listing_submissions(id) ON DELETE CASCADE,
  shoe_id       UUID NOT NULL REFERENCES shoes(id) ON DELETE CASCADE,
  PRIMARY KEY (submission_id, shoe_id)
);

-- ============================================================
--  ORDERS  (rentals + purchases)
-- ============================================================
CREATE TABLE orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       VARCHAR(30) UNIQUE NOT NULL, -- e.g. ORD-ABC-1234
  customer_id     UUID NOT NULL REFERENCES users(id),
  shoe_id         UUID NOT NULL REFERENCES shoes(id),
  order_type      VARCHAR(10) NOT NULL CHECK (order_type IN ('rent','buy')),
  status          VARCHAR(30) NOT NULL DEFAULT 'confirmed'
                  CHECK (status IN (
                    'confirmed',
                    'cleaning',       -- pre-dispatch clean
                    'dispatched',
                    'delivered',
                    'active_rental',  -- rental period live
                    'return_initiated',
                    'returned',
                    'completed',
                    'cancelled',
                    'refunded'
                  )),
  -- Pricing snapshot at time of order
  unit_price      NUMERIC(10,2) NOT NULL,  -- rent: per day / buy: total
  rental_days     SMALLINT,                -- NULL for purchases
  subtotal        NUMERIC(10,2) NOT NULL,
  platform_fee    NUMERIC(10,2) NOT NULL,  -- 15%
  total           NUMERIC(10,2) NOT NULL,
  -- Delivery address snapshot
  delivery_line1    VARCHAR(200),
  delivery_line2    VARCHAR(200),
  delivery_city     VARCHAR(100),
  delivery_county   VARCHAR(100),
  delivery_postcode VARCHAR(20),
  -- Shipping
  tracking_number VARCHAR(100),
  return_label_url TEXT,
  -- Stripe
  stripe_payment_intent_id VARCHAR(200),
  paid_at          TIMESTAMPTZ,
  -- Rental dates
  rental_start_date DATE,
  rental_end_date   DATE,
  returned_at       TIMESTAMPTZ,
  -- Timestamps
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_shoe     ON orders(shoe_id);
CREATE INDEX idx_orders_status   ON orders(status);

-- ============================================================
--  OWNER PAYOUTS
-- ============================================================
CREATE TABLE payouts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      UUID NOT NULL REFERENCES users(id),
  order_id      UUID REFERENCES orders(id),
  amount        NUMERIC(10,2) NOT NULL,   -- 85% of transaction
  status        VARCHAR(20) DEFAULT 'pending'
                CHECK (status IN ('pending','processing','paid','failed')),
  payout_type   VARCHAR(20) CHECK (payout_type IN ('rental','sale','refund_deduction')),
  bank_ref      VARCHAR(200),  -- bank transfer reference
  processed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
--  CLEAN BOOKINGS  (public service — any shoes)
-- ============================================================
CREATE TABLE clean_bookings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       VARCHAR(30) UNIQUE NOT NULL, -- e.g. CLN-ABC-1234
  customer_id     UUID REFERENCES users(id),   -- NULL if not logged in
  -- Contact (captured on form in case not logged in)
  contact_name    VARCHAR(200) NOT NULL,
  contact_email   VARCHAR(255) NOT NULL,
  contact_phone   VARCHAR(30),
  -- Shoe details
  shoe_description TEXT NOT NULL,
  pair_count      SMALLINT NOT NULL DEFAULT 1,
  -- Service
  service_type    VARCHAR(30) NOT NULL
                  CHECK (service_type IN ('express','deep','restoration')),
  service_name    VARCHAR(100) NOT NULL,
  price_per_pair  NUMERIC(10,2) NOT NULL,
  total_price     NUMERIC(10,2) NOT NULL,
  -- Collection
  preferred_date  DATE,
  -- Return address
  return_line1    VARCHAR(200) NOT NULL,
  return_line2    VARCHAR(200),
  return_city     VARCHAR(100) NOT NULL,
  return_county   VARCHAR(100),
  return_postcode VARCHAR(20) NOT NULL,
  -- Label & status
  label_url       TEXT,
  status          VARCHAR(20) DEFAULT 'booked'
                  CHECK (status IN ('booked','collected','in_progress','complete','returned','cancelled')),
  notes           TEXT,
  -- Stripe
  stripe_payment_intent_id VARCHAR(200),
  paid_at         TIMESTAMPTZ,
  -- Timestamps
  booked_at       TIMESTAMPTZ DEFAULT NOW(),
  collected_at    TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  returned_at     TIMESTAMPTZ
);

CREATE INDEX idx_cleans_customer ON clean_bookings(customer_id);
CREATE INDEX idx_cleans_status   ON clean_bookings(status);

-- ============================================================
--  REVIEWS
-- ============================================================
CREATE TABLE reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id),
  shoe_id     UUID NOT NULL REFERENCES shoes(id),
  customer_id UUID NOT NULL REFERENCES users(id),
  stars       SMALLINT NOT NULL CHECK (stars BETWEEN 1 AND 5),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (order_id)  -- one review per order
);

CREATE INDEX idx_reviews_shoe ON reviews(shoe_id);

-- ============================================================
--  ACTIVITY LOG  (admin audit trail)
-- ============================================================
CREATE TABLE activity_log (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID REFERENCES users(id),
  action      VARCHAR(100) NOT NULL,  -- e.g. 'shoe.listed', 'order.dispatched'
  entity_type VARCHAR(50),            -- 'shoe', 'order', 'user', etc.
  entity_id   UUID,
  meta        JSONB,                  -- any extra context
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_activity_entity ON activity_log(entity_type, entity_id);
CREATE INDEX idx_activity_actor  ON activity_log(actor_id);

-- ============================================================
--  REFRESH TOKENS  (for JWT rotation)
-- ============================================================
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tokens_user ON refresh_tokens(user_id);

-- ============================================================
--  UPDATED_AT TRIGGER (auto-updates updated_at columns)
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_shoes_updated_at
  BEFORE UPDATE ON shoes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_orders_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================================
--  CHANNEL LISTINGS  (cross-platform: eBay, Vinted, Depop)
-- ============================================================
CREATE TABLE channel_listings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shoe_id         UUID NOT NULL REFERENCES shoes(id) ON DELETE CASCADE,
  platform        VARCHAR(20) NOT NULL CHECK (platform IN ('ebay','vinted','depop')),
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN (
                    'pending',      -- owner opted in, awaiting staff action
                    'listed',       -- live on the platform
                    'sold',         -- sold on this platform
                    'delisted',     -- removed from this platform
                    'failed'        -- listing attempt failed
                  )),
  -- Platform-specific details (filled by staff)
  platform_listing_id   VARCHAR(200),  -- eBay item ID, Vinted ID etc.
  platform_listing_url  TEXT,          -- direct link to the listing
  platform_price        NUMERIC(10,2), -- price set on that platform
  -- Fee structure: 20% for external platform sales
  platform_fee_pct      NUMERIC(5,2) DEFAULT 20.00,
  -- Notes from staff
  notes           TEXT,
  -- Timestamps
  opted_in_at     TIMESTAMPTZ DEFAULT NOW(),
  listed_at       TIMESTAMPTZ,
  sold_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (shoe_id, platform)
);

CREATE INDEX idx_channel_shoe    ON channel_listings(shoe_id);
CREATE INDEX idx_channel_status  ON channel_listings(platform, status);

-- ============================================================
--  CHARITY DONATIONS
-- ============================================================
CREATE TABLE donations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference       VARCHAR(30) UNIQUE NOT NULL, -- e.g. DON-ABC-1234
  -- Donor details (no account required)
  donor_user_id   UUID REFERENCES users(id),   -- NULL if guest
  donor_name      VARCHAR(200) NOT NULL,
  donor_email     VARCHAR(255) NOT NULL,
  donor_phone     VARCHAR(30),
  -- Shoes
  shoe_description TEXT NOT NULL,
  pair_count      SMALLINT NOT NULL DEFAULT 1,
  notes           TEXT,
  -- Collection address
  collection_line1    VARCHAR(200) NOT NULL,
  collection_line2    VARCHAR(200),
  collection_city     VARCHAR(100),
  collection_county   VARCHAR(100),
  collection_postcode VARCHAR(20) NOT NULL,
  -- Charity
  charity_name    VARCHAR(200) DEFAULT 'Soles4Souls UK',
  charity_number  VARCHAR(50)  DEFAULT '1157346',
  -- Status
  status          VARCHAR(20) DEFAULT 'pending'
                  CHECK (status IN (
                    'pending',      -- submitted, awaiting collection
                    'collected',    -- picked up from donor
                    'processing',   -- being authenticated & cleaned
                    'listed',       -- live on platform
                    'profit_transferred', -- profits sent to charity
                    'cancelled'
                  )),
  -- Financials
  collection_fee  NUMERIC(10,2) DEFAULT 3.99,
  total_revenue   NUMERIC(10,2) DEFAULT 0,  -- accumulated from rentals/sales
  label_url       TEXT,
  -- Timestamps
  submitted_at    TIMESTAMPTZ DEFAULT NOW(),
  collected_at    TIMESTAMPTZ,
  listed_at       TIMESTAMPTZ,
  transferred_at  TIMESTAMPTZ
);

CREATE INDEX idx_donations_email  ON donations(donor_email);
CREATE INDEX idx_donations_status ON donations(status);

-- Link donated shoes to the donation record
ALTER TABLE shoes ADD COLUMN IF NOT EXISTS donation_id UUID REFERENCES donations(id);
CREATE INDEX IF NOT EXISTS idx_shoes_donation ON shoes(donation_id);
