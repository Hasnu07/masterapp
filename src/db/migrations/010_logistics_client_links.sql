-- Which of OUR clients a logistics client is (asked 24 Oct 2026: "make a separate
-- tab of clients in logistics … linked with the master client tab").
--
-- The logistics app's clients are mostly typed names, with no Chrono Key id. So
-- masterapp works the link out from the data itself, every time it is shown
-- (src/logistics/clients.js): the watches the logistics app says were bought
-- from or sold to that client, against who OUR watches with those stock numbers
-- were bought from and sold to (Chrono Key's own ids). A name decides only when
-- no watch does, and only a full name that is one client of ours.
--
-- This table keeps only what a PERSON decided: "this logistics client is our
-- client N", or (client_id NULL) "none of ours". A person's decision always wins
-- over the worked-out match, and is never changed by a sync. Kept outside the
-- record's data, which the sync rewrites.
--
-- Additive only: one new table.

CREATE TABLE logistics_client_links (
  item_id    integer PRIMARY KEY REFERENCES logistics_items(id) ON DELETE CASCADE,  -- kind 'clients'
  client_id  integer REFERENCES clients(id),                                        -- NULL: none of ours
  user_id    integer REFERENCES users(id),
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX logistics_client_links_client ON logistics_client_links (client_id);
