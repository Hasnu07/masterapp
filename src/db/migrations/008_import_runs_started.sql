-- The runs, newest first: the Import page (its last 30, every 5 seconds while
-- one is going) and the 15-minute pass (when the daily re-read last went
-- through). import_runs gains ~6 rows a pass, ~210,000 a year, and both read
-- it whole without this: measured at a year's rows, 61 ms and 30 ms; with it,
-- 0.2 ms and 0.1 ms.
--
-- Additive only. Built inside the start-up migration's transaction (so not
-- CONCURRENTLY); on the table as it is now that takes milliseconds.
CREATE INDEX IF NOT EXISTS import_runs_started ON import_runs(started_at DESC);
