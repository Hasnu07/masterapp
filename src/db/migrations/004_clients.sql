-- Clients: the people and dealers watches are bought from and sold to.
--
-- The same three layers as the watches (001_init.sql):
--   ck_clients     exactly what Chrono Key's client list said, as last read
--   clients        OUR record — what the app shows and people edit
--   client_events  every change to a client, by whom
--
-- Chrono Key's product grid names both sides of every deal by the client's
-- id (clientId = bought from, soldToId = sold to), so a watch is linked to
-- its clients by id, never by matching names.

CREATE TABLE clients (
  id             serial PRIMARY KEY,
  ck_id          text UNIQUE,                 -- Chrono Key's id for the client (a GUID)
  forename       text NOT NULL DEFAULT '',
  surname        text NOT NULL DEFAULT '',
  nickname       text NOT NULL DEFAULT '',
  type           text NOT NULL DEFAULT '' CHECK (type IN ('', 'dealer', 'retail', 'retail_company')),
  company        text NOT NULL DEFAULT '',
  company_number text NOT NULL DEFAULT '',
  email          text NOT NULL DEFAULT '',
  phone          text NOT NULL DEFAULT '',
  address        text NOT NULL DEFAULT '',
  country        text NOT NULL DEFAULT '',
  notes          text NOT NULL DEFAULT '',     -- our own, made here
  active         boolean NOT NULL DEFAULT true,
  origin         text NOT NULL DEFAULT 'manual' CHECK (origin IN ('chronokey', 'manual')),
  -- Fields somebody edited here; the copy from Chrono Key leaves them alone.
  locked_fields  text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

CREATE TABLE ck_clients (
  ck_id      text PRIMARY KEY,
  data       jsonb NOT NULL,                  -- the client list's row, as Chrono Key wrote it
  fetched_at timestamptz NOT NULL DEFAULT now(),
  client_id  integer REFERENCES clients(id) ON DELETE SET NULL
);

CREATE TABLE client_events (
  id         bigserial PRIMARY KEY,
  client_id  integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    integer REFERENCES users(id),
  source     text NOT NULL DEFAULT 'user',     -- user, chronokey
  action     text NOT NULL,                    -- create, update, sync
  changes    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX client_events_client ON client_events(client_id, at DESC);

-- Both sides of a watch's deals. Set by the sync from the grid's ids; a link
-- changed here is locked like a field ('purchased_from_client' /
-- 'sold_to_client' in watches.locked_fields).
ALTER TABLE watches ADD COLUMN purchased_from_client_id integer REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE watches ADD COLUMN sold_to_client_id integer REFERENCES clients(id) ON DELETE SET NULL;
CREATE INDEX watches_purchased_from_client ON watches(purchased_from_client_id);
CREATE INDEX watches_sold_to_client ON watches(sold_to_client_id);
