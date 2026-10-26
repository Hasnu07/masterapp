import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import sharp from 'sharp';

/*
 * The logistics app's records in masterapp: the copy from the worker's
 * document (against a stand-in), the rules it keeps (locks, soft deletes, a
 * broken read is not a clear-out, its passwords never copied), what a watch's
 * page says about where it is, and the API. Against a real Postgres
 * (TEST_DATABASE_URL), which is EMPTIED first.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let worker, base, m, db, dataDir, server, api, state;

const jpeg = (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();

async function fixture() {
  const inline = (await jpeg(40, 30, '#c33')).toString('base64');
  return {
    settings: { fobPassword: 'secret-fob', workerToken: 'tok-in-settings', claudeKey: 'k-claude' },
    notepad: 'a private note',
    clients: [
      { id: 'c1', name: 'Dealer One', country: 'UAE' },
      { id: 'c2', name: 'Buyer Two' },
    ],
    londonStock: [
      {
        id: 'L1', stockNumber: '1668', brand: 'Rolex', watchModel: 'Lady-Datejust', status: 'moved', needPolish: true,
        movements: [{ id: 'm1', ts: 1760000000000, moveType: 'dubai', destination: 'Dubai', carrier: 'by hand' }],
      },
    ],
    dubaiStock: [
      {
        id: 'D1', stockNumber: '1668', brand: 'Rolex', watchModel: 'Lady-Datejust', status: 'current', inOffice: true, needPolish: true,
        receivedAt: 1760100000000, vaultPin: '9911',
        photos: [`data:image/jpeg;base64,${inline}`, `${base}/photos/p1.jpg`],
      },
      { id: 'D2', stockNumber: '1700', brand: 'Patek Philippe', status: 'current', needPolish: true, polish: { status: 'at_polish', sentTo: 'Polisher X', sentDate: '2026-10-01' } },
    ],
    hkStock: [],
    safeStock: [],
    soldStocks: [],
    readyForDelivery: [],
    incomings: [
      { id: 'I1', stockNumber: '1900', brand: 'Rolex', reference: 'GMT', supplier: 'Dealer One', status: 'pending', eta: '2026-11-02', costAmount: 9000, costCurrency: 'USD' },
      { id: 'I2', stockNumber: '1950', brand: 'Tudor', supplier: 'Dealer One', status: 'pending' },
    ],
    shipments: [
      {
        id: 'S1', stockNumber: '1668, 1700', date: '2026-10-20', fromText: 'Dubai', toClientId: 'c2', tracking: '7777', status: 'pending',
        costAmount: 300, costCurrency: 'USD',
        fedex: { lastStatus: { status: 'Clearance delay - Import', derivedCode: 'CD', location: 'LONDON GB' } }, fedexUpdatedAt: 1761000000000,
      },
      { id: 'S2', stockNumber: '-', items: 'Spare straps', status: 'delivered' },
    ],
    logisticCosts: [
      { id: 'C1', stockNumber: '1668,1700', title: 'Courier', amount: 200, currency: 'AED', date: '2026-10-20', shipmentId: 'S1' },
      { id: 'C2', stockNumber: '1668', title: 'Insurance', amount: 50, currency: 'USD', date: '2026-10-21' },
      { id: 'C3', stockNumber: '1668', title: 'From a trip', amount: 999, currency: 'USD', tripId: 'T1' },
    ],
    personTrips: [
      {
        id: 'T1', personName: 'Kashan', fromLocation: 'Dubai', toLocation: 'London', startDate: '2026-10-25', status: 'in_progress',
        stockIds: ['dubai-D1', 'dubai-D2'], costs: [{ id: 'tc1', category: 'Flight', amount: 1000, currency: 'GBP' }],
      },
    ],
    goldSoukTasks: Array.from({ length: 15 }, (_, i) => ({ id: `g${i}`, title: `Task ${i}` })),
    activity: [{ id: 'a1', text: 'Shipment created', ts: 1761000000000 }],
    someNewList: [{ id: 'n1', title: 'A list the catalog does not know yet' }],
    checkoutStock: [{ id: 'K1', stockNumber: '1950', brand: 'Tudor', checkedOutBy: 'trade show', checkedOutDate: '2026-10-22' }],
    // The vault's holder of a stock row, keyed by the row's id (a map, not a list).
    vaultTracking: { D1: { holder: 'Ali', loc: 'dubai' } },
    shipmentDocs: [{ id: 'SD1', title: 'Customs papers', files: [`${base}/photos/doc.pdf`, `${base}/photos/dead.jpg`] }],
  };
}

const hits = {};

before(async () => {
  const photo = await jpeg(60, 40, '#3a6');
  const photo2 = await jpeg(50, 50, '#36a');
  worker = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    hits[url.pathname] = (hits[url.pathname] || 0) + 1;
    // A stand-in for the converter's rate source (USD-based, as Coinbase answers): no test reaches the internet.
    if (url.pathname === '/rates/live') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: { rates: { USD: '1', EUR: '0.9', GBP: '0.8', AED: '3.6725', HKD: '7.8' } } }));
    }
    if (url.pathname === '/photos/doc.pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      return res.end(Buffer.from('%PDF-1.4\n% a customs paper\n%%EOF\n'));
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
    if (url.pathname === '/photos/p1.jpg' || url.pathname === '/photos/p2.jpg' || url.pathname === '/photos/notnamed.jpg') {
      res.setHeader('Content-Type', 'image/jpeg');
      return res.end(url.pathname === '/photos/p1.jpg' ? photo : photo2);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => worker.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${worker.address().port}`;
  state = await fixture();

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lg-'));
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
    lg: await import('../src/logistics/index.js'),
    lgc: await import('../src/logistics/clients.js'),
    situation: await import('../src/logistics/situation.js'),
    kinds: await import('../src/logistics/kinds.js'),
  };
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/auth/index.js')).ensureFirstAdmin(() => {});
  db = m.db.query;
  server = (await import('../src/web/server.js')).createServer().listen(0);
  api = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  worker.close();
  await m.db.pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const item = async (kind, sourceId) => (await db('SELECT * FROM logistics_items WHERE kind = $1 AND source_id = $2', [kind, sourceId])).rows[0];
const events = async (id) => (await db('SELECT * FROM logistics_events WHERE item_id = $1 ORDER BY id', [id])).rows;

/* ── pure rules ── */

test('stock numbers: lists, "#", the "-" placeholder and SHIP- stand-ins', () => {
  const { stockList } = m.kinds;
  assert.deepEqual(stockList('1668, 1700 ;\n#1801'), ['1668', '1700', '1801']);
  assert.deepEqual(stockList('-'), []);
  assert.deepEqual(stockList('SHIP-12'), []);
  assert.deepEqual(stockList(['1668', '1668', { stockNumber: '1700' }]), ['1668', '1700']);
});

test('moments: milliseconds, days and the app’s DD/MM/YYYY all read', () => {
  const { when } = m.situation;
  assert.equal(when(1760000000000), 1760000000000);
  assert.equal(when('2026-10-20'), Date.UTC(2026, 9, 20));
  assert.equal(when('02/11/2026'), Date.UTC(2026, 10, 2));
  assert.equal(when(''), null);
});

test('a shipment’s stage: the carrier knows better than a status set by hand', () => {
  const { stage } = m.situation;
  assert.equal(stage({ status: 'pending', tracking: '1', fedex: { lastStatus: { derivedCode: 'CD', status: 'x' } } }).key, 'customs');
  assert.equal(stage({ status: 'pending', tracking: '1', fedex: { lastStatus: { delivered: true, status: 'Delivered' } } }).key, 'delivered');
  assert.equal(stage({ status: 'pending', tracking: '1', dhl: { description: 'Shipment on hold — refused' } }).key, 'exception');
  assert.equal(stage({ status: 'cancelled', tracking: '1' }).key, 'cancelled');
  assert.equal(stage({ status: 'pending' }).key, 'no_tracking');
});

/* ── the copy ── */

test('every list is copied — its settings, passwords and notes never are', async () => {
  const s = await m.sync.syncLogistics();
  // 2 clients, 3 places' rows, 2 incomings, 2 shipments, 3 costs, 1 trip, 15 tasks, 1 activity line, 1 new list,
  // 1 checked out, 1 vault holder, 1 shipping document.
  assert.equal(s.created, 33, JSON.stringify(s));
  const kinds = (await db('SELECT DISTINCT kind FROM logistics_items')).rows.map((r) => r.kind);
  assert.ok(!kinds.includes('settings') && !kinds.includes('notepad'));
  assert.ok(kinds.includes('someNewList'), 'a list the catalog does not know yet is kept too');
  const everything = JSON.stringify((await db('SELECT data FROM logistics_items UNION ALL SELECT data FROM logistics_records')).rows);
  for (const secret of ['secret-fob', 'tok-in-settings', 'k-claude', '9911', 'a private note']) {
    assert.ok(!everything.includes(secret), `${secret} is not copied`);
  }
});

test('stock numbers are split, placeholders skipped, and a trip’s row ids found', async () => {
  assert.deepEqual((await item('shipments', 'S1')).stock_nos, ['1668', '1700']);
  assert.deepEqual((await item('shipments', 'S2')).stock_nos, [], '"-" is no watch');
  assert.deepEqual((await item('personTrips', 'T1')).stock_nos.sort(), ['1668', '1700'], 'dubai-D1, dubai-D2');
});

test('pictures inside records become files; the worker’s own are copied too', async () => {
  const d1 = await item('dubaiStock', 'D1');
  assert.match(d1.data.photos[0], /^lgfile:\d+$/, 'the inline picture');
  assert.match(d1.data.photos[1], /^lgfile:\d+$/, 'the one on the worker');
  const raw = (await db("SELECT data FROM logistics_records WHERE kind = 'dubaiStock' AND source_id = 'D1'")).rows[0].data;
  assert.equal(raw.photos[1], `${base}/photos/p1.jpg`, 'the raw record keeps the address it gave');
  const doc = await item('shipmentDocs', 'SD1');
  assert.match(doc.data.files[0], /^lgfile:\d+$/, 'a PDF on the worker is copied too');
  assert.equal(doc.data.files[1], `${base}/photos/dead.jpg`, 'a dead address stays as it was');
  const types = (await db('SELECT content_type FROM logistics_files')).rows.map((r) => r.content_type).sort();
  assert.deepEqual(types, ['application/pdf', 'image/jpeg', 'image/jpeg']);
});

