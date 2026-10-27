import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import sharp from 'sharp';

/*
 * The logistics app's three accessory pages in masterapp — Missing
 * Accessories, Accessory History, Swaps (src/logistics/pages): the rules
 * ported from the app's own code, every stock number linked to OUR watch and
 * its clients by Chrono Key's ids, the app's client id to the logistics
 * client and to ours as that one is linked, and what each page says about a
 * watch (forStock). Against a stand-in worker and a real Postgres
 * (TEST_DATABASE_URL), which is EMPTIED first.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let worker, base, m, db, dataDir, server, api, state;

const jpeg = (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();

function fixture() {
  return {
    clients: [
      { id: 'c1', name: 'Hayat Dealer', country: 'UAE' },
      { id: 'c2', name: 'Buyer Two', country: 'UK' },
    ],
    // London: a current row with something missing; a row moved away (not counted).
    londonStock: [
      { id: 'L1', stockNumber: '809', brand: 'Rolex', watchModel: 'Datejust 36', watchReference: '126234', status: 'current', accessoriesMissing: 'Booklet' },
      { id: 'L2', stockNumber: '1668', brand: 'Rolex', watchModel: 'Lady-Datejust', status: 'moved', accessoriesMissing: 'Box' },
    ],
    // Dubai: quantities, two tokens, a filler word; a row on consignment is not counted (the app: status must be current).
    dubaiStock: [
      { id: 'D1', stockNumber: '1610', brand: 'Rolex', watchModel: 'Submariner', status: 'current', accessoriesMissing: '3 Links' },
      { id: 'D2', stockNumber: '1502', brand: 'Patek Philippe', watchModel: 'Nautilus', watchReference: '5711', status: 'current', accessoriesMissing: 'Warranty card, Missing box' },
      { id: 'D3', stockNumber: '1555', brand: 'Rolex', status: 'consignment', accessoriesMissing: 'Box' },
      { id: 'D4', stockNumber: '1563', brand: 'Patek Philippe', watchModel: 'Calatrava', watchReference: '5212A-001', status: 'current' },
    ],
    hkStock: [],
    // HK: only the rows in hand count.
    hkSituation: [
      { id: 'H1', stockNumber: '1108', brand: 'Patek Philippe', description: '1108 · Patek Philippe · 5712', section: 'in_hand', accessoriesMissing: 'Box - General' },
      { id: 'H2', stockNumber: '1109', brand: 'Rolex', description: 'gone', section: 'outgoing', accessoriesMissing: 'Box' },
    ],
    safeStock: [],
    soldStocks: [],
    readyForDelivery: [],
    incomings: [],
    shipments: [],
    logisticCosts: [],
    personTrips: [],
    transactions: [
      {
        id: 'T1', date: '2026-10-26', type: 'bought', clientId: 'c1', stockNumber: '1563', createdAt: 1793011404661,
        // No reference typed: the app takes it from the stock row (lookupStockMeta).
        notes: 'Missing on 1563 — collect from Hayat',
        items: [
          { id: 'i1', accessory: 'Watch', qty: 1, direction: 'receive', status: 'pending', settledBy: null, settlementId: null },
          { id: 'i2', accessory: 'Warranty Sheet', qty: 2, direction: 'receive', status: 'pending', settledBy: null, settlementId: null },
          { id: 'i3', accessory: 'Box', qty: 1, direction: 'receive', status: 'done', settledBy: null, settlementId: 'S1' },
          { id: 'i6', accessory: 'Pouch', qty: 1, direction: 'receive', status: 'done', settledBy: 'SW1', settlementId: null },
        ],
      },
      {
        id: 'T2', date: '2026-10-20', type: 'sold', clientId: 'c2', stockNumber: '1610', brand: 'Rolex', reference: '126610LN', createdAt: 1792000000000,
        items: [
          { id: 'i4', accessory: 'Link', qty: 2, direction: 'give', status: 'pending', settledBy: null, settlementId: null },
          { id: 'i5', accessory: 'Pouch', qty: 1, direction: 'give', status: 'done', settledBy: 'SW1', settlementId: null },
        ],
      },
      // A client the app does not list, two transactions the same day: the later created first.
      { id: 'T3', date: '2026-10-26', type: 'bought', clientId: 'zz', fromClient: 'Walk-in', stockNumber: '809', brand: 'Rolex', createdAt: 1793011404000, items: [{ id: 'i7', accessory: 'Strap', qty: 1, direction: 'receive', status: 'pending' }] },
    ],
    settlements: [{ id: 'S1', txId: 'T1', itemIds: ['i3'], direction: 'receive', notes: 'Box came with the watch', ts: 1793100000000, photos: [`${base}/photos/p1.jpg`] }],
    swaps: [{ id: 'SW1', giveTxId: 'T2', giveItemId: 'i5', receiveTxId: 'T1', receiveItemId: 'i6', notes: 'Pouch from 1563 went with 1610', ts: 1793200000000 }],
    activity: [],
  };
}

before(async () => {
  const photo = await jpeg(60, 40, '#3a6');
  worker = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/rates/live') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: { rates: { USD: '1', EUR: '0.9', GBP: '0.8', AED: '3.6725', HKD: '7.8' } } }));
    }
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
    if (url.pathname === '/photos/p1.jpg') {
      res.setHeader('Content-Type', 'image/jpeg');
      return res.end(photo);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => worker.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${worker.address().port}`;
  state = fixture();

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lgacc-'));
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
    missingacc: await import('../src/logistics/pages/missingacc.js'),
    history: await import('../src/logistics/pages/history.js'),
    swaps: await import('../src/logistics/pages/swaps.js'),
  };
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/auth/index.js')).ensureFirstAdmin(() => {});
  db = m.db.query;
  server = (await import('../src/web/server.js')).createServer().listen(0);
  api = `http://127.0.0.1:${server.address().port}`;

  // Our side: the clients Chrono Key ties the watches to, and the watches themselves (1563 lacks its box on Chrono Key).
  const hayat = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Hayat', 'Dealer', 'manual') RETURNING id")).rows[0].id;
  const buyer = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Buyer', 'Two', 'manual') RETURNING id")).rows[0].id;
  await db(
    `INSERT INTO watches(stock_no, brand, model, origin, status, purchased_from_client_id, sold_to_client_id, box, papers) VALUES
       ('1563', 'Patek Philippe', 'Calatrava', 'manual', 'in_stock', $1, NULL, false, true),
       ('1610', 'Rolex', 'Submariner', 'manual', 'sold', NULL, $2, true, true),
       ('809', 'Rolex', 'Datejust 36', 'manual', 'in_stock', NULL, NULL, NULL, NULL)`,
    [hayat, buyer]
  );
  state.ours = { hayat, buyer };
  await m.sync.syncLogistics();
});

after(async () => {
  server.close();
  worker.close();
  await m.db.pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const rowsOf = async (no) => (await db('SELECT * FROM logistics_items WHERE deleted_at IS NULL AND stock_nos && $1::text[] ORDER BY id', [[no]])).rows;

/* ── pure rules, from the app's code ── */

