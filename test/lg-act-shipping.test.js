import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';

/*
 * The shipping domain's actions — Live Shipments (ship-*), 3rd Party Movers
 * (tpm-*), Logistic Cost (cost-*) and the Route Optimizer's AI (route-*) —
 * run through the API as an editor against a fixture: what each writes
 * (every record, field, lock, event and activity line, as the logistics
 * app's own function does), what each refuses, a viewer refused. The AI's
 * prompts and parsing are checked as pure functions with an injected answer
 * (no key on this PC: the actions answer 409). Against a real Postgres
 * (TEST_DATABASE_URL), EMPTIED first; no worker.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let rates, base, m, db, dataDir, server, api;

before(async () => {
  rates = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { rates: { USD: '1', EUR: '0.9', GBP: '0.8', AED: '3.6725', HKD: '7.8' } } }));
  });
  await new Promise((r) => rates.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${rates.address().port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lg-act-ship-'));
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
    ANTHROPIC_API_KEY: '',
    RATES_LIVE_URL: `${base}/rates/live`,
    RATES_DAILY_URL: `${base}/rates/live`,
  });
  const reset = new pg.Client({ connectionString: DB });
  await reset.connect();
  await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await reset.end();
  m = {
    db: await import('../src/db/index.js'),
    shipping: await import('../src/logistics/actions/shipping.js'),
    movers: await import('../src/logistics/actions/movers.js'),
    actions: await import('../src/logistics/actions/index.js'),
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

/* ── helpers ── */
const add = async (kind, data, stock, sourceId = null, origin = 'logistics') =>
  (await db('INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ($1, $2, $3, $4, $5) RETURNING id', [kind, sourceId, data, stock, origin])).rows[0].id;
const item = async (id) => (await db('SELECT * FROM logistics_items WHERE id = $1', [id])).rows[0];
const ofKind = async (kind, where = 'TRUE', params = []) => (await db(`SELECT * FROM logistics_items WHERE kind = $1 AND deleted_at IS NULL AND (${where}) ORDER BY id`, [kind, ...params])).rows;
const byAppId = async (kind, appId) => (await ofKind(kind, "data->>'id' = $2", [appId]))[0] || null;
let activityFrom = 0;
/* The activity lines written since the last look, oldest first. */
const activity = async () => {
  const { rows } = await db("SELECT id, data->>'text' AS text FROM logistics_items WHERE kind = 'activity' AND id > $1 ORDER BY id", [activityFrom]);
  if (rows.length) activityFrom = rows[rows.length - 1].id;
  return rows.map((r) => r.text);
};
const events = async (id) => (await db('SELECT action, changes FROM logistics_events WHERE item_id = $1 ORDER BY id', [id])).rows;

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const headers = { 'X-Requested-With': 'masterapp' };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(api + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
  };
  return { call, login: (email, password) => call('POST', '/api/login', { email, password }) };
}
let editor, viewer;
const act = (key, id, body = {}, qs = '') => editor.call('POST', `/api/logistics${id ? `/items/${id}` : ''}/act/${key}${qs}`, body);
const form = (key, id, qs = '') => editor.call('GET', `/api/logistics${id ? `/items/${id}` : ''}/act/${key}${qs}`);

const ids = {};

test('the fixture: our watches and clients, the logistics clients (two company locations), a mover, a stock row, a sale waiting for delivery', async () => {
  const ourClient = async (fore, sur) => (await db('INSERT INTO clients(forename, surname, origin) VALUES ($1, $2, $3) RETURNING id', [fore, sur, 'manual'])).rows[0].id;
  ids.seller = await ourClient('Khawar', 'Saeed');
  ids.robin = await ourClient('Robin', 'Casanova');
  const watch = async (no, status, more = {}) =>
    (await db("INSERT INTO watches(stock_no, brand, model, origin, status, purchased_from_client_id, sold_to_client_id) VALUES ($1, 'Rolex', 'Daytona', 'manual', $2, $3, $4) RETURNING id", [no, status, more.from || null, more.to || null])).rows[0].id;
  ids.w4201 = await watch('4201', 'in_stock', { from: ids.seller });
  ids.w4202 = await watch('4202', 'sold', { from: ids.seller, to: ids.robin });
  ids.cDubai = await add('clients', { id: 'c-dubai', name: 'Company', isCompany: true, country: 'Dubai' }, [], 'c-dubai');
  ids.cHK = await add('clients', { id: 'c-hk', name: 'Company', isCompany: true, country: 'HK' }, [], 'c-hk');
  ids.cRobin = await add('clients', { id: 'c-robin', name: 'Robin Casanova', country: 'Switzerland' }, [], 'c-robin');
  ids.mover = await add('thirdPartyMovers', { id: 'M1', name: 'Ferrari', country: 'UK', contact: '+44', notes: '', ts: 1 }, [], 'M1');
  ids.d4201 = await add('dubaiStock', { id: 'D-4201', stockNumber: '4201', brand: 'Rolex', watchModel: 'Daytona', watchReference: '126500LN', watchSerial: 'Z1', status: 'current', buyPrice: 20000, buyCurrency: 'USD' }, ['4201'], 'D-4201');
  ids.ready = await add('readyForDelivery', { id: 'R-4202', stockNumber: '4202', brand: 'Rolex', watchModel: 'Daytona', watchReference: '126500LN', watchSerial: 'Z2', soldPrice: 30000, soldCurrency: 'USD', soldPriceUsd: 30000, soldDate: '2026-10-20', soldToBuyer: 'Robin Casanova', soldFromLocation: 'Dubai office', originKey: 'dubai', status: 'pending_ship' }, ['4202'], 'R-4202');

  editor = client();
  assert.equal((await editor.login('boss@example.com', 'admin-password-1')).status, 200);
  await editor.call('POST', '/api/users', { email: 'vi@example.com', role: 'viewer', password: 'viewer-password' });
  viewer = client();
  await viewer.login('vi@example.com', 'viewer-password');
  await activity();
});

