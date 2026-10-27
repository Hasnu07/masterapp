import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';

/*
 * Three of the logistics app's pages in masterapp — Logistic Cost, Route
 * Optimizer and Owner Decisions (src/logistics/pages/costs.js,
 * routeoptimizer.js, ownerdecisions.js): the figures each works out from
 * our copy of the app's records, the app's own rules ported, the one rule
 * every tab keeps (a stock number is OUR watch, with our clients by Chrono
 * Key's ids; a typed name as far as the logistics client goes), and what
 * each page says about one watch on its Inventory card. Against a stand-in
 * worker and a real Postgres (TEST_DATABASE_URL), which is EMPTIED first.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let worker, base, m, db, dataDir, server, api, state;

function fixture() {
  return {
    settings: { fobPassword: 'secret-fob', claudeKey: 'k-claude' },
    clients: [
      { id: 'c1', name: 'Dealer One', country: 'UAE' },
      { id: 'c2', name: 'Salva', country: 'Spain' },
    ],
    londonStock: [
      { id: 'L1', stockNumber: '4101', brand: 'Rolex', watchModel: 'Daytona', watchReference: '126500LN', status: 'current', from: 'Salva', buyPrice: 10000, buyCurrency: 'GBP' },
      { id: 'L2', stockNumber: '4109', brand: 'Rolex', watchModel: 'Gone', status: 'moved' },
    ],
    dubaiStock: [
      { id: 'D1', stockNumber: '4102', brand: 'Patek Philippe', watchModel: 'Nautilus', status: 'consignment', buyPrice: 20000, buyCurrency: 'AED' },
      { id: 'D2', stockNumber: '4103', brand: 'Tudor', watchModel: 'Black Bay', status: 'current' },
    ],
    hkSituation: [
      { id: 'H1', stockNumber: '4104', brand: 'Audemars Piguet', description: 'AP | Royal Oak', section: 'in_hand' },
      { id: 'H2', stockNumber: '4105', brand: 'Omega', section: 'incoming' },
    ],
    shipments: [
      { id: 'S1', stockNumber: '4101', fromText: 'Switzerland', toText: 'Dubai', date: '2026-10-20', tracking: '123456789012', status: 'delivered', costAmount: 300, costCurrency: 'USD' },
      { id: 'S2', stockNumber: '4102, 4103', fromText: 'Geneva', toText: 'uae', date: '2026-10-10', status: 'delivered', costAmount: 400, costCurrency: 'EUR' },
    ],
    thirdPartyShipments: [{ id: 'T1', moverName: 'Ferrari', fromCountry: 'swiss', toCountry: 'dubai', amount: 500, currency: 'USD', shipmentDate: '2026-09-01', stockNumber: '4103', isOurStock: true }],
    logisticCosts: [
      { id: 'C1', stockNumber: '4101, 4102', title: 'Courier', amount: 200, currency: 'AED', date: '2026-10-20', shipmentId: 'S1', fromName: 'Switzerland', toName: '🏢 Dubai', toClientId: 'c1', ts: 1 },
      { id: 'C2', stockNumber: '4101', title: 'Insurance', amount: 50, currency: 'USD', date: '2026-10-21', fromName: 'Salva', toName: 'Dubai', ts: 2 },
      { id: 'C3', stockNumber: '4101', title: 'Flight (Kashan trip)', amount: 999, currency: 'USD', date: '2026-10-19', tripId: 'TR1', tripCostId: 'tc1', ts: 3 },
      { id: 'C4', stockNumber: '4103', title: '3rd Party · Ferrari', amount: 500, currency: 'USD', date: '2026-09-01', thirdPartyShipmentId: 'T1', fromName: 'swiss', toName: 'dubai', ts: 4 },
      { id: 'C5', stockNumber: '4102', title: 'Polish — Sina', amount: 100, currency: 'AED', date: '2026-08-01', polishId: 'P1', fromName: 'Dubai Stock', toName: 'Sina', ts: 5 },
      { id: 'C6', stockNumber: '', title: 'Old one', amount: 10, currency: '', date: '2025-01-01', fromName: '', toName: '', ts: 6 },
    ],
    personTrips: [
      {
        id: 'TR1', personName: 'Kashan', status: 'completed', startDate: '2026-10-19', stockIds: ['lon-L1', 'dubai-D1'],
        legs: [{ id: 'lg1', from: 'Zurich', to: 'Dubai', date: '2026-10-19' }],
        costs: [{ id: 'tc1', category: 'Flight', amount: 1000, currency: 'GBP', legId: 'lg1' }, { id: 'tc2', category: 'Taxi', amount: 50, currency: 'AED' }],
      },
      { id: 'TR2', personName: 'Ben', status: 'planned', startDate: '2026-11-01', stockIds: [], legs: [{ id: 'lg2', from: 'Geneva', to: 'Dubai', date: '2026-11-01' }], costs: [{ id: 'tc3', category: 'Flight', amount: 700, currency: 'EUR', legId: 'lg2' }] },
    ],
    incomings: [
      { id: 'I1', stockNumber: '4201', brand: 'Patek Philippe', reference: '5711/1A', supplier: 'Salva', location: 'Spain', destination: 'Dubai', status: 'pending', buyPrice: 25000, buyCurrency: 'EUR', ownerDecisionId: 'OD1', notes: 'box only' },
      { id: 'I2', stockNumber: '4202', brand: 'Rolex', reference: '126710', supplier: 'Diego', location: 'Spain', inventoryDest: 'dubai', status: 'pending' },
      { id: 'I3', stockNumber: '4203', brand: 'Omega', supplier: 'Gaetano', location: 'Italy', destination: 'Dubai', status: 'pending', fromFob: true },
      { id: 'I4', stockNumber: '4204', brand: 'Rolex', supplier: 'Salva', location: 'Spain', status: 'arrived', inventoryId: 'D9', ownerDecisionId: 'OD2' },
      { id: 'I5', stockNumber: '4205', brand: 'Cartier', supplier: 'Lataj', location: 'Switzerland', destination: 'Dubai', status: 'pending', ownerDecisionId: 'OD3' },
      { id: 'I6', stockNumber: '4206', brand: 'Tudor', supplier: 'Francesco', location: 'Italy', destination: 'Dubai', status: 'in_transit', ownerDecisionId: 'OD4' },
      { id: 'I7', stockNumber: '4207', brand: 'Breguet', supplier: 'Diego', location: 'Spain', status: 'pending', ownerDecisionId: 'OD5' },
    ],
    ownerDecisions: [
      { id: 'OD1', incomingId: 'I1', stockNumber: '4201', status: 'SENT_TO_OWNER', briefId: 'B1', requestedAt: 1760000000000, events: [{ type: 'created', by: 'manager', ts: 1760000000000 }, { type: 'sent_to_owner', by: 'manager', source: 'WHATSAPP', ts: 1760000001000, text: 'Sent to the owner on WhatsApp' }] },
      { id: 'OD2', incomingId: 'I4', stockNumber: '4204', status: 'APPROVED', action: 'COLLECT', confirmedAt: 1760000000000 },
      { id: 'OD3', incomingId: 'I5', stockNumber: '4205', status: 'APPROVED', action: 'SHIP', destination: 'Dubai', collector: 'Ben', confirmedAt: 1760000002000, confirmedBy: 'manager', rawInstruction: 'Ship it to Dubai with Ben', events: [{ type: 'created', by: 'manager', ts: 1760000000000 }, { type: 'updated', by: 'manager', source: 'APP', ts: 1760000002000, from: { status: 'DECISION_NEEDED' }, to: { status: 'APPROVED' } }] },
      { id: 'OD4', incomingId: 'I6', stockNumber: '4206', status: 'IN_EXECUTION', action: 'SHIP', destination: 'London', confirmedAt: 1760000003000 },
      { id: 'OD5', incomingId: 'I7', stockNumber: '4207', status: 'HOLD', reviewAt: '2020-01-01', holdUntil: '2026-12-01' },
      { id: 'OD6', incomingId: 'GONE', stockNumber: '4208', status: 'COMPLETED', action: 'HAND_CARRY', updatedAt: 1760000009000 },
    ],
    ownerBriefs: [{ id: 'B1', ts: 1760000001000, by: 'manager', to: '+971500001234', group: 'supplier', count: 2, text: '📦 INCOMINGS — hello', incomingIds: ['I1', 'I4'] }],
  };
}

before(async () => {
  worker = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    // A stand-in for the converter's rate source (USD-based, as Coinbase answers): no test reaches the internet.
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
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => worker.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${worker.address().port}`;
  state = fixture();

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lgd-'));
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
    costs: await import('../src/logistics/pages/costs.js'),
    route: await import('../src/logistics/pages/routeoptimizer.js'),
    od: await import('../src/logistics/pages/ownerdecisions.js'),
  };
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/auth/index.js')).ensureFirstAdmin(() => {});
  db = m.db.query;
  server = (await import('../src/web/server.js')).createServer().listen(0);
  api = `http://127.0.0.1:${server.address().port}`;

  // Our watches and clients, as Chrono Key ties them: 4101 bought from Salva Perez and sold to Dealer One; two incomings bought from Salva Perez, so the logistics client "Salva" is hers by its watches.
  const salva = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Salva', 'Perez', 'manual') RETURNING id")).rows[0].id;
  const dealer = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Dealer', 'One', 'manual') RETURNING id")).rows[0].id;
  const watch = (no, brand, model, status, from, to) =>
    db('INSERT INTO watches(stock_no, brand, model, origin, status, purchased_from_client_id, sold_to_client_id) VALUES ($1, $2, $3, $4, $5, $6, $7)', [no, brand, model, 'manual', status, from, to]);
  await watch('4101', 'Rolex', 'Daytona', 'sold', salva, dealer);
  await watch('4102', 'Patek Philippe', 'Nautilus', 'in_stock', null, null);
  await watch('4201', 'Patek Philippe', 'Nautilus', 'incoming', salva, null);
  await watch('4204', 'Rolex', 'Submariner', 'in_stock', salva, null);
  await watch('4205', 'Cartier', 'Santos', 'incoming', null, null);
  Object.assign(state, { ours: { salva, dealer } });
  await m.sync.syncLogistics();
});

after(async () => {
  server.close();
  worker.close();
  await m.db.pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const row = async (kind, sourceId) => (await db('SELECT * FROM logistics_items WHERE kind = $1 AND source_id = $2', [kind, sourceId])).rows[0];
const near = (a, b, tol = 0.02) => assert.ok(Math.abs(a - b) <= tol, `${a} ≈ ${b}`);

/* ── Logistic Cost ── */

