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
  watches/documents.js      a watch's documents: invoice, papers, customs, receipts (PDFs or pictures)
  import/productlist.js     Chrono Key's product list (CSV export or live grid) → fields
  import/apply.js           writing a source's values into a watch, respecting edits
  import/listimport.js      the list → ck_records + watches
  import/chronokey/         client (ported), page parsers, sync
  import/vault/sync.js      the Watch vault → watches
  import/logistics/sync.js  the logistics app (same worker document) → logistics_items
  import/accounts/          the accounts app: client.js signs in as the ERP and reads /api/state; sync.js → accounts_items
  accounts/                 what our copy says about a stock number or a client (index.js), which client of ours an accounts client is (clients.js)
  ai/                       Claude in the ERP: what the model reads (context.js), the watch's brief and Ask with tools (index.js)
  logistics/                the app's lists (kinds.js), moments and stages (situation.js), which client of ours a logistics client is (clients.js), our watch by stock number (shared.js)
  import/jobs.js            the timer, and the one-job-at-a-time lock
  web/server.js             the API
  web/lgapp.js              the logistics app itself, served inside the ERP at /lg-app/
  web/accapp.js             the accounts app itself, served inside the ERP at /acc-app/
  web/public/               the console — no build step, served raw; lgapp-bridge.js / accapp-bridge.js run inside the two apps; timeline.js is the watch's combined timeline; ask.js the brief and the Ask thread
test/                       node:test against stand-ins and a real Postgres
```

Node 20+, Express 5, Postgres, `sharp` for thumbnails, `@anthropic-ai/sdk` for the assistant.

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

**Moves** (asked 3 Nov 2026: "for incoming add a button to move to stock,
for in stock sold and return and all the stuff, then fill up the info"):
each status offers its moves on the Inventory card and the watch page —
incoming / other → *Received into stock* (place); in stock → *Sold* (date,
sold to, price, currency, paid by), *Reserve* (reserved for), *Return to
client*; reserved → *Sold*, *Back in stock*; sold → *Sale taken back* (the
sale cleared); returned → *Back in stock*. A move is a small form over the
page (`MOVES`, `openMove` in `app.js`) saved by the same PATCH as the edit
form, so its fields are locked against the copy like any edit; Chrono Key is
not written to — the same move is made there by hand until the switch-over.

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

## Logistics (24 Oct 2026; the app itself since 30 Oct 2026)

The logistics app (Purosangue Watches Logistics, repo
`11muhammadharis11-cloud/purosangue-watches`, private, live on Vercel at
`https://purosangue-watches.vercel.app`) is Jhonny's too. Its whole state is
ONE JSON document on the puro-sync worker — the same `/api/state` the vault
sync reads: about 35 lists (shipments, incomings, londonStock / dubaiStock /
hkStock / safeStock / checkoutStock / hkSituation, readyForDelivery,
soldStocks, personTrips, kashanPlans, thirdPartyMovers / thirdPartyShipments,
logisticCosts, transactions, accCollect / accGive, externalPolish,
driverDeliveries, clients, activity …), stock numbers as typed (split on
`, ; newline`; "-" and "SHIP-…" are no watch; a trip names ROW ids with a list
prefix), clients mostly as typed names (only transactions and shipments carry
its client ids), pictures inline as base64, and its `settings` holding Chrono
Key's password, FedEx and AI keys, the worker's key and the vault PIN.

