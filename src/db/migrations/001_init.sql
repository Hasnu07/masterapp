-- masterapp, phase 1: the watch inventory.
--
-- Three layers, and keeping them apart is the design:
--   ck_records / vault_records  exactly what Chrono Key and the vault said, as
--                               last read — never edited here
--   watches                     OUR record of each watch: what the app shows,
--                               what people edit
--   watch_events                every change to a watch, by whom, from what
--
-- So a misread field can always be re-derived from the raw copy, and an edit
-- made here is never silently undone by the next copy from Chrono Key (see
-- watches.locked_fields).

CREATE TABLE users (
  id            serial PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL DEFAULT '',
  role          text NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'editor', 'viewer')),
  password_hash text NOT NULL,
  disabled      boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE watches (
  id              serial PRIMARY KEY,
  -- One record per STOCK NUMBER, which is one purchase: the same physical
  -- watch bought back and sold again is two records, as in Chrono Key.
  -- ck_product_id is Chrono Key's id for the physical watch, shared by them.
  stock_no        text,
  ck_product_id   integer,
  title           text NOT NULL DEFAULT '',
  brand           text NOT NULL DEFAULT '',
  model           text NOT NULL DEFAULT '',
  reference       text NOT NULL DEFAULT '',
  serial          text NOT NULL DEFAULT '',
  watch_date      text NOT NULL DEFAULT '',   -- as written: "04/2026", "2025"
  condition       text NOT NULL DEFAULT '',
  dial            text NOT NULL DEFAULT '',
  case_material   text NOT NULL DEFAULT '',
  case_size       text NOT NULL DEFAULT '',
  bezel           text NOT NULL DEFAULT '',
  bracelet        text NOT NULL DEFAULT '',
  movement        text NOT NULL DEFAULT '',
  box             boolean,                    -- null = not stated
  papers          boolean,
  service_papers  boolean,
  accessories     text NOT NULL DEFAULT '',
  customisation   text NOT NULL DEFAULT '',
  location        text NOT NULL DEFAULT '',   -- Dubai, UK, Europe, HK …
  status          text NOT NULL DEFAULT 'in_stock'
                  CHECK (status IN ('incoming', 'in_stock', 'reserved', 'sold', 'returned', 'other')),
  inspected_by    text NOT NULL DEFAULT '',
  display_case    text NOT NULL DEFAULT '',
  pouch_number    text NOT NULL DEFAULT '',
  order_type      text NOT NULL DEFAULT '',   -- Chrono Key: INVENTORY, CONSIGNMENT …

  -- The PURCHASE, in the currency the deal was done in. Chrono Key's export
  -- heads this column "(£)" and it is not pounds: it is whatever the deal
  -- was in, which only its Description says ("aed 46,000 = usd 12,534").
  purchase_date     date,
  purchased_from    text NOT NULL DEFAULT '',
  purchase_price    numeric(14,2),
  purchase_currency text NOT NULL DEFAULT '',   -- '' = not stated, never assumed
  purchase_payments jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {cash, card, bank, crypto, paypal}
  purchase_price_eur numeric(14,2),             -- Chrono Key's own book figure, in euros
  description     text NOT NULL DEFAULT '',     -- the hand-typed note: what was really paid, and more

  accessories_cost   numeric(14,2),
  consignment_pct    numeric(6,2),
  consignment_price  numeric(14,2),
  consignment_cost   numeric(14,2),

  sale_date       date,
  sold_to         text NOT NULL DEFAULT '',
  sale_price      numeric(14,2),
  sale_currency   text NOT NULL DEFAULT '',
  sale_payments   jsonb NOT NULL DEFAULT '{}'::jsonb,
  sale_price_eur  numeric(14,2),

  retail_price    numeric(14,2),
  retail_currency text NOT NULL DEFAULT '',
  website_price   numeric(14,2),
  website_currency text NOT NULL DEFAULT '',
  b2b_price       numeric(14,2),
  b2b_currency    text NOT NULL DEFAULT '',
  b2c_price       numeric(14,2),
  b2c_currency    text NOT NULL DEFAULT '',

  notes           text NOT NULL DEFAULT '',     -- our own notes, made here
  extra           jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Where it came from.
  ck_id           integer,                      -- Chrono Key's purchase id (its detail page)
  vault_id        text,
  origin          text NOT NULL DEFAULT 'manual' CHECK (origin IN ('chronokey', 'vault', 'manual')),

  -- Fields somebody edited here. The copy from Chrono Key / the vault leaves
  -- these alone, so an edit is never undone by the next sync.
  locked_fields   text[] NOT NULL DEFAULT '{}',

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
-- A stock number is one watch. Deleted ones keep theirs, so a re-import
-- finds the deleted record rather than bringing the watch back as new.
CREATE UNIQUE INDEX watches_stock_no_unique ON watches(stock_no) WHERE stock_no IS NOT NULL AND stock_no <> '';
CREATE INDEX watches_product ON watches(ck_product_id);
CREATE INDEX watches_reference ON watches(lower(reference));
CREATE INDEX watches_status ON watches(status) WHERE deleted_at IS NULL;

CREATE TABLE watch_photos (
  id           serial PRIMARY KEY,
  watch_id     integer NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  storage_key  text NOT NULL,
  thumb_key    text,
  content_type text NOT NULL DEFAULT 'image/jpeg',
  bytes        integer NOT NULL DEFAULT 0,
  width        integer,
  height       integer,
  sort         integer NOT NULL DEFAULT 0,
  caption      text NOT NULL DEFAULT '',
  source       text NOT NULL DEFAULT 'upload' CHECK (source IN ('chronokey', 'vault', 'upload')),
  -- The path or url it was copied from, so a sync never copies it twice — and
  -- never brings back a photo somebody removed here (deleted_at is kept).
  source_ref   text,
  created_by   integer REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX watch_photos_watch ON watch_photos(watch_id, sort);
CREATE UNIQUE INDEX watch_photos_source ON watch_photos(watch_id, source, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE watch_events (
  id         bigserial PRIMARY KEY,
  watch_id   integer NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    integer REFERENCES users(id),
  source     text NOT NULL DEFAULT 'user',   -- user, chronokey, vault
  action     text NOT NULL,                  -- create, update, delete, restore, photo_add, photo_remove, photo_order, sync
  changes    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX watch_events_watch ON watch_events(watch_id, at DESC);

-- What Chrono Key said, as last read.
CREATE TABLE ck_records (
  stock_no    text PRIMARY KEY,
  ck_id       integer,         -- the purchase id its detail page is under
  ck_product_id integer,
  list_row    jsonb,           -- the product-list row (export or grid), by column heading
  list_at     timestamptz,
  detail      jsonb,           -- the parsed detail page
  html        bytea,           -- the detail page itself, gzipped, so a misread can be re-read
  detail_at   timestamptz,
  photos_at   timestamptz,
  error       text,
  watch_id    integer REFERENCES watches(id) ON DELETE SET NULL
);
CREATE INDEX ck_records_detail ON ck_records(detail_at NULLS FIRST);

-- What the vault said, as last read. One stock number can have several
-- records here (an incoming and, later, the sale of the same watch).
CREATE TABLE vault_records (
  vault_id    text PRIMARY KEY,
  list        text NOT NULL,
  stock_no    text,
  data        jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  watch_id    integer REFERENCES watches(id) ON DELETE SET NULL
);
CREATE INDEX vault_records_stock ON vault_records(stock_no);

CREATE TABLE import_runs (
  id          serial PRIMARY KEY,
  source      text NOT NULL,          -- chronokey, vault
  mode        text NOT NULL,          -- full, new
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean,
  stats       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error       text,
  started_by  integer REFERENCES users(id)
);
