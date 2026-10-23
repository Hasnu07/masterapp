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
  storage/                  photos: Cloudflare R2, or disk under DATA_DIR; same-picture check
  watches/fields.js         THE list of a watch's fields (API, import, form)
  watches/index.js          read / create / edit / delete / photos / history
  import/productlist.js     Chrono Key's product list (CSV export or live grid) → fields
  import/apply.js           writing a source's values into a watch, respecting edits
  import/listimport.js      the list → ck_records + watches
  import/chronokey/         client (ported), page parsers, sync
  import/vault/sync.js      the Watch vault → watches
  import/logistics/sync.js  the logistics app (same worker document) → logistics_items
  logistics/                its lists (kinds.js), "right now" / history / costs (situation.js), the API's reads and edits
  import/jobs.js            the timer, and the one-job-at-a-time lock
  web/server.js             the API
  web/public/               the console — no build step, served raw
test/                       node:test against stand-ins and a real Postgres
```

Node 20+, Express 5, Postgres, `sharp` for thumbnails.

**LIVE since 23 Oct 2026: https://coral-app-7qthm.ondigitalocean.app**
(DigitalOcean app `coral-app` + database `masterapp-db`, photos in R2 bucket
`purosangue-masterapp-apac`, all Bangalore / Asia-Pacific). Read the top of
`HOSTING.md` first: where everything is, how to sign in, what not to do.
The local copy below is now the backup — not to be run alongside.

**Where it ran until then: this PC** (`npm run local`), not Railway — decided 22 Oct
2026, because of the sheer number of photos (thousands, GBs). Next: Cloudflare
R2 for files + DigitalOcean App Platform and Managed Postgres, all in
**Bangalore / Asia-Pacific** because it is used in Pakistan and Dubai — the
steps, the measurements and what exists are in `HOSTING.md`. Only this PC uses it for now, so it stays on 127.0.0.1.
The database and photos under `data/` ARE the live
data: back them up, and move them whole if it moves. The Railway notes below
are kept for reference only.

## Three layers of data, kept apart

- `ck_records` / `vault_records` — exactly what Chrono Key and the vault said,
  as last read. Never edited here. The detail page's HTML is kept gzipped, so
  a field read wrongly can be re-read without asking Chrono Key again.
- `watches` — **our** record. What the console shows and people edit.
- `watch_events` — every change, by whom (a user, `chronokey`, `vault`), with
  old → new values.

The watch page shows neither the history nor the raw Chrono Key / vault
records (asked 23 Oct 2026). Both are still kept: the history at
`/api/watches/:id/events`, the raw records in the tables.

The watch page's header shows the purchase price, B2B, B2C and Chrono24 and
Chrono Key's description; under the photos, **what the reference has sold
for** (`soldFor`, `/api/watches/:id/sold-for`) — InvoiceWEB's box of the same
name, but read from our own copy, so it costs Chrono Key nothing: Chrono Key's
euro figure (else the sale price held), the vault's own sold figure beside it,
newest ten, and the examples still in stock.

**The blue ▾ converter beside every price** (asked 23 Oct 2026) is
InvoiceWEB's, ported: `public/fxchip.js` watches the page and hangs an arrow
after any amount written WITH its currency (`€16,800`, `AED 71,000`,
`$110,000`); a bare figure ("currency not stated") gets none — converting it
would be guessing. Rates: `src/rates` → `/api/rates` (Coinbase live, else
open.er-api daily; held a minute; a stale copy says so). No Converter tab
here, so the popup has no "Open converter". If InvoiceWEB's changes, port it
again rather than letting the two drift.

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
- `SYNC=off` is the switch-over: nothing is copied any more — not by the
  timer, and not from the Import page (its buttons and the CSV upload answer
  409). The command line (`npm run import`) still can, deliberately.

Source strengths (`apply.js`): **own** replaces (Chrono Key's product list for
purchase and sale; Chrono Key's euro figures; the vault's B2B, B2C and Chrono24 — its `b2chronoFinal`), **fill**
only fills a blank (the detail page's spec; the vault's spec, place and
status). A currency is never CLEARED by a source that simply does not state
one.

An **empty spec cell on the list** (the Watch and Specification fields —
size, bezel, dial, serial, …) is not a clear either: the vault or the watch's
page often filled it, and clearing it made every sync blank it and the vault
fill it again (85 sizes and bezels on the first live read). The list still
clears the DEAL — a sale taken back on Chrono Key is cleared here. So handing
back ("use Chrono Key's") a spec field the list leaves empty clears it at
once, for the page or the vault to fill (`unlockField`, `leftBlank`).

## A watch's status = where Chrono Key's own lists put it (23 Oct 2026)

Reported: stock 1722 showed "In stock" here; Chrono Key's page said RETURNED
TO CLIENT and its Inventory tab did not list it. The old rule (a sale on the
grid = sold, anything else = in stock) could not see it: **the grid row of a
returned watch is identical to one on the shelf** (no sale, order type R).
Checked against every watch that day: 72 shown in stock/incoming here were
not on the tab — 37 returned to their client, 29 incoming (already right),
6 only in the vault. Nothing on the tab was missing here.

`import/chronokey/lists.js` reads, each pass, back to back and BEFORE the
grid: To-be-shipped, the Inventory tab's feed (`/stock/FilterInstock`,
filterBy 'A', PageSize 1000 — its cards: "STOCK NUMBER: n", badge, Owner,
page id), Returned consignments (rows in the page, RETURN DATE `data-sort`),
and the Inventory page for the count its script declares (`itemCount <
'134'` — the feed itself states none). Then `listStatus` (listimport.js):

1. a sale on the grid → **sold** — first: 1708 and 1737 were sold before
   they arrived and are still on To-be-shipped
2. To-be-shipped → **incoming**
3. the Inventory tab → **in stock** (1271 "Checked Out", at a trade show,
   stays in stock as Chrono Key counts it; its note says "Watch is sold" —
   for a person to check)
4. Returned consignments → **returned** (to the client)
5. none of them → **other**, only after two trusted reads in a row

- **The watch page's Item Status is not a place**: "Due Payment" is on 11
  incoming watches and on 1590, on the shelf. Shown, never used.
- **Trusted only when whole**: every table with its headings, every card
  readable and none twice, fewer cards than the page size, the count within 2
  of the declared one (or, if the page stops declaring it, within
  max(10, 10%) of the last read), Returned / To-be-shipped not suddenly empty
  after many. Sizes compare with the LAST read, trusted or not — against the
  last trusted one only, one refusal repeats for ever.
- **An untrusted pass, and any CSV, re-derives nothing**: only what the grid
  proves (a sale; a sale taken back; To-be-shipped as before) moves a status.
  Re-deriving would put every returned watch back on the shelf until the next
  good read.
- **More than GONE_LIMIT moves at once is refused** — unless the previous pass
  proposed the same change (≥ 90% the same moves): a real change reads the
  same twice, a glitch does not; without that a real one is refused for ever.
  Locked statuses are never proposed.
- A rejected sign-in stops the pass at the first attempt (signed in once,
  before the reads).
- **The vault**: a watch Chrono Key no longer (or never) lists gets 'other'
  (or 'sold' from the vault's sold list) in 'own' mode — after a complete CK
  read within a day, never for a watch added here by hand. A watch first seen
  on the grid is decided afresh, so one the vault made first is not stuck.
- Kept in `ck_records.ck_lists` / `lists_at`; the watch page says why under
  the chip, with the read time, and names a Chrono Key watch with the same
  serial for a vault-only one (1528 → 1515, 1617. → 1617).
- Dry run on real data: in stock here 134 = the tab's 134, nothing different
  either way; 37 returned; the 6 vault-only 'other'. On this PC's day-old copy
  the first pass refused 63 moves and the next took them, as designed.
- Load: 3 more requests a pass (~1.6 MB).

## Keeping in step with everything, until the switch-over (23 Oct 2026)

Asked for: "auto sync on everything with watch vault and Chrono Key until we
stop using those … whatever changes there will be here also". Every 15
minutes (`jobs.js` cycle), one job at a time:

| step | reads | catches |
|---|---|---|
| list | the product grid (1 request) | every grid field; a watch gone from it |
| clients | the client list (1) | every client field, the links; a client gone |
| expenses | the expense list (1) + pages: new/changed (≤200) and the 40 read longest ago | every field; an expense gone; page-only edits within ~6 h |
| new details | watch pages never read (≤200) | — |
| rolling details | the 40 watch pages read longest ago | photos, euro figures, ticks anywhere, within ~10 h; failed pages retried |
| active details | once a day: unsold and sold in 30 days | — |
| vault | the whole state (1) + photos | every field; a record gone; a vault-only watch gone |

**Deletions are mirrored, softly** (`import/gone.js`, migration 006): a raw
record its source no longer lists gets `gone_at`; our record with no live
source left is deleted with `deleted_at = source_gone_at`, restored by the
sync if it is listed again. A person's deletion is never undone; a record a
person restored after the sync removed it is never removed again. A read
where more than 3% (and more than ten) vanish at once is refused, not acted
on; a read listing nothing never counts; a CSV upload never mirrors. A watch
gone from Chrono Key but still in the vault stays (and the other way round).
A client a watch still names stays. **Photos are never deleted** because a
source dropped them. Dry run on real data first: nothing would be removed;
two vault records (1308, 1325, off Dubai stock) marked gone, their watches
kept (still on Chrono Key).

`SYNC=off` ends all of it — the switch-over.

## Clients (23 Oct 2026)

Asked for: "connect each stock with each client … a new tab of that client,
searchable." `src/clients`, `import/chronokey/clients.js`, migration 004.

- Chrono Key's client list is `/User/ClientList`; its rows come from **POST
  `/User/ClientListDatatable`** (PageSize, PageNumber, SearchBy,
  `roleType=Client`). First read: **646 clients**, all in one answer of
  PageSize 1000 — an object per client, `id` a GUID, `firstName` with stray
  spaces, `clientType` D (499, Dealer) or I (147, Retail; the page shows any
  other code as Retail-Company), `companyName`, `phoneNumber`, bill…/ship…
  address, `isActive`. Kept whole in `ck_clients`; ours in `clients`; changes
  in `client_events`. A field edited here is locked, as for watches.
- **Linked by id, never by name.** The product grid names both sides of every
  deal: `clientId` (bought from — the `purchasedFrom` column) and `soldToId`
  (sold to). All 1,665 / 1,468 ids were on the client list. 505 watches have
  a typed "Purchased from" that is NOT the client's name ("EVALUMASA (DieGO
  GIMINEZ)" is the client "DieGO GIMINEZ"), and 8 names belong to two
  clients — matching names would have been wrong both ways.
- `watches.purchased_from_client_id` / `sold_to_client_id`, set by the sync
  from `ck_records.list_row` (rows from the CSV export carry no ids: left
  alone). A link changed on the watch page is locked
  (`purchased_from_client` / `sold_to_client` in `locked_fields`); "Use Chrono
  Key's" hands it back. A grid row with no buyer clears the sale's link.
- The 15-minute pass reads the client list after the product list (one more
  request). Dry run on this PC's copy, rolled back: 646 clients, 1,661 of
  1,671 watches linked to who they were bought from, 1,464 of 1,467 sold ones
  to their buyer.

## Expenses (23 Oct 2026)

Asked for: a separate Expenses tab — currency, title, type, cost, payment
method, description, payment copy. `src/expenses`,
`import/chronokey/expenses.js`, migration 005.

- **`/Stock/ExpenseList` is not a data grid**: the page itself holds every
  expense (915 rows, 3.6 MB — Title, Type, Description, Cost "£", Created
  Date in `data-sort`, edit link `/Stock/AddEditExpense/{id}`). Each
  expense's own page (its edit form, a GET) holds the rest: CurrencyID (the
  `selected` option), ExchangeRate, Cost in that currency, typeId,
  PaymentType (0 Cash · 1 Card · 2 Wire · 3 Crypto · 4 PayPal / Chrono24),
  ExcludeFromProfit ("Loan Book"). Chrono Key has no place for a payment
  copy: that is ours (`expense_files`, a picture or a PDF, checked by its
  bytes, served behind the sign-in).
- **The list's Cost is Chrono Key's booked figure** = cost × rate, in euros
  in practice (AED 4,300 × 0.24 = "£1,032"): stored as `cost_eur`. Checked on
  60 real pages: every one within 1%. Kept as Chrono Key booked it — where
  somebody typed rate 1 on a dollar or pound cost (2012 "usd 1307", 2020
  "gbp 636"), its euro figure is the bare amount, and so is ours.
- **Its two European currency options are not what they say.** "GBP (£)" is
  the BASE (rate fixed at 1) and the base is euros: "salva | COMMISION | eur
  5,000" is GBP 5,000 at 1. "EUR (€)" is used for POUNDS at a pound-to-euro
  rate: "kashan | salary | gbp 3,000" is EUR 3,000 at 1.18. So the currency
  (`currencyOf`): what the title/description says with this same amount
  (`currencyFromNote`, as the product list) → else "GBP" = EUR → else "EUR"
  at rate 1 = EUR, at any other rate NOT STATED (pounds, most likely — not
  guessed) → AED / USD / CHF / HKD as chosen (their rates fit).
- Payment type is unset on Chrono Key for most expenses (55 of 60 read),
  though titles often say "PAID IN CASH" — not read from the title.
- The pass: the list every 15 minutes (one request); an expense's page only
  when it is new or its line on the list changed (compared key-sorted —
  jsonb reorders keys), at most 200 a pass, two at a time. A page that fails
  is retried a day later, not never. First run on the live site: ~915 pages
  over the first five passes.

## Logistics (24 Oct 2026)

Asked for: copy the logistics app (Purosangue Watches Logistics, repo
`11muhammadharis11-cloud/purosangue-watches`, private) into masterapp, with
editing — "we all will switch to the masterapp as whole … no one will use
either the logistic app or watch vault or even chronokey". Until then
masterapp copies it, the way it copies Chrono Key. `src/logistics`,
`import/logistics/sync.js`, migration 009.

- **Its whole state is ONE JSON document** on the puro-sync worker — the
  same `/api/state` the vault sync reads for its five stock lists. One
  download per pass serves both steps (`fetchState({ reuse })`). About 35
  lists: shipments, incomings, londonStock / dubaiStock / hkStock /
  safeStock / checkoutStock / hkSituation, readyForDelivery, soldStocks,
  personTrips, kashanPlans, thirdPartyMovers / thirdPartyShipments,
  logisticCosts, transactions, accCollect / accGive, externalPolish,
  driverDeliveries, clients, activity … (`src/logistics/kinds.js` names
  them; a list it does not know yet is copied too, under its own name).
- **Kept as documents, one row per record** (`logistics_items.data` jsonb),
  not a table per list: the shapes keep changing. Same three layers:
  `logistics_records` (as read), `logistics_items` (ours, `locked_fields` =
  top-level keys edited here), `logistics_events`. Pictures inside records
  (inline base64 — 90% of the document's bytes) are stored once each in
  `logistics_files` and the record keeps `lgfile:<id>`; the worker's own
  `/photos/` are copied too, a hundred a pass — the worker goes when the app
  does. Served only behind the sign-in (`/api/logistics/files/:id`).
- **Its `settings` are never copied**: they hold Chrono Key's username and
  password, FedEx and AI keys, the worker's key and the vault PIN. Fields
  that look like secrets are dropped at any depth (`isSecret`).
- Same rules as the other copies: the app wins until the switch-over except
  a field edited here; a record it drops is deleted softly and comes back
  with it; a person's deletion stands; a list losing more than 3% (and ten)
  at once is refused; `activity` (the app keeps its last 200 lines) never
  mirrors a deletion. Never written back.
- **About a minute behind, not fifteen**: the worker's `/api/version` (a few
  bytes) is checked every `LOGISTICS_POLL_SEC` (60) and the document read
  again when it moved; unchanged records are skipped by hash, and a pass
  that found nothing new leaves no `import_runs` row. `LOGISTICS_SYNC` is
  its own switch and follows `SYNC` when unset.
- **Stock numbers join everything** (`stock_nos`, GIN-indexed): split on
  `, ; newline` (the app's own rule), "-" and "SHIP-…" are no watch, and a
  trip names its watches by ROW ids with a list prefix (`lon-`, `dubai-`,
  `hk-`, `inc-`, `sold-`, `ready-`). Clients are mostly typed names there;
  only transactions and shipments carry client ids — not linked to our
  clients (by id only, never by name).
- **"Right now" on the watch page** (`situation.now`): sold (and delivered)
  → sold, waiting for delivery → checked out → in a place (London, Dubai,
  Hong Kong, the safe — a client's), maybe on consignment or at polish → the
  HK list → on its way in; and on top, what is moving it — a shipment not
  delivered (the carrier's stage first: FedEx's codes, then the words — the
  app's own `shpStageFrom`), a mover, a trip, a driver, accessories still to
  give or collect. Under the photos: its logistics history, what moving it
  cost, its records. Refreshed every minute while open. **Tracking is only as
  fresh as the logistics app's open tabs**: its worker's cron does not save
  carrier results into the document.
- **Costs = the app's own `costsForStock`, line for line** — logistic costs
  split evenly over the watches they name (a trip's lines counted with the
  trip), a shipment's own cost unless a cost line stands for it, trip lines
  split over its watches, the purchase from the incoming. Checked on the
  June snapshot: all 172 watches equal to the app's function run on the same
  data. Amounts stay in their own currency.
- **The console**: one Logistics entry in the menu; its tabs across the top
  (Overview first), a tab's lists in a row under them. Every record has its
  page: its fields (typed ones with proper controls, the rest as plain
  fields), its lists and pictures, its history, edit / delete / restore /
  "use the logistics app's".
- First copy of the June snapshot (on a stand-in worker): 699 records, 18
  lists, 59 pictures. `npm run import -- logistics` runs it by hand.
- **Found in the logistics app, for its owner** (not ours to fix): its
  worker key is written in its public page (`index.html:2445`), and its
  settings — with the passwords above — travel in the document, so anyone
  who loads that page can read and overwrite everything. Also: cancelling an
  HK sale restores into the wrong list; background DHL tracking never saves;
  deliveredAt is milliseconds or a date string; Kashan-plan watches drop out
  of Movement (ids without a prefix); vault notifications can revert a value.

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
- **Category is the location**: `Watch` = Europe, `Jewellery` = HK, and
  `Dubai` / `UK` as named (the Inventory tab, 23 Oct 2026: Dubai 109, UK 20,
  Watch 3, Jewellery 1).
- Watch Month + Watch Year → `watch_date` "MM/YYYY".
- Dates are day first (`21/04/2023`); a date that does not exist is refused.
- Stock 238 appears four times (a sale recorded twice). The latest sale wins;
  the other rows are kept in `ck_records.list_row._repeated`.
- Columns are matched **by name**, never position.

**The live grid** (`/Stock/ProductsDataTable`), first read 22 Oct 2026, and
checked against the export watch by watch before anything was written:

- One JSON answer, everything in it: `{draw: ["1"], recordsTotal: 1662,
  recordsFiltered: 1662, data: [1665 objects]}` (stock 238's four rows count
  once). Each row an **object with the same 54 keys** (`stockNumber`,
  `makeName`, `subModel`, `purchaseDate`, `purchaseCash` …), typed: numbers,
  true/false, null. **No markup**, so no detail-page id: the detail pass finds
  each page through Chrono Key's search.
- Read by `GRID_KEYS` in `productlist.js`, exactly, before the headings —
  because **`retailPrice` is the export's Website Price and `wholeSalePrice`
  its Retail Price** (all 16 watches where they differ). `id` is the Product
  ID; `subModel` the reference; `material` the case; `paperWork` the papers;
  `purchaseWire` / `purchaseZellVenmo` bank transfer and PayPal / Chrono24.
- Dates are ISO with Chrono Key's clock time (`2026-10-22T13:05:07.84`); the
  day is the day it says. A date written but not readable is left alone, not
  taken as blank — read as blank, the first run would have wiped 1,661
  purchase dates.
- Order type is a code: `R` = INVENTORY (the only one seen). Another code is
  kept as written.
- Not read but kept in `list_row`: `purchaseExchangeRate` / `saleExchangeRate`
  — they look like to-euro rates (AED ≈ 0.234, GBP ≈ 1.15, CHF ≈ 1.07, USD ≈
  0.86) and may give the missing **sale currency**, but 1.000 also appears on
  USD purchases, so not without checking. `shelfBox` (null everywhere),
  `clientName` / `clientType`, `isSold`, `imgProduct`.

## Photos

Copied, never linked: Chrono Key's photos sit behind its login, and the
vault's behind its worker. Stored once (original untouched) plus a 480px JPEG
thumbnail; served only through `/api/photos/:id`, behind the sign-in, because
papers and serials are in them. Keys are generated server-side and checked
against a strict pattern before touching disk. R2 when `R2_*` is set (private
bucket), else `DATA_DIR` (Railway volume).

Only paths on Chrono Key's own host are fetched (a `data:` placeholder or an
off-host url out of a scraped page is refused); the vault's key goes only to
the worker's own origin. A vault photo url is fetched only from a public
address (not loopback, a private network or the metadata service) unless it
is on the worker's own origin, with the vault's timeout and at most 50 MB;
redirects are followed by hand, each hop checked, the key never carried off
the worker's origin.
Chrono Key's sign-in follows a redirect only on Chrono Key's own host — the
client's cookies go with it.

**The same picture comes many times.** Chrono Key's galleries and the vault
both list a picture more than once under different file names, and the two
hold many of the same pictures (first copy: 170 repeats on 113 watches). So
the syncs fingerprint each picture (`watch_photos.sha256`, `dhash`) and a
picture the watch already has — or HAD, and somebody removed — is recorded as
a hidden row (`duplicate_of`, no file) and never fetched again. Repeats copied
before that: `npm run import -- tidy-photos` (files kept).

But **"looks the same" is not the test**: the vault keeps EDITED client copies
beside the originals — the purchase date wiped off the papers, a serial
hidden, a white box over a label — identical except one small patch (stock
1650: average difference 0.04, date gone). Same picture = identical bytes, or
same width and height and every 8x8 window, slid over the picture at 256x256,
within 2.5 grey levels (re-saves reach 1.83; the smallest real edit never goes
below 3.48). Fixed squares were not enough — an edit across their corners is
split four ways. The same picture at another SIZE is kept twice by the rule —
resizing differs along every edge, too like an edit. That turned out common
(Chrono Key holds the full-size original, the vault a smaller copy: ~196
pairs), so after the first copy those pairs were checked by eye, twice, and
the agreed ones hidden by hand, keeping the larger.

- Chrono Key's **"NO IMAGE AVAILABLE" graphic** (`/images/no_image.png`) sits
  in the gallery of every page without photos. It is not copied
  (`isPlaceholder`); the first copy had shown it on 316 watches.
- **PDFs are not held.** 249 PDFs (invoices, papers) on 136 Chrono Key pages
  were refused as "not a picture". Holding documents is still to do.

## Being polite to Chrono Key

Somebody else's server, and the real inventory. Read-only; two pages at a
time with a pause; one job at a time across processes (Postgres advisory
lock). First full read of every watch page ≈ 1,700 pages → a couple of hours,
resumable. After that the 15-minute pass reads the list (one request) and only
NEW watch pages; once a day it re-reads unsold and recently sold watches. A
failed sign-in stops the run rather than failing 1,700 times. That daily pass
counts as done when it went through with at most a tenth of its pages failing
(the rolling pass retries those) — counting only a flawless one re-read ~200
pages every 15 minutes while any single page kept failing (fixed 23 Oct 2026).
A CSV upload takes the same lock.

An EMPTY answer is never trusted as "nothing there" — the ported client checks
the session first (InvoiceWEB lost hours to a dead session reading as an empty
inventory).

## Accounts

Per-person accounts, because an ERP has to say who moved a price. Roles:
viewer (reads), editor (+ add/edit/delete watches and photos), admin
(+ accounts, imports). The first admin comes from `ADMIN_EMAIL` /
`ADMIN_PASSWORD` when there are no accounts. scrypt hashes, 30-day sessions
(stored hashed), HttpOnly SameSite=Lax cookie, and every non-GET API call must
carry `X-Requested-With: masterapp`. Ten failed sign-ins per ten minutes per
address, and per account at each address (three while that account is failing
from everywhere) — never one lock on a whole account, which let anybody keep
its owner out (fixed 24 Oct 2026). Each attempt is counted before its password
is checked, so a burst sent at once gets no more. The address is `do-connecting-ip` in production:
on App Platform `x-forwarded-for` (so `req.ip`) is DigitalOcean's ingress,
the same for everybody — counted by it, ten wrong passwords from anyone locked
everyone out (fixed 23 Oct 2026). An admin cannot demote or disable themselves.

The console page carries a Content-Security-Policy (`server.js`,
`PAGE_POLICY`): scripts only from the app itself, so a value that ever slipped
past `esc()` still cannot run — keep the console free of inline scripts and
`on…=` handlers. Not on the files the API serves: a payment copy's PDF opens
on its own, and a policy there can stop the browser's PDF viewer. HSTS in
production. Field names from a request are looked up in prototype-free maps
(`FIELD`, `CLIENT_FIELD`): they become column names in SQL.

## Skills

`.claude/skills/` holds ten skills from
[jeffallan/claude-skills](https://github.com/jeffallan/claude-skills), copied
unchanged (MIT; source commit in `.claude/skills/LICENSE`). They are general
advice: where they disagree with this file, this file wins — no new
dependencies for what they suggest (helmet, zod, bcrypt), and migrations run
inside a transaction at start-up, so `CREATE INDEX CONCURRENTLY` is out.

| Skill | Use it when |
|---|---|
| `security-reviewer` | auditing for vulnerabilities: auth, sessions, uploads, secrets |
| `secure-code-guardian` | changing sign-in, roles, input handling or headers |
| `code-reviewer` | reviewing a change or a PR before it goes to `main` |
| `javascript-pro` | writing or debugging the Node code and the console (ESM, async) |
| `postgres-pro` | a slow query, an index, jsonb, EXPLAIN — verify on realistic data |
| `sql-pro` | writing or reshaping a query or a migration |
| `api-designer` | adding or changing an `/api/…` endpoint |
| `test-master` | adding tests in `test/` (node:test, real Postgres, stand-ins) |
| `debugging-wizard` | a sync or import that misbehaves: logs, `import_runs`, hypotheses |
| `devops-engineer` | DigitalOcean App Platform, R2, deploys (see `HOSTING.md`) |

## Running

**On a PC, with nothing to install but Node and Git** (asked for 22 Oct 2026,
while Railway was down): double-click `start-masterapp.cmd`, or

```bash
npm install
npm run local             # its own Postgres, http://localhost:3300, opens the browser
```

`src/local.js` starts an embedded Postgres (the `embedded-postgres` package
ships the real binaries for Windows/macOS/Linux through npm) in `data/pg`, keeps
photos in `data/`, makes `admin@local` with a random password the first time
(printed, and kept in `data/local.json`), and stops the database on Ctrl+C.

- Port **3300**, because InvoiceWEB's console is on 3000 on the same PC.
- Bound to **127.0.0.1**: nothing on the network reaches it, and Windows does
  not ask about its firewall.
- The database is created **UTF-8 with the C locale** on every platform. Left
  to itself, initdb on Windows takes the PC's code page (WIN1252), and an
  Arabic or Chinese client name then cannot be stored. Proven here with
  "محمد العلي — 王先生 € £ ✓".
- Do not run it from an Administrator terminal: Postgres refuses to run with
  admin rights on Windows.
- Chrono Key / vault credentials in a `.env` beside it make it copy photos
  locally too, exactly as on Railway.

**On a server** (Railway):

```bash
npm install
cp .env.example .env      # fill in
npm start                 # migrates, creates the first admin, serves on :3000
npm test                  # EMPTIES the test database first
npm run import -- csv ProductList.csv
npm run import -- list | details [new|active|full] [limit] | vault | all
npm run import -- tidy-photos     # hide repeats among photos already copied
npm run user -- add someone@example.com editor 'a-long-password' Name
```

Tests need a Postgres at `TEST_DATABASE_URL` (default
`postgres://postgres@localhost:5433/masterapp_test`) — it is wiped each run.