**Decided 30 Oct 2026** ("delete the old logistics of the ERP … in the ERP
only the new one stays that we copied; stop the sync for logistics for now;
the logistics app performs as usual; next step is the linking and setting up
the logistics app on our own"):

- **Logistics in the ERP IS the logistics app.** `src/web/lgapp.js` reads the
  app's page from its Vercel address (`LOGISTICS_APP_URL`, default
  `https://purosangue-watches.vercel.app`; `off` = no Logistics) and serves it
  at `/lg-app/` — editors only (the app has no roles, and its page holds its
  worker key), its own CSP (`appPolicy`: inline scripts, cdnjs, its worker,
  OpenAI / Anthropic / GitHub, `frame-ancestors 'self'`), a copy held a minute
  then re-asked with its ETag, the held copy served when Vercel is down. Its
  own Vercel functions (`fetch('/api/claude')`, whatsapp, dhl-track,
  app-version …) are rewritten to `/lg-app/api/…` and passed on whole —
  method, query, body up to 30 MB, never the ERP's cookie; a write must come
  from our own origin. Its worker calls (`CF_URL + '/api/state'`) are
  untouched: **the app still saves to its worker**, exactly as on Vercel. Safe
  on a fresh origin: the app reads the worker before it is allowed to write
  (`_cloudStateSeen`), so an empty localStorage never pushes over the live
  document (its own pitfall 10). `public/lgapp-bridge.js` goes first in its
  `<head>`: hides the app's own sign-in (the ERP's stands in), opens the tab
  the ERP asks for and finds what it names (`#tab=…&q=…` on the frame, or a
  `postMessage`: a stock number's row scrolled to and marked, else the app's
  dashboard search on it; on Clients the name searched and the profile opened
  when one matches). **The two are one connected whole** (asked 30 Oct 2026:
  "don't show the ERP button — every watch should be linked already because
  it is the same watch"): every stock number the app shows that is OUR watch
  IS the link to our watch, and every client name that is OUR client IS the
  link to our client — the text itself wrapped (`.erp-link`, a dotted
  underline, gold on hover), no badge; `POST /api/lg-app/links` decides: a
  stock number is our watch of that number (`oursByNumber`), a name is our
  client when exactly one of ours carries it (`oursByExactName`, compared as
  `normName`), else as the copied records tie it to one (`linksByName`). A
  stock number typed into one of the app's forms (`FORMS` in the bridge:
  London / Dubai / HK rows, Incoming, Receive, 3rd-party shipment,
  Transaction — by the ids of their fields) fills the watch in from the ERP
  where the form's fields are still empty — brand (its select matched by
  text), model, reference, serial, watch date, the HK description line
  (`GET /api/lg-app/watch?no=`); and our clients' names are added to the
  app's own name lists (`clientNameList`, `shipClientList`;
  `GET /api/lg-app/clients`), so a name typed there can be ours exactly.
  Nothing is written to the app's records by the ERP. Console: `logistics.js`
  is only this — one iframe in `#lg-app-host`, kept while other pages show,
  dropped at sign-out; `#/logistics/<tab>/<what>`; tabs map through
  `GROUPS[].app` (kinds.js, the app's sidebar in its order).
  `test/lgapp.test.js` against a stand-in Vercel.
- **From our pages into the app, nothing of the copy shown.** The watch page's
  **Logistics** button (asked 30 Oct 2026: "each logistics info … live
  shipment, incoming, sold or in stock … as a window when I tap a button
  named Logistics"; then "design a better window with Claude design") opens
  a window in the console's own look (`showLogisticsWindow`, a `<dialog
  class="lgw">`): the hidden frame hands over everything the app holds on the
  stock number (the bridge's `passport-data`: incomings, the rows in every
  stock list with their movements, sales, waiting deliveries, shipments,
  courier shipments, accessory transactions and settlements, cost lines,
  trips, polish; its clients' and movers' names; pictures made absolute to
  the worker, which the console's `img-src` allows), and the window says in
  one serif line where the watch is (sold → waiting for delivery → on its way
  → on consignment → checked out → in a place → incoming), then its story
  in the order it happened (oldest first — asked 3 Nov 2026; newest first
  until then) with the pictures taken, the shipments, what moving it cost
  per currency, every picture, and "See it in the logistics app" — the
  Logistics page itself (the app) with the app's own passport in front of it
  (the bridge's `passport` with `inApp`; the chrome-hidden window version,
  `showLogisticsAppWindow` / `body.erp-window`, stays for the frame route).
  Polish is read off the stock row (`polish`, `polishHistory`), as the app
  keeps it; an incoming's arrival off `arrivalRecord`. Asked again
  every half second until the frame has loaded — and the frame is started
  hidden two seconds after an editor signs in (`lgAppWarm`), so the first
  window finds the app ready (3 Nov 2026: "loads very late"). Its pictures
  are the worker's full-size originals (100–200 KB each, seconds away), so
  the window shows them through `GET /api/lg-app/photo?u=&thumb=1`: the
  file copied here once by the pass's own code (`workerFile` in
  `import/logistics/sync.js`, no refusal memory) and served as its 480px
  thumbnail, immutable; one the app no longer has says "picture missing".
  Still too slow from a cold frame (3 Nov 2026, 9 s here), so the window
  first draws from OUR copy of the app's records — `GET
  /api/lg-app/passport?no=` (`logistics/passport.js`, the bridge's shape
  from `logistics_items` by `stock_nos`, 100 ms), its pictures and papers as
  `lgfile:<id>` through `/api/lg-app/file/:id` — with a line saying so, and
  the app's own answer replaces it when the frame has loaded. The copy must
  be running for that (`LOGISTICS_SYNC`, on with `SYNC` since 3 Nov).
  The client page's "See <name> in Logistics →"
  (`#/logistics/contacts/<name>`) opens the app's Clients tab. The
  Inventory card shows Ref, Serial and From (our client by Chrono Key's id,
  else as typed) — nothing from the logistics copy.
- **The ERP's own logistics pages are gone.** 24–27 Oct 2026 had built every
  tab of the app in the console's look (Overview, In Safe, Checked out, Hand
  carry, Transactions, Accessories, Incoming, Shipments, Movement, 3rd party
  movers, then every page of the app in its order), 171 actions writing into
  the copied records, the client situation pages, and facts from the copy on
  the Inventory cards, the watch page and the client page. All removed 30 Oct
  2026 — `src/logistics/pages`, `actions`, `write.js`, `ai.js` (and the
  `@anthropic-ai/sdk` dependency), `public/lg/`, `/api/logistics/*`, their
  tests. Last whole at the merge of PR #22 (`10125c6`), if a piece is ever
  wanted back. The ERP's own logistics, on its own records, is the next step
  — not started.
- **The copy runs again** (asked 3 Nov 2026: "sync with the logistics app";
  it was off by default 30 Oct – 3 Nov, so the tables held what was copied up
  to the 30th). `import/logistics/sync.js` copies the document — it follows
  `SYNC` unless `LOGISTICS_SYNC` says otherwise, or `npm run import --
  logistics` by hand — into the same three layers — `logistics_records` (as read),
  `logistics_items` (ours; `locked_fields` = keys once edited here),
  `logistics_events`; pictures once each in `logistics_files` (`lgfile:<id>`);
  `stock_nos` GIN-indexed (migrations 009, 010). Its rules stand: settings
  never copied (`isSecret` at any depth; the one exception `settings.perDiem`
  by named keys — `perDiemOf`), a list the app does not know yet copied under
  its own name, deletions mirrored softly (a person's deletion stands; a list
  losing more than 3% and ten at once refused; `activity` never mirrors a
  deletion), `/api/version` polled every `LOGISTICS_POLL_SEC` (60) and the
  document read only when it moved, nothing ever written back.
- **What still reads the copy: which of OUR clients a logistics client is**
  (`src/logistics/clients.js`, `linksByName` / `linksByClientId`, for the
  bridge's marks) — by the watches, not the name: the stock numbers the app
  ties to the client (purchases by its client id, incomings by supplier, sales
  by buyer, a place row's "bought from") vote for who OUR watch with that
  number was bought from / sold to (Chrono Key's ids); a shipment only backs a
  match up, never makes one (a forwarder in Belfast sent three watches bought
  from a dealer in Spain); ONE watch alone links only when the names look
  alike (`namesAlike`); a place or placeholder typed as a client ("HK", "Need
  to confirm") never links on its own; a full name decides only when no watch
  does; a person's choice (`logistics_client_links`, NULL = "none of ours")
  always wins. Live, 27 Oct 2026: 197 logistics clients, 144 linked by
  watches, 15 by name, 30 not. `shared.js` `oursByNumber`: our watch of a
  stock number with its clients by id. `situation.js` stays for the sync
  (`happenedAt`) and the shared readers.
- **Found in the logistics app, for its owner** (not ours to fix): its
  worker key is written in its public page (`index.html:2445`), and its
  settings — with the passwords above — travel in the document, so anyone
  who loads that page can read and overwrite everything. Also: cancelling an
  HK sale restores into the wrong list; background DHL tracking never saves;
  deliveredAt is milliseconds or a date string; Kashan-plan watches drop out
  of Movement (ids without a prefix); vault notifications can revert a value.

## Accounts (4 Nov 2026)

Asked for: "add accountancy app to the ERP same way as how we did logistic …
with linked stock and clients, with the watch page showing accountancy info …
keep the sync on for the accountancy app until things get straight". The
accounts app (Purosangue Watches — Accounts, repo
`purosanguewatches94/Accountany-App`, live on Railway at
`https://accountancy-app-production.up.railway.app`) is a **React build with
its own Express + MySQL backend**: the payable/receivable ledger (every
purchase and sale leg with its payments, by stock number and client), clients
(`CL-001` …), documents/invoices, quick sales, expenses, wallets, currencies
and rates, the exchange desk, schedules, employees and commission, partner
desks — about 33 collections, each ONE JSON document in its `app_state` table,
read whole at `GET /api/state` (or `?only=a,b`), with a version number per
collection at `GET /api/state/revs`. It signs people in itself
(express-session, cookie `connect.sid`, sign-up by email + admin approval) and
stamps `_createdBy` / `_updatedBy` / `_history` on every record.

- **Accounts in the ERP IS the accounts app.** `src/web/accapp.js` reads the
  app from `ACCOUNTS_APP_URL` (default the Railway address; `off` = no
  Accounts menu) and serves it at `/acc-app/` — editors only, its own CSP
  (`appPolicy`: its inline theme script, Google fonts, the currency feeds it
  reads, Google Maps for addresses, `frame-ancestors 'self'`), a copy held a
  minute then re-asked with its ETag, the held copy served when Railway is
  down. Because it is a React build, three things the logistics app never
  needed: (1) its page names `/assets/…` and its 2.5 MB script calls `/api`
  by absolute paths (the axios base, a few fetches) — both **rewritten to
  `/acc-app/…`** as served (`rewritePage`, `rewriteScript`; the Google Maps
  `…googleapis.com/maps/api/js` is left alone); (2) **its own sign-in stays**:
  its API calls are passed on with the browser's `connect.sid` and its
  `Set-Cookie` comes back for this origin (`Path=/`, no `Domain`, `Secure`
  only in production) — so each person signs in to the accounts app ONCE,
  inside the frame, with their own accounts account, and it keeps recording
  who did what; the ERP's `ma_session` is never sent on; (3) its router keeps
  the frame at the app's own routes (`/clients/CL-001`), so a GET of any such
  address **asked for by a frame** (`Sec-Fetch-Dest: iframe`) is answered with
  the app's page, never the console. Its uploads (`/uploads/<folder>/<file>`,
  proof pictures and invoices on records) are served through `/acc-app/uploads/…`
  and `/uploads/…` alike, with the cookie. A write must come from our own origin.
  `test/accapp.test.js` against a stand-in Railway.
- **`public/accapp-bridge.js`** goes first in its `<head>`: every stock number
  the app shows that is OUR watch IS the link to our watch, every client name
  that is OUR client IS the link to our client (`POST /api/acc-app/links` —
  a name is ours when exactly one of ours carries it, else as the copied
  ledger ties it to one); a stock number typed into an entry's "Stock no."
  (placeholder `e.g. 1385`) or a part-exchange row fills the model and serial
  from the ERP (`GET /api/acc-app/watch`), through React's own value setter;
  `fetch`/XHR/`window.open` to `/api/…` and `/uploads/…` are re-routed as a
  safety net; and the page the ERP asks for is opened (`#stock=` → the Stock
  report searched for it, `#client=` → that client's own profile when the ERP
  knows which (`GET /api/acc-app/client?name=`), `#path=&q=`), by
  `pushState` + a `popstate` the app's router hears — after the app's own
  sign-in, if that comes first. Console: `accounts.js` — one iframe in
  `#acc-app-host`, kept while other pages show, dropped at sign-out;
  `#/accounts/<page>/<what>` (`PAGES` in `src/accounts/index.js`).
- **The copy is ON** (`ACCOUNTS_SYNC`, on by default; off = the switch-over
  for accounts). `import/accounts/client.js` signs in as the ERP with
  `ACCOUNTS_USERNAME` / `ACCOUNTS_PASSWORD` — **an account made for the ERP in
  the app itself (Admin → Team, approved, password set)**; without them nothing
  is copied and the Import page says so. `import/accounts/sync.js` copies every
  collection into the same three layers — `accounts_records` (as read),
  `accounts_items` (ours; `locked_fields`), `accounts_events`; inline base64
  pictures once each in `accounts_files` (`acfile:<id>`); `stock_nos` and
  `client_ids` GIN-indexed (migration 011). A list of records with an `id`
  (or a `code`, the currencies) is one row per record; anything else (a map,
  a list of plain values) is ONE row under the id `*`, whole. Stock numbers
  come off `stock` (one, or "1385, 1390"), the lines of a settlement, the
  part-exchange rows, and an expense's own "1385 | Client | Commission".
  Deletions mirrored softly (a person's deletion stands; a collection losing
  more than 3% and ten at once refused). Every 15 minutes the whole state;
  between passes the versions every `ACCOUNTS_POLL_SEC` (60) and **only the
  collections that moved** are read again. `npm run import -- accounts`.
- **Which of OUR clients an accounts client is** (`src/accounts/clients.js`),
  by the watches, as for logistics: every entry the app posts against a
  client carries a stock number — a PAYABLE is a purchase (our watch's
  `purchased_from`), a RECEIVABLE a sale (`sold_to`) — each a vote; the winner
  needs twice the runner-up's; one watch alone only when the names look alike;
  a full name that is exactly one of ours decides when no watch does; a
  person's choice (`accounts_client_links`) always wins. **Set on the client
  page's Accounts panel** (4 Nov 2026): each match says how it was made, and
  an editor can *Confirm* it, say *Not them* (none of ours, over the watches),
  *Undo* a decision (the watches decide again), or *Link an accounts client*
  from a picker over the copied clients (`GET /api/acc-app/app-clients?q=`,
  `PUT /api/acc-app/client-link {acc_client_id, client_id|null}`,
  `DELETE /api/acc-app/client-link/:accId` — `setClientLink`,
  `forgetClientLink`).
- **The app's uploads are copied** (4 Nov 2026, for the switch-over): each
  full pass, every `/uploads/<folder>/<file>` our records point at (proofs,
  invoices, ID documents) is fetched with the ERP's own session —
  `ACCOUNTS_FILES_PER_PASS` (200) a pass, four at a time, at most 50 MB,
  pictures and PDFs only — stored once in `accounts_files` (`source_ref` =
  the address) and swapped into our record as `acfile:<id>` (`copyUploads`;
  the raw record keeps the address). Not a change of the record: no history
  entry, no lock. An address that gave nothing is not asked again for a day.
- **Inside the ERP the app opens in its light theme** (the console's look):
  the bridge sets the app's own `app-theme` key to `light` only when the
  person has never chosen one; the app's toggle still rules after that.
- **The Accounts button — on the watch page and on every Inventory card**
  (asked 4 Nov 2026: "see its payments, wallet, history, remaining / paid, and
  its timeline") opens a window in the console's look (`showAccountsWindow`,
  the Logistics window's shape) read from OUR COPY (`GET /api/acc-app/stock/:no`),
  so it works for every role and needs no sign-in to the app: one serif line
  on where the money stands ("Bought from X for AED 46,000, settled · Sold to
  Y for USD 14,000, USD 4,000 still owed"); the facts — bought for / sold for
  with paid and **remaining**, the **wallets** the money went through (the
  app's `accounts` collection, resolved by `_walletAccId`, returned as
  `wallets`), the invoice; the **ledger**, each leg with its **track**: to
  pay / to receive, then every payment with its date, amount (and the amount
  actually paid when in another currency), the wallet it came from or went
  into, the method, the note, its proofs, and what was **left** after it, then
  paid and remaining; **what happened**, in order (legs posted, payments,
  invoice issued, quick sales, expenses, commission); quick sales, documents
  (by the entry's invoice number), expenses, commission; every picture; when
  the copy was read; "See it in the accounts app". `accStory(data)` builds all
  of it and the Timeline reuses it. **When the copy is not there** — no
  account for the ERP in the app yet, or the first pass still to come (seen
  live 4 Nov 2026: "accountancy info not showing up") — the same answer is
  read from the app itself, live, with the person's own accounts sign-in out
  of the frame (their `connect.sid`), else the ERP's (`forStock` → `liveForStock`,
  `fetchStateAs`; seven collections, held a minute per session); `source` says
  `copy`, `live` or `none`, and the window's foot says which and what to set
  up. Live, a client is ours by its name only (the ledger match needs the
  copy). Files on a record (`attachments`, `proofs`,
  `invoiceProof` …): "acfile:<id>" is served from our copy at
  `/api/acc-app/file/:id` (`?thumb=1`), an app upload (`/uploads/…`) through
  `/acc-app/uploads/…` — **with the ERP's own accounts session when the person
  has none** (`erpSessionCookie`, viewers included), a PDF in the same viewer
  as the logistics papers (`lgDocOpen` takes any same-origin address now).
  The client page's **Accounts** panel (`GET /api/acc-app/our-client/:id`):
  which of the app's clients this is and how it was matched, what stands open
  per currency (owed to us / we owe), and "See <name> in Accounts →" (their
  profile in the app).
- **The Timeline button — watch page and Inventory card** (`timeline.js`,
  asked 4 Nov 2026: "a separate timeline button that shows both accountancy
  and logistics combined, with attached pdf"): one window, three lines on
  where it stands (the ERP's status and dates, the logistics line, the
  accounts line), the accounts facts, then ONE story in the order it happened
  with a tag on every line saying whose it is — **ERP / Chrono Key** (bought,
  sold, added, every status change and who made it, from the watch and
  `/api/watches/:id/events`), **Logistics** (`lgStory`, split out of the
  Logistics window: from our copy at once, the app's own answer replacing it
  when the frame has it, editors), **Accounts** (`accStory`) — with the
  pictures and papers on each line (customs papers, invoices, proofs; a PDF
  opens in the viewer), all papers and all pictures again at the foot, and
  **Save as PDF** (the browser's print of the window alone: `@media print`
  hides everything else). Within a day the order is each app's own stage
  order, the ERP's fact first.
- **Not done / to decide:** the app's own client picker cannot be fed our
  names (a React SearchSelect over its state). Found in the app, for its
  owner: a break-glass `admin` login exists in its code (disabled unless a
  strong `ADMIN_PASS` is set); `/api/deploy-log` is public.

## Additional expenditures per watch (4 Nov 2026)

Asked for: "an option where I can add a watch's additional expenditures …
what we know from logistics and accounting such as movement cost, commission;
but sometimes we sell and move in bulk and it gets confusing, so a manual
entry per watch that we add by typing" — then: "in the empty space below"
the prices, and "the manual is not a correction … it's for overview".
`src/watches/costs.js`, migration 014 (`watch_costs`), the panel under the
dossier's price line (`renderCosts` in `app.js`, `.dossier-costs`).

- **Two groups, side by side when the dossier's body is 900px or wider**
  (a container query), stacked otherwise. **From Logistics and Accounts**:
  read-only, each line tagged with its app — the logistics copy's cost lines
  (`logisticCosts`, by trip or shipment), shipments' and couriers' costs, the
  movements and polish on the watch's own stock rows; the accounts app's
  expenses, the commission settled on the stock number, the costs on a ledger
  leg (`forStock`: the copy, else live with the person's sign-in). **A line
  the app ties to several watches at once** (a courier that carried 1700 and
  1718 — the bulk case) is marked "shared with … · not in the total" and left
  out of the sums: how it splits is nobody's guess. **Added here**: typed by
  a person — kind (shipping, customs, service, commission, insurance, travel,
  other), title, amount and currency (required; never converted), paid on,
  paid by, note — the ERP's own overview of what the watch cost beyond its
  price; not a correction of the apps' lines, never written to either app.
  Totals per currency: the apps', the typed, and all together, in the head.
- `GET /api/watches/:id/costs` (`costsOf`: `known`, `added`, `totals`,
  `shared`, where each app's answer came from), `POST` / `PATCH
  /:cid` / `DELETE /:cid` (editors; at most 100 a watch; a date that does not
  exist is refused; soft delete). Every add, change and removal is in the
  watch's history (`cost_add` / `cost_edit` with old → new / `cost_remove`).
  The **Timeline** shows each typed line as an ERP line on the day it was
  paid; the model's picture carries them as `costs_added_here`.
- Test in `test/accapp.test.js` (the accounts copy and two logistics cost
  rows, one shared). Checked in the browser on this PC's copy with the API
  stubbed in the page (the backup database stays unwritten).

## Claude in the ERP (4 Nov 2026)

Asked for: "add api to the tool so it can read through everything easily and
be smart about what and how to show the data combined and in a good manner".
`src/ai/`, through the official SDK (`@anthropic-ai/sdk`), **read-only**:
nothing the model says is written anywhere, and it has no tool that writes.

- **On when `ANTHROPIC_API_KEY` is set** on the server (`config.ai`; the
  console learns it from `/api/meta`'s `ai.enabled` and hides the buttons
  otherwise). `AI_MODEL` (default `claude-opus-5-5`, the current Opus) and
  `AI_EFFORT` (default `medium`). Every request carries the server-side
  refusal fallback (`fallbacks: "default"`, beta
  `server-side-fallback-2026-07-01`), so a declined request is re-run on
  another model rather than left blank; the house prompt is cached
  (`cache_control`); forced `tool_choice` is never used (Opus 5.5 refuses it).
- **What the model reads** (`ai/context.js`): `watchPicture` — the ERP's
  record (the fields that matter, `status_why`), its two clients, the history
  as changes (who moved what, when), what the reference has sold for, the same
  watch's other purchases, the logistics app's story from our copy
  (`passport`), the accounts ledger (`forStock`: our copy, or live with the
  person's sign-in — the cookie goes with the question); `clientPicture`,
  `searchWatches`, `searchClients`, `accountsOpen` (every entry with money
  outstanding, each way, with totals per currency), `logisticsWhere`. All
  through `trim`: pictures, papers, inline files, provenance histories and
  secrets out; lists capped at 60; texts at 400 characters.
- **The brief** (`GET /api/ai/watch/:id/brief`, `briefWatch`): the picture in
  one request, the answer as DATA FOR A PICTURE (structured output,
  `output_config.format` json_schema; asked the same day after the first
  prose version: "instead of this overwhelming data show diagrams and a
  timeline, easy to understand"): `headline` (one short sentence), `journey`
  (eight stages — bought, paid, shipped, arrived, in_stock, sold, delivered,
  received — each done / partial / pending / not_yet / unknown with a date
  and a few words), `money` (bought, paid, sold, received, costs as figures
  with their currency, one note), `moments` (5–10 turning points with their
  source and tone), `attention` (≤ 4), `missing` (≤ 3). **Kept in
  `ai_briefs`** (migration 013) with the picture's fingerprint (`fingerprint`:
  the picture without its read times), served from there at once across
  restarts until something about the watch changes ("this loads way too
  slow", 4 Nov 2026 — the first draw of a watch is the only slow one). Drawn
  at **low effort** (`AI_BRIEF_EFFORT`; extraction over data it is handed) by
  `AI_BRIEF_MODEL` (default `AI_MODEL`; set `claude-sonnet-5-5` here if the
  first draw is still too slow) from a `compact` picture: the last 15
  history changes, 12 records per logistics list, 5 reference sales. The
  waiting line counts the seconds and says the full story is already below. Drawn at the top of the watch's
  **Timeline** ("In one read", `aiBrief` in `ask.js`): the journey as a
  stepper (a dot per stage, filled when done), the money as two bars (paid of
  bought, received of sold) with costs under them, the moments as a short
  timeline with source tags, then the flags — and a line saying the model
  drew it and to check a figure before acting on it.
- **Ask** (`POST /api/ai/ask` `{question, history, watch_id?}`, `ask`): the
  SDK's tool runner (`client.beta.messages.toolRunner`, `betaTool` with raw
  JSON schemas, at most 8 iterations) over six tools — `search_watches`,
  `watch_picture`, `find_clients`, `client_picture`, `accounts_open`,
  `logistics_where`. The page keeps the conversation (last 12 turns, text
  only) and sends it back each time; about a watch, its picture opens the
  first turn. Answers are asked for short, a one-line answer then "- " lines,
  stock numbers as "#1668" and clients by name — the page makes those links
  through `/api/acc-app/links` (`aiText`, `aiLinks`). On the Timeline (about
  that watch) and from the **Ask** button in the bar (about anything).
- `test/ai.test.js` against a stand-in Anthropic API (`ANTHROPIC_BASE_URL`,
  which the SDK honours): what the model was given, the brief's shape and
  cache, the tool round-trip, the conversation carried. Not tried against the
  real API from this PC (no key here): the first live run is the check.
- **Cost**: a brief is one request of roughly 10–30k input tokens
  (Opus 5.5: $4 per million in); a question two to four. The ten-minute hold
  and the cached house prompt keep repeats cheap. Switch to
  `AI_MODEL=claude-sonnet-5-5` if it adds up.

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

## Documents per watch (4 Nov 2026)

On the "not done" list since the start; done with the rest of "fix
everything". `src/watches/documents.js`, migration 012 (`watch_documents`):
the invoice, the papers, a customs form, a receipt — a PDF or a picture (the
same `saveDocument` as an expense's payment copies: a PDF as it is, a picture
with its 480px thumbnail), with a `kind` (invoice, papers, customs, receipt,
other) and the name it was uploaded under. `GET/POST
/api/watches/:id/documents` (editors post, up to 30 a watch, `kind` in the
form), `DELETE /api/watches/:id/documents/:did` (soft), the file at
`/api/watch-documents/:did` (`?thumb=1`, `?download=1`) behind the sign-in,
framed only by our own PDF viewer. Every add and remove is in the watch's
history (`document_add`, `document_remove`). The watch page's **Papers**
panel lists them (a PDF opens in the viewer, `lgDocOpen`), with a drop zone
and the kind for editors; the **Timeline** shows each as an ERP line when it
was added and in its Papers at the foot; the model's brief lists their names.
Chrono Key's own 249 PDFs are still not copied (the detail pass refuses them
as "not a picture") — the next step for this table.

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
| `frontend-design` | reshaping a console page's look and wording (Anthropic's, Apache-2.0, from `anthropics/claude-plugins-official` @ `44490cc`). Within the console's own look — EB Garamond / Hanken Grotesk, the warm palette in `index.html` — not a new one per page |

| VectorLab UI/UX (21) | any console page: `page-patterns`, `viewports`, `typography`, `spacing`, `colour-palette`, `anti-slop`, `verbs` / `labels` / `errors`, `empty-states`, `loaders`, `motion`, `surfaces`, `forms`, `keyboard`, … and `ux-audit` before finishing (MIT, `VectorLabAU/skills` @ `0756cc9`; `.claude/skills/LICENSE-vectorlab`) |

More are added when a task would gain from one (asked 24 Oct 2026: "always add skills you think are good for the project"): read whole first, open licence, reputable source, copied unchanged.

## UI/UX skills

Taste, a11y, bans, voice, and icon library for this project live in `.ux-profile.md`.
Run `setup-ui-ux-skills` again only to change those defaults.
Before UI or microcopy work, read `.ux-profile.md`, then the matching domain skill (page-patterns, viewports, forms, surfaces, loaders, empty-states, copy, motion).
Before creating a new page, read `page-patterns` and name the pattern. Do not write page markup until the pattern is named.
Layouts must pass `viewports` at 375px and 1280px.
Before finishing UI, run `ux-audit`.

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
npm test                  # EMPTIES the test database first (TEST_DATABASE_URL)
npm run test:local        # the same, on a fresh embedded Postgres it starts and stops itself
npm run import -- csv ProductList.csv
npm run import -- list | details [new|active|full] [limit] | vault | logistics | accounts | all
npm run import -- tidy-photos     # hide repeats among photos already copied
npm run user -- add someone@example.com editor 'a-long-password' Name
```

Tests need a Postgres at `TEST_DATABASE_URL` (default
`postgres://postgres@localhost:5433/masterapp_test`) — it is wiped each run.
`npm run test:local` (`test/run-local.mjs`) needs nothing: it starts a fresh
embedded Postgres in a temporary folder, runs the suite and stops it. Start
one each time — an embedded server kept running across whole suite runs was
seen to start refusing connections (4 Nov 2026).

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
- (Done 4 Nov 2026: `watch_documents`.) Chrono Key's own PDFs — 249 on 136
  pages — are still not copied into it.
- Sale currency for imported sales (could come from InvoiceWEB's Buy & Sell
  ledger, which reads the sales group).
- Writing back to Chrono Key or the vault — deliberately not done.
- **Port to InvoiceWEB**: its Chrono Key client follows a sign-in redirect to
  any host, cookies and all. masterapp's (`chronokey/client.js`, `login`) now
  refuses one off Chrono Key's host (23 Oct 2026); the two should agree again.
- The rest of the ERP: customers/suppliers, invoices (InvoiceWEB), payments,
  consignment, accounting.