test('an address that gave nothing is not asked for again every pass', async () => {
  const before = hits['/photos/dead.jpg'];
  await m.sync.syncLogistics();
  await m.sync.syncLogistics({ quiet: true });
  assert.equal(hits['/photos/dead.jpg'], before, 'refused for a day, not every minute');
});

test('an unchanged document changes nothing — and leaves no run behind', async () => {
  const runs = (await db("SELECT count(*)::int AS n FROM import_runs WHERE source = 'logistics'")).rows[0].n;
  const evs = (await db('SELECT count(*)::int AS n FROM logistics_events')).rows[0].n;
  const s = await m.sync.syncLogistics();
  assert.equal(s.created + s.updated + s.gone, 0);
  assert.equal(s.unchanged, s.records);
  assert.equal((await db('SELECT count(*)::int AS n FROM logistics_events')).rows[0].n, evs);
  assert.equal((await db("SELECT count(*)::int AS n FROM import_runs WHERE source = 'logistics'")).rows[0].n, runs);
});

test('the app’s changes come through, except a field somebody edited here', async () => {
  const s1 = await item('shipments', 'S1');
  await m.lg.updateItem(s1.id, { tracking: 'TYPED-HERE' }, null);
  state.shipments[0].status = 'in_transit';
  state.shipments[0].tracking = '8888';
  await m.sync.syncLogistics();
  const after1 = await item('shipments', 'S1');
  assert.equal(after1.data.status, 'in_transit', 'not locked: the app wins');
  assert.equal(after1.data.tracking, 'TYPED-HERE', 'locked: the person wins');
  assert.deepEqual(after1.locked_fields, ['tracking']);
  const sync = (await events(s1.id)).find((e) => e.action === 'sync');
  assert.deepEqual(sync.changes.status, ['pending', 'in_transit']);
  assert.equal(sync.changes.tracking, undefined, 'a locked field is no sync change');

  await m.lg.unlockField(s1.id, 'tracking', null);
  const after2 = await item('shipments', 'S1');
  assert.equal(after2.data.tracking, '8888', 'handed back: the app’s value at once');
  assert.deepEqual(after2.locked_fields, []);
});

test('a record the app drops is deleted softly, and comes back with it; a person’s deletion stands', async () => {
  const [inc] = state.incomings.splice(0, 1);
  await m.sync.syncLogistics();
  const gone = await item('incomings', 'I1');
  assert.ok(gone.deleted_at && gone.source_gone_at, 'deleted by the sync');
  state.incomings.push(inc);
  await m.sync.syncLogistics();
  assert.equal((await item('incomings', 'I1')).deleted_at, null, 'restored when listed again');

  const c2 = await item('logisticCosts', 'C2');
  await m.lg.deleteItem(c2.id, null);
  const [cost] = state.logisticCosts.splice(1, 1);
  await m.sync.syncLogistics();
  state.logisticCosts.splice(1, 0, cost);
  await m.sync.syncLogistics();
  assert.ok((await item('logisticCosts', 'C2')).deleted_at, 'deleted here: stays deleted');
  await m.lg.deleteItem(c2.id, null, { restore: true });
});

test('a list that loses most of its records at once is a broken read, not a clear-out', async () => {
  const kept = state.goldSoukTasks;
  state.goldSoukTasks = kept.slice(0, 3);
  const s = await m.sync.syncLogistics();
  assert.equal(s.refused.goldSoukTasks, 12);
  assert.equal((await db("SELECT count(*)::int AS n FROM logistics_items WHERE kind = 'goldSoukTasks' AND deleted_at IS NULL")).rows[0].n, 15);
  state.goldSoukTasks = kept;
});

test('a list the app empties is mirrored too: a watch checked back in is not "checked out" here', async () => {
  const kept = state.checkoutStock;
  state.checkoutStock = [];
  await m.sync.syncLogistics();
  assert.ok((await item('checkoutStock', 'K1')).deleted_at);
  state.checkoutStock = kept;
  await m.sync.syncLogistics();
  assert.equal((await item('checkoutStock', 'K1')).deleted_at, null, 'and back when it is listed again');
});

test('one record Postgres refuses is skipped, not the end of the pass', async () => {
  state.brokenList = [
    { id: 'b1', title: 'carries a \u0000 nul' },
    { id: 'b2', title: 'fine' },
  ];
  state.shipments[1].notes = 'changed after the broken list';
  const s = await m.sync.syncLogistics();
  assert.equal(s.failed, 1, JSON.stringify(s));
  assert.ok(await item('brokenList', 'b2'), 'the rest of its list is kept');
  assert.equal((await item('shipments', 'S2')).data.notes, 'changed after the broken list', 'and every list after it');
  delete state.brokenList;
});

test('two records the app gives one id are both kept — not one written over the other every pass', async () => {
  state.hkSituation = [
    { id: 'H1', stockNumber: '2700', section: 'in_hand', brand: 'Patek Philippe', notes: 'the full copy' },
    { id: 'H1', stockNumber: '2700', section: 'in_hand' },
  ];
  await m.sync.syncLogistics();
  const a = await item('hkSituation', 'H1');
  const b = await item('hkSituation', 'H1~2');
  assert.equal(a.data.notes, 'the full copy');
  assert.equal(b.data.notes, undefined);
  const count = async () => (await events(a.id)).length + (await events(b.id)).length;
  const before = await count();
  await m.sync.syncLogistics();
  await m.sync.syncLogistics();
  assert.equal(await count(), before, 'the next passes change nothing');
  delete state.hkSituation;
});

test('late, titles and changes in words: one rule for Late, no brand or reference twice, a block of details named', () => {
  assert.equal(m.lg.lateSince({ status: 'pending', deliveryDate: '2020-01-01' }), '2020-01-01');
  assert.equal(m.lg.lateSince({ status: 'in_transit', deliveryDate: '01/01/2020' }), '2020-01-01', 'day first');
  assert.equal(m.lg.lateSince({ status: 'pending', deliveryDate: 'Oct 30' }), null, 'words are no date');
  assert.equal(m.lg.lateSince({ status: 'delivered', deliveryDate: '2020-01-01' }), null);
  const ctx = { client: () => '', route: () => '', stage: () => ({}) };
  assert.equal(m.kinds.KIND.dubaiStock.summary({ brand: 'Rolex', watchModel: 'Rolex Daytona', watchReference: '116500LN' }, ctx).title, 'Rolex Daytona 116500LN');
  assert.equal(m.kinds.KIND.readyForDelivery.summary({ brand: 'Patek Philippe', watchModel: '5740/1G-001', watchReference: '5740/1G-001' }, ctx).title, 'Patek Philippe 5740/1G-001');
  assert.deepEqual(
    m.lg.readableChanges({ polish: [null, { sentTo: 'Sina Star' }], trackingNumber: ['', '7712'], deliveredAt: [null, 1792827369915], movements: [[], [{ a: 1 }]] }),
    { polish: [null, '(details)'], trackingNumber: ['', '7712'], deliveredAt: [null, 1792827369915] }
  );
});

test('the vault’s photo store is not part of a logistics record', async () => {
  state.dubaiStock[0].vaultPhotos = ['https://example.invalid/v.jpg'];
  const s = await m.sync.syncLogistics();
  assert.equal(s.updated, 0, 'a missed or changed read of it changes no stock row');
  delete state.dubaiStock[0].vaultPhotos;
});

test('a vault holder is named by its key; editing it keeps its stock number', async () => {
  const vt = await item('vaultTracking', 'D1');
  assert.deepEqual(vt.stock_nos, ['1668']);
  await m.lg.updateItem(vt.id, { holder: 'Omar' }, null);
  assert.deepEqual((await item('vaultTracking', 'D1')).stock_nos, ['1668']);
  await m.sync.syncLogistics();
  assert.deepEqual((await item('vaultTracking', 'D1')).stock_nos, ['1668'], 'and so does the sync, with the field locked');
});

test('the between-passes read keeps no run', async () => {
  const runs = (await db("SELECT count(*)::int AS n FROM import_runs WHERE source = 'logistics'")).rows[0].n;
  state.shipments[1].notes = 'a quiet change';
  const s = await m.sync.syncLogistics({ quiet: true });
  assert.equal(s.updated, 1);
  assert.equal((await db("SELECT count(*)::int AS n FROM import_runs WHERE source = 'logistics'")).rows[0].n, runs);
});

test('costs: a shipment added here keeps its own cost; no currency is dollars, as the app counts it', () => {
  const { costs } = m.situation;
  const c = costs('9', [
    { id: 1, kind: 'shipments', data: { stockNumber: '9', costAmount: 100, costCurrency: 'GBP' } },
    { id: 2, kind: 'logisticCosts', data: { stockNumber: '9', title: 'Taxi', amount: 5 } },
  ]);
  assert.deepEqual(c.totals, { GBP: 100, USD: 5 });
});

test('a number no calendar holds is no moment', () => {
  const { when, happenedAt } = m.situation;
  assert.equal(when(8.7e15), null);
  assert.equal(when(1e20), null);
  assert.equal(happenedAt('logisticCosts', { date: 1e20 }), null);
});

test('an activity line falling off the app’s last 200 is not a deletion', async () => {
  state.activity = [{ id: 'a2', text: 'Newer line', ts: 1762000000000 }];
  await m.sync.syncLogistics();
  assert.equal((await item('activity', 'a1')).deleted_at, null);
});

test('the app’s answer without its lists is refused, not read as an empty app', async () => {
  const saved = state;
  state = { settings: {} };
  await assert.rejects(m.sync.syncLogistics(), /without its lists/);
  state = saved;
  assert.equal((await db("SELECT count(*)::int AS n FROM logistics_items WHERE deleted_at IS NOT NULL AND kind = 'shipments'")).rows[0].n, 0);
});

/* ── one watch ── */