test('missing tokens: the app’s split, quantity and canonical names', () => {
  const { parseMissingTokens, normalizeAccessoryName } = m.missingacc;
  assert.deepEqual(parseMissingTokens('3 Links, Box, Missing 2 link; booklet'), [
    { accessory: 'Link', qty: 3 },
    { accessory: 'Box', qty: 1 },
    { accessory: 'Link', qty: 2 },
    { accessory: 'Booklet', qty: 1 },
  ]);
  assert.deepEqual(parseMissingTokens('Warranty card, Box - General, purchased like this'), [
    { accessory: 'Warranty Card', qty: 1 },
    { accessory: 'Box - General', qty: 1 },
    { accessory: 'Purchased Like This', qty: 1 },
  ]);
  assert.deepEqual(parseMissingTokens(''), []);
  assert.equal(normalizeAccessoryName('manuals'), 'Booklet');
  assert.equal(normalizeAccessoryName('white tag'), 'White Tag', 'not in the app’s table: each word capitalised');
});

/* ── Missing Accessories ── */

test('missing accessories: the rows the app counts, each linked to our watch and clients, Chrono Key’s own lacks beside', async () => {
  const r = await m.missingacc.page();
  assert.deepEqual(
    r.rows.map((x) => [x.place, x.stock_no, x.brand, x.tokens.map((t) => `${t.accessory}×${t.qty}`).join(',')]).sort(),
    [
      ['dubai', '1502', 'Patek Philippe', 'Warranty Card×1,Box×1'],
      ['dubai', '1610', 'Rolex', 'Link×3'],
      ['hk', '1108', 'Patek Philippe', 'Box - General×1'],
      ['london', '809', 'Rolex', 'Booklet×1'],
    ],
    'a row moved away, on consignment, or an HK row not in hand is not counted; a row with nothing missing is not a row'
  );
  const hk = r.rows.find((x) => x.place === 'hk');
  assert.equal(hk.model, '1108 · Patek Philippe · 5712', 'the HK list names the watch by its description');
  const sub = r.rows.find((x) => x.stock_no === '1610');
  assert.equal(sub.watch.id > 0, true);
  assert.deepEqual(sub.watch.sold_to, { id: state.ours.buyer, name: 'Buyer Two' }, 'our client by Chrono Key’s id');
  assert.deepEqual(sub.ck_missing, [], 'Chrono Key lists box and papers');
  assert.equal(r.rows.find((x) => x.stock_no === '1108').watch, null, 'not one of our watches');
  assert.deepEqual(r.brands, ['Patek Philippe', 'Rolex']);
  assert.deepEqual(r.accessories, ['Booklet', 'Box', 'Box - General', 'Link', 'Warranty Card']);

  // What clients need to give us: pending items to receive, by client, by transaction; the app's lookupStockMeta fills the reference.
  const o = r.client_owes;
  assert.equal(o.items, 4, '1 Watch + 2 Warranty Sheet from Hayat, 1 Strap from the unlisted client — settled or to-give items never count');
  assert.deepEqual(
    o.clients.map((c) => [c.name, c.country, c.items]),
    [
      ['Hayat Dealer', 'UAE', 3],
      ['Walk-in', '', 1],
    ],
    'by name; a client the app does not list shows under the typed name'
  );
  const hayat = o.clients[0];
  assert.equal(hayat.link.client_id, state.ours.hayat, 'the app’s client id → the logistics client → our client, by its watches');
  assert.equal(hayat.transactions.length, 1);
  const t = hayat.transactions[0];
  assert.equal(t.reference, '5212A-001', 'reference from the Dubai stock row, as the app’s lookupStockMeta');
  assert.equal(t.brand, 'Patek Philippe');
  assert.deepEqual(t.items, [
    { accessory: 'Watch', qty: 1 },
    { accessory: 'Warranty Sheet', qty: 2 },
  ]);
  assert.deepEqual(t.watch.bought_from, { id: state.ours.hayat, name: 'Hayat Dealer' });
  assert.deepEqual(t.ck_missing, ['Box'], 'Chrono Key says 1563 has no box');
});

