-- Documents per watch (on the "not done" list since 22 Oct 2026; done 4 Nov
-- 2026): the invoice, the papers, a customs form, a receipt — a PDF or a
-- picture, kept with the watch and shown on its page and in its Timeline.
-- Stored like an expense's payment copies (saveDocument: a PDF as it is, a
-- picture with its 480px thumbnail), served only behind the sign-in, because
-- serials, prices and passports are in them. Removing one is soft.
--
-- Additive only: one new table.

CREATE TABLE watch_documents (
  id           serial PRIMARY KEY,
  watch_id     integer NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  storage_key  text NOT NULL,
  thumb_key    text,
  content_type text NOT NULL,
  bytes        integer NOT NULL DEFAULT 0,
  name         text NOT NULL DEFAULT '',   -- the file's name as uploaded
  kind         text NOT NULL DEFAULT '',   -- invoice, papers, customs, receipt, other — or '' when not said
  created_by   integer REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX watch_documents_watch ON watch_documents(watch_id, created_at) WHERE deleted_at IS NULL;
