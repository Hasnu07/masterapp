-- Logistics: everything the Purosangue Watches Logistics app keeps — shipments,
-- incomings, the stock in each place, trips, movers and customs, sales waiting
-- for delivery, accessories, polish, costs — so masterapp can become the one
-- app ("we all will switch to the masterapp as whole", 23 Oct 2026).
--
-- The logistics app keeps all of it in ONE JSON document on its Cloudflare
-- worker (puro-sync): the document the Watch vault sync already reads for its
-- five stock lists. Its records come in about thirty-five shapes that keep
-- changing, so they are kept as documents, one row per record, not a table per
-- shape. The same three layers as watches, clients and expenses:
--
--   logistics_records  exactly what the logistics app said, as last read —
--                      never edited (its inline pictures are swapped for
--                      references to logistics_files: they are 90% of the
--                      document's bytes)
--   logistics_items    OUR record: what masterapp shows and people edit. A
--                      field edited here is locked against the sync
--   logistics_events   every change, by whom
--
-- and logistics_files, the pictures and documents those records carry, stored
-- once each (by their bytes).
--
-- Until the switch-over the logistics app is the master for its records, as
-- Chrono Key is for watches. Nothing is ever written back to it.
--
-- Additive only: four new tables, nothing existing is touched.

CREATE TABLE logistics_items (
  id             serial PRIMARY KEY,
  kind           text NOT NULL,                -- the logistics app's list: shipments, incomings, londonStock …
  source_id      text,                         -- the record's id there; NULL for one added here
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  stock_nos      text[] NOT NULL DEFAULT '{}', -- every stock number it names, as written (trimmed)
  origin         text NOT NULL DEFAULT 'manual' CHECK (origin IN ('logistics', 'manual')),
  locked_fields  text[] NOT NULL DEFAULT '{}', -- top-level keys of data edited here
  happened_at    timestamptz,                  -- the record's own date (shipped, sold, received …), for "newest first"
  created_by     integer REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  source_gone_at timestamptz,
  UNIQUE (kind, source_id)
);
CREATE INDEX logistics_items_kind ON logistics_items(kind, happened_at DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE INDEX logistics_items_stock ON logistics_items USING gin(stock_nos);

CREATE TABLE logistics_records (
  kind       text NOT NULL,
  source_id  text NOT NULL,
  data       jsonb NOT NULL,
  hash       text NOT NULL,              -- of the record as read: an unchanged record is skipped, not rewritten
  fetched_at timestamptz NOT NULL DEFAULT now(),
  gone_at    timestamptz,
  item_id    integer REFERENCES logistics_items(id) ON DELETE SET NULL,
  PRIMARY KEY (kind, source_id)
);

CREATE TABLE logistics_events (
  id      bigserial PRIMARY KEY,
  item_id integer NOT NULL REFERENCES logistics_items(id) ON DELETE CASCADE,
  at      timestamptz NOT NULL DEFAULT now(),
  user_id integer REFERENCES users(id),
  source  text NOT NULL DEFAULT 'user',  -- user, logistics
  action  text NOT NULL,                 -- create, update, sync, delete, restore, unlock
  changes jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX logistics_events_item ON logistics_events(item_id, at DESC);
CREATE INDEX logistics_events_at ON logistics_events(at DESC);

-- A picture or a PDF out of a logistics record — inline in the document, or on
-- the worker's /photos/ — copied here, because the worker goes when the
-- logistics app does. Served only behind the sign-in: customs papers, passports
-- and serials are in them.
CREATE TABLE logistics_files (
  id           serial PRIMARY KEY,
  sha256       text NOT NULL UNIQUE,
  storage_key  text NOT NULL,
  thumb_key    text,
  content_type text NOT NULL,
  bytes        integer NOT NULL DEFAULT 0,
  source_ref   text,                     -- the address it was copied from, when it had one
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX logistics_files_ref ON logistics_files(source_ref) WHERE source_ref IS NOT NULL;
