import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';

/*
 * Three of the logistics app's pages in masterapp — In Consignment, Sold
 * Stocks and Refinement (polish) — read from our copy of its records: what
 * each page lists and counts, every stock number linked to our watch and its
 * clients by id, a typed name linked as far as it goes, what each page says
 * about one watch (forStock), and the one record change allowed on the
 * Refinement page (send to / back from polish through the API). Against a
 * real Postgres (TEST_DATABASE_URL), which is EMPTIED first; no worker — the
 * records are inserted as the sync would leave them.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let rates, base, m, db, dataDir, server, api;

before(async () => {
  // A stand-in for the converter's rate source (USD-based, as Coinbase answers): no test reaches the internet.
  rates = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { rates: { USD: '1', EUR: '0.9', GBP: '0.8', AED: '3.6725', HKD: '7.8' } } }));
  });
  await new Promise((r) => rates.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${rates.address().port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lg-sold-'));
  Object.assign(process.env, {
    DATABASE_URL: DB,
    DATA_DIR: dataDir,
    VAULT_URL: `${base}/api/state`,
    VAULT_TOKEN: 'vault-key',
    CHRONOKEY_USERNAME: '',
    CHRONOKEY_PASSWORD: '',
    ADMIN_EMAIL: 'boss@example.com',
    ADMIN_PASSWORD: 'admin-password-1',
    SYNC: 'off',
    RATES_LIVE_URL: `${base}/rates/live`,
    RATES_DAILY_URL: `${base}/rates/live`,
  });
  const reset = new pg.Client({ connectionString: DB });
  await reset.connect();
  await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await reset.end();
  m = {
    db: await import('../src/db/index.js'),
    pages: await import('../src/logistics/pages/index.js'),
    consignment: await import('../src/logistics/pages/consignment.js'),
    sold: await import('../src/logistics/pages/soldstocks.js'),
    refinement: await import('../src/logistics/pages/refinement.js'),
  };
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/auth/index.js')).ensureFirstAdmin(() => {});
  db = m.db.query;
  server = (await import('../src/web/server.js')).createServer().listen(0);
  api = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  rates.close();
  await m.db.pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const add = async (kind, data, stock, sourceId = null) =>
  (await db("INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ($1, $2, $3, $4, 'manual') RETURNING id", [kind, sourceId, data, stock])).rows[0].id;
const rowsOf = async (no) => (await db('SELECT * FROM logistics_items WHERE deleted_at IS NULL AND stock_nos @> ARRAY[$1]::text[] ORDER BY id', [no])).rows;

const ids = {};

test('the fixture: our watches and clients, the logistics clients, and the app’s records as copied', async () => {
  const client = async (fore, sur) => (await db('INSERT INTO clients(forename, surname, origin) VALUES ($1, $2, $3) RETURNING id', [fore, sur, 'manual'])).rows[0].id;
  ids.seller = await client('Khawar', 'Saeed');
  ids.buyer = await client('Parsa', 'Nouri');
  ids.robin = await client('Robin', 'Casanova');
  const watch = async (no, status, more = {}) =>
    (
      await db(
        "INSERT INTO watches(stock_no, brand, model, origin, status, purchased_from_client_id, sold_to_client_id, sale_price, sale_currency, sale_date) VALUES ($1, 'Rolex', 'Daytona', 'manual', $2, $3, $4, $5, $6, $7) RETURNING id",
        [no, status, more.from || null, more.to || null, more.price || null, more.currency || '', more.date || null]
      )
    ).rows[0].id;
  // Sold on Chrono Key to Robin — so the logistics client of that name is linked to ours by this watch, the Clients tab's rule.
  ids.w4101 = await watch('4101', 'sold', { from: ids.seller, to: ids.robin, price: 100000, currency: 'USD', date: '2026-10-09' });
  ids.w4102 = await watch('4102', 'in_stock', { from: ids.seller });
  ids.w4103 = await watch('4103', 'in_stock');
  ids.w4104 = await watch('4104', 'in_stock');
  ids.w4108 = await watch('4108', 'in_stock');
  ids.lgRobin = await add('clients', { name: 'Robin Casanova', country: 'Switzerland' }, [], 'c-robin');
  ids.lgSina = await add('clients', { name: 'Sina Star' }, [], 'c-sina');

  // Consignment: ours with Robin (overdue), a client's with us, one a sale still names (hidden), one coming in, one plain row.
  ids.c4102 = await add(
    'dubaiStock',
    {
      stockNumber: '4102', brand: 'Rolex', watchModel: 'Daytona', watchReference: '126500LN', status: 'consignment', inOffice: true, needPolish: true,
      consignment: { direction: 'to_client', with: 'Robin Casanova', date: '2026-10-01', accessories: 'Watch, Box', returnDate: '2020-01-01', notes: 'Robin took it', photosBefore: [] },
      polish: { id: 'p1', status: 'at_polish', sentTo: 'Sina Star', takenBy: 'Fiaz', itemDescription: 'Links', sentDate: '2026-10-20', expectedBack: '', costAmount: 100, costCurrency: 'AED', createdAt: 1792000000000 },
      polishHistory: [{ id: 'h1', status: 'at_polish', sentTo: 'Sina Star', sentDate: '2026-08-20', returnedDate: '2026-09-01', costAmount: 50, costCurrency: 'USD' }],
    },
    ['4102'],
    'D-4102'
  );
  ids.c4103 = await add('londonStock', { stockNumber: '4103', brand: 'Omega', watchModel: 'Speedmaster', status: 'consignment', consignment: { direction: 'from_client', with: 'Zed Nobody', date: '2026-10-05', accessories: 'Watch' } }, ['4103'], 'L-4103');
  await add('dubaiStock', { stockNumber: '4104', brand: 'Tudor', status: 'consignment', consignment: { direction: 'to_client', with: 'Someone', date: '2026-10-06' } }, ['4104'], 'ORIG-4104');
  ids.c4105 = await add('incomings', { stockNumber: '4105', brand: 'Patek Philippe', reference: '5711', supplier: 'Robin Casanova', location: 'Geneva', status: 'consignment', accessoriesPresent: 'Watch, Papers', eta: '2026-11-02' }, ['4105'], 'I-4105');
  await add('dubaiStock', { stockNumber: '4110', brand: 'Rolex', status: 'current' }, ['4110'], 'D-4110');

  // Sold: 4101 delivered by hand, bought-in and shipped at a cost; 4106 with no delivery date; 4107 waiting for delivery.
  ids.s4101 = await add(
    'soldStocks',
    {
      id: 'S-4101', stockNumber: '4101', brand: 'Rolex', watchModel: 'Daytona', watchReference: '126500LN', watchSerial: 'Z1', originKey: 'dubai', originLocation: '🇦🇪 Dubai',
      soldPrice: 90000, soldCurrency: 'GBP', soldPriceUsd: 114300, soldDate: '2026-10-10', soldToBuyer: 'Robin Casanova', soldFromLocation: 'Dubai office', soldNotes: 'paid by wire',
      deliveredVia: 'in_person', deliveredAt: Date.UTC(2026, 9, 12, 9), shipmentId: 'SH1',
      originRow: { id: 'ORIG-4104', accessoriesPresent: 'Box, Papers', accessoriesMissing: 'Links', inOffice: true, watchDate: '2024' },
      polishHistory: [{ id: 'h1', sentTo: 'Sina Star', returnedDate: '2026-09-01' }, { id: 'h2', sentTo: 'RK', sentDate: '2026-10-01', returnedDate: '2026-10-05', costAmount: 20, costCurrency: 'USD' }],
    },
    ['4101'],
    'S-4101'
  );
  ids.s4106 = await add('soldStocks', { id: 'S-4106', stockNumber: '4106', brand: 'Tudor', soldPrice: 5000, soldCurrency: 'USD', soldPriceUsd: 5000, soldDate: '2026-09-01', soldToBuyer: 'Walk-in', originKey: 'london' }, ['4106'], 'S-4106');
  await add('readyForDelivery', { stockNumber: '4107', brand: 'Rolex', soldPrice: 1, soldCurrency: 'USD', soldDate: '2026-10-20', soldToBuyer: 'Parsa', status: 'pending_ship' }, ['4107'], 'R-4107');
  ids.ship = await add('shipments', { id: 'SH1', stockNumber: '4101', date: '2026-10-11', items: 'Daytona', status: 'delivered', costAmount: 300, costCurrency: 'USD' }, ['4101'], 'SH1');
  await add('logisticCosts', { id: 'LC1', stockNumber: '4101, 4102', title: 'Courier', amount: 200, currency: 'AED', date: '2026-10-11' }, ['4101', '4102'], 'LC1');
  await add('incomings', { id: 'I-4101', stockNumber: '4101', brand: 'Rolex', reference: '126500LN', supplier: 'Khawar Saeed', status: 'arrived', costAmount: 50000, costCurrency: 'USD', eta: '2026-06-01' }, ['4101'], 'I-4101');

  // Polish: a flagged London row, a moved row still carrying a polish (history, not now), two external polishes.
  ids.p4108 = await add('londonStock', { stockNumber: '4108', brand: 'Rolex', watchModel: 'Submariner', status: 'current', inMayfair: true, needPolish: true }, ['4108'], 'L-4108');
  await add('londonStock', { stockNumber: '4109', brand: 'Rolex', status: 'moved', needPolish: true, polish: { id: 'p9', status: 'at_polish', sentTo: 'Old', sentDate: '2026-06-16' } }, ['4109'], 'L-4109');
  ids.e1 = await add('externalPolish', { id: 'E1', description: '4103', sentTo: 'Sina Star', sentDate: '2026-07-30', returnDate: '2026-08-02', cost: 500, costCurrency: 'AED', status: 'done', notes: 'Our watch' }, [], 'E1');
  ids.e2 = await add('externalPolish', { id: 'E2', description: 'Daytona oysterflex', sentTo: 'Sina Star', sentDate: '2026-10-22', expectedBack: '2026-10-23', cost: 0, costCurrency: 'USD', status: 'at_polish', notes: 'Josh’s watch' }, [], 'E2');
});

test('consignment: ours with clients, theirs with us, coming in — linked to our watch and its clients, the typed name as far as it goes; a row a sale still names is left out', async () => {
  const r = await m.consignment.page();
  assert.deepEqual(r.to_client.map((x) => x.stock_no), ['4102']);
  assert.deepEqual(r.from_client.map((x) => x.stock_no), ['4103']);
  assert.deepEqual(r.incoming.map((x) => x.stock_no), ['4105']);
  const ours = r.to_client[0];
  assert.equal(ours.place, 'Dubai');
  assert.deepEqual([ours.with, ours.date, ours.return_by, ours.accessories, ours.notes], ['Robin Casanova', '2026-10-01', '2020-01-01', 'Watch, Box', 'Robin took it']);
  assert.deepEqual(ours.with_link, { lg_client_id: ids.lgRobin, client_id: ids.robin, client_name: 'Robin Casanova' }, 'the typed name: the logistics client, and ours as that one is');
  assert.deepEqual([ours.watch.id, ours.watch.status, ours.watch.bought_from], [ids.w4102, 'in_stock', { id: ids.seller, name: 'Khawar Saeed' }], 'our watch and its client by id');
  assert.equal(r.from_client[0].with_link, null, 'a name no logistics client carries links nowhere');
  assert.equal(r.from_client[0].direction, 'from_client');
  const inc = r.incoming[0];
  assert.deepEqual([inc.supplier, inc.supplier_link.client_id, inc.location, inc.eta, inc.accessories, inc.watch], ['Robin Casanova', ids.robin, 'Geneva', '2026-11-02', 'Watch, Papers', null]);

  assert.deepEqual(m.consignment.forStock('4102', await rowsOf('4102')), [{ text: 'On consignment with Robin Casanova since 1 Oct 2026 · was due back 1 Jan 2020', link: '#/logistics/consignment', tone: 'bad' }]);
  assert.deepEqual(m.consignment.forStock('4103', await rowsOf('4103')), [{ text: "Zed Nobody's watch, held on consignment since 5 Oct 2026", link: '#/logistics/consignment', tone: 'warn' }]);
  assert.deepEqual(m.consignment.forStock('4105', await rowsOf('4105')), [{ text: 'Consignment coming in from Robin Casanova · now in Geneva', link: '#/logistics/consignment', tone: 'move' }]);
  assert.deepEqual(m.consignment.forStock('4110', await rowsOf('4110')), [], 'a row in stock says nothing');
});

test('sold stocks: every sale our watch with our own sale and client beside the app’s typed buyer; the P&L’s lines as the app finds them; the rates to add them up', async () => {
  const r = await m.sold.page();
  assert.deepEqual(r.rows.map((s) => s.stock_no).sort(), ['4101', '4106']);
  assert.equal(r.ready_for_delivery, 1, 'ready for delivery is counted, and left to the Shipments tab');
  const s = r.rows.find((x) => x.stock_no === '4101');
  assert.deepEqual([s.origin, s.sold_date, s.delivered_via, s.delivered_at, s.buyer, s.sold_from, s.price, s.currency, s.price_usd_app, s.notes], ['Dubai', '2026-10-10', 'in_person', '2026-10-12T09:00:00.000Z', 'Robin Casanova', 'Dubai office', 90000, 'GBP', 114300, 'paid by wire']);
  assert.equal(s.buyer_link.client_id, ids.robin, 'the typed buyer, linked as far as the name goes');
  assert.deepEqual(
    [s.watch.id, s.watch.status, s.watch.sold_to, s.watch.bought_from, s.watch.sale_price, s.watch.sale_currency, s.watch.sale_date],
    [ids.w4101, 'sold', { id: ids.robin, name: 'Robin Casanova' }, { id: ids.seller, name: 'Khawar Saeed' }, 100000, 'USD', '2026-10-09'],
    'our sale on Chrono Key, by id — the typed buyer is linked beside it, never merged into it'
  );
  assert.equal(s.shipment_item_id, ids.ship, 'the app’s shipment id finds our copy of the shipment');
  assert.deepEqual(s.condition, { watch_date: '2024', place: 'Office', need_polish: false, present: ['Box', 'Papers'], missing: ['Links'] });
  assert.deepEqual(
    s.costs.map((c) => [c.source, c.currency, c.amount]).sort(),
    [
      ['Logistic cost', 'AED', 100],
      ['Purchase', 'USD', 50000],
      ['Shipment', 'USD', 300],
    ],
    'the app’s costsForStock: the courier split over its two watches, the shipment, the purchase'
  );
  assert.deepEqual(Object.keys(r.rates.table).sort(), ['AED', 'GBP', 'USD'], 'a rate for every currency the sums need');
  assert.equal(r.rates.table.AED, 3.6725);
  const other = r.rows.find((x) => x.stock_no === '4106');
  assert.deepEqual([other.delivered_at, other.watch, other.buyer_link, other.costs], [null, null, null, []]);

  assert.deepEqual(m.sold.forStock('4101', await rowsOf('4101')), [{ text: 'Sold to Robin Casanova on 10 Oct 2026 · delivered by hand on 12 Oct 2026', link: '#/logistics/soldstocks', tone: 'good' }]);
  assert.deepEqual(m.sold.forStock('4106', await rowsOf('4106')), [{ text: 'Sold to Walk-in on 1 Sep 2026 · delivery date not set', link: '#/logistics/soldstocks', tone: 'warn' }]);
  assert.deepEqual(m.sold.forStock('4107', await rowsOf('4107')), [{ text: 'Sold to Parsa on 20 Oct 2026 · awaiting delivery', link: '#/logistics/shipments', tone: 'move' }]);
});

test('refinement: at polish (a row on consignment included, a moved row not), flagged, the history once per polish, external polishes — and the facts on a watch', async () => {
  const r = await m.refinement.page();
  assert.deepEqual(r.at_polish.map((p) => p.stock_no), ['4102'], 'the moved London row’s old polish is not "at polish now"');
  const p = r.at_polish[0];
  assert.deepEqual([p.place, p.item, p.sent_to.name, p.sent_to.link.lg_client_id, p.taken_by, p.sent_date, p.cost, p.watch.id], ['Dubai office', 'Links', 'Sina Star', ids.lgSina, 'Fiaz', '2026-10-20', { amount: 100, currency: 'AED' }, ids.w4102]);
  const grid = Object.fromEntries(r.stock.map((s) => [s.stock_no, s]));
  assert.equal(grid['4102'].state, 'at_polish');
  assert.equal(grid['4102'].on_consignment, true);
  assert.equal(grid['4108'].state, 'flagged');
  assert.equal(grid['4108'].place, 'Mayfair');
  assert.equal(grid['4110'].state, '');
  assert.equal(grid['4109'], undefined, 'a moved row is not stock in place');
  assert.equal(grid['4101'].kind, 'soldStocks', 'a sold watch is in the grid, for the search');
  assert.deepEqual(r.history.map((h) => [h.polish_id, h.stock_no, h.returned_date]), [['h2', '4101', '2026-10-05'], ['h1', '4102', '2026-09-01']], 'one line per polish id, newest return first; the Dubai row’s copy of h1 wins the sold row’s');
  assert.equal(r.history[1].cost.amount, 50);
  assert.deepEqual(r.external.active.map((e) => e.description), ['Daytona oysterflex']);
  const done = r.external.done[0];
  assert.deepEqual([done.description, done.stock_no, done.watch.id, done.cost, done.return_date, done.sent_to.link.lg_client_id], ['4103', '4103', ids.w4103, { amount: 500, currency: 'AED' }, '2026-08-02', ids.lgSina], 'a bare number as the description is our watch');
  assert.ok(r.rates.table.AED && r.rates.table.USD, 'rates for the spend');

  assert.deepEqual(m.refinement.forStock('4102', await rowsOf('4102')), [{ text: 'At polish with Sina Star since 20 Oct 2026 · the links', link: '#/logistics/refinement', tone: 'warn' }]);
  assert.deepEqual(m.refinement.forStock('4108', await rowsOf('4108')), [{ text: 'Needs polish', link: '#/logistics/refinement', tone: 'warn' }]);
  assert.deepEqual(m.refinement.forStock('4101', await rowsOf('4101')), [{ text: 'Polished by RK, back on 5 Oct 2026 · 2 polishes', link: '#/logistics/refinement', tone: 'good' }]);
  assert.deepEqual(m.refinement.forStock('4109', await rowsOf('4109')), [], 'a moved row’s stale polish says nothing');

  // Every page's facts about one watch, as the Inventory card and the watch page read them.
  const facts = (await m.pages.factsFor(['4102'])).get('4102');
  assert.deepEqual(
    facts.filter((f) => ['consignment', 'refinement'].includes(f.page)).map((f) => [f.page, f.tone]),
    [
      ['consignment', 'bad'],
      ['refinement', 'warn'],
    ]
  );
});

/* ── the API ── */

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const headers = { 'X-Requested-With': 'masterapp' };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(api + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  return { call, login: (email, password) => call('POST', '/api/login', { email, password }) };
}

