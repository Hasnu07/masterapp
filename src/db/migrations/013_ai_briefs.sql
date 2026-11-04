-- The briefs Claude drew (asked 4 Nov 2026: "this loads way too slow"): one
-- per watch, kept with the fingerprint of the picture it was drawn from, so a
-- watch whose data has not changed opens its brief at once — across restarts
-- and deploys — and the model is asked only when something about the watch
-- moved. Nothing here is the truth about a watch: it is the model's reading,
-- redrawn when the data changes, deletable without loss.
--
-- Additive only: one new table.

CREATE TABLE ai_briefs (
  watch_id  integer PRIMARY KEY REFERENCES watches(id) ON DELETE CASCADE,
  hash      text NOT NULL,                   -- of the picture, without its read times
  brief     jsonb NOT NULL,
  model     text NOT NULL DEFAULT '',
  at        timestamptz NOT NULL DEFAULT now()
);
