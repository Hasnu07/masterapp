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
    settings: {
      fobPassword: 'secret-fob', workerToken: 'tok-in-settings', claudeKey: 'k-claude',
      // The travel allowance's part is copied (rates and salaries, asked) — named keys only, scrubbed.
      perDiem: { currency: 'EUR', rates: { uae: 120, europe: 60 }, majorityHours: 12, places: { blogna: 'europe' }, salaries: [{ name: 'Kashan', amount: 3000, currency: 'GBP' }], apiKey: 'pd-secret-key', note: 'pd-unlisted' },
    },
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
  // 1 checked out, 1 vault holder, 1 shipping document, the travel allowance's settings.
  assert.equal(s.created, 34, JSON.stringify(s));
  const pd = (await item('perDiem', 'settings')).data;
  assert.deepEqual(pd, { currency: 'EUR', rates: { uae: 120, europe: 60 }, majorityHours: 12, places: { blogna: 'europe' }, salaries: [{ name: 'Kashan', amount: 3000, currency: 'GBP' }] }, 'the allowance’s named keys only');
  const kinds = (await db('SELECT DISTINCT kind FROM logistics_items')).rows.map((r) => r.kind);
  assert.ok(!kinds.includes('settings') && !kinds.includes('notepad'));
  assert.ok(kinds.includes('someNewList'), 'a list the catalog does not know yet is kept too');
  const everything = JSON.stringify((await db('SELECT data FROM logistics_items UNION ALL SELECT data FROM logistics_records')).rows);
  for (const secret of ['secret-fob', 'tok-in-settings', 'k-claude', '9911', 'a private note', 'pd-secret-key', 'pd-unlisted']) {
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

test('the vault’s photo store is not part of a logistics record', async () => {
  state.dubaiStock[0].vaultPhotos = ['https://example.invalid/v.jpg'];
  const s = await m.sync.syncLogistics();
  assert.equal(s.updated, 0, 'a missed or changed read of it changes no stock row');
  delete state.dubaiStock[0].vaultPhotos;
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

test('a trip keeps the watches it carried after one of them is sold (its row id then points nowhere)', async () => {
  state.dubaiStock = state.dubaiStock.filter((r) => r.id !== 'D2');
  state.personTrips[0].notes = 'edited after the sale';
  await m.sync.syncLogistics();
  assert.deepEqual((await item('personTrips', 'T1')).stock_nos.sort(), ['1668', '1700']);
});
