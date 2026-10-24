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