test('costs: every line, newest day first, its source and the record it stands for, totals by currency, our watch and clients on each', async () => {
  const r = await m.costs.page();
  assert.deepEqual(r.lines.map((l) => l.title), ['Insurance', 'Courier', 'Flight (Kashan trip)', '3rd Party · Ferrari', 'Polish — Sina', 'Old one'], 'the app’s order: the day, newest first');
  assert.deepEqual(r.lines.map((l) => l.source), ['manual', 'shipment', 'trip', 'mover', 'polish', 'manual']);
  assert.deepEqual(r.by_currency, { AED: { amount: 300, count: 2 }, USD: { amount: 1549, count: 3 }, OTHER: { amount: 10, count: 1 } }, 'all-time totals, a line with no currency as the app’s OTHER');
  assert.equal(r.rates.usd.AED, 3.6725, 'the converter’s rates, for the total in dollars');

  const courier = r.lines.find((l) => l.title === 'Courier');
  assert.equal(courier.for_id, (await row('shipments', 'S1')).id, 'a cost written for a live shipment opens that shipment');
  assert.equal(r.lines.find((l) => l.source === 'mover').for_id, (await row('thirdPartyShipments', 'T1')).id);
  assert.equal(r.lines.find((l) => l.source === 'trip').for_id, (await row('personTrips', 'TR1')).id);
  assert.deepEqual(courier.watches.map((w) => [w.stock_no, w.watch?.id ? 'ours' : 'not ours']), [['4101', 'ours'], ['4102', 'ours']], 'every stock number on the line, ours when it is');
  const w = courier.watches[0].watch;
  assert.deepEqual([w.bought_from.name, w.sold_to.name, w.status], ['Salva Perez', 'Dealer One', 'sold'], 'our clients by Chrono Key’s ids');
  assert.equal(courier.to.name, 'Dubai', 'the app’s 🏢 mark on a company is dropped');
  assert.equal(courier.to.link.lg_client_id, (await row('clients', 'c1')).id, 'the app’s own client id on the line → the logistics client');
  const ins = r.lines.find((l) => l.title === 'Insurance');
  assert.equal(ins.from.link.lg_client_id, (await row('clients', 'c2')).id, 'a typed name links as far as the logistics client of that name');
  assert.equal(ins.from.link.client_id, state.ours.salva, '…and to our client, as that one is linked by its watches');
  assert.equal(r.lines.find((l) => l.title === 'Old one').currency, '', 'no currency is not guessed');
});

