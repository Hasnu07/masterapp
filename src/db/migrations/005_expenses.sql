-- Expenses: what the business spends — salaries, shipping, rent, travel …
--
-- The same three layers as watches and clients:
--   ck_expenses     exactly what Chrono Key's expense list and each expense's
--                   own page said, as last read
--   expenses        OUR record — what the app shows and people edit
--   expense_events  every change, by whom
-- and the payment copies (receipts, transfer slips) in expense_files.
--
-- Money as Chrono Key's form holds it: the cost in the expense's OWN
-- currency, the exchange rate typed with it, and the figure Chrono Key books
-- (cost × rate) — labelled £ there and euros in practice, as on its watch
-- pages: AED 4,300 at 0.24 is "£1,032".

CREATE TABLE expenses (
  id                  serial PRIMARY KEY,
  ck_id               integer UNIQUE,          -- Chrono Key's expense id (/Stock/AddEditExpense/{id})
  expense_date        date,
  title               text NOT NULL DEFAULT '',
  type                text NOT NULL DEFAULT '', -- Chrono Key's expense type, by name: "SALARY", "Logistics Expense" …
  amount              numeric(14,2),            -- the cost, in `currency`
  currency            text NOT NULL DEFAULT '', -- '' = not stated, never assumed
  exchange_rate       numeric(20,10),           -- as typed on Chrono Key: `currency` → its booking currency
  cost_eur            numeric(14,2),            -- what Chrono Key books (amount × rate), in euros
  payment_method      text NOT NULL DEFAULT '' CHECK (payment_method IN ('', 'cash', 'card', 'bank', 'crypto', 'paypal')),
  description         text NOT NULL DEFAULT '',
  exclude_from_profit boolean NOT NULL DEFAULT false, -- Chrono Key's "Loan Book" switch
  origin              text NOT NULL DEFAULT 'manual' CHECK (origin IN ('chronokey', 'manual')),
  locked_fields       text[] NOT NULL DEFAULT '{}',
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE INDEX expenses_date ON expenses(expense_date DESC NULLS LAST) WHERE deleted_at IS NULL;

CREATE TABLE ck_expenses (
  ck_id      integer PRIMARY KEY,
  list_row   jsonb,                -- the expense list's row: title, type, description, cost, date
  list_at    timestamptz,
  detail     jsonb,                -- its own page, parsed: currency, rate, cost, payment type …
  detail_at  timestamptz,
  error      text,
  expense_id integer REFERENCES expenses(id) ON DELETE SET NULL
);

CREATE TABLE expense_events (
  id         bigserial PRIMARY KEY,
  expense_id integer NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    integer REFERENCES users(id),
  source     text NOT NULL DEFAULT 'user',     -- user, chronokey
  action     text NOT NULL,                    -- create, update, sync, delete, restore, file_add, file_remove
  changes    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX expense_events_expense ON expense_events(expense_id, at DESC);

-- Payment copies: a picture or a PDF, stored like the photos and served only
-- behind the sign-in (they carry account numbers).
CREATE TABLE expense_files (
  id           serial PRIMARY KEY,
  expense_id   integer NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  storage_key  text NOT NULL,
  thumb_key    text,
  content_type text NOT NULL,
  bytes        integer NOT NULL DEFAULT 0,
  name         text NOT NULL DEFAULT '',
  created_by   integer REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz
);
CREATE INDEX expense_files_expense ON expense_files(expense_id) WHERE deleted_at IS NULL;
