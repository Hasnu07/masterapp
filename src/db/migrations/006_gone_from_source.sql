-- Mirroring what the sources DROP, until the switch-over (src/import/gone.js).
--
-- `gone_at` on a raw record: the source no longer lists it (cleared if it
-- comes back). `source_gone_at` on our record: when the sync acted on that —
-- deleting it softly, with deleted_at set to the same moment, so the sync can
-- tell its own deletion from a person's, and undo only its own when the
-- record reappears. A person who restores it keeps it: source_gone_at stays
-- set, and the sync never deletes it a second time.

ALTER TABLE ck_records    ADD COLUMN gone_at timestamptz;
ALTER TABLE vault_records ADD COLUMN gone_at timestamptz;
ALTER TABLE ck_clients    ADD COLUMN gone_at timestamptz;
ALTER TABLE ck_expenses   ADD COLUMN gone_at timestamptz;

ALTER TABLE watches  ADD COLUMN source_gone_at timestamptz;
ALTER TABLE clients  ADD COLUMN source_gone_at timestamptz;
ALTER TABLE expenses ADD COLUMN source_gone_at timestamptz;