test('costs on a watch: the app’s own costsForStock, in its currencies, for the Inventory card', async () => {
  const facts = (await m.pages.factsFor(['4101'])).get('4101').filter((f) => f.page === 'costs');
  // C1 split over two watches (AED 100), C2 (USD 50), the trip's lines over its two watches (GBP 500, AED 25); C3 is the trip's own line, counted once; S1's cost has C1 standing for it.
  assert.deepEqual(facts, [{ page: 'costs', text: 'Logistic cost so far: GBP 500 + AED 125 + USD 50 (4 lines)', link: '#/logistics/costs', tone: '' }]);
  assert.equal((await m.pages.factsFor(['4109'])).get('4109'), undefined, 'a watch nothing was spent on says nothing');
});

/* ── Route Optimizer ── */

test('route optimizer: a typed place to the app’s six', () => {
  const { placeOf } = m.route;
  assert.deepEqual(['swiss', 'Geneva', 'Mayfair', 'uk', 'HK', 'milan', 'uae', '🏢 Dubai', 'belfast', ''].map(placeOf), ['Switzerland', 'Switzerland', 'London', 'London', 'Hong Kong', 'Italy', 'Dubai', 'Dubai', 'Belfast', '']);
});

test('route optimizer: the watches available at each place, what each cost to buy and to move, and every recorded move between two places', async () => {
  const r = await m.route.page();
  assert.deepEqual(
    Object.fromEntries(Object.entries(r.available).map(([k, v]) => [k, v.map((w) => w.stock_no)])),
    { London: ['4101'], Dubai: ['4102', '4103'], 'Hong Kong': ['4104'] },
    'in stock or on consignment in London and Dubai, in hand on the HK list; a moved row and an HK incoming are not there'
  );
  const daytona = r.available.London[0];
  assert.deepEqual(daytona.buy, { amount: 10000, currency: 'GBP' });
  assert.equal(daytona.buy_usd, 12500, 'at the converter’s rates');
  assert.equal(daytona.log_lines, 4);
  near(daytona.log_usd, 100 / 3.6725 + 50 + 1000 / 2 / 0.8 + 50 / 2 / 3.6725, 0.05);
  assert.deepEqual([daytona.watch.stock_no, daytona.watch.bought_from.name, daytona.watch.sold_to.name], ['4101', 'Salva Perez', 'Dealer One']);
  assert.equal(daytona.from.link.client_id, state.ours.salva, 'the typed "bought from" on the row, as far as it goes');
  assert.equal(r.available.Dubai.find((w) => w.stock_no === '4103').buy, null, 'no cost price is said, not guessed');
  assert.equal(r.available['Hong Kong'][0].model, 'AP | Royal Oak', 'an HK row is named by its description');

  const chdx = r.moves.filter((x) => x.from === 'Switzerland' && x.to === 'Dubai').sort((a, b) => a.method.localeCompare(b.method));
  assert.deepEqual(
    chdx.map((x) => [x.kind, x.method, Math.round(x.usd)]),
    [['cost', '3rd Party · Ferrari', 500], ['shipment', 'Courier', 444], ['cost', 'Courier', 54], ['shipment', 'FedEx', 300], ['mover', 'Ferrari', 500], ['trip', 'Personal (Kashan)', 1264]],
    'live shipments (the carrier from the tracking number), a mover, the cost lines, a completed trip’s leg (its own lines and the unassigned ones) — "Geneva" → "uae" and "swiss" → "dubai" counted on the route; a mover’s shipment and the cost line written for it are two moves, as the app counts them'
  );
  assert.deepEqual(chdx.filter((x) => x.kind === 'cost').map((x) => x.stands_for), ['mover', 'shipment'], 'a cost line says which record it was written for, so the page can leave it out of the count');
  assert.ok(!r.moves.some((x) => x.kind === 'trip' && x.person === 'Ben'), 'a planned trip is not history');
  assert.equal(r.moves.find((x) => x.kind === 'cost' && x.method === 'Insurance').from, 'Salva', 'a from that is no place stays as typed');
  assert.match(r.waits, /switch-over/);
  assert.deepEqual(m.route.forStock('4101', []), [], 'the optimizer keeps nothing about a watch');
});