## Not done yet / next

- First live runs, 22 Oct 2026, on the PC copy: the list (grid shape above),
  then every watch's page and photos, then the vault. Each new kind of live
  read was dry-run first (rolled back) — keep doing that.
- (Fixed 23 Oct 2026 by the rolling pass, which re-reads the oldest pages
  first.) A page that fails (a rejected sign-in included) is stamped `detail_at`, so
  the `new` pass never retries it — only `active` (unsold / recent) or
  `full` do. Should retry pages never read successfully.
- After the first full copy: 1,354 of 1,671 watches have real photos. 315 have
  none on Chrono Key either (mostly sold 2024–25; two still in stock).
- Waiting on a person, found by the audit and not changed: the vault's
  `1617.` is the same watch as Chrono Key's `1617` (same serial), likely
  `1528` = `1515`; vault-only junk records (`-`, `0000`, `xxxx`, `Parsa 1`, …);
  photos on the wrong watch in the source data (11 ↔ 1446, 1570, 739 ↔ 1346,
  1607 ↔ 1606); buy-backs not linked by `ck_product_id` (same serial: 126/330,
  537/1021, 683/1007, 813/1535, 1048/1433, 1149/1426, 1454/1645).
- Documents (PDFs) per watch. Storage now takes PDFs (`saveDocument`, used
  for expense payment copies); a watch's own documents are still to do.
- Sale currency for imported sales (could come from InvoiceWEB's Buy & Sell
  ledger, which reads the sales group).
- Writing back to Chrono Key or the vault — deliberately not done.
- **Port to InvoiceWEB**: its Chrono Key client follows a sign-in redirect to
  any host, cookies and all. masterapp's (`chronokey/client.js`, `login`) now
  refuses one off Chrono Key's host (23 Oct 2026); the two should agree again.
- The rest of the ERP: customers/suppliers, invoices (InvoiceWEB), payments,
  consignment, accounting.
