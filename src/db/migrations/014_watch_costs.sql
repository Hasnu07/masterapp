-- Additional expenditures per watch (asked 4 Nov 2026: "an option where I can
-- add a watch's additional expenditures … manually … what we know from
-- logistics and accounting such as movement cost, commission; but sometimes we
-- sell and move in bulk and it gets confusing, so a manual entry per watch").
-- The costs the two apps hold stay in their copies and are only READ; these
-- rows are the ones typed here, one per watch, in the cost's own currency,
-- never converted — the ERP's own overview, never written to either app.
-- Removing one is soft; every add, change and removal is in the watch's
-- history (watch_events).
--
-- Additive only: one new table.

CREATE TABLE watch_costs (
  id         serial PRIMARY KEY,
  watch_id   integer NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  kind       text NOT NULL DEFAULT 'other',   -- shipping, customs, service, commission, insurance, travel, other
  title      text NOT NULL DEFAULT '',        -- what it was, in the person's words
  amount     numeric(14, 2) NOT NULL,
  currency   text NOT NULL,                   -- EUR, USD, GBP, AED, HKD, CHF, USDT
  paid_on    date,
  paid_by    text NOT NULL DEFAULT '',        -- cash, card, bank, crypto, paypal — or '' when not said
  note       text NOT NULL DEFAULT '',
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX watch_costs_watch ON watch_costs(watch_id, paid_on, id) WHERE deleted_at IS NULL;
