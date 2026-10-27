import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';

/*
 * The stock-by-place tabs (London Stock, Dubai Stock, HK Stock — one engine,
 * as in the logistics app): what is in stock, its history, its spares, the HK
 * situation board; every row linked to our watch and its clients by id, a
 * typed name by linksByName; and what each page says about a watch for its
 * Inventory card (forStock). Against a real Postgres (TEST_DATABASE_URL),
 * which is EMPTIED first.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let worker, base, m, db, dataDir, server, api, state;

const RECEIVED = Date.UTC(2026, 9, 12); // 12 Oct 2026
const MOVED = Date.UTC(2026, 9, 20, 10, 36); // 20 Oct 2026

function fixture() {
  return {
    settings: { fobPassword: 'secret-fob' },
    clients: [
      { id: 'c1', name: 'Dealer One', country: 'UAE' },
      { id: 'c2', name: 'Buyer Two' },
    ],
    londonStock: [
      {
        id: 'L1', stockNumber: '1668', brand: 'Rolex', watchModel: 'Lady-Datejust', watchReference: '279171', watchSerial: 'S1', watchDate: '09/2025',
        from: 'Dealer One', status: 'current', inMayfair: 'yes', inNcl: '', receivedAt: RECEIVED, createdAt: RECEIVED,
        buyPrice: 10000, buyCurrency: 'GBP', b2bPrice: 12000, b2bCurrency: 'USD', b2cPrice: null,
        accessoriesPresent: 'Watch, Warranty Card', accessoriesMissing: 'Box', needPolish: false,
        caseDiameter: '28mm', caseMaterial: 'Steel', dial: 'Silver', notes: 'in the window', photos: [],
      },
      {
        id: 'L2', stockNumber: '1700', brand: 'Patek Philippe', watchModel: 'Nautilus', status: 'moved', movedAt: MOVED, createdAt: RECEIVED - 1000,
        movements: [{ id: 'm1', ts: MOVED, date: '2026-10-20', moveType: 'dubai', destination: 'Dubai Stock', carrier: 'by hand', takenAccessories: ['Watch'], leftSpareAccessories: ['Box', 'Booklet'] }],
      },
      { id: 'L3', stockNumber: '1801', brand: 'Rolex', watchModel: 'Daytona', status: 'consignment', createdAt: RECEIVED + 1, consignment: { with: 'Dealer One', direction: 'to_client', date: '2026-10-15', returnDate: '2026-11-01', accessories: 'Watch' } },
      { id: 'L4', stockNumber: '1802', brand: 'Rolex', watchModel: 'Submariner', status: 'consignment', createdAt: RECEIVED + 2, consignment: { with: 'Buyer Two', direction: 'from_client', date: '2026-10-16' } },
      { id: 'L5', stockNumber: '1803', brand: 'Tudor', watchModel: 'Black Bay', status: 'current', needPolish: true, createdAt: RECEIVED + 3 },
      { id: 'L6', stockNumber: '1804', brand: 'Tudor', watchModel: 'Pelagos', status: 'current', needPolish: true, createdAt: RECEIVED + 4, polish: { status: 'at_polish', sentTo: 'Polisher X', sentDate: '2026-10-01', expectedBack: '2026-10-30' } },
    ],
    londonSpares: [{ id: 'sp1', brand: 'Patek Philippe', accessory: 'Box', qty: 2, fromStock: '1700', fromWatch: 'Nautilus', notes: 'Left when 1700 moved to Dubai Stock', addedAt: MOVED }],
    dubaiStock: [{ id: 'D1', stockNumber: '1900', brand: 'Rolex', watchModel: 'GMT-Master II', status: 'current', inOffice: 'yes', inSafe: '', receivedAt: RECEIVED }],
    hkStock: [{ id: 'H1', stockNumber: '1950', brand: 'Patek Philippe', watchModel: 'Calatrava', status: 'current', inVault: 'box 3', receivedAt: RECEIVED }],
    hkSituation: [
      { id: 'S1', stockNumber: '1950', brand: 'Patek Philippe', description: '1950 · Patek Philippe · Calatrava', section: 'in_hand', holder: 'RK', stockStatus: 'WITH RK', createdAt: RECEIVED + 10 },
      { id: 'S2', stockNumber: '1960, 1961', brand: 'Rolex', description: '1960 · Rolex · Daytona\n1961 · Rolex · GMT', section: 'incoming', holder: '', linkedShipmentId: 'ship1', createdAt: RECEIVED + 20 },
      {
        id: 'S3', stockNumber: '1970', brand: 'Rolex', description: '1970 · Rolex · Day-Date', section: 'sold', holder: 'IN SAFE', createdAt: RECEIVED + 30,
        movements: [{ id: 'hm1', ts: MOVED, date: '2026-10-20', fromSection: 'in_hand', fromHolder: 'RK', toSection: 'sold', sale: { clientName: 'Buyer Two', price: 'HKD 90,000', givenAccessories: ['Watch'], remainingAccessories: ['Box'] } }],
      },
    ],
    accCollect: [{ id: 'ac1', stockNumber: '1668', items: 'links', fromClient: 'Dealer One' }],
    accGive: [{ id: 'ag1', stockNumber: '1668', items: 'extra strap', toClient: 'Buyer Two' }],
    activity: [],
  };
}

before(async () => {
  worker = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-worker-token'] !== 'vault-key') {
        res.statusCode = 401;
        return res.end('{"error":"Unauthorized"}');
      }
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/state') return res.end(JSON.stringify({ data: state }));
      if (url.pathname === '/api/vault-photos') return res.end('{"data":{}}');
      if (url.pathname === '/api/version') return res.end('{"version":1}');
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => worker.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${worker.address().port}`;
  state = fixture();

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lgstock-'));
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
    sync: await import('../src/import/logistics/sync.js'),
    pages: await import('../src/logistics/pages/index.js'),
    london: await import('../src/logistics/pages/londonstock.js'),
  };
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/auth/index.js')).ensureFirstAdmin(() => {});
  db = m.db.query;
  server = (await import('../src/web/server.js')).createServer().listen(0);
  api = `http://127.0.0.1:${server.address().port}`;

  // Our watches and clients: the rows link to them by stock number and Chrono Key's client ids, never by the typed names.
  const seller = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Khawar', 'Saeed', 'manual') RETURNING id")).rows[0].id;
  const buyer = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Parsa', 'Nouri', 'manual') RETURNING id")).rows[0].id;
  await db(
    `INSERT INTO watches(stock_no, brand, model, origin, status, purchased_from_client_id, sold_to_client_id) VALUES
       ('1668', 'Rolex', 'Lady-Datejust', 'manual', 'in_stock', $1, NULL),
       ('1700', 'Patek Philippe', 'Nautilus', 'manual', 'sold', $1, $2),
       ('1801', 'Rolex', 'Daytona', 'manual', 'in_stock', NULL, NULL),
       ('1950', 'Patek Philippe', 'Calatrava', 'manual', 'in_stock', NULL, NULL),
       ('1961', 'Rolex', 'GMT-Master II', 'manual', 'incoming', NULL, NULL),
       ('1970', 'Rolex', 'Day-Date 40', 'manual', 'sold', NULL, $2)`,
    [seller, buyer]
  );
  await m.sync.syncLogistics();
});

after(async () => {
  server.close();
  worker.close();
  await m.db.pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

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

/* The page as the API serves it, signed in once. */
let admin;
async function page(key) {
  if (!admin) {
    admin = client();
    await admin.login('boss@example.com', 'admin-password-1');
  }
  const r = await admin.call('GET', `/api/logistics/page/${key}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test('London Stock: in stock as the app counts it, each row linked to our watch and its clients, the typed names as far as they go', async () => {
  const r = await page('londonstock');
  assert.equal(r.place, 'London');
  assert.deepEqual(r.corners, [{ key: 'inMayfair', label: 'In Mayfair' }, { key: 'inNcl', label: 'In NCL' }]);
  // current + consignment are in stock (the app's isVisibleInStock); moved is history.
  assert.equal(r.counts.in_stock, 5);
  assert.equal(r.counts.plain, 3);
  assert.equal(r.counts.consignment_to, 1);
  assert.equal(r.counts.consignment_from, 1);
  assert.equal(r.counts.need_polish, 1, 'needs polish and not at the polisher');
  assert.equal(r.counts.at_polish, 1);
  assert.equal(r.counts.moved, 1);
  assert.deepEqual(r.counts.corners, [{ key: 'inMayfair', label: 'In Mayfair', n: 1 }, { key: 'inNcl', label: 'In NCL', n: 0 }]);
  assert.deepEqual(r.watches.map((w) => w.stock_no), ['1804', '1803', '1802', '1801', '1668'], 'newest first, as the app sorts');

  const w = r.watches.find((x) => x.stock_no === '1668');
  assert.equal(w.watch.stock_no, '1668', 'our watch');
  assert.equal(w.watch.bought_from.name, 'Khawar Saeed', 'our client by Chrono Key’s id, not the typed "Dealer One"');
  assert.equal(w.watch.sold_to, null);
  assert.equal(w.from, 'Dealer One');
  assert.ok(w.from_link?.lg_client_id, 'the typed name links to the logistics client of that name');
  assert.equal(w.from_link.client_id, null, 'not one of ours by its watches: no guess by name');
  assert.deepEqual(w.cost, { amount: 10000, currency: 'GBP' });
  assert.deepEqual(w.b2b, { amount: 12000, currency: 'USD' });
  assert.equal(w.b2c, null);
  assert.deepEqual(w.corners, [{ key: 'inMayfair', label: 'In Mayfair', value: 'yes' }]);
  assert.equal(w.corner, 'Mayfair');
  assert.equal(w.received_at, new Date(RECEIVED).toISOString());
  assert.equal(w.accessories_missing, 'Box');
  assert.deepEqual(w.pending_collect, ['links'], 'the app’s pending badge: accCollect of that stock number');
  assert.deepEqual(w.pending_give, ['extra strap']);
  assert.equal(w.status, 'current');
  assert.equal(w.consignment, null);

  const c = r.watches.find((x) => x.stock_no === '1801');
  assert.equal(c.status, 'consignment');
  assert.equal(c.consignment.direction, 'to_client');
  assert.equal(c.consignment.with, 'Dealer One');
  assert.equal(c.consignment.date, '2026-10-15');
  assert.equal(c.consignment.return_date, '2026-11-01');
  assert.ok(c.consignment.with_link?.lg_client_id);
  assert.equal(r.watches.find((x) => x.stock_no === '1802').consignment.direction, 'from_client');
  const p = r.watches.find((x) => x.stock_no === '1804');
  assert.deepEqual(p.polish, { sent_to: 'Polisher X', sent_date: '2026-10-01', expected_back: '2026-10-30', status: 'at_polish' });
  assert.equal(r.watches.find((x) => x.stock_no === '1803').polish, null);
  assert.equal(r.watches.find((x) => x.stock_no === '1803').need_polish, true);
});

test('London Stock: the history is the rows moved out, with the move that took them; the spares by brand link to our watch', async () => {
  const r = await page('londonstock');
  assert.equal(r.history.length, 1);
  const h = r.history[0];
  assert.equal(h.stock_no, '1700');
  assert.equal(h.status, 'moved');
  assert.equal(h.moved_at, new Date(MOVED).toISOString());
  assert.equal(h.movements[0].destination, 'Dubai Stock');
  assert.equal(h.movements[0].carrier, 'by hand');
  assert.deepEqual(h.movements[0].taken, ['Watch']);
  assert.deepEqual(h.movements[0].left, ['Box', 'Booklet']);
  assert.equal(h.watch.sold_to.name, 'Parsa Nouri');

  assert.equal(r.counts.spares, 1);
  assert.equal(r.counts.spare_items, 2);
  const s = r.spares[0];
  assert.equal(s.accessory, 'Box');
  assert.equal(s.qty, 2);
  assert.equal(s.from_stock, '1700');
  assert.equal(s.watch.stock_no, '1700', 'the spare’s stock number is our watch');
  assert.equal(s.added_at, new Date(MOVED).toISOString());
});

test('Dubai Stock: the same engine with Dubai’s corners (office / safe)', async () => {
  const r = await page('dubaistock');
  assert.equal(r.place, 'Dubai');
  assert.deepEqual(r.corners.map((c) => c.key), ['inOffice', 'inSafe']);
  assert.equal(r.counts.in_stock, 1);
  assert.equal(r.watches[0].stock_no, '1900');
  assert.equal(r.watches[0].corner, 'office');
  assert.equal(r.watches[0].watch, null, 'not in our stock list: said so, never guessed');
  assert.equal(r.situation, undefined, 'the HK board is Hong Kong’s only');
});

test('HK Stock: the stock rows (vault / with client) AND the app’s HK situation board — sections, holder, status, a sale in its movements', async () => {
  const r = await page('hkstock');
  assert.equal(r.place, 'Hong Kong');
  assert.deepEqual(r.corners.map((c) => c.key), ['inVault', 'withClient']);
  assert.equal(r.watches[0].stock_no, '1950');
  assert.deepEqual(r.watches[0].corners, [{ key: 'inVault', label: 'In vault', value: 'box 3' }], 'a corner that says where keeps its words');
  assert.equal(r.watches[0].corner, 'vault: box 3');

  const b = r.situation;
  assert.deepEqual(
    b.sections.map((s) => [s.key, s.n]),
    [['in_hand', 1], ['incoming', 1], ['outgoing', 0], ['sold', 1]],
    'the app’s HK_SECTIONS, in its order'
  );
  assert.deepEqual(b.holders, ['IN SAFE', 'RK']);
  assert.deepEqual(b.rows.map((x) => x.section), ['in_hand', 'incoming', 'sold'], 'by section, the app’s default order');
  const inHand = b.rows[0];
  assert.equal(inHand.holder, 'RK');
  assert.equal(inHand.stock_status, 'WITH RK');
  assert.equal(inHand.section_title, 'HK Stock (In Hand)');
  assert.equal(inHand.watch.stock_no, '1950');
  const inc = b.rows[1];
  assert.deepEqual(inc.stock_nos, ['1960', '1961'], 'an incoming group names several watches');
  assert.equal(inc.watches[0], null, '1960 is not ours');
  assert.equal(inc.watches[1].stock_no, '1961', '1961 is');
  assert.equal(inc.linked_shipment, 'ship1');
  const sold = b.rows[2];
  assert.equal(sold.watch.sold_to.name, 'Parsa Nouri', 'our buyer by Chrono Key’s id');
  const sale = sold.movements[0].sale;
  assert.equal(sale.client, 'Buyer Two');
  assert.ok(sale.client_link?.lg_client_id, 'the typed buyer links to the logistics client of that name');
  assert.equal(sale.price, 'HKD 90,000');
  assert.deepEqual(sale.given, ['Watch']);
  assert.deepEqual(sale.still_owed, ['Box']);
  assert.equal(sold.movements[0].from_section, 'HK Stock (In Hand)');
  assert.equal(sold.movements[0].to_section, 'Sold Stock');
});

test('forStock: what each place says about a watch for its Inventory card — place and corner since when, consignment, polish, what is missing, the HK board', async () => {
  const facts = await m.pages.factsFor(['1668', '1801', '1802', '1804', '1803', '1700', '1900', '1950', '1970']);
  const of = (no, pg) => (facts.get(no) || []).filter((f) => f.page === pg).map((f) => [f.text, f.tone]);
  assert.deepEqual(of('1668', 'londonstock'), [
    ['In London (Mayfair) since 12 Oct 2026', 'good'],
    ['Missing: Box', 'bad'],
  ]);
  assert.deepEqual(of('1801', 'londonstock'), [['On consignment with Dealer One from London since 15 Oct 2026, due back 1 Nov 2026', 'warn']]);
  assert.deepEqual(of('1802', 'londonstock'), [['In London on consignment from Buyer Two since 16 Oct 2026', 'warn']]);
  assert.deepEqual(of('1804', 'londonstock'), [
    ['In London', 'good'],
    ['At polish with Polisher X since 1 Oct 2026, back 30 Oct 2026', 'warn'],
  ]);
  assert.deepEqual(of('1803', 'londonstock'), [
    ['In London', 'good'],
    ['Needs polish', 'warn'],
  ]);
  assert.deepEqual(of('1700', 'londonstock'), [], 'moved out: history, nothing to say');
  assert.deepEqual(of('1900', 'dubaistock'), [['In Dubai (office) since 12 Oct 2026', 'good']]);
  assert.deepEqual(of('1900', 'londonstock'), []);
  assert.deepEqual(of('1950', 'hkstock'), [
    ['In Hong Kong (vault: box 3) since 12 Oct 2026', 'good'],
    ['In Hong Kong, in hand — held by RK, WITH RK', 'good'],
  ]);
  assert.deepEqual(of('1970', 'hkstock'), [['Sold in Hong Kong to Buyer Two — held by IN SAFE', '']]);
  const link = (facts.get('1668') || []).find((f) => f.page === 'londonstock').link;
  assert.match(link, /^#\/lg\/\d+$/, 'a fact opens the row’s record');

  // The pure function, straight: rows another kind's are not this place's.
  const rows = [{ id: 7, kind: 'dubaiStock', data: { stockNumber: '1668', status: 'current' } }];
  assert.deepEqual(m.london.stockFacts('london', '1668', rows), []);
  assert.deepEqual(m.london.stockFacts('dubai', '1668', rows), [{ text: 'In Dubai', link: '#/lg/7', tone: 'good' }]);
});
