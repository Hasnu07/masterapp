# masterapp — working notes

The start of an **ERP for Purosangue / Kashi**. Phase 1 is the **watch
inventory**: our own copy of every watch in Chrono Key (the "FOB" app at
`fobcheck.azurewebsites.net`) and the Watch vault, editable here — fields,
photos, everything — with a history of who changed what.

Sister repo: **InvoiceWEB** (`Hasnu07/invoiceweb`) — the WhatsApp bot and
console. Its `CLAUDE.md` is the long record of how Chrono Key and the vault
actually behave; the Chrono Key client and parsers here are ported from it.

**Who is who.** Jhonny owns both businesses. Hasnain runs the tools and asked
for this. Kashan is a colleague who decided much of InvoiceWEB.

---

## Shape

```
src/
  config.js                 every setting, from the environment
  db/                       Postgres pool, migrations (run at start-up)
  auth/                     accounts, roles, sessions; `npm run user`
  storage/                  photos: Cloudflare R2, or disk under DATA_DIR
  watches/fields.js         THE list of a watch's fields (API, import, form)
  watches/index.js          read / create / edit / delete / photos / history
  import/productlist.js     Chrono Key's product list (CSV export or live grid) → fields
  import/apply.js           writing a source's values into a watch, respecting edits
  import/listimport.js      the list → ck_records + watches
  import/chronokey/         client (ported), page parsers, sync
  import/vault/sync.js      the Watch vault → watches
  import/jobs.js            the timer, and the one-job-at-a-time lock
  web/server.js             the API
  web/public/               the console — no build step, served raw
test/                       node:test against stand-ins and a real Postgres
```

Node 20+, Express 5, Postgres, `sharp` for thumbnails. Deployed like
InvoiceWEB: Railway, push to deploy.

## Three layers of data, kept apart

- `ck_records` / `vault_records` — exactly what Chrono Key and the vault said,
  as last read. Never edited here. The detail page's HTML is kept gzipped, so
  a field read wrongly can be re-read without asking Chrono Key again.
- `watches` — **our** record. What the console shows and people edit.
- `watch_events` — every change, by whom (a user, `chronokey`, `vault`), with
  old → new values.

**One watch record = one STOCK NUMBER = one purchase.** The same physical
watch bought back and sold again is two records, exactly as in Chrono Key;
`ck_product_id` (Chrono Key's "Product ID") links them, and the watch page
lists "the same watch, other purchases". Stock numbers are unique.

## Chrono Key is the master until the switch-over

Asked for (22 Oct 2026): copy Chrono Key into masterapp and keep copying until
we switch over. So the sync **overwrites** our fields with Chrono Key's — with
one rule that matters more: **a field edited here is locked**
(`watches.locked_fields`) and the sync never touches it again. The watch page
marks it "✎ edited here · use Chrono Key's" (unlock). On a record added here
(`origin = manual`) nothing is locked — there is nothing to sync over it.

- Deleting is soft. A watch deleted here stays deleted even though Chrono Key
  still lists it; restore brings it back.
- A photo removed here keeps its row (`deleted_at`), which is what stops the
  sync copying it back.
- `SYNC=off` is the switch-over: nothing is copied any more.

Source strengths (`apply.js`): **own** replaces (Chrono Key's product list for
purchase and sale; Chrono Key's euro figures; the vault's B2B/B2C), **fill**
only fills a blank (the detail page's spec; the vault's spec, place and
status). A currency is never CLEARED by a source that simply does not state
one.

## Chrono Key's product list — read it right

Checked against the real export (`ProductList_3.csv`, 1,664 rows, 22 Oct 2026):

- **`Purchase Price (£)` is not pounds.** It is the figure in the deal's own
  currency: stock 1668 reads 46000 and was AED 46,000; 1692 reads 111500 and
  was USD 111,500; 1325 reads 78000 and was £78,000. The currency is only in
  the hand-typed **Description** ("aed 46,000 = usd 12,534 as of …"), and
  `currencyFromNote` takes it from there **only when the note names that same
  amount**. Otherwise it is left blank and shown as "currency not stated" —
  about 860 older purchases with no description. Never assume one.
- The detail page's prices **are** euros (labelled £ — see InvoiceWEB's notes),
  stored as `purchase_price_eur` / `sale_price_eur`. When the list figure
  equals the euro figure, the deal was in euros and a blank currency becomes
  EUR. Retail and website prices on the list are Chrono Key's euro figures.