/* ── Owner Decisions ── */

test('owner decisions: the live incomings by the app’s rules — status, words, stale, review due, execution queue, consolidations, records and briefs', async () => {
  const r = await m.od.page();
  assert.deepEqual(
    r.rows.map((i) => [i.stock_no, i.status]),
    [['4201', 'SENT_TO_OWNER'], ['4202', 'DECISION_NEEDED'], ['4203', 'NOT_ASKED'], ['4205', 'APPROVED'], ['4206', 'IN_EXECUTION'], ['4207', 'HOLD']],
    'an arrived incoming has nothing left to decide; no record = decision needed; picked from Chrono Key = not asked yet'
  );
  const by = Object.fromEntries(r.rows.map((i) => [i.stock_no, i]));
  assert.equal(by['4202'].destination, 'Dubai', 'inventoryDest is the firm answer');
  assert.equal(by['4205'].words, 'Ship · with Ben · → Dubai');
  assert.equal(by['4207'].words, 'review 2020-01-01 · until 2026-12-01');
  assert.equal(by['4207'].review_due, true, 'a deferred review, now due');
  assert.equal(by['4206'].changed, 'destination changed to Dubai after the owner said London', 'a decision the facts moved under');
  assert.equal(by['4201'].changed, '', 'not confirmed: nothing to be stale');
  assert.deepEqual(by['4205'].decision.events.map((e) => e.label), ['Decision needed → Approved', 'Decision opened'], 'newest first, in the app’s words');
  assert.equal(by['4205'].decision.instruction, 'Ship it to Dubai with Ben');
  assert.deepEqual([by['4201'].watch.stock_no, by['4201'].watch.bought_from.name, by['4201'].watch.status], ['4201', 'Salva Perez', 'incoming'], 'our watch and our client, by id');
  assert.equal(by['4201'].supplier_link.client_id, state.ours.salva, 'the typed supplier, as far as the logistics client goes');
  assert.equal(by['4203'].supplier_link, null, 'a name no logistics client carries links nowhere');

  assert.deepEqual(
    r.execution.map((g) => [g.from, g.to, g.collector, g.items.map((id) => r.rows.find((i) => i.id === id).stock_no)]),
    [['Switzerland', 'Dubai', 'Ben', ['4205']], ['Italy', 'London', '', ['4206']]],
    'approved and in execution, by place → the decision’s destination, with the collector'
  );
  assert.deepEqual(
    r.consolidations.map((g) => [g.route, g.suppliers]),
    [['Spain → Dubai', ['Salva', 'Diego']], ['Italy → Dubai', ['Gaetano', 'Francesco']]],
    'same place, same destination, more than one supplier'
  );
  assert.deepEqual(
    r.records.map((d) => [d.stock_no, d.status, d.incoming_live, d.incoming_status]).sort((a, b) => a[0].localeCompare(b[0])),
    [['4201', 'SENT_TO_OWNER', true, 'pending'], ['4204', 'APPROVED', false, 'arrived'], ['4205', 'APPROVED', true, 'pending'], ['4206', 'IN_EXECUTION', true, 'in_transit'], ['4207', 'HOLD', true, 'pending'], ['4208', 'COMPLETED', false, '']],
    'every record is kept, live or not'
  );
  const gone = r.records.find((d) => d.stock_no === '4208');
  assert.deepEqual([gone.incoming_id, gone.words], [null, 'Hand carry'], 'a decision whose incoming is gone still says what it said');
  assert.equal(r.records.find((d) => d.stock_no === '4204').incoming_status, 'arrived');
  assert.deepEqual(r.briefs.map((b) => [b.to, b.count, b.group, b.watches.map((w) => [w.stock_no, w.live])]), [['a number ending 1234', 2, 'supplier', [['4201', true], ['4204', false]]]], 'a brief: who it went to (the number’s end only), which watches, which are still incoming');
  assert.match(r.waits, /WhatsApp/);
});