test('where a watch is: its place, what is moving it, its history and what moving it cost', async () => {
  const { rows } = await db("INSERT INTO watches(stock_no, origin, status) VALUES ('1668','manual','in_stock'), ('1700','manual','in_stock') RETURNING id, stock_no");
  const id = rows.find((r) => r.stock_no === '1668').id;
  const w = await m.lg.forWatch(id);
  assert.equal(w.now.headline, 'In Dubai');
  assert.match(w.now.detail, /office/);
  const ship = w.now.overlays.find((o) => o.text.startsWith('On a shipment'));
  assert.ok(ship, JSON.stringify(w.now.overlays));
  assert.match(ship.text, /Dubai → Buyer Two/, 'the client’s name, not its id');
  assert.match(ship.text, /At customs/, 'FedEx CD');
  assert.ok(w.now.overlays.some((o) => /Kashan’s trip/.test(o.text)));
  assert.ok(w.timeline.some((e) => e.text === 'Moved to Dubai'), 'the moved London row’s movement');

  // The logistics app's own costing, line for line.
  assert.deepEqual(w.costs.totals, { AED: 100, USD: 50, GBP: 500 }, JSON.stringify(w.costs.lines));
  assert.ok(!w.costs.lines.some((l) => l.source === 'Shipment'), 'S1’s own cost is already the Courier line');

  // As one figure: in dollars while the purchase currency is not known …
  const usd = 100 / 3.6725 + 50 + 500 / 0.8;
  assert.deepEqual(
    { amount: w.costs.total.amount, currency: w.costs.total.currency, bought_in: w.costs.total.bought_in },
    { amount: Math.round(usd * 100) / 100, currency: 'USD', bought_in: false }
  );
  // … and in the currency it was bought in once it is.
  await db("UPDATE watches SET purchase_currency = 'AED' WHERE id = $1", [id]);
  const aed = (await m.lg.forWatch(id)).costs.total;
  assert.equal(aed.currency, 'AED');
  assert.equal(aed.bought_in, true);
  assert.equal(aed.amount, Math.round(usd * 3.6725 * 100) / 100);
  await db("UPDATE watches SET purchase_currency = '' WHERE id = $1", [id]);

  const other = await m.lg.forWatch(rows.find((r) => r.stock_no === '1700').id);
  assert.equal(other.now.headline, 'At polish with Polisher X');
});

test('the overview’s figures are the logistics app’s own: deliveries, accessories, costs, need polish', async () => {
  state.shipments[0].deliveryDate = '01/01/2026'; // past, written day first
  state.transactions = [
    { id: 'TX1', type: 'sold', clientId: 'c2', stockNumber: '1668', items: [
      { id: 'i1', accessory: 'Box', qty: 2, direction: 'give', status: 'pending' },
      { id: 'i2', accessory: 'Papers', qty: 3, direction: 'receive', status: 'pending' },
      { id: 'i3', accessory: 'Tag', qty: 1, direction: 'give', status: 'done' },
    ] },
  ];
  await m.sync.syncLogistics();
  const o = await m.lg.overview();
  assert.deepEqual(o.deliveries, { in_motion: 1, delivered: 1, delayed: 1, in_progress: 0, ready: 0 });
  assert.deepEqual(o.accessories, { give: 2, owed: 3 }, 'pending items, by quantity');
  assert.deepEqual(o.costs.by_currency, { AED: { amount: 200, count: 1 }, USD: { amount: 1049, count: 2 } }, 'every cost line, a trip’s included');
  assert.equal(o.costs.rates.table.AED, 3.6725);
  const polish = o.need_polish.map((r) => [r.source_id, Boolean(r.polish), r.can_polish]);
  assert.deepEqual(polish.sort(), [['D1', false, true], ['D2', true, true]], 'the moved London copy is left out');
  assert.ok(o.need_polish.every((r) => r.watches.length === 1), 'each points at OUR watch');

  // Latest changes: one line per record, and only what a person can read.
  assert.deepEqual(
    m.lg.readableChanges({
      status: ['pending', 'delivered'],
      notes: ['', 'with the client'],
      fedexUpdatedAt: [1792788490091, 1792827369915],
      fedex: [{ a: 1 }, { a: 2 }],
      dial: [null, ''],
      photos: [[], ['lgfile:1']],
      createdAt: [null, 1760000000000],
    }),
    { status: ['pending', 'delivered'], notes: ['', 'with the client'] }
  );
  const ids = o.recent.map((e) => e.item.id);
  assert.equal(ids.length, new Set(ids).size, 'each record once');
  assert.ok(o.recent.every((e) => !Object.keys(e.changes).some((k) => /fedex|UpdatedAt/.test(k))));
  // One record with two real changes and carrier noise between; another with nothing but carrier noise.
  const add = async (kind) => (await db("INSERT INTO logistics_items(kind, data, origin) VALUES ($1, '{\"status\":\"pending\"}', 'manual') RETURNING id", [kind])).rows[0].id;
  const [real, noisy] = [await add('shipments'), await add('shipments')];
  const ev = (id, at, changes) => db("INSERT INTO logistics_events(item_id, at, source, action, changes) VALUES ($1, $2, 'logistics', 'sync', $3)", [id, at, changes]);
  await ev(real, '2030-01-01T10:00Z', { status: ['pending', 'in_transit'] });
  await ev(real, '2030-01-01T11:00Z', { fedex: [null, { s: 1 }], fedexUpdatedAt: [1, 2] });
  await ev(real, '2030-01-01T12:00Z', { status: ['in_transit', 'delivered'] });
  await ev(noisy, '2030-01-01T13:00Z', { fedex: [null, { s: 2 }], fedexUpdatedAt: [2, 3] });
  const feed = (await m.lg.overview()).recent;
  const line = feed.find((e) => e.item.id === real);
  assert.deepEqual([line.changes, line.earlier], [{ status: ['in_transit', 'delivered'] }, 1], 'its newest change, and one earlier');
  assert.ok(!feed.some((e) => e.item.id === noisy), 'carrier noise alone is no change');
  assert.ok(feed.length <= 12);
  await db('DELETE FROM logistics_events WHERE item_id = ANY($1)', [[real, noisy]]);
  await db('DELETE FROM logistics_items WHERE id = ANY($1)', [[real, noisy]]);

  // A delivery date typed as words is no date to be late against (guessed, "Oct 30" is 2001).
  const typed = (await db(`INSERT INTO logistics_items(kind, data, origin) VALUES ('shipments', '{"status":"pending","deliveryDate":"Oct 30"}', 'manual') RETURNING id`)).rows[0];
  const d = (await m.lg.overview()).deliveries;
  assert.deepEqual([d.in_motion, d.delayed], [2, 1]);
  await db('UPDATE logistics_items SET deleted_at = now() WHERE id = $1', [typed.id]);
});

test('polish: Send records who has it (and its cost, as a cost line); Done files it in the history', async () => {
  const d1 = await item('dubaiStock', 'D1');
  await assert.rejects(m.lg.polishAction(d1.id, { action: 'send' }, null), /who the watch is going to/);
  const sent = await m.lg.polishAction(d1.id, { action: 'send', sentTo: 'Sina Star', sentDate: '2026-10-24', costAmount: '150', costCurrency: 'aed' }, null);
  assert.equal(sent.cost, true);
  const atPolish = await item('dubaiStock', 'D1');
  assert.equal(atPolish.data.polish.sentTo, 'Sina Star');
  assert.ok(atPolish.locked_fields.includes('polish'), 'the next copy does not undo it');
  const cost = (await db("SELECT * FROM logistics_items WHERE kind = 'logisticCosts' AND data->>'polishId' = $1", [atPolish.data.polish.id])).rows[0];
  assert.deepEqual([cost.data.amount, cost.data.currency, cost.stock_nos], [150, 'AED', ['1668']]);
  await assert.rejects(m.lg.polishAction(d1.id, { action: 'send', sentTo: 'Again' }, null), /Already at polish/);
  await m.sync.syncLogistics();
  assert.equal((await item('dubaiStock', 'D1')).data.polish.sentTo, 'Sina Star', 'still at polish after a sync');

  await m.lg.polishAction(d1.id, { action: 'done', returnedDate: '2026-10-30', returnNotes: 'like new' }, null);
  const back = await item('dubaiStock', 'D1');
  assert.equal(back.data.polish, undefined);
  assert.equal(back.data.needPolish, false);
  assert.deepEqual([back.data.polishHistory.length, back.data.polishHistory[0].returnedDate, back.data.polishHistory[0].returnNotes], [1, '2026-10-30', 'like new']);
  const hk = (await db("INSERT INTO logistics_items(kind, data, origin) VALUES ('hkSituation', '{}', 'manual') RETURNING id")).rows[0];
  await assert.rejects(m.lg.polishAction(hk.id, { action: 'send', sentTo: 'X' }, null), /Only a watch/);
});

test('search everything: our watch once (found through its logistics row), our client once, the rest as records', async () => {
  await db("INSERT INTO clients(forename, surname, origin) VALUES ('Dealer', 'One', 'manual')");
  const viaRow = await m.lg.search({ q: 'Lady-Datejust' });
  assert.deepEqual(viaRow.watches.map((w) => w.stock_no), ['1668'], 'our watch, found through the logistics app’s model name');
  assert.equal(viaRow.watches[0].now.headline, 'In Dubai', 'with where it is right now');
  assert.ok(!viaRow.records.some((r) => ['dubaiStock', 'londonStock'].includes(r.kind)), 'its stock rows are not listed again');

  const notOurs = await m.lg.search({ q: 'Tudor' });
  assert.deepEqual(
    notOurs.records.filter((r) => r.stock_nos.includes('1950')).map((r) => r.source_id),
    ['K1'],
    'a watch we do not hold shows as its logistics record — once, where it is now (checked out, no longer coming in)'
  );

  const people = await m.lg.search({ q: 'One', scope: 'clients' });
  assert.ok(people.clients.some((c) => c.name === 'Dealer One'), 'our client');
  assert.ok(!people.records.some((r) => r.kind === 'clients' && r.source_id === 'c1'), 'the logistics app’s Dealer One is not shown twice');

  const ship = await m.lg.search({ q: '8888', scope: 'shipments' });
  assert.deepEqual(ship.records.map((r) => r.source_id), ['S1']);
  assert.ok(ship.records[0].watches.some((w) => w.stock_no === '1668'), 'its watches link to ours');
  assert.deepEqual((await m.lg.search({ q: '' })).watches, []);
});