test('missing accessories on the watch: what its row lacks where it is now, and what the client still has to give', async () => {
  const { forStock } = m.missingacc;
  const ctx = {};
  assert.deepEqual(forStock('1610', await rowsOf('1610'), ctx), [{ text: 'Missing: Link × 3', link: '#/logistics/missingacc', tone: 'warn' }]);
  const calatrava = forStock('1563', await rowsOf('1563'), ctx);
  assert.equal(calatrava.length, 1);
  assert.equal(calatrava[0].text, 'Client still to give us: Watch, Warranty Sheet × 2');
  assert.match(calatrava[0].link, /^#\/lg\/\d+$/);
  assert.deepEqual(forStock('1668', await rowsOf('1668'), ctx), [], 'a row moved away says nothing');
  // Through the pages' own reader, as the Inventory card gets it.
  const facts = await m.pages.factsFor(['1502']);
  assert.ok(facts.get('1502').some((f) => f.page === 'missingacc' && f.text === 'Missing: Warranty Card, Box'));
});

/* ── Accessory History ── */

test('accessory history: every transaction newest first, its items, its settlements with photos, the client by the app’s id', async () => {
  const r = await m.history.page();
  assert.deepEqual(
    r.transactions.map((t) => [t.stock_no, t.date, t.type, t.pending, t.done]),
    [
      ['1563', '2026-10-26', 'bought', 2, 2],
      ['809', '2026-10-26', 'bought', 1, 0],
      ['1610', '2026-10-20', 'sold', 1, 1],
    ],
    'by date, then by when created — items counted by status, as the app'
  );
  const t1 = r.transactions[0];
  assert.deepEqual([t1.client.name, t1.client.country, t1.client.client_id], ['Hayat Dealer', 'UAE', state.ours.hayat]);
  assert.equal(t1.client_id, 'c1');
  assert.deepEqual(t1.watch.bought_from, { id: state.ours.hayat, name: 'Hayat Dealer' });
  assert.deepEqual(
    t1.items.map((it) => [it.accessory, it.qty, it.direction, it.status, it.settled_by_swap]),
    [
      ['Watch', 1, 'receive', 'pending', false],
      ['Warranty Sheet', 2, 'receive', 'pending', false],
      ['Box', 1, 'receive', 'done', false],
      ['Pouch', 1, 'receive', 'done', true],
    ]
  );
  assert.equal(t1.settlements.length, 1);
  const s = t1.settlements[0];
  assert.equal(s.direction, 'receive');
  assert.deepEqual(s.items, ['Box'], 'the items the settlement names, by id');
  assert.equal(s.notes, 'Box came with the watch');
  assert.equal(s.at, new Date(1793100000000).toISOString());
  assert.equal(s.pictures.length, 1, 'the proof photo, copied by the sync');
  assert.match(s.pictures[0], /^lgfile:\d+$|\/photos\/p1\.jpg$/);
  assert.equal(r.transactions[1].client, null, 'a client the app does not list');
  assert.deepEqual(
    r.clients.map((c) => [c.id, c.name, c.country]),
    [
      ['c2', 'Buyer Two', 'UK'],
      ['c1', 'Hayat Dealer', 'UAE'],
    ],
    'the filter lists every logistics client by name'
  );
  assert.equal(r.settlements, 1);
});

test('accessory history on the watch: what we owe, what is still to collect, what was settled', async () => {
  const { forStock } = m.history;
  assert.deepEqual(
    forStock('1563', await rowsOf('1563'), {}).map((f) => [f.text, f.tone]),
    [
      ['Still to collect: Watch, Warranty Sheet × 2', 'warn'],
      ['Settled: Box, Pouch', 'good'],
    ]
  );
  assert.deepEqual(
    forStock('1610', await rowsOf('1610'), {}).map((f) => [f.text, f.tone]),
    [
      ['We still owe: Link × 2', 'warn'],
      ['Settled: Pouch', 'good'],
    ]
  );
});

/* ── Swaps ── */

test('swaps: each side’s transaction, item and client, linked to our watch; on the watch, what a swap settled', async () => {
  const r = await m.swaps.page();
  assert.equal(r.swaps.length, 1);
  const s = r.swaps[0];
  assert.equal(s.at, new Date(1793200000000).toISOString());
  assert.equal(s.notes, 'Pouch from 1563 went with 1610');
  assert.deepEqual([s.give.reference, s.give.accessory, s.give.qty, s.give.type, s.give.client.name], ['126610LN', 'Pouch', 1, 'sold', 'Buyer Two']);
  assert.deepEqual(s.give.watch.sold_to, { id: state.ours.buyer, name: 'Buyer Two' });
  assert.deepEqual([s.receive.stock_no, s.receive.accessory, s.receive.client.client_id], ['1563', 'Pouch', state.ours.hayat]);
  assert.deepEqual(m.swaps.forStock('1610', await rowsOf('1610'), {}), [{ text: 'Settled by a swap: Pouch', link: '#/logistics/swaps', tone: 'good' }]);
  assert.deepEqual(m.swaps.forStock('809', await rowsOf('809'), {}), []);

  // A swap whose transactions the app no longer has: '?' on both sides, as the app shows it, never a crash.
  await db("INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ('swaps', 'SW2', $1, '{}', 'manual')", [{ id: 'SW2', giveTxId: 'gone', giveItemId: 'x', receiveTxId: 'gone', receiveItemId: 'y', ts: 1793300000000 }]);
  const again = await m.swaps.page();
  assert.deepEqual(again.swaps.map((x) => [x.give, x.receive])[0], [null, null], 'newest first; an orphan swap is shown with nothing on either side');
});

/* ── the API ── */

test('the three pages are served behind the sign-in', async () => {
  for (const key of ['missingacc', 'history', 'swaps']) {
    const anon = await fetch(`${api}/api/logistics/page/${key}`);
    assert.equal(anon.status, 401, key);
  }
  const login = await fetch(`${api}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'masterapp' },
    body: JSON.stringify({ email: 'boss@example.com', password: 'admin-password-1' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const got = await fetch(`${api}/api/logistics/page/missingacc`, { headers: { cookie } });
  assert.equal(got.status, 200);
  const r = await got.json();
  assert.equal(r.client_owes.items, 4);
  assert.equal((await (await fetch(`${api}/api/logistics/page/history`, { headers: { cookie } })).json()).transactions.length, 3);
  assert.equal((await (await fetch(`${api}/api/logistics/page/swaps`, { headers: { cookie } })).json()).swaps.length, 2);
});