test('owner decisions on a watch: "Owner: <what was decided>, <status>" while it is still incoming', async () => {
  const facts = await m.pages.factsFor(['4201', '4205', '4204', '4208', '4203']);
  const of = (no) => (facts.get(no) || []).filter((f) => f.page === 'ownerdecisions').map((f) => [f.text, f.tone]);
  assert.deepEqual(of('4201'), [['Owner: Sent to owner', 'warn']]);
  assert.deepEqual(of('4205'), [['Owner: Ship · with Ben · → Dubai, approved', 'move']]);
  assert.deepEqual(of('4204'), [], 'arrived: nothing left to decide, as the app has it');
  assert.deepEqual(of('4208'), [['Owner: Hand carry, completed', 'good']], 'the decision outlives its incoming');
  assert.deepEqual(of('4203'), [], 'only picked from Chrono Key: not a question yet');
});

/* ── the API ── */

test('the three pages answer behind the sign-in', async () => {
  const headers = { 'X-Requested-With': 'masterapp', 'Content-Type': 'application/json' };
  const login = await fetch(`${api}/api/login`, { method: 'POST', headers, body: JSON.stringify({ email: 'boss@example.com', password: 'admin-password-1' }) });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  for (const [key, check] of [
    ['costs', (j) => j.lines.length === 6 && j.by_currency.AED.amount === 300],
    ['routeoptimizer', (j) => j.available.London.length === 1 && j.places.length === 6],
    ['ownerdecisions', (j) => j.rows.length === 6 && j.records.length === 6],
  ]) {
    const res = await fetch(`${api}/api/logistics/page/${key}`, { headers: { cookie } });
    assert.equal(res.status, 200, key);
    assert.ok(check(await res.json()), key);
  }
  assert.equal((await fetch(`${api}/api/logistics/page/costs`)).status, 401, 'not without signing in');
});