test('search without strays: a stock number exactly, a contact hidden only beside our own, HK rows by section', async () => {
  const add = (kind, data, stock) =>
    db("INSERT INTO logistics_items(kind, data, stock_nos, origin) VALUES ($1, $2, $3, 'manual') RETURNING id", [kind, data, stock]);
  // Our 11668, whose London row holds "1668" inside longer numbers (a timestamp, a price, its own stock number).
  await db("INSERT INTO watches(stock_no, brand, model, origin, status) VALUES ('11668', 'Rolex', 'Rolex Daytona', 'manual', 'in_stock')");
  await add('londonStock', { stockNumber: '11668', watchModel: 'Cosmograph', createdAt: 1761668123456, costAmount: 16680, status: 'current' }, ['11668']);
  assert.deepEqual((await m.lg.search({ q: '1668' })).watches.map((w) => w.stock_no), ['1668'], 'not 11668 through its row');
  assert.deepEqual((await m.lg.search({ q: '1668', scope: 'stock' })).watches.map((w) => w.stock_no), ['1668']);
  const byRow = (await m.lg.search({ q: 'Cosmograph' })).watches;
  assert.deepEqual(byRow.map((w) => [w.stock_no, w.title]), [['11668', 'Rolex Daytona']], 'found through its row, titled as on the Watches page');

  // The logistics app's Dealer One, found by what only it holds: shown, since our Dealer One is not in the answer.
  const uae = await m.lg.search({ q: 'UAE', scope: 'clients' });
  assert.deepEqual(uae.clients, []);
  assert.deepEqual(uae.records.map((r) => r.source_id), ['c1']);

  // The HK list by its section; the safe (clients' watches) only under All; one record per watch we do not hold.
  await add('londonStock', { stockNumber: '2500', watchModel: 'Speedmaster', status: 'moved' }, ['2500']);
  await add('hkSituation', { stockNumber: '2500', description: 'Speedmaster', section: 'sold' }, ['2500']);
  await add('safeStock', { stockNumber: '2600', description: 'Speedmaster, a client’s' }, ['2600']);
  const nos = async (scope) => (await m.lg.search({ q: 'Speedmaster', scope })).records.map((r) => `${r.kind}:${r.stock_nos}`).sort();
  assert.deepEqual(await nos('sold'), ['hkSituation:2500']);
  assert.deepEqual(await nos('stock'), [], 'neither sold in HK nor a client’s watch is our stock — nor the copy a move left behind');
  assert.deepEqual(await nos('all'), ['hkSituation:2500', 'safeStock:2600']);
});

test('in the safe: clients’ watches with who each is for, accessories owed there, and the badge on our stock', async () => {
  const add = (kind, data, stock) =>
    db("INSERT INTO logistics_items(kind, data, stock_nos, origin) VALUES ($1, $2, $3, 'manual') RETURNING id", [kind, data, stock]);
  const { rows: ours } = await db(
    "INSERT INTO watches(stock_no, brand, model, origin, status) VALUES ('3101', 'Rolex', 'Oyster Perpetual 28', 'manual', 'sold') RETURNING id"
  );
  await add('safeStock', { stockNumber: '3101', brand: 'Rolex', watchModel: 'Oyster Perpetual 28', watchReference: '276200', from: 'Mark', inSafe: '✓', receivedAt: 1761000000000, status: 'current' }, ['3101']);
  await add('safeStock', { stockNumber: '3102', brand: 'Patek Philippe', watchModel: 'Nautilus', from: 'Mark', withClient: true, needPolish: true, status: 'current', receivedAt: 1761100000000 }, ['3102']);
  await add('safeStock', { stockNumber: '3103', brand: 'Tudor', from: 'Someone', status: 'moved' }, ['3103']);
  await add('accGive', { stockNumber: '3101', items: 'RM Box', toClient: 'Mark', inSafe: true, inSafeAt: 1761200000000 }, ['3101']);
  await add('accGive', { stockNumber: '3102', items: 'Booklet', toClient: 'Mark' }, ['3102']);
  await add('accGive', { stockNumber: '3102', items: 'Strap', toClient: 'Mark', inSafe: 'no' }, ['3102']);
  await add('safeStock', { stockNumber: '3104', brand: 'Omega', from: 'Ali', withClient: 'false', inSafe: 'Box 2', status: 'current', receivedAt: 1760000000000 }, ['3104']);

  const r = await m.lg.inSafe();
  const mine = r.watches.filter((w) => w.stock_no.startsWith('310'));
  assert.deepEqual(mine.map((w) => [w.stock_no, w.owner]), [['3102', 'Mark'], ['3101', 'Mark'], ['3104', 'Ali']], 'newest first; a row a move left behind is not in the safe');
  const omega = mine.find((w) => w.stock_no === '3104');
  assert.equal(omega.with_owner, '', '"false" typed is not out with its owner');
  assert.equal(omega.where, 'Box 2', 'words in the tick say which safe');
  const op = mine.find((w) => w.stock_no === '3101');
  assert.equal(op.where, '', 'a tick says nothing about which safe');
  assert.equal(op.watch.id, ours[0].id, 'our own watch of that number is linked');
  const naut = mine.find((w) => w.stock_no === '3102');
  assert.equal(naut.with_owner, 'yes');
  assert.equal(naut.need_polish, true);
  assert.equal(naut.watch, null, 'one we do not hold stays the logistics record it is');
  assert.deepEqual(r.accessories.filter((a) => a.stock_no.startsWith('310')).map((a) => [a.items, a.for_client, a.about]), [['RM Box', 'Mark', 'Rolex Oyster Perpetual 28']], 'only what is ticked in the safe');

  // Our stock list says it is in the safe, and for whom; the watch page names them too.
  const { listWatches } = await import('../src/watches/index.js');
  const tile = (await listWatches({ q: '3101' })).watches[0];
  assert.deepEqual(tile.in_safe, { for: 'Mark', with_owner: false });
  assert.equal((await listWatches({ q: '1668' })).watches[0].in_safe, null);
  const page = await m.lg.forWatch(ours[0].id);
  assert.match(page.now.headline, /safe/);
  assert.match(page.now.detail, /for Mark/);
});

test('checked out: linked to our watch and its clients, one entry per watch, a junk number never merged; the safe’s owner linked by name as far as it goes', async () => {
  const add = (kind, data, stock) =>
    db("INSERT INTO logistics_items(kind, data, stock_nos, origin) VALUES ($1, $2, $3, 'manual') RETURNING id", [kind, data, stock]);
  const seller = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Khawar', 'Saeed', 'manual') RETURNING id")).rows[0].id;
  const buyer = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Parsa', 'Nouri', 'manual') RETURNING id")).rows[0].id;
  await db(
    "INSERT INTO watches(stock_no, brand, model, origin, status, purchased_from_client_id, sold_to_client_id) VALUES ('3201', 'Rolex', 'Day-Date 40', 'manual', 'sold', $1, $2)",
    [seller, buyer]
  );
  await add('checkoutStock', { stockNumber: '3201', brand: 'Rolex', watchModel: 'Day-Date 40', checkedOutBy: 'Given back to Khawar', checkedOutDate: '2026-09-18', originLocation: 'dubai' }, ['3201']);
  await add('checkoutStock', { stockNumber: '3202', brand: 'Patek Philippe', description: '3202 · Patek Philippe · 4910/1200A-010 · TR: 8749', checkedOutDate: '2026-07-30', originLocation: 'hk', checkedOutBy: 'no need' }, ['3202']);
  await add('checkoutStock', { stockNumber: '3202', brand: 'Patek Philippe', description: '3202 · Patek Philippe · 4910/1200A-010', checkedOutDate: '2026-08-18', originLocation: 'hk' }, ['3202']);
  await add('checkoutStock', { stockNumber: 'xxxxxx', brand: 'Rolex', watchModel: 'Datejust 36', checkedOutDate: '2026-09-29', originLocation: 'dubai' }, []);
  await add('checkoutStock', { stockNumber: 'xxxxxx', brand: 'Richard Mille', watchModel: 'Automatic', checkedOutDate: '2026-09-17', originLocation: 'dubai' }, []);
  await add('checkoutStock', { stockNumber: '3203', brand: 'Tudor', checkedOutDate: '2026-06-01', status: 'returned' }, ['3203']);

  const r = await m.lg.checkedOut();
  const mine = r.watches.filter((w) => w.stock_no.startsWith('32') || w.stock_no === 'xxxxxx');
  assert.deepEqual(mine.map((w) => [w.stock_no, w.checked_out]), [['xxxxxx', '2026-09-29'], ['3201', '2026-09-18'], ['xxxxxx', '2026-09-17'], ['3202', '2026-08-18']], 'newest first; a returned row is gone; "xxxxxx" twice is two watches');
  const patek = mine.find((w) => w.stock_no === '3202');
  assert.equal(patek.model, '4910/1200A-010', 'the number and the brand are not repeated as the model');
  assert.equal(patek.origin, 'Hong Kong');
  assert.deepEqual(patek.earlier.map((e) => [e.checked_out, e.reason]), [['2026-07-30', 'no need']], 'checked out again without a return: one entry, the earlier row under it');
  const dd = mine.find((w) => w.stock_no === '3201');
  assert.deepEqual([dd.watch.bought_from, dd.watch.sold_to], [{ id: seller, name: 'Khawar Saeed' }, { id: buyer, name: 'Parsa Nouri' }], 'our clients, by Chrono Key’s ids');
  assert.ok(r.rows > r.watches.length);
  assert.ok(r.by_origin.some((o) => o.origin === 'Dubai' && o.n >= 3));

  // In the safe: the owner is linked to the logistics client of that name, and to ours only as that one is.
  const ours = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Kashif', 'Rana', 'manual') RETURNING id")).rows[0].id;
  const lgKashif = (await add('clients', { name: 'Kashif Rana' }, [])).rows[0].id;
  const lgNobody = (await add('clients', { name: 'Zed Unknownson' }, [])).rows[0].id;
  await add('safeStock', { stockNumber: '3301', brand: 'Rolex', from: 'Kashif Rana', status: 'current' }, ['3301']);
  await add('safeStock', { stockNumber: '3302', brand: 'Omega', from: 'Zed Unknownson', status: 'current' }, ['3302']);
  await add('safeStock', { stockNumber: '3303', brand: 'Tudor', from: 'Walk-in', status: 'current' }, ['3303']);
  const safe = (await m.lg.inSafe()).watches;
  const link = (no) => safe.find((w) => w.stock_no === no).owner_link;
  assert.deepEqual(link('3301'), { lg_client_id: lgKashif, client_id: ours, client_name: 'Kashif Rana' });
  assert.deepEqual(link('3302'), { lg_client_id: lgNobody, client_id: null, client_name: '' });
  assert.equal(link('3303'), null, 'a name no logistics client carries links nowhere');
});

