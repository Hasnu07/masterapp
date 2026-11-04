-- Accounts: everything the Purosangue Watches Accounts app keeps — the
-- payable and receivable ledger (every purchase and sale leg with its
-- payments), its clients, invoices, quick sales, expenses, wallets, currencies
-- and rates, the exchange desk, schedules, employees and their commission,
-- the partner desks — so the ERP can become the one app, as it is becoming for
-- the watches and logistics (asked 4 Nov 2026: "add accountancy app to the ERP
-- same way as how we did logistic … keep the sync on for the accountancy app
-- until things get straight").
--
-- The accounts app keeps all of it as one JSON document per collection in its
-- own MySQL (app_state), read whole through its API. Its records come in some
-- thirty shapes that keep changing, so they are kept as documents here, one row
-- per record — the same three layers as watches, clients, expenses and
-- logistics:
--
--   accounts_records  exactly what the accounts app said, as last read — never
--                     edited (a picture written inline into a record is swapped
--                     for a reference to accounts_files)
--   accounts_items    OUR record: what the ERP shows and people edit. A field
--                     edited here is locked against the sync
--   accounts_events   every change, by whom
--
-- accounts_files, the pictures and documents those records carry inline, stored
-- once each (by their bytes); and accounts_client_links, which of OUR clients
-- an accounts client is when a PERSON decided it (the worked-out match — by the
-- stock numbers on its ledger, else its full name — is not stored).
--
-- Until the switch-over the accounts app is the master for its records, as
-- Chrono Key is for watches. Nothing is ever written back to it.
--
-- Additive only: five new tables, nothing existing is touched.

CREATE TABLE accounts_items (
  id             serial PRIMARY KEY,
  kind           text NOT NULL,                -- the app's collection: entries, clients, invoices, quickSales, expenses …
  source_id      text,                         -- the record's id there (a client's code CL-001, an entry's uid); NULL for one added here
  data           jsonb NOT NULL DEFAULT '{}'::jsonb,
  stock_nos      text[] NOT NULL DEFAULT '{}', -- every stock number it names, as written (trimmed)
  client_ids     text[] NOT NULL DEFAULT '{}', -- every accounts client it names (clientId …)
  origin         text NOT NULL DEFAULT 'manual' CHECK (origin IN ('accounts', 'manual')),
  locked_fields  text[] NOT NULL DEFAULT '{}', -- top-level keys of data edited here
  happened_at    timestamptz,                  -- the record's own date (an entry's date, a sale's day …), for "newest first"
  created_by     integer REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  source_gone_at timestamptz,
  UNIQUE (kind, source_id)
);
CREATE INDEX accounts_items_kind ON accounts_items(kind, happened_at DESC NULLS LAST) WHERE deleted_at IS NULL;
CREATE INDEX accounts_items_stock ON accounts_items USING gin(stock_nos);
CREATE INDEX accounts_items_client ON accounts_items USING gin(client_ids);

CREATE TABLE accounts_records (
  kind       text NOT NULL,
  source_id  text NOT NULL,
  data       jsonb NOT NULL,
  hash       text NOT NULL,              -- of the record as read: an unchanged record is skipped, not rewritten
  fetched_at timestamptz NOT NULL DEFAULT now(),
  gone_at    timestamptz,
  item_id    integer REFERENCES accounts_items(id) ON DELETE SET NULL,
  PRIMARY KEY (kind, source_id)
);

CREATE TABLE accounts_events (
  id      bigserial PRIMARY KEY,
  item_id integer NOT NULL REFERENCES accounts_items(id) ON DELETE CASCADE,
  at      timestamptz NOT NULL DEFAULT now(),
  user_id integer REFERENCES users(id),
  source  text NOT NULL DEFAULT 'user',  -- user, accounts
  action  text NOT NULL,                 -- create, update, sync, delete, restore, unlock
  changes jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX accounts_events_item ON accounts_events(item_id, at DESC);
CREATE INDEX accounts_events_at ON accounts_events(at DESC);

-- A picture or a PDF written inline into an accounts record (older entries carry
-- their invoice or proof as base64), copied here once. Served only behind the
-- sign-in: invoices, passports and bank details are in them. The app's newer
-- files live under its own /uploads/ and are shown through the ERP as they are.
CREATE TABLE accounts_files (
  id           serial PRIMARY KEY,
  sha256       text NOT NULL UNIQUE,
  storage_key  text NOT NULL,
  thumb_key    text,
  content_type text NOT NULL,
  bytes        integer NOT NULL DEFAULT 0,
  source_ref   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Which of OUR clients an accounts client is, when a person decided it
-- (client_id NULL: "none of ours"). A person's decision always wins over the
-- worked-out match (src/accounts/clients.js) and is never changed by a sync.
CREATE TABLE accounts_client_links (
  item_id    integer PRIMARY KEY REFERENCES accounts_items(id) ON DELETE CASCADE,  -- kind 'clients'
  client_id  integer REFERENCES clients(id),
  user_id    integer REFERENCES users(id),
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX accounts_client_links_client ON accounts_client_links (client_id);