- **The sale currency is not on the list at all.** Left blank.
- The payment split (Cash, Card, Bank Transfer, Crypto, PayPal / Chrono24)
  appears **twice under identical headings** — purchase, then sale. Which is
  which is decided by position relative to "Sold To".
- **Category is the location**: `Watch` = Europe, `Jewellery` = HK.
- Watch Month + Watch Year → `watch_date` "MM/YYYY".
- Dates are day first (`21/04/2023`); a date that does not exist is refused.
- Stock 238 appears four times (a sale recorded twice). The latest sale wins;
  the other rows are kept in `ck_records.list_row._repeated`.
- Columns are matched **by heading**, never position. The live grid
  (`/Stock/ProductsDataTable`) goes through the same reader; it may answer in
  objects keyed by field name rather than arrays, and both are read. Which
  shape the live grid uses has **not been seen yet** — first live run will
  tell (`npm run import -- list`).

## Photos

Copied, never linked: Chrono Key's photos sit behind its login, and the
vault's behind its worker. Stored once (original untouched) plus a 480px JPEG
thumbnail; served only through `/api/photos/:id`, behind the sign-in, because
papers and serials are in them. Keys are generated server-side and checked
against a strict pattern before touching disk. R2 when `R2_*` is set (private
bucket), else `DATA_DIR` (Railway volume).

Only paths on Chrono Key's own host are fetched (a `data:` placeholder or an
off-host url out of a scraped page is refused); the vault's key goes only to
the worker's own origin.

## Being polite to Chrono Key

Somebody else's server, and the real inventory. Read-only; two pages at a
time with a pause; one job at a time across processes (Postgres advisory
lock). First full read of every watch page ≈ 1,700 pages → a couple of hours,
resumable. After that the 15-minute pass reads the list (one request) and only
NEW watch pages; once a day it re-reads unsold and recently sold watches. A
failed sign-in stops the run rather than failing 1,700 times.

An EMPTY answer is never trusted as "nothing there" — the ported client checks
the session first (InvoiceWEB lost hours to a dead session reading as an empty
inventory).

## Accounts

Per-person accounts, because an ERP has to say who moved a price. Roles:
viewer (reads), editor (+ add/edit/delete watches and photos), admin
(+ accounts, imports). The first admin comes from `ADMIN_EMAIL` /
`ADMIN_PASSWORD` when there are no accounts. scrypt hashes, 30-day sessions
(stored hashed), HttpOnly SameSite=Lax cookie, and every non-GET API call must
carry `X-Requested-With: masterapp`. Ten sign-in attempts per ten minutes per
address. An admin cannot demote or disable themselves.

## Running

```bash
npm install
cp .env.example .env      # fill in
npm start                 # migrates, creates the first admin, serves on :3000
npm test                  # EMPTIES the test database first
npm run import -- csv ProductList.csv
npm run import -- list | details [new|active|full] [limit] | vault | all
npm run user -- add someone@example.com editor 'a-long-password' Name
```

Tests need a Postgres at `TEST_DATABASE_URL` (default
`postgres://postgres@localhost:5433/masterapp_test`) — it is wiped each run.

## Not done yet / next

- Live Chrono Key and vault runs are only proven against stand-ins built from
  InvoiceWEB's parsers; the first run against the real systems is the test.
- Sale currency for imported sales (could come from InvoiceWEB's Buy & Sell
  ledger, which reads the sales group).
- Writing back to Chrono Key or the vault — deliberately not done.
- The rest of the ERP: customers/suppliers, invoices (InvoiceWEB), payments,
  consignment, accounting.