test('hand carry: plans with their stops, every watch linked to ours and its clients, what waits for a plan, and the plan on our watch', async () => {
  const add = (kind, data, stock, sourceId = null) =>
    db("INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ($1, $2, $3, $4, 'manual') RETURNING id", [kind, sourceId, data, stock]);
  const buyer = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Lifestyle', 'Watches', 'manual') RETURNING id")).rows[0].id;
  const diego = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Diego', 'Ruiz', 'manual') RETURNING id")).rows[0].id;
  const w = (await db("INSERT INTO watches(stock_no, brand, model, origin, status, sold_to_client_id) VALUES ('3401', 'Patek Philippe', 'Nautilus', 'manual', 'sold', $1) RETURNING id", [buyer])).rows[0].id;
  await add('clients', { name: 'Diego Ruiz' }, []);
  const plan = (
    await add('kashanPlans', {
      name: 'Cristian', currentCity: 'Bahrain',
      legs: [
        { id: 'L1', toCity: 'UAE', date: '2026-08-25', time: '15:35', flightCost: 1358, flightCostCurrency: 'EUR',
          deliveries: [{ id: 'd1', readyId: 'HC-R1', stockNumber: '3401', brand: 'Patek Philippe', model: 'Nautilus', clientName: 'Lifestyle Watches', clientCountry: 'Dubai' }],
          collections: [] },
        { id: 'L2', toCity: 'Valencia', date: '2026-08-27',
          collections: [{ id: 'c1', incId: 'HC-I1', stockNumber: '3402', brand: 'Rolex', model: '126529LN', supplier: 'Diego Ruiz', country: 'Spain' }] },
        { id: 'L3', toCity: 'Munich', date: '2026-08-27' },
      ],
    }, ['3401', '3402'])
  ).rows[0].id;
  await add('kashanPlans', { name: 'Kashan', status: 'completed', completedAt: 1760000000000, legs: [{ toCity: 'London', deliveries: [{ stockNumber: '3403' }] }] }, ['3403']);
  await add('readyForDelivery', { stockNumber: '3401', brand: 'Patek Philippe', soldToBuyer: 'Lifestyle Watches' }, ['3401'], 'HC-R1');
  await add('readyForDelivery', { stockNumber: '3404', brand: 'Rolex', soldToBuyer: 'Someone', status: 'shipped' }, ['3404'], 'HC-R2');
  await add('incomings', { stockNumber: '3405', brand: 'Rolex', supplier: 'Diego Ruiz', status: 'pending' }, ['3405'], 'HC-I2');

  const r = await m.lg.handCarry();
  const p = r.plans.find((x) => x.id === plan);
  assert.deepEqual([p.name, p.start, p.counts], ['Cristian', 'Bahrain', { stops: 3, deliver: 1, collect: 1, move: 0 }]);
  assert.deepEqual(p.flights, [{ currency: 'EUR', amount: 1358 }]);
  const d = p.stops[0].deliver[0];
  assert.deepEqual([d.watch.id, d.watch.sold_to], [w, { id: buyer, name: 'Lifestyle Watches' }], 'our watch, and its buyer by Chrono Key’s id');
  const c = p.stops[1].collect[0];
  assert.equal(c.watch, null, 'an incoming we do not hold yet');
  assert.deepEqual([c.who.name, c.who.link.client_id], ['Diego Ruiz', diego], 'the typed supplier, linked as far as the logistics client is');
  assert.equal(p.stops[2].deliver.length + p.stops[2].collect.length, 0, 'a stop with nothing on it');
  assert.ok(r.history.some((x) => x.name === 'Kashan' && x.completed), 'a completed plan is history');
  assert.ok(!r.plans.some((x) => x.name === 'Kashan'));
  const waitNos = r.waiting.deliver.map((x) => x.stock_no);
  assert.ok(waitNos.includes('3401') && !waitNos.includes('3404'), 'a shipped sale waits for nobody');
  assert.equal(r.waiting.deliver.find((x) => x.stock_no === '3401').on_plan.name, 'Cristian', 'which open plan has it');
  const inc = r.waiting.collect.find((x) => x.stock_no === '3405');
  assert.equal(inc.on_plan, null);
  assert.equal(inc.who.link.client_id, diego);

  // Our watch says so: on its tile, and in its "right now" and history.
  const { listWatches } = await import('../src/watches/index.js');
  assert.deepEqual((await listWatches({ q: '3401' })).watches[0].hand_carry, { plan: 'Cristian', to: 'UAE', date: '2026-08-25', role: 'deliver' });
  const page = await m.lg.forWatch(w);
  assert.ok(page.now.overlays.some((o) => /Cristian’s hand-carry plan · stop 1, UAE .* to deliver · to Lifestyle Watches/.test(o.text)), JSON.stringify(page.now.overlays));
  assert.ok(page.timeline.some((e) => e.text === 'Hand carry — deliver in UAE'));
});

test('transactions: each linked to our watch and its clients, the client by the app’s id, what is pending either way, and on the watch’s page', async () => {
  const add = (kind, data, stock, sourceId = null) =>
    db("INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ($1, $2, $3, $4, 'manual') RETURNING id", [kind, sourceId, data, stock]);
  const salva = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Salva', 'Ortiz', 'manual') RETURNING id")).rows[0].id;
  const w = (await db("INSERT INTO watches(stock_no, brand, model, origin, status, purchased_from_client_id) VALUES ('3501', 'Patek Philippe', 'Aquanaut', 'manual', 'in_stock', $1) RETURNING id", [salva])).rows[0].id;
  const lg = (await add('clients', { name: 'Salva Ortiz', country: 'Spain' }, [], 'TX-LC1')).rows[0].id;
  await add('transactions', {
    type: 'bought', date: '2026-10-21', clientId: 'TX-LC1', stockNumber: '3501', brand: 'Patek Philippe', reference: '3501',
    items: [{ id: 'i1', accessory: 'Box', qty: 1, direction: 'get', status: 'pending' }, { id: 'i2', accessory: 'Papers', qty: 2, direction: 'get', status: 'done' }],
  }, ['3501'], 'TX-1');
  await add('transactions', { type: 'sold', date: '2026-10-22', clientId: 'TX-NOBODY', stockNumber: '3502', brand: 'Rolex', items: [{ id: 'j1', accessory: 'Booklet', status: 'pending' }] }, ['3502'], 'TX-2');
  await add('settlements', { txId: 'TX-1', itemIds: ['i2'], direction: 'receive', notes: 'by hand in Valencia', ts: 1761100000000 }, [], 'TX-S1');

  const r = await m.lg.transactionsList();
  const t = r.transactions.find((x) => x.stock_no === '3501');
  assert.deepEqual([t.type, t.date, t.pending, t.total], ['bought', '2026-10-21', 1, 2]);
  assert.deepEqual(t.client, { lg_client_id: lg, name: 'Salva Ortiz', country: 'Spain', client_id: salva, client_name: 'Salva Ortiz' }, 'the app’s client id → the logistics client → ours, by its watch');
  assert.deepEqual([t.watch.id, t.watch.bought_from], [w, { id: salva, name: 'Salva Ortiz' }]);
  assert.deepEqual(t.settlements.map((s) => [s.dir, s.items, s.notes]), [['get', ['Papers × 2'], 'by hand in Valencia']]);
  const sold = r.transactions.find((x) => x.stock_no === '3502');
  assert.equal(sold.items[0].dir, 'get', 'the app’s own rule, as its Accessories page counts: only "give" is ours to give');
  assert.equal(sold.client, null, 'a client id the app does not list links nowhere');
  assert.ok(r.countries.includes('Spain') && r.clients.some((c) => c.id === lg));
  assert.ok(r.transactions.indexOf(sold) < r.transactions.indexOf(t), 'newest first');

  // On the watch's own page, with its costs.
  const page = await m.lg.forWatch(w);
  assert.deepEqual(page.transactions.map((x) => [x.type, x.pending]), [['bought', 1]]);
});