test('the API: the three pages behind the sign-in; back from polish through the one endpoint the Refinement page reuses', async () => {
  const anon = client();
  assert.equal((await anon.call('GET', '/api/logistics/page/consignment')).status, 401);
  const admin = client();
  assert.equal((await admin.login('boss@example.com', 'admin-password-1')).status, 200);
  const c = await admin.call('GET', '/api/logistics/page/consignment');
  assert.equal(c.status, 200);
  assert.deepEqual([c.body.to_client.length, c.body.from_client.length, c.body.incoming.length], [1, 1, 1]);
  const s = await admin.call('GET', '/api/logistics/page/soldstocks');
  assert.equal(s.body.rows.length, 2);
  const f = await admin.call('GET', '/api/logistics/page/refinement');
  assert.equal(f.body.at_polish.length, 1);

  // Back from polish: the Overview's action, reused by the Refinement page — the polish moves into the row's history, the flag clears.
  const done = await admin.call('POST', `/api/logistics/items/${ids.c4102}/polish`, { action: 'done', returnedDate: '2026-10-25', returnNotes: 'like new' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const again = await m.refinement.page();
  assert.deepEqual(again.at_polish, []);
  assert.deepEqual(again.history.map((h) => [h.polish_id, h.returned_date, h.notes])[0], ['p1', '2026-10-25', 'like new']);
  assert.equal(Object.fromEntries(again.stock.map((x) => [x.stock_no, x.state]))['4102'], '');
  assert.deepEqual(m.refinement.forStock('4102', await rowsOf('4102'))[0].text, 'Polished by Sina Star, back on 25 Oct 2026 · 2 polishes');

  // Send to polish again, with a cost: a logistic cost line for the watch, as the app writes one.
  const send = await admin.call('POST', `/api/logistics/items/${ids.p4108}/polish`, { action: 'send', sentTo: 'RK', itemDescription: 'Full Watch', sentDate: '2026-10-26', costAmount: '350', costCurrency: 'aed' });
  assert.equal(send.status, 200, JSON.stringify(send.body));
  assert.equal(send.body.cost, true);
  const third = await m.refinement.page();
  assert.deepEqual(third.at_polish.map((p) => [p.stock_no, p.sent_to.name, p.cost]), [['4108', 'RK', { amount: 350, currency: 'AED' }]]);
  assert.equal(third.history.length, 3);
  assert.equal((await anon.call('POST', `/api/logistics/items/${ids.p4108}/polish`, { action: 'done' })).status, 401, 'never without the sign-in');
});
