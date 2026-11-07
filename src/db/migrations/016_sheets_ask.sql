-- Sheets and Ask (asked 7 Nov 2026).
--
-- sheets       a spreadsheet built from the system — logistics, accounting,
--              a client's situation, the stock's situation — then edited by
--              hand: its columns and rows kept as one document. A cell edited
--              here changes the system only when the person says so, through
--              the same API as any edit (so it is locked and logged there).
-- ask_threads  conversations with the assistant: what was asked, every step
--              it took (the SQL it ran), what it answered.
-- ask_files    the CSVs and PDFs it made, kept a while for download.
-- people       users without their password hashes: the only way the
--              assistant's read-only SQL may name who changed what.
--
-- Additive only: nothing existing is touched.

CREATE TABLE sheets (
  id          serial PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('logistics', 'accounting', 'client', 'stock', 'blank')),
  title       text NOT NULL DEFAULT '',
  subject     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- what it was built for: stock numbers, a client, a status …
  doc         jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { columns: [...], rows: [...], note }
  version     integer NOT NULL DEFAULT 1,           -- a save names the version it edited: two people never overwrite each other unseen
  built_at    timestamptz,                          -- when its rows were last read from the system
  created_by  integer REFERENCES users(id),
  updated_by  integer REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX sheets_recent ON sheets(updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE ask_threads (
  id          serial PRIMARY KEY,
  user_id     integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       text NOT NULL DEFAULT '',
  messages    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- the conversation as the API holds it (tool calls and results included)
  steps       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- what it did, for the page: [{at, tool, summary, error}]
  status      text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'error')),
  error       text,
  usage       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ask_threads_user ON ask_threads(user_id, updated_at DESC);

CREATE TABLE ask_files (
  id          text PRIMARY KEY,                     -- random, unguessable
  thread_id   integer REFERENCES ask_threads(id) ON DELETE CASCADE,
  user_id     integer REFERENCES users(id) ON DELETE CASCADE,
  name        text NOT NULL,
  type        text NOT NULL,
  bytes       bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ask_files_thread ON ask_files(thread_id);

CREATE VIEW people AS SELECT id, name, email, role, disabled, created_at, last_login_at FROM users;