test('accessories: owed either way counted as the app counts, by accessory, brand and client; and what a watch has and is missing', async () => {
  const add = (kind, data, stock, sourceId = null) =>
    db("INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ($1, $2, $3, $4, 'manual') RETURNING id", [kind, sourceId, data, stock]);
  const adam = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Adam', 'Rasul', 'manual') RETURNING id")).rows[0].id;
  const w = (
    await db("INSERT INTO watches(stock_no, brand, model, origin, status, purchased_from_client_id, box, papers, service_papers) VALUES ('3601', 'Rolex', 'Daytona', 'manual', 'in_stock', $1, true, false, null) RETURNING id", [adam])
  ).rows[0].id;
  await add('clients', { name: 'Adam Rasul', country: 'Dubai' }, [], 'AC-LC1');
  await add('transactions', {
    type: 'bought', clientId: 'AC-LC1', stockNumber: '3601', brand: 'Rolex', reference: '3601', date: '2026-10-01',
    items: [
      { id: 'a', accessory: 'Booklet', qty: 1, direction: 'receive', status: 'pending' },
      { id: 'b', accessory: 'Links', qty: 3, direction: 'receive', status: 'pending' },
      { id: 'c', accessory: 'Box', qty: 1, direction: 'receive', status: 'done' },
    ],
  }, ['3601'], 'AC-T1');
  await add('transactions', { type: 'sold', clientId: 'AC-NOPE', stockNumber: '3602', brand: 'Audemars Piguet', items: [{ id: 'd', accessory: 'Box', qty: 2, direction: 'give', status: 'pending' }] }, ['3602'], 'AC-T2');
  await add('dubaiStock', { stockNumber: '3601', brand: 'Rolex', status: 'current', accessoriesPresent: 'Box, Warranty card', accessoriesMissing: ['Hang tag'] }, ['3601'], 'AC-D1');
  await add('accGive', { stockNumber: '3601', items: 'Strap', toClient: 'Adam Rasul', inSafe: true }, ['3601'], 'AC-G1');

  const r = await m.lg.accessoriesSummary();
  const n = (side, a) => side.by_accessory.find((x) => x.accessory === a)?.n;
  assert.ok(n(r.get, 'Links') >= 3 && n(r.get, 'Booklet') >= 1, 'by quantity, pending only');
  assert.ok(n(r.give, 'Box') >= 2);
  const rolex = r.by_brand.find((b) => b.brand === 'Rolex');
  const ap = r.by_brand.find((b) => b.brand === 'Audemars Piguet');
  assert.ok(rolex.get >= 4 && ap.give >= 2 && ap.transactions >= 1);
  const dubai = r.by_country.find((c) => c.country === 'Dubai');
  const ad = dubai.clients.find((p) => p.client?.name === 'Adam Rasul');
  assert.deepEqual([ad.give, ad.get, ad.client.client_id], [0, 4, adam], 'the client linked to ours, by its watch');
  assert.deepEqual(ad.rows.map((x) => [x.stock_no, x.dir, x.items]), [['3601', 'get', ['Booklet', 'Links × 3']]], 'one row per transaction and direction; the settled box is not pending');
  assert.equal(ad.rows[0].watch.id, w);
  const none = r.by_country.flatMap((c) => c.clients).find((p) => !p.client && p.rows.some((x) => x.stock_no === '3602'));
  assert.ok(none, 'a client the app does not list is shown, not dropped');

  // The watch's own panel: what it has, what is missing, what we owe.
  const A = (await m.lg.forWatch(w)).accessories;
  assert.deepEqual(A.chrono_key, { box: true, papers: false, service_papers: null, accessories: '' });
  assert.deepEqual(A.places.map((p) => [p.place, p.present, p.missing]), [['Dubai', ['Box', 'Warranty card'], ['Hang tag']]]);
  assert.deepEqual(A.owed_to_us.map((t) => t.items), [['Booklet', 'Links × 3']]);
  assert.deepEqual(A.received.map((t) => t.items), [['Box']]);
  assert.deepEqual(A.to_give.map((g) => [g.items, g.who, g.in_safe]), [[['Strap'], 'Adam Rasul', true]]);
});

test('the Inventory card carries the logistics app’s stock card: serial, received, who from, what came with it', async () => {
  const nathan = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Nathan james', 'williamson', 'manual') RETURNING id")).rows[0].id;
  await db(
    "INSERT INTO watches(stock_no, brand, model, reference, serial, watch_date, origin, status, purchased_from_client_id, purchased_from) VALUES ('3751', 'Rolex', 'Daytona', '116500LN', '6WT18264', '08/2023', 'manual', 'in_stock', $1, 'nathan w')",
    [nathan]
  );
  await db("INSERT INTO watches(stock_no, brand, origin, status, purchased_from) VALUES ('3752', 'Tudor', 'manual', 'in_stock', 'typed seller')");
  await db("INSERT INTO logistics_items(kind, data, stock_nos, origin) VALUES ('dubaiStock', $1, '{3751}', 'manual')", [
    { stockNumber: '3751', status: 'current', receivedAt: 1792800000000, from: 'Nathan james williamson', accessoriesPresent: ['Watch', 'Warranty Card', 'Box'], accessoriesMissing: 'Green Tag, White Tag' },
  ]);
  await db("INSERT INTO logistics_items(kind, data, stock_nos, origin) VALUES ('londonStock', $1, '{3751}', 'manual')", [{ stockNumber: '3751', status: 'moved', receivedAt: '2026-01-01', accessoriesPresent: 'old' }]);

  const { listWatches } = await import('../src/watches/index.js');
  const t = (await listWatches({ q: '3751' })).watches[0];
  assert.deepEqual(
    [t.reference, t.serial, t.watch_date, t.bought_from, t.received, t.accessories],
    ['116500LN', '6WT18264', '08/2023', 'Nathan james williamson', 1792800000000, { with: ['Watch', 'Warranty Card', 'Box'], missing: ['Green Tag', 'White Tag'] }],
    'our client by id over the typed name; the place it is in now, not a row a move left behind'
  );
  const plain = (await listWatches({ q: '3752' })).watches[0];
  assert.deepEqual([plain.bought_from, plain.received, plain.accessories], ['typed seller', null, null], 'no logistics row: nothing made up');
});

test('incoming: the app’s Incomings page — destination, history, the owner’s decision, received day, links', async () => {
  const add = (kind, data, stock, sourceId = null) =>
    db("INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ($1, $2, $3, $4, 'manual') RETURNING id", [kind, sourceId, data, stock]);
  const avneet = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Avneet', 'Singh', 'manual') RETURNING id")).rows[0].id;
  const w = (await db("INSERT INTO watches(stock_no, brand, model, origin, status, purchased_from_client_id) VALUES ('3801', 'Patek Philippe', '5267/200A', 'manual', 'incoming', $1) RETURNING id", [avneet])).rows[0].id;
  await add('clients', { name: 'Avneet Singh', country: 'United Kingdom' }, [], 'IN-LC1');
  await add('ownerDecisions', { status: 'SENT_TO_OWNER', action: 'HAND_CARRY', destination: 'Dubai' }, [], 'IN-OD1');
  await add('incomings', { stockNumber: '3801', brand: 'Patek Philippe', reference: '5267/200A-001', supplier: 'Avneet Singh', location: 'United Kingdom', status: 'pending', ownerDecisionId: 'IN-OD1', inventoryDest: 'dubai', destination: 'typed somewhere' }, ['3801'], 'IN-1');
  await add('incomings', { stockNumber: '3802', brand: 'Rolex', supplier: 'Diego', location: 'Spain', status: 'in_transit', eta: '2026-10-28' }, ['3802'], 'IN-2');
  await add('incomings', { stockNumber: '3803', brand: 'Rolex', location: 'Italy', status: 'pending', fromFob: true }, ['3803'], 'IN-3');
  await add('incomings', { stockNumber: '3804', brand: 'Rolex', location: 'Italy', status: 'arrived', arrivedAt: 1760000000000, inventoryId: 'D9' }, ['3804'], 'IN-4');
  await add('dubaiStock', { stockNumber: '3804', status: 'current', receivedAt: 1761000000000 }, ['3804'], 'IN-D9');
  await add('incomings', { stockNumber: '3805', brand: 'Tudor', location: 'Spain', status: 'pending', shipmentId: 'S9', shippedAt: 1761500000000 }, ['3805'], 'IN-5');
  await add('fobPicked', { stockNumber: '3806', brand: 'Omega', watchModel: 'Speedmaster', supplier: 'Lataj', buyPrice: '4200', buyCurrency: 'CHF' }, ['3806'], 'IN-F1');

  const r = await m.lg.incomingPage();
  const by = (no) => r.rows.find((x) => x.stock_no === no);
  const a = by('3801');
  assert.deepEqual([a.destination, a.history, a.decision], ['Dubai', false, { status: 'SENT_TO_OWNER', what: 'Hand carry · → Dubai' }], 'inventoryDest is the firm answer; the decision in words');
  assert.deepEqual([a.watch.id, a.watch.bought_from?.id, a.supplier_link?.client_id], [w, avneet, avneet], 'our watch and its client; the typed client as far as it goes');
  assert.deepEqual([by('3802').decision.status, by('3802').destination], ['DECISION_NEEDED', ''], 'no decision record: still to decide; no destination set');
  assert.equal(by('3803').decision.status, 'NOT_ASKED', 'picked from FOB and not asked yet');
  assert.deepEqual([by('3804').history, by('3804').in_stock, by('3804').received_at], [true, true, new Date(1761000000000).toISOString()], 'the stock row’s day received over arrivedAt');
  assert.deepEqual([by('3805').history, by('3805').shipped], [true, true]);
  assert.deepEqual(r.fob_picked.filter((x) => x.stock_no === '3806').map((x) => [x.model, x.supplier, x.buy_price, x.buy_currency]), [['Speedmaster', 'Lataj', 4200, 'CHF']]);
});