test('the catalog: every action of the domain, the AI ones marked and not ready without a key; the forms open with the app’s defaults and choices', async () => {
  const meta = (await editor.call('GET', '/api/meta')).body;
  const acts = Object.fromEntries(meta.logistics.actions.map((a) => [a.key, a]));
  for (const k of ['ship-add', 'ship-edit', 'ship-shipped', 'ship-pending', 'ship-cancel', 'ship-deliver', 'ship-delete', 'tpm-mover-add', 'tpm-mover-edit', 'tpm-mover-delete', 'tpm-add', 'tpm-edit', 'tpm-payment', 'tpm-status', 'tpm-not-payable', 'tpm-delete', 'tpm-import', 'tpm-import-movers', 'cost-add', 'cost-edit', 'cost-delete', 'route-prices', 'route-advice']) assert.ok(acts[k], k);
  assert.deepEqual([acts['route-prices'].ai, acts['route-prices'].ai_ready, acts['ship-add'].page, acts['tpm-import'].has_template, acts['ship-delete'].danger], [true, false, 'shipments', true, true]);
  const f = await form('ship-add');
  assert.equal(f.status, 200);
  const from = f.body.form.find((x) => x.key === 'fromClientId');
  assert.deepEqual(
    from.options.map((o) => o.label),
    ['— a typed place (below) —', '🏢 Dubai', '🏢 HK', 'Robin Casanova (Switzerland)'],
    'the app’s datalist: company locations first by country, then the clients by name'
  );
  assert.deepEqual([f.body.values.costCurrency, f.body.values.status, f.body.values.hasWatch, f.body.values.customsRatePct, f.body.values.aedPerUsd], ['AED', 'pending', true, 0.3, 3.67]);
  const mv = f.body.form.find((x) => x.key === 'thirdPartyMoverId');
  assert.deepEqual(mv.options[1], { value: 'M1', label: 'Ferrari (UK)' });
  // From a Ready-for-delivery row: the app's openShipmentFromReady pre-fill.
  const r = await form('ship-add', null, `?ready=${ids.ready}`);
  assert.deepEqual([r.body.values.stockNumber, r.body.values.fromText, r.body.values.toText, r.body.values.items], ['4202', 'Dubai office', 'Robin Casanova', 'Rolex · Daytona · Ref 126500LN · SN Z2']);
});