test('shipments: the app’s Live Shipments and Need to Give and Collect — places, cost, stage, watches, links', async () => {
  const add = (kind, data, stock, sourceId = null) =>
    db("INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ($1, $2, $3, $4, 'manual') RETURNING id", [kind, sourceId, data, stock]);
  const gaetano = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Gaetano', 'Russo', 'manual') RETURNING id")).rows[0].id;
  const w = (await db("INSERT INTO watches(stock_no, brand, model, reference, origin, status, purchased_from_client_id) VALUES ('3901', 'Patek Philippe', 'Aquanaut', '5168G-001', 'manual', 'incoming', $1) RETURNING id", [gaetano])).rows[0].id;
  await add('clients', { name: 'Gaetano Russo', country: 'Italy' }, [], 'SH-LC1');
  await add('dubaiStock', { stockNumber: '3902', brand: 'Patek Philippe', watchReference: '5712/1R-001', status: 'current' }, ['3902'], 'SH-D1');
  await add('shipments', { stockNumber: '3901, 3902', fromClientId: 'SH-LC1', toText: 'Dubai office', status: 'pending', cost: 'USD 1,200', items: '2 watches + 4 boxes' }, ['3901', '3902'], 'SH-S1');
  await add('shipments', { stockNumber: '3903', fromText: 'HK', toText: 'Germany', status: 'in_transit', tracking: '123456789012', fedex: { lastStatus: { status: 'Delivery exception', location: 'HORNSEY', derivedCode: 'DE' } }, costAmount: 50, costCurrency: 'eur' }, ['3903'], 'SH-S2');
  await add('readyForDelivery', { stockNumber: '3901', watchModel: 'Aquanaut', soldToBuyer: 'Gaetano Russo', soldDate: '2026-10-22', soldPrice: 19900, soldCurrency: 'EUR', soldPriceUsd: 21492, shipmentId: 'SH-S1', ts: 2 }, ['3901'], 'SH-R1');
  await add('accCollect', { stockNumber: '3902', items: 'Box and pusher', fromClient: 'Gaetano Russo' }, ['3902'], 'SH-C1');
  await add('accGive', { stockNumber: '3901', items: 'Booklet', toClient: 'Nobody Known', inSafe: true }, ['3901'], 'SH-G1');

  const r = await m.lg.shippingPage();
  const s1 = r.shipments.find((s) => s.items === '2 watches + 4 boxes');
  assert.deepEqual([s1.from.label, s1.from.name, s1.from.link?.client_id], ['Italy', 'Gaetano Russo', gaetano], 'the app’s client by id: its name and country, linked to ours');
  assert.deepEqual([s1.to.label, s1.to.name], ['Dubai', 'Dubai office'], 'a typed place: its country picked out of the words');
  assert.deepEqual(s1.cost, { currency: 'USD', amount: 1200 }, 'the old typed cost read');
  assert.equal(s1.stage.key, 'no_tracking');
  assert.deepEqual(s1.watches.map((x) => [x.stock, x.ref, x.watch?.id || null]), [['3901', '5168G-001', w], ['3902', '5712/1R-001', null]], 'one card, every watch; ours by our record, the other described from its logistics row');
  const s2 = r.shipments.find((s) => s.tracking === '123456789012');
  assert.deepEqual([s2.stage.key, s2.cost, s2.from.label, s2.to.label], ['exception', { currency: 'EUR', amount: 50 }, 'HK', 'Germany']);
  const rd = r.ready.find((x) => x.stock_no === '3901');
  assert.deepEqual([rd.buyer.link?.client_id, rd.shipment, rd.watch.id, rd.price, rd.currency], [gaetano, 'pending', w, 19900, 'EUR'], 'the buyer linked as far as it goes; its shipment’s status');
  const c = r.to_collect.find((x) => x.stock_no === '3902');
  assert.deepEqual([c.ref, c.who.link?.client_id], ['5712/1R-001', gaetano]);
  const g = r.to_give.find((x) => x.stock_no === '3901');
  assert.deepEqual([g.in_safe, g.who.link, g.watch.id], [true, null, w]);
  assert.ok(r.clients.some((x) => x.name === 'Gaetano Russo'));

  // Leave the shared database as it was: later tests count shipments and look clients up by name.
  await db("DELETE FROM logistics_items WHERE source_id LIKE 'SH-%'");
  await db("DELETE FROM watches WHERE stock_no = '3901'");
  await db('DELETE FROM clients WHERE id = $1', [gaetano]);
});

/* ── the API ── */

function client() {
  let cookie = '';
  const call = async (method, url, body, { csrf = true } = {}) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-Requested-With'] = 'masterapp';
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(api + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), type };
  };
  return { call, login: (email, password) => call('POST', '/api/login', { email, password }) };
}

test('the API: read by anyone signed in, changed by editors, from our own page only', async () => {
  const admin = client();
  await admin.login('boss@example.com', 'admin-password-1');
  await admin.call('POST', '/api/users', { email: 'ed@example.com', role: 'editor', password: 'editor-password' });
  await admin.call('POST', '/api/users', { email: 'vi@example.com', role: 'viewer', password: 'viewer-password' });
  const editor = client();
  const viewer = client();
  await editor.login('ed@example.com', 'editor-password');
  await viewer.login('vi@example.com', 'viewer-password');

  const meta = (await viewer.call('GET', '/api/meta')).body;
  assert.ok(meta.logistics.groups.some((g) => g.key === 'shipments'));
  assert.ok(meta.logistics.groups.some((g) => g.key === 'safe'), 'the In Safe tab');
  const safe = await viewer.call('GET', '/api/logistics/in-safe');
  assert.equal(safe.status, 200);
  assert.ok(Array.isArray(safe.body.watches) && Array.isArray(safe.body.accessories));
  assert.ok(meta.logistics.groups.some((g) => g.key === 'checkout'), 'the Checked out tab');
  const out = await viewer.call('GET', '/api/logistics/checked-out');
  assert.equal(out.status, 200);
  assert.ok(Array.isArray(out.body.watches) && Array.isArray(out.body.by_origin));
  assert.ok(meta.logistics.groups.some((g) => g.key === 'handcarry'), 'the Hand carry tab');
  const hand = await viewer.call('GET', '/api/logistics/hand-carry');
  assert.equal(hand.status, 200);
  assert.ok(Array.isArray(hand.body.plans) && Array.isArray(hand.body.waiting.deliver));
  assert.ok(meta.logistics.groups.some((g) => g.key === 'transactions'), 'the Transactions tab');
  const txs = await viewer.call('GET', '/api/logistics/transactions');
  assert.equal(txs.status, 200);
  assert.ok(Array.isArray(txs.body.transactions) && Array.isArray(txs.body.countries));
  const ships = await viewer.call('GET', '/api/logistics/shipping');
  assert.equal(ships.status, 200);
  assert.ok(Array.isArray(ships.body.shipments) && Array.isArray(ships.body.ready));
  const incs = await viewer.call('GET', '/api/logistics/incoming');
  assert.equal(incs.status, 200);
  assert.ok(Array.isArray(incs.body.rows) && Array.isArray(incs.body.fob_picked));
  const accs = await viewer.call('GET', '/api/logistics/accessories');
  assert.equal(accs.status, 200);
  assert.ok(typeof accs.body.give.total === 'number' && Array.isArray(accs.body.by_country));
  assert.ok(meta.logistics.kinds.some((k) => k.key === 'shipments' && k.fields.length));

  assert.equal((await client().call('GET', '/api/logistics/items')).status, 401, 'signed out reads nothing');
  const list = (await viewer.call('GET', '/api/logistics/items?group=shipments')).body;
  assert.ok(list.items.some((i) => i.kind === 'shipments' && i.summary.sub.includes('Buyer Two')));
  assert.ok(list.kinds.some((k) => k.kind === 'shipments' && k.n === 2));
  const found = (await viewer.call('GET', '/api/logistics/items?q=Polisher')).body;
  assert.deepEqual(found.items.map((i) => i.source_id), ['D2'], 'searched across every field');

  const s1 = await item('shipments', 'S1');
  assert.equal((await viewer.call('PATCH', `/api/logistics/items/${s1.id}`, { status: 'delivered' })).status, 403, 'a viewer cannot edit');
  assert.equal((await editor.call('PATCH', `/api/logistics/items/${s1.id}`, { status: 'delivered' }, { csrf: false })).status, 403, 'no header, no write');
  assert.equal((await editor.call('PATCH', `/api/logistics/items/${s1.id}`, { status: 'lost' })).status, 400, 'not one of the statuses');
  assert.equal((await editor.call('PATCH', `/api/logistics/items/${s1.id}`, { fedex: { x: 1 } })).status, 400, 'a nested record is not edited loose');
  assert.equal((await editor.call('PATCH', `/api/logistics/items/${s1.id}`, { constructor: 'x' })).status, 400);
  const e = await editor.call('PATCH', `/api/logistics/items/${s1.id}`, { status: 'delivered', deliveredAt: '2026-10-24', costAmount: '1,250.50' });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  const got = (await viewer.call('GET', `/api/logistics/items/${s1.id}`)).body;
  assert.equal(got.data.costAmount, 1250.5);
  assert.deepEqual(got.locked_fields.sort(), ['costAmount', 'deliveredAt', 'status']);
  assert.ok((await viewer.call('GET', `/api/logistics/items/${s1.id}/events`)).body.events.some((x) => x.action === 'update'));

  assert.equal((await editor.call('POST', '/api/logistics/items', { kind: 'settings', data: {} })).status, 400);
  const made = await editor.call('POST', '/api/logistics/items', { kind: 'logisticCosts', data: { title: 'Taxi', stockNumber: '1668', amount: '40', currency: 'gbp', date: '2026-10-24' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const mine = (await viewer.call('GET', `/api/logistics/items/${made.body.id}`)).body;
  assert.equal(mine.origin, 'manual');
  assert.deepEqual(mine.stock_nos, ['1668']);
  assert.equal(mine.data.currency, 'GBP');
  assert.ok(mine.watches.some((w) => w.stock_no === '1668'), 'linked to our watch by its stock number');
  assert.equal((await editor.call('DELETE', `/api/logistics/items/${made.body.id}`)).status, 200);
  assert.equal((await editor.call('POST', `/api/logistics/items/${made.body.id}/restore`)).status, 200);

  const watchId = (await db("SELECT id FROM watches WHERE stock_no = '1668'")).rows[0].id;
  const wl = (await viewer.call('GET', `/api/watches/${watchId}/logistics`)).body;
  assert.equal(wl.now.headline, 'In Dubai');
  assert.ok(wl.as_of, 'says when the logistics app was last read');
  assert.equal(wl.costs.totals.GBP, 540, 'the taxi added here counts too');

  const ov = (await viewer.call('GET', '/api/logistics/overview')).body;
  assert.ok(Array.isArray(ov.shipments) && Array.isArray(ov.recent));

  const fileId = Number((await item('dubaiStock', 'D1')).data.photos[0].slice('lgfile:'.length));
  assert.equal((await client().call('GET', `/api/logistics/files/${fileId}`)).status, 401, 'files are behind the sign-in');
  const pic = await viewer.call('GET', `/api/logistics/files/${fileId}?thumb=1`);
  assert.equal(pic.status, 200);
  assert.equal(pic.type, 'image/jpeg');

  // A picture still on the worker shows straight away: copied on first sight, behind the sign-in,
  // and only an address on the worker that a record names.
  const p2 = `${base}/photos/p2.jpg`;
  await editor.call('POST', '/api/logistics/items', { kind: 'otherReceivingPics', data: { title: 'Arrival photos', notes: p2 } });
  const proxied = `/api/logistics/worker-file?u=${encodeURIComponent(p2)}`;
  assert.equal((await client().call('GET', proxied)).status, 401);
  const shown = await viewer.call('GET', `${proxied}&thumb=1`);
  assert.equal(shown.status, 200);
  assert.equal(shown.type, 'image/jpeg');
  assert.equal((await db('SELECT count(*)::int AS n FROM logistics_files WHERE source_ref = $1', [p2])).rows[0].n, 1, 'kept, not fetched again');
  assert.equal((await viewer.call('GET', `/api/logistics/worker-file?u=${encodeURIComponent(`${base}/photos/notnamed.jpg`)}`)).status, 404, 'no record names it');
  assert.equal((await viewer.call('GET', `/api/logistics/worker-file?u=${encodeURIComponent('http://example.invalid/photos/p2.jpg')}`)).status, 404, 'not the worker');
  const pdf = (await db("SELECT id FROM logistics_files WHERE content_type = 'application/pdf'")).rows[0].id;
  assert.equal((await viewer.call('GET', `/api/logistics/files/${pdf}?thumb=1`)).type, 'image/svg+xml', 'a PDF shows as a tile among the pictures');
  assert.equal((await viewer.call('GET', '/api/meta')).body.logistics.photoPrefix, `${base}/photos/`);

  // A client added here can be chosen on a shipment, and its name shows.
  const cl = await editor.call('POST', '/api/logistics/items', { kind: 'clients', data: { name: 'New Dealer', country: 'UAE' } });
  const choices = (await viewer.call('GET', '/api/logistics/clients')).body.clients;
  const mine2 = choices.find((c) => c.name === 'New Dealer');
  assert.equal(mine2.id, `ma-${cl.body.id}`);
  const ship = await editor.call('POST', '/api/logistics/items', { kind: 'shipments', data: { stockNumber: '1950', toClientId: mine2.id, status: 'pending' } });
  assert.match((await viewer.call('GET', `/api/logistics/items/${ship.body.id}`)).body.summary.sub, /New Dealer/);
});

test('a trip keeps the watches it carried after one of them is sold (its row id then points nowhere)', async () => {
  state.dubaiStock = state.dubaiStock.filter((r) => r.id !== 'D2');
  state.personTrips[0].notes = 'edited after the sale';
  await m.sync.syncLogistics();
  assert.deepEqual((await item('personTrips', 'T1')).stock_nos.sort(), ['1668', '1700']);
});

test('a logistics client is our client by the watches, else by a full name; a person’s choice wins; its situation', async () => {
  // Our 1668 was sold to Bertrand Twofold (Chrono Key's link); the logistics app sold 1668 to "Buyer Two" — the same person.
  const x = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Bertrand', 'Twofold', 'manual') RETURNING id")).rows[0].id;
  await db("UPDATE watches SET sold_to_client_id = $1 WHERE stock_no IN ('1668', '1700')", [x]);
  await db("INSERT INTO logistics_items(kind, data, stock_nos, origin) VALUES ('soldStocks', $1, '{1700}', 'manual')", [{ stockNumber: '1700', soldToBuyer: 'Buyer Two' }]);
  m.lgc.forgetClientSnapshot();
  const list = await m.lgc.listLogisticsClients();
  const two = list.clients.find((c) => c.name === 'Buyer Two');
  assert.deepEqual([two.link.client_id, two.link.how, two.link.stocks], [x, 'watches', ['1668', '1700']], 'by the watches, not the name');
  assert.deepEqual([two.we_give, two.they_give], [2, 3], 'what is still owed either way');
  const one = list.clients.find((c) => c.name === 'Dealer One');
  assert.equal(one.link.how, 'name', 'no watch decides it: the full name that is one client of ours');
  assert.equal(list.clients.find((c) => c.name === 'New Dealer').link.client_id, null, 'no watch and no name: not linked');
  assert.deepEqual((await m.lgc.listLogisticsClients({ q: 'twofold' })).clients.map((c) => c.name), ['Buyer Two'], 'found by our client’s name too');
  // A parcel alone proves nothing: New Dealer only shipped 1700, which we bought from someone else.
  const y = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Yannick', 'Elsewhere', 'manual') RETURNING id")).rows[0].id;
  await db("UPDATE watches SET purchased_from_client_id = $1 WHERE stock_no = '1700'", [y]);
  const nd = list.clients.find((c) => c.name === 'New Dealer');
  await db("INSERT INTO logistics_items(kind, data, stock_nos, origin) VALUES ('shipments', $1, '{1700}', 'manual')", [{ stockNumber: '1700', fromClientId: `ma-${nd.id}`, status: 'pending' }]);
  m.lgc.forgetClientSnapshot();
  assert.equal((await m.lgc.listLogisticsClients()).clients.find((c) => c.name === 'New Dealer').link.client_id, null, 'a shipment alone links no one');
  // One watch alone links only a name that looks alike; a place or a polisher typed as a client is suggested, not linked.
  const q = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Quentin', 'Farrow', 'manual') RETURNING id")).rows[0].id;
  const lcClient = async (name, stock) => {
    const id = (await db("INSERT INTO logistics_items(kind, data, origin) VALUES ('clients', $1, 'manual') RETURNING id", [{ name }])).rows[0].id;
    await db("INSERT INTO watches(stock_no, origin, status, purchased_from_client_id) VALUES ($1, 'manual', 'in_stock', $2)", [stock, q]);
    await db("INSERT INTO logistics_items(kind, data, stock_nos, origin) VALUES ('transactions', $1, $2, 'manual')", [{ type: 'bought', clientId: `ma-${id}`, stockNumber: stock }, [stock]]);
    return id;
  };
  const [pete, hk, quenten] = [await lcClient('Sina Star', '2950'), await lcClient('HK', '2951'), await lcClient('Quenten Farow', '2952')];
  m.lgc.forgetClientSnapshot();
  const now = (await m.lgc.listLogisticsClients()).clients;
  assert.equal(now.find((c) => c.id === pete).link.client_id, null, 'one watch and a name nothing like ours');
  assert.equal(now.find((c) => c.id === hk).link.client_id, null, 'a place is not a person');
  assert.deepEqual([now.find((c) => c.id === quenten).link.client_id, now.find((c) => c.id === quenten).link.how], [q, 'watches'], 'one watch, the name typed another way');
  assert.ok((await m.lgc.logisticsClient(pete)).candidates.some((x) => x.client_id === q), 'still suggested, for a person to decide');

  const v = await m.lgc.logisticsClient(two.id);
  assert.equal(v.situation.counts.we_give, 2);
  assert.deepEqual(v.situation.accessories.we_give[0].items, [{ accessory: 'Box', qty: 2 }]);
  assert.ok(v.situation.shipments.some((s) => s.dir === 'to_them' && s.item.stock_nos.includes('1668')), 'the shipment to them');
  assert.ok(v.situation.stocks.some((s) => s.dir === 'sold' && s.stock === '1668' && s.watch), 'the watch sold to them, linked to ours');

  const ours = await m.lgc.forOurClient(x);
  assert.deepEqual(ours.linked.map((c) => c.name), ['Buyer Two']);
  assert.equal(ours.situation.counts.they_give, 3);
  assert.ok(ours.watch_now['1668']?.headline, 'where each of their watches is now');

  // A person says "none of ours": no longer linked, and not suggested again; "auto" works it out again.
  await m.lgc.setClientLink(two.id, null, null);
  assert.deepEqual((await m.lgc.forOurClient(x)).linked, []);
  assert.deepEqual((await m.lgc.forOurClient(x)).suggestions, []);
  await m.lgc.setClientLink(two.id, 'auto', null);
  assert.equal((await m.lgc.forOurClient(x)).linked.length, 1);
  await assert.rejects(m.lgc.setClientLink(two.id, 999999, null), /No such client of ours/);
  const events = await db("SELECT changes FROM logistics_events WHERE item_id = $1 AND source = 'user' ORDER BY id", [two.id]);
  assert.deepEqual(
    events.rows.map((e) => e.changes.our_client),
    [
      [`Bertrand Twofold (#${x}), by the watches`, 'none of ours (chosen by a person)'],
      ['none of ours (chosen by a person)', `Bertrand Twofold (#${x}), by the watches`],
    ],
    'each change in its history, saying what was decided'
  );
  // A person's link to a client of ours deleted since counts for nothing: the worked-out match shows instead.
  const z = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Zed', 'Gone', 'manual') RETURNING id")).rows[0].id;
  await m.lgc.setClientLink(two.id, z, null);
  await db('UPDATE clients SET deleted_at = now(), updated_at = now() WHERE id = $1', [z]);
  const after = (await m.lgc.listLogisticsClients()).clients.find((c) => c.name === 'Buyer Two').link;
  assert.deepEqual([after.client_id, after.how], [x, 'watches']);
  await m.lgc.setClientLink(two.id, 'auto', null);

  // Names in any script are names; a consignment says which way it goes.
  assert.equal(m.lgc.normName('  محمد  العلي '), 'محمد العلي');
  assert.equal(m.lgc.normName('Rooh Ul-Amín'), 'rooh ul amin');
  const add = (kind, data, stock) => db("INSERT INTO logistics_items(kind, data, stock_nos, origin) VALUES ($1, $2, $3, 'manual')", [kind, data, stock]);
  await add('londonStock', { stockNumber: '2801', status: 'consignment', consignment: { with: 'Buyer Two', direction: 'from_client' } }, ['2801']);
  await add('londonStock', { stockNumber: '2802', status: 'consignment', consignment: { with: 'Buyer Two', direction: 'to_client' } }, ['2802']);
  await add('readyForDelivery', { stockNumber: '2803', soldToBuyer: 'Buyer Two', status: 'shipped' }, ['2803']);
  const w = (await m.lgc.logisticsClient(two.id)).situation.with_them.map((x) => `${x.label}:${x.item.stock_nos[0]}`).sort();
  assert.deepEqual(w, ['On consignment from them:2801', 'Ours, on consignment with them:2802', 'Sold to them, on its way:2803']);

  // The API: anyone signed in reads, only an editor links, and only with a client of ours, none, or auto.
  const admin = client();
  await admin.login('boss@example.com', 'admin-password-1');
  assert.equal((await admin.call('GET', `/api/clients/${x}/logistics`)).body.linked[0].name, 'Buyer Two');
  assert.equal((await admin.call('PUT', `/api/logistics/client-view/${two.id}/link`, { client_id: 'x' })).status, 400);
  const viewer = client();
  await viewer.login('vi@example.com', 'viewer-password');
  assert.equal((await viewer.call('GET', `/api/logistics/client-view/${two.id}`)).status, 200);
  assert.equal((await viewer.call('PUT', `/api/logistics/client-view/${two.id}/link`, { client_id: null })).status, 403);
});