test('ship-add from Ready-for-delivery: the shipment, the ready row linked and shipped, the cost line with shipmentId, the app’s activity lines', async () => {
  const r = await act('ship-add', null, { stockNumber: '4202', date: '2026-10-21', fromClientId: 'c-dubai', toClientId: 'c-robin', items: 'Rolex Daytona 126500LN', tracking: '', costAmount: '250', costCurrency: 'aed', status: 'pending' }, `?ready=${ids.ready}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.message, /Shipment saved · linked to the sale waiting for delivery$/, 'our watch: nothing flagged');
  ids.ship1 = r.body.created[0];
  const s = await item(ids.ship1);
  assert.equal(s.origin, 'manual');
  assert.deepEqual(s.stock_nos, ['4202']);
  const d = s.data;
  assert.ok(/^[0-9a-z]{8,}$/.test(d.id), 'the app’s own id shape');
  assert.deepEqual(
    [d.fromClientId, d.fromText, d.toClientId, d.toText, d.cost, d.costCurrency, d.costAmount, d.status, d.hasWatch, d.deliveredAt, d.deliveryPhotos, d.missingItems, d.readyForDeliveryId, d.viaThirdParty, d.thirdPartyDocuments, d.shippingDocuments],
    ['c-dubai', '', 'c-robin', '', 'AED 250', 'AED', 250, 'pending', true, null, [], [], 'R-4202', false, [], []]
  );
  assert.equal(typeof d.createdAt, 'number');
  const ready = await item(ids.ready);
  assert.deepEqual([ready.data.shipmentId, ready.data.status], [d.id, 'shipped'], 'the app’s saveShipment links the ready row and marks it shipped');
  assert.deepEqual(ready.locked_fields.sort(), ['shipmentId', 'status'], 'the app’s copy: the changed fields are locked against the sync');
  const lc = await ofKind('logisticCosts');
  assert.equal(lc.length, 1);
  assert.deepEqual(
    [lc[0].data.title, lc[0].data.shipmentId, lc[0].data.stockNumber, lc[0].data.fromClientId, lc[0].data.toClientId, lc[0].data.fromName, lc[0].data.toName, lc[0].data.date, lc[0].data.currency, lc[0].data.amount, lc[0].data.notes],
    ['🏢 Dubai → Robin Casanova shipment Cost', d.id, '4202', 'c-dubai', 'c-robin', '🏢 Dubai', 'Robin Casanova', '2026-10-21', 'AED', 250, '']
  );
  assert.equal(typeof lc[0].data.ts, 'number');
  assert.deepEqual(await activity(), ['New shipment: Company → Robin Casanova · Rolex Daytona 126500LN (linked to Ready-for-Delivery)', '💰 Shipment cost: AED 250 · 🏢 Dubai → Robin Casanova']);
  assert.deepEqual(await ofKind('hkSituation'), [], 'Switzerland is not Hong Kong');
  assert.deepEqual(await ofKind('thirdPartyShipments'), [], 'not through a mover');
  assert.equal((await events(ids.ship1))[0].action, 'create');
});

test('ship-add to Hong Kong through a mover: the HK Situation row and the customs mirror under the mover; a stock number we do not hold is flagged', async () => {
  const r = await act('ship-add', null, {
    stockNumber: '4201, 9999', date: '2026-10-22', fromClientId: 'c-dubai', toClientId: 'c-hk', items: 'Two watches', tracking: '794644790131', deliveryDate: '2026-10-25', situation: 'By FedEx', status: 'in_transit', hkHolder: 'Winnie',
    viaThirdParty: true, thirdPartyMoverId: 'M1', thirdPartyPaymentStatus: 'pending', watchBrand: 'Rolex', watchReference: '126500LN', valueUsd: '20000', customsRatePct: '0.3', aedPerUsd: '3.67', costAmount: '', costCurrency: 'USD',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message, 'Shipment saved · customs entry synced · 9999 is not one of our watches');
  ids.ship2 = r.body.created[0];
  const d = (await item(ids.ship2)).data;
  assert.deepEqual([d.valueUsd, d.customsRatePct, d.aedPerUsd, d.customsUsd, Math.round(d.customsAed * 100) / 100, d.thirdPartyMoverName, d.cost, d.costAmount], [20000, 0.3, 3.67, 60, 220.2, 'Ferrari', '', 0]);
  const hk = await ofKind('hkSituation');
  assert.equal(hk.length, 1);
  assert.deepEqual(
    [hk[0].data.stockNumber, hk[0].data.brand, hk[0].data.description, hk[0].data.section, hk[0].data.holder, hk[0].data.notes, hk[0].data.movements, hk[0].data.linkedShipmentId, hk[0].stock_nos],
    ['4201, 9999', 'Rolex', '4201 · Rolex · Daytona · 126500LN · SN Z1 · TR: 794644790131', 'incoming', 'Winnie', 'From 🏢 Dubai · By FedEx · ETA 2026-10-25', [], d.id, ['4201', '9999']],
    'the app’s routeShipmentToHkSituation: the description enriched from the Dubai row'
  );
  const tpm = await ofKind('thirdPartyShipments');
  assert.equal(tpm.length, 1);
  const t = tpm[0].data;
  assert.deepEqual(
    [t.moverId, t.moverName, t.isOurStock, t.stockNumber, t.fromClientName, t.fromCountry, t.toCountry, t.currency, Math.round(t.amount * 100) / 100, t.paymentStatus, t.status, t.trackingNumber, t.shipmentDate, t.deliveryDate, t.liveShipmentId, t.originLive, t.valueUsd],
    ['M1', 'Ferrari', true, '4201, 9999', '🏢 Dubai', 'Dubai', 'HK', 'AED', 220.2, 'pending', 'in_transit', '794644790131', '2026-10-22', '2026-10-25', d.id, true, 20000],
    'the app’s syncShipmentToThirdPartyForCustoms'
  );
  assert.match(t.notes, /^🚛 Auto-synced from Live Shipment customs sheet\. Value USD 20,000, customs 0\.3% = \$60 \(≈ AED 220\.2\)\.$/);
  assert.deepEqual(await activity(), [
    'New shipment: Company → Company · Two watches',
    '🌐 Auto-filed in HK Situation Incomings: 4201, 9999 · holder: Winnie',
    '🚛 Added customs entry for shipment Two watches via Ferrari',
  ]);
});

test('ship-edit on the app’s copy: the typed fields, the cost line kept in step, the changed fields locked; clearing the cost removes the synced line', async () => {
  // An app copy, with a cost, as the sync would hold it.
  ids.ship3 = await add('shipments', { id: 'SH3', stockNumber: '4201', date: '2026-09-01', fromClientId: 'c-robin', fromText: '', toClientId: 'c-dubai', toText: '', items: 'Daytona back', tracking: '', cost: 'USD 100', costCurrency: 'USD', costAmount: 100, status: 'pending', hasWatch: true, createdAt: 1 }, ['4201'], 'SH3');
  ids.lc3 = await add('logisticCosts', { id: 'LC3', shipmentId: 'SH3', title: 'Robin Casanova → 🏢 Dubai shipment Cost', stockNumber: '4201', fromName: 'Robin Casanova', toName: '🏢 Dubai', date: '2026-09-01', currency: 'USD', amount: 100, notes: '' }, ['4201'], 'LC3');
  const f = await form('ship-edit', ids.ship3);
  assert.deepEqual([f.body.values.costAmount, f.body.values.costCurrency, f.body.values.status], [100, 'USD', 'pending']);
  const r = await act('ship-edit', ids.ship3, { stockNumber: '4201', date: '2026-09-02', fromClientId: 'c-robin', toClientId: 'c-dubai', items: 'Daytona back', tracking: '', costAmount: '1,250', costCurrency: 'USD', status: 'pending', hasWatch: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = await item(ids.ship3);
  assert.deepEqual([s.data.date, s.data.cost, s.data.costAmount], ['2026-09-02', 'USD 1,250', 1250]);
  assert.ok(s.locked_fields.includes('costAmount') && s.locked_fields.includes('date') && !s.locked_fields.includes('items'), `locked: ${s.locked_fields}`);
  const lc = await item(ids.lc3);
  assert.deepEqual([lc.data.amount, lc.data.date, lc.data.fromClientId, lc.data.toClientId, lc.deleted_at], [1250, '2026-09-02', 'c-robin', 'c-dubai', null], 'the app updates the linked line instead of duplicating it');
  assert.ok(lc.locked_fields.includes('amount'));
  assert.deepEqual(await activity(), ['Updated shipment: Daytona back', '💰 Shipment cost: USD 1,250 · Robin Casanova → 🏢 Dubai']);
  // The cost cleared: the synced line (no notes) goes.
  const r2 = await act('ship-edit', ids.ship3, { stockNumber: '4201', date: '2026-09-02', fromClientId: 'c-robin', toClientId: 'c-dubai', items: 'Daytona back', costAmount: '', costCurrency: 'USD', status: 'pending', hasWatch: true });
  assert.equal(r2.status, 200);
  assert.ok((await item(ids.lc3)).deleted_at, 'the auto-synced line removed');
  assert.deepEqual(await activity(), ['Updated shipment: Daytona back']);
  const ev = await events(ids.ship3);
  assert.equal(ev.filter((e) => e.action === 'update').length, 2);
});

test('ship-shipped / ship-pending / ship-cancel: the status, deliveredAt cleared, the customs mirror following, the app’s line', async () => {
  let r = await act('ship-shipped', ids.ship1);
  assert.equal(r.status, 200);
  assert.deepEqual([(await item(ids.ship1)).data.status, (await item(ids.ship1)).data.deliveredAt], ['in_transit', null]);
  assert.deepEqual(await activity(), ['Shipment Rolex Daytona 126500LN → in_transit']);
  r = await act('ship-pending', ids.ship2);
  assert.equal(r.status, 200);
  const mirror = (await ofKind('thirdPartyShipments', "data->>'liveShipmentId' = $2", [(await item(ids.ship2)).data.id]))[0];
  assert.equal(mirror.data.status, 'pending', 'the mirror follows');
  assert.deepEqual(await activity(), ['🚛 Updated customs entry for shipment Two watches via Ferrari', 'Shipment Two watches → pending']);
  r = await act('ship-cancel', ids.ship3);
  assert.equal(r.status, 200);
  assert.equal((await item(ids.ship3)).data.status, 'cancelled');
  assert.deepEqual(await activity(), ['Shipment Daytona back → cancelled']);
});

test('ship-deliver: delivered with the time, the cost line, the missing accessories as a transaction the buyer owes, the sale finalized into Sold Stocks', async () => {
  const f = await form('ship-deliver', ids.ship1);
  assert.deepEqual([f.body.values.costTitle, f.body.values.costCurrency, f.body.values.costAmount, f.body.values.costDate], ['🏢 Dubai → Robin Casanova shipment Cost', 'AED', '250', '2026-10-21'], 'the app’s deliver modal pre-fills the cost from the shipment');
  const before = Date.now();
  const r = await act('ship-deliver', ids.ship1, { nothingMissing: false, missingItems: 'Box (Rolex), Hang tag (Rolex)', presentItems: 'Papers (Rolex)', deliveryNotes: 'Signed by Robin', costTitle: '', costAmount: '300', costCurrency: 'usd', costDate: '', costNotes: 'FedEx invoice' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message, 'Delivered ✓ · sale finalized · cost USD 300 recorded · 2 missing items owed by Robin Casanova');
  const s = (await item(ids.ship1)).data;
  assert.equal(s.status, 'delivered');
  assert.ok(s.deliveredAt >= before && s.deliveredAt <= Date.now(), 'deliveredAt in milliseconds, as the app writes it');
  assert.deepEqual([s.deliveryNotes, s.missingItems, s.presentItems, s.cost], ['Signed by Robin', [{ brand: 'Rolex', accessory: 'Box' }, { brand: 'Rolex', accessory: 'Hang tag' }], [{ brand: 'Rolex', accessory: 'Papers' }], 'USD 300']);
  const lc = await ofKind('logisticCosts', "data->>'shipmentId' = $2", [s.id]);
  assert.equal(lc.length, 2, 'the app pushes a second line on delivery beside the one synced on save');
  const d = lc[1].data;
  assert.deepEqual([d.title, d.stockNumber, d.fromName, d.toName, d.date, d.currency, d.amount, d.notes, d.fromClientId, d.toClientId], ['🏢 Dubai → Robin Casanova shipment Cost', '4202', '🏢 Dubai', 'Robin Casanova', '2026-10-21', 'USD', 300, 'FedEx invoice', 'c-dubai', 'c-robin']);
  const tx = await ofKind('transactions');
  assert.equal(tx.length, 1);
  const t = tx[0].data;
  assert.deepEqual([t.type, t.clientId, t.reference, t.stockNumber, t.shipmentId, t.notes, t.items.length, t.items[0].accessory, t.items[0].direction, t.items[0].status, t.items[0].qty], ['sold', 'c-robin', 'Rolex Daytona 126500LN', `SHIP-${s.id.slice(0, 4)}`, s.id, 'Auto-created from delivered shipment. Missing: Box, Hang tag', 2, 'Box (Rolex)', 'give', 'pending', 1], 'company → client: we owe the buyer');
  const sold = await ofKind('soldStocks');
  assert.equal(sold.length, 1);
  assert.deepEqual([sold[0].data.stockNumber, sold[0].data.deliveredVia, sold[0].data.shipmentId, sold[0].data.soldToBuyer, sold[0].data.deliveryNotes, sold[0].stock_nos], ['4202', 'shipment', s.id, 'Robin Casanova', 'Signed by Robin', ['4202']]);
  assert.ok((await item(ids.ready)).deleted_at, 'the waiting row gone');
  assert.deepEqual(await activity(), [
    '💰 Logistic cost recorded: 4202 · USD 300',
    'Missing items from shipment routed to Robin Casanova: Box, Hang tag',
    '📦➡️💰 Ready-for-delivery 4202 finalized as SOLD (via shipment)',
    'Delivered shipment "Rolex Daytona 126500LN" (2 missing)',
  ]);
  assert.equal((await act('ship-deliver', ids.ship1, {})).status, 400, 'not twice');
});

test('ship-delete: the shipment and its customs mirror go softly, the app’s line', async () => {
  const mirror = (await ofKind('thirdPartyShipments'))[0];
  const r = await act('ship-delete', ids.ship2);
  assert.equal(r.status, 200);
  assert.equal(r.body.open, '#/logistics/shipments');
  assert.ok((await item(ids.ship2)).deleted_at);
  assert.ok((await item(mirror.id)).deleted_at, 'the mirror it made');
  assert.deepEqual(await activity(), ['Deleted shipment "Two watches"']);
  const r3 = await act('ship-delete', ids.ship3);
  assert.equal(r3.status, 200);
  assert.deepEqual(await activity(), ['Deleted shipment "Daytona back" (history)']);
});

test('what ship-add refuses: no From / To, no items, a client id that is nobody, a bad date', async () => {
  assert.deepEqual((await act('ship-add', null, { items: 'x' })).body.error, 'From & To required');
  assert.deepEqual((await act('ship-add', null, { fromText: 'A', toText: 'B' })).body.error, 'Shipping items required');
  assert.deepEqual((await act('ship-add', null, { fromClientId: 'nobody', toText: 'B', items: 'x' })).body.error, 'From: no logistics client with that id');
  assert.match((await act('ship-add', null, { fromText: 'A', toText: 'B', items: 'x', date: '2026-02-30' })).body.error, /not a date/);
  assert.equal((await act('ship-shipped', ids.ship1 + 1000)).status, 404);
  assert.equal((await act('tpm-edit', ids.ship1, {})).status, 400, 'a shipping action on a record of another kind');
});

/* ── 3rd Party Movers ── */

test('tpm-mover-add / edit / delete: the mover, the app’s lines, the shipments that still name it counted', async () => {
  let r = await act('tpm-mover-add', null, { name: ' RK ', country: 'Hong Kong', contact: '+852', notes: 'HK consolidations' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  ids.rk = r.body.created[0];
  const d = (await item(ids.rk)).data;
  assert.deepEqual([d.name, d.country, d.contact, d.notes, typeof d.ts], ['RK', 'Hong Kong', '+852', 'HK consolidations', 'number']);
  assert.deepEqual(await activity(), ['🚛 Mover added: RK']);
  r = await act('tpm-mover-edit', ids.mover, { name: 'Ferrari', country: 'United Kingdom', contact: '+44', notes: 'Main courier' });
  assert.equal(r.status, 200);
  const f = await item(ids.mover);
  assert.deepEqual([f.data.country, f.data.notes, f.locked_fields.sort()], ['United Kingdom', 'Main courier', ['country', 'notes']]);
  assert.deepEqual(await activity(), ['🚛 Mover updated: Ferrari']);
  assert.equal((await act('tpm-mover-add', null, { name: '' })).body.error, 'Mover name required');
});

test('tpm-add: a valued watch’s customs AED becomes the amount, the cost line with thirdPartyShipmentId and its id kept, the mirror in Live Shipments', async () => {
  const f = await form('tpm-add');
  assert.deepEqual([f.body.values.currency, f.body.values.isOurStock, f.body.values.paymentStatus], ['GBP', true, 'pending']);
  assert.deepEqual(f.body.form.find((x) => x.key === 'moverId').options.map((o) => o.value), ['M1', (await item(ids.rk)).data.id]);
  const r = await act('tpm-add', null, { moverId: 'M1', isOurStock: true, stockNumber: '4201', fromClientId: 'c-robin', fromCountry: 'Switzerland', toCountry: 'Dubai', items: 'Rolex Daytona', shipmentDate: '2026-10-23', amount: '150', currency: 'gbp', paymentStatus: 'pending', status: 'pending', trackingNumber: 'FER123', watchBrand: 'Rolex', watchReference: '126500LN', valueUsd: '20,000', customsRatePct: '0.3', aedPerUsd: '3.67', notes: 'first' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message, 'Shipment saved · also in Live Shipments');
  ids.tpm1 = r.body.created[0];
  const t = (await item(ids.tpm1)).data;
  assert.deepEqual(
    [t.moverId, t.moverName, t.isOurStock, t.stockNumber, t.description, t.fromClientId, t.fromClientName, t.fromCountry, t.toCountry, t.currency, Math.round(t.amount * 100) / 100, t.customsUsd, t.paymentStatus, t.status, t.trackingNumber, t.shipmentDate, t.deliveryDate, t.photos, t.shippingDocuments],
    ['M1', 'Ferrari', true, '4201', '', 'c-robin', 'Robin Casanova', 'Switzerland', 'Dubai', 'AED', 220.2, 60, 'pending', 'pending', 'FER123', '2026-10-23', '', [], []],
    'the app’s saveTpmShipment: the customs AED replaces the typed GBP 150'
  );
  const lc = await byAppId('logisticCosts', t.logisticCostId);
  assert.ok(lc, 'the cost line’s id kept on the shipment');
  assert.deepEqual([lc.data.thirdPartyShipmentId, lc.data.title, lc.data.stockNumber, lc.data.fromClientId, lc.data.fromName, lc.data.toName, lc.data.date, lc.data.currency, Math.round(lc.data.amount * 100) / 100, lc.data.notes, lc.stock_nos], [t.id, '3rd Party · Ferrari · Rolex Daytona', '4201', 'c-robin', 'Switzerland', 'Dubai', '2026-10-23', 'AED', 220.2, 'first', ['4201']]);
  const live = await byAppId('shipments', t.liveShipmentId);
  assert.ok(live, 'the live mirror');
  assert.deepEqual(
    [live.data.date, live.data.stockNumber, live.data.fromClientId, live.data.fromText, live.data.toClientId, live.data.toText, live.data.items, live.data.tracking, live.data.cost, live.data.costAmount, live.data.status, live.data.hasWatch, live.data.viaThirdParty, live.data.thirdPartyMoverId, live.data.tpmShipmentId, live.data.originTpm, live.data.deliveredAt, live.data.missingItems],
    ['2026-10-23', '4201', 'c-robin', 'Robin Casanova', null, 'Dubai', 'Rolex Daytona', 'FER123', '', 0, 'pending', true, true, 'M1', t.id, true, null, []],
    'the app’s syncTpmShipmentToLive: the cost stays on the mover’s line only'
  );
  assert.deepEqual(await activity(), ['🚛 New 3rd party shipment: Ferrari · 4201 · Switzerland → Dubai']);
  assert.equal((await act('tpm-add', null, { moverId: 'M1', isOurStock: true, fromClientName: 'X', fromCountry: 'A', toCountry: 'B' })).body.error, "Stock # required (or switch to Friend's stock)");
  assert.equal((await act('tpm-add', null, { moverId: 'M1', isOurStock: false, fromClientName: 'X', fromCountry: 'A', toCountry: 'B' })).body.error, "Description required for friend's stock");
  assert.equal((await act('tpm-add', null, { moverId: 'M1', isOurStock: true, stockNumber: '1', fromCountry: 'A', toCountry: 'B' })).body.error, 'From person / client name required');
  assert.equal((await act('tpm-add', null, { moverId: 'M1', isOurStock: true, stockNumber: '1', fromClientName: 'X', fromCountry: 'A' })).body.error, 'From and To country required');
});

test('tpm-payment, tpm-status (the mirror follows), tpm-not-payable toggled, tpm-edit (the cost line rewritten), tpm-delete (the line and the mirror with it)', async () => {
  let r = await act('tpm-payment', ids.tpm1, { paymentStatus: 'partial' });
  assert.equal(r.status, 200);
  assert.equal((await item(ids.tpm1)).data.paymentStatus, 'partial');
  assert.equal((await act('tpm-payment', ids.tpm1, { paymentStatus: 'unpaid' })).status, 400);
  r = await act('tpm-status', ids.tpm1, { status: 'in_transit' });
  assert.equal(r.status, 200);
  const t = (await item(ids.tpm1)).data;
  assert.equal(t.status, 'in_transit');
  assert.equal((await byAppId('shipments', t.liveShipmentId)).data.status, 'in_transit', 'the live mirror follows');
  r = await act('tpm-not-payable', ids.tpm1);
  assert.equal(r.status, 200);
  assert.equal((await item(ids.tpm1)).data.notPayable, true);
  assert.deepEqual(await activity(), ['🚛 Updated 3rd party shipment: Ferrari · 4201', '🚛 Updated 3rd party shipment: Ferrari · 4201', '🚛 Ferrari 4201: NOT payable by us']);
  await act('tpm-not-payable', ids.tpm1);
  assert.equal((await item(ids.tpm1)).data.notPayable, false);
  assert.deepEqual(await activity(), ['🚛 Ferrari 4201: payable by us']);

  const oldLine = t.logisticCostId;
  r = await act('tpm-edit', ids.tpm1, { moverId: 'M1', isOurStock: true, stockNumber: '4201', fromClientName: 'Robin typed', fromCountry: 'Switzerland', toCountry: 'Dubai', items: 'Rolex Daytona', shipmentDate: '2026-10-23', amount: '175', currency: 'usd', paymentStatus: 'paid', status: 'delivered', deliveryDate: '2026-10-26', valueUsd: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = (await item(ids.tpm1)).data;
  assert.deepEqual([e.fromClientId, e.fromClientName, e.amount, e.currency, e.paymentStatus, e.status, e.deliveryDate, e.valueUsd, e.customsAed], [null, 'Robin typed', 175, 'USD', 'paid', 'delivered', '2026-10-26', 0, 0], 'a typed name is kept as typed, never matched to a client');
  assert.notEqual(e.logisticCostId, oldLine);
  assert.ok((await byAppId('logisticCosts', oldLine)) === null, 'the old line gone');
  assert.deepEqual([(await byAppId('logisticCosts', e.logisticCostId)).data.amount, (await byAppId('logisticCosts', e.logisticCostId)).data.currency], [175, 'USD']);
  assert.equal((await byAppId('shipments', e.liveShipmentId)).data.status, 'delivered');
  assert.deepEqual(await activity(), ['🚛 Updated 3rd party shipment: Ferrari · 4201']);

  r = await act('tpm-delete', ids.tpm1);
  assert.equal(r.status, 200);
  assert.ok((await item(ids.tpm1)).deleted_at);
  assert.equal(await byAppId('logisticCosts', e.logisticCostId), null, 'its cost line');
  assert.equal(await byAppId('shipments', e.liveShipmentId), null, 'its live mirror');
  assert.deepEqual(await activity(), [], 'the app logs nothing for a deleted mover shipment');
});

test('tpm-import: the app’s columns and rules — a mover made when missing, a friend’s stock, the customs amount; the template; tpm-import-movers updates by name', async () => {
  const tpl = await editor.call('GET', '/api/logistics/act/tpm-import/template');
  assert.equal(tpl.status, 200);
  assert.ok(String(tpl.body).startsWith('mover,owner,stockNumber,description,fromClient,fromCountry,toCountry,items,currency,amount,paymentStatus,status,trackingNumber,shipmentDate,deliveryDate,watchBrand,watchReference,valueUsd,customsRatePct,aedPerUsd,notes\nFerrari,ours,1265,'));
  const csv =
    '﻿Mover,Owner,Stock,Description,From Client,From Country,To Country,Items,Currency,Amount,Payment,Status,Tracking,Date,ETA,Brand,Ref,Value,Rate,AED rate,Notes\n' +
    'FORAK,ours,4201,,Adam,UK,Dubai,"Rolex Daytona",,,paid,pending,FK1,2026-06-10,,Rolex,126500LN,10000,,,"customs"\n' +
    'RK,friend,,Patek full set,Winnie,Hong Kong,Dubai,PP,USD,150,unpaid,in_transit,RK9,2026-06-14,,,,,,,\n' +
    ',,,,,,,,,,,,,,,,,,,,\n' +
    ',ours,4203,,Nobody,UK,Dubai,x,,,,,,,,,,,,,\n';
  const r = await act('tpm-import', null, { csv });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.message, '3rd Party Movers import complete · added 2 · skipped 1 (Line 4: missing mover)', 'the app counts lines after dropping blank rows, as its parseCSV does');
  assert.equal(r.body.created.length, 2);
  const forak = (await ofKind('thirdPartyMovers', "data->>'name' = 'FORAK'"))[0];
  assert.ok(forak, 'the mover made');
  assert.equal(forak.data.notes, 'Auto-created from HK movement');
  const a = (await item(r.body.created[0])).data;
  assert.deepEqual([a.moverId, a.moverName, a.isOurStock, a.stockNumber, a.fromClientId, a.fromClientName, a.currency, Math.round(a.amount * 100) / 100, a.paymentStatus, a.status, a.trackingNumber, a.shipmentDate, a.valueUsd, a.customsRatePct, a.aedPerUsd, a.notes], [forak.data.id, 'FORAK', true, '4201', null, 'Adam', 'AED', 110.1, 'paid', 'pending', 'FK1', '2026-06-10', 10000, 0.3, 3.67, 'customs']);
  assert.ok(a.logisticCostId && a.liveShipmentId, 'its cost line and live mirror');
  const b = (await item(r.body.created[1])).data;
  assert.deepEqual([b.moverName, b.isOurStock, b.stockNumber, b.description, b.currency, b.amount, b.paymentStatus, b.logisticCostId], ['RK', false, '', 'Patek full set', 'USD', 150, 'unpaid', null], 'a friend’s stock: no cost line');
  assert.deepEqual(await activity(), ['🚛 Auto-created 3rd party mover "FORAK" from HK movement', '🚛 3rd Party Movers CSV import — added 2, skipped 1']);
  assert.equal((await act('tpm-import', null, { csv: 'name,x\n' })).body.error, 'CSV is empty or only has a header row.');
  assert.match((await act('tpm-import', null, { csv: 'name,x\na,b\n' })).body.error, /missing required "mover" column/);

  const mv = await act('tpm-import-movers', null, { csv: 'name,country,contact,notes\nferrari,UK,"+44 7700","Main UK"\nJonny,Dubai,,\n,,,\n' });
  assert.equal(mv.status, 200, JSON.stringify(mv.body));
  assert.equal(mv.body.message, 'Movers import complete · added 1 · updated 1 · skipped 0');
  assert.deepEqual([(await item(ids.mover)).data.country, (await item(ids.mover)).data.contact, (await item(ids.mover)).data.notes], ['UK', '+44 7700', 'Main UK'], 'Ferrari updated by name, case-insensitively');
  assert.ok((await ofKind('thirdPartyMovers', "data->>'name' = 'Jonny'"))[0]);
  assert.deepEqual(await activity(), ['🚛 Movers ledger CSV import — added 1, updated 1, skipped 0']);
  const r2 = await act('tpm-mover-delete', ids.rk);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.message, 'Mover deleted · 1 shipment still names it');
  assert.ok((await item(ids.rk)).deleted_at);
});

/* ── Logistic Cost ── */

test('cost-add linked to a shipment: the shipment’s ids, and its stock / from / to / date where the form left them blank; cost-edit; cost-delete; the app’s lines', async () => {
  const f = await form('cost-add');
  assert.deepEqual([f.body.values.currency, typeof f.body.values.date], ['USD', 'string']);
  const choices = f.body.form.find((x) => x.key === 'shipmentId').options;
  assert.equal(choices[0].label, '-- standalone cost, no linked shipment --');
  const ship1 = (await item(ids.ship1)).data;
  assert.ok(choices.some((o) => o.value === ship1.id && o.label === '4202 · 🏢 Dubai → Robin Casanova · 2026-10-21'), JSON.stringify(choices));
  let r = await act('cost-add', null, { title: 'Insurance', shipmentId: ship1.id, amount: '45.5', currency: 'eur', notes: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  ids.cost = r.body.created[0];
  const c = await item(ids.cost);
  assert.deepEqual([c.data.title, c.data.shipmentId, c.data.stockNumber, c.data.fromName, c.data.toName, c.data.date, c.data.currency, c.data.amount, c.data.fromClientId, c.data.toClientId, c.stock_nos], ['Insurance', ship1.id, '4202', '🏢 Dubai', 'Robin Casanova', '2026-10-21', 'EUR', 45.5, 'c-dubai', 'c-robin', ['4202']]);
  assert.deepEqual(await activity(), ['💰 Added logistic cost: Insurance · EUR 45.5']);
  r = await act('cost-edit', ids.cost, { title: 'Insurance', shipmentId: '', stockNumber: '4201', fromName: 'A', toName: 'B', date: '2026-10-01', amount: '50', currency: 'EUR', notes: 'changed' });
  assert.equal(r.status, 200);
  const e = await item(ids.cost);
  assert.deepEqual([e.data.shipmentId, e.data.stockNumber, e.data.amount, e.data.notes, e.data.fromClientId, e.stock_nos], [null, '4201', 50, 'changed', 'c-dubai', ['4201']]);
  assert.deepEqual(await activity(), ['Updated logistic cost: Insurance · EUR 50']);
  assert.equal((await act('cost-add', null, { title: '', amount: '1' })).body.error, 'Title is required');
  assert.equal((await act('cost-add', null, { title: 'x', amount: '' })).body.error, 'Amount is required');
  assert.equal((await act('cost-add', null, { title: 'x', amount: '1', shipmentId: 'nope' })).body.error, 'Linked shipment: no live shipment with that id');
  r = await act('cost-delete', ids.cost);
  assert.equal(r.status, 200);
  assert.ok((await item(ids.cost)).deleted_at);
  assert.deepEqual(await activity(), ['Deleted logistic cost']);
});

/* ── the Route Optimizer's AI ── */

test('route-prices / route-advice: the app’s prompts verbatim, the answers parsed as the app shows them; refused without a key', async () => {
  const { marketPricesPrompt, parseMarketPrices, routePrompt, routeHistoryText, parseRecommendation } = m.shipping;
  const watches = [
    { id: 1, stock_no: '4201', brand: 'Rolex', model: 'Daytona', reference: '126500LN', buy_usd: 20000, log_usd: 320.5 },
    { id: 2, stock_no: '4204', brand: 'Patek Philippe', model: '', reference: '', buy_usd: null, log_usd: 0 },
  ];
  const p1 = marketPricesPrompt(watches);
  assert.ok(p1.startsWith('You are a luxury watch market pricing expert. For each watch below, provide the current (2025) secondary market price in USD based on your knowledge of Chrono24, WatchBox, Bob\'s Watches, and dealer prices.\n\nReturn ONLY a JSON array, no explanation, no markdown:\n[\n  { "stockNumber": "...", "marketPriceUsd": 12000, "confidence": "high|medium|low", "note": "brief source note" },\n  ...\n]\n\nWatches:\n4201: Rolex Daytona (Ref: 126500LN)\n4204: Patek Philippe  (Ref: unknown)'), p1);
  const prices = parseMarketPrices('```json\n[{"stockNumber":"4201","marketPriceUsd":31500,"confidence":"high","note":"Chrono24 median"},{"stockNumber":4204,"marketPriceUsd":"x"},{"stockNumber":"9","marketPriceUsd":5}]\n```', watches);
  assert.deepEqual(prices[0], { stockNumber: '4201', label: 'Rolex Daytona', marketPriceUsd: 31500, confidence: 'high', note: 'Chrono24 median', buyUsd: 20000, profit: 11500, item_id: 1 });
  assert.deepEqual([prices[1].marketPriceUsd, prices[1].confidence, prices[1].profit, prices[2].label], [null, 'medium', null, '9']);
  assert.throws(() => parseMarketPrices('sorry, no', watches), /not a price list/);

  const moves = [
    { kind: 'shipment', method: 'FedEx', usd: 400 },
    { kind: 'shipment', method: 'FedEx', usd: 200 },
    { kind: 'mover', method: 'Ferrari', usd: 1000 },
    { kind: 'trip', person: 'Ben', usd: 900 },
    { kind: 'cost', method: 'Insurance', usd: 50 },
  ];
  assert.equal(routeHistoryText(moves, 'Dubai', 'London'), 'Historical moves (Dubai → London) — 5 recorded:\n  • FedEx: 2 times, avg $300 USD\n  • Ferrari: 1 time, avg $1,000 USD\n  • Personal carry (Ben): 1 time, avg $900 USD\n  • Insurance: 1 time, avg $50 USD');
  assert.equal(routeHistoryText([], 'Dubai', 'London'), 'No previous moves recorded in this app for Dubai → London.');
  const p2 = routePrompt({ fromLabel: 'Dubai', toLabel: 'London', watches, histText: routeHistoryText(moves, 'Dubai', 'London'), movers: [{ name: 'Ferrari', country: 'UK' }, { name: 'RK', country: '' }], prices: { 4201: { usd: 31500, confidence: 'high' } }, today: '27 October 2026' });
  assert.ok(p2.startsWith('You are a luxury watch logistics expert advising Purosangue Watches, a high-end watch trading business (Dubai, London, Hong Kong, Switzerland).\n\nDate: 27 October 2026\nRoute: Dubai → London\nWatches: 2 watches | total cost price ~$20,000 USD | total market value ~$31,500 USD | potential profit ~$11,500 USD\n\nWATCHES BEING MOVED:\n  • Stock #4201: Rolex Daytona (Ref 126500LN) — cost price $20,000 USD — market value $31,500 USD (high) — potential profit $11,500 USD — existing logistics cost $321 USD\n  • Stock #4204: Patek Philippe  (Ref n/a) — no cost price recorded\n\nOUR HISTORICAL DATA FOR THIS ROUTE:\nHistorical moves (Dubai → London)'), p2);
  assert.ok(p2.includes('\nOUR 3RD PARTY MOVERS ON FILE: Ferrari (UK), RK (?)\n'));
  for (const line of ['## ✈️ Option A — Personal Carry (Person Trip)', '## 🚚 Option B — Ferrari Logistics', '## 📦 Option C — RK (or FORAK)', '## 📬 Option D — Express Courier (FedEx/DHL)', '## ✅ Recommendation\nGive a clear winner for THIS specific move (2 watches, Dubai → London).', 'Be specific with numbers and practical. Use our historical data when available to anchor estimates.']) assert.ok(p2.includes(line), line);
  assert.ok(routePrompt({ fromLabel: 'A', toLabel: 'B', watches: [watches[1]], histText: 'x', movers: [], today: 't' }).includes('OUR 3RD PARTY MOVERS ON FILE: Ferrari, RK, FORAK (standard)'));
  const rec = parseRecommendation('Intro line\n## ✈️ Option A — Personal Carry\n- Emirates, ~$900\n\n## ✅ Recommendation\n**Option A** wins.\nTip: carry on.');
  assert.deepEqual(rec.sections.map((s) => s.heading), ['', '✈️ Option A — Personal Carry', '✅ Recommendation']);
  assert.equal(rec.recommendation, '**Option A** wins.\nTip: carry on.');

  const r = await act('route-prices', null, { ids: '1' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /No AI key/);
  assert.equal((await act('route-advice', null, { ids: '1', from: 'Dubai', to: 'London' })).status, 409);
});

test('a viewer is refused (403), nobody signed in too (401)', async () => {
  assert.equal((await viewer.call('POST', `/api/logistics/items/${ids.ship1}/act/ship-shipped`, {})).status, 403);
  assert.equal((await viewer.call('GET', '/api/logistics/act/ship-add')).status, 403);
  assert.equal((await viewer.call('POST', '/api/logistics/act/tpm-mover-add', { name: 'x' })).status, 403);
  assert.equal((await client().call('POST', '/api/logistics/act/cost-add', { title: 'x', amount: 1 })).status, 401);
  assert.deepEqual(await ofKind('thirdPartyMovers', "data->>'name' = 'x'"), []);
});
