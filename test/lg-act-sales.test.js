import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';

/*
 * The sales workflows of the logistics app done here (src/logistics/actions/
 * sales.js): Sold Stocks (set delivery date, hold in safe, cancel sale,
 * delete), Ready for delivery (mark delivered, link to shipment), In
 * Consignment (our watch → client, client's watch → us, edit, move back,
 * sold, delete) and Refinement's external polish (add, done, edit, delete) —
 * each run through the API as an editor against a fixture, checked record
 * for record against what the app's own functions write: the fields, the
 * locks, the events, the activity line. What is refused, and a viewer
 * refused. Against a real Postgres (TEST_DATABASE_URL), EMPTIED first; no
 * worker — the records are inserted as the sync would leave them.
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lg-act-sales-'));
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
  m = { db: await import('../src/db/index.js'), auth: await import('../src/auth/index.js'), sales: await import('../src/logistics/actions/sales.js') };
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await m.auth.ensureFirstAdmin(() => {});
  await m.auth.createUser({ email: 'ed@example.com', role: 'editor', password: 'editor-password-1', name: 'Ed' });
  await m.auth.createUser({ email: 'view@example.com', role: 'viewer', password: 'viewer-password-1', name: 'Vi' });
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

/* The app's copy of a record (origin app, a source id) — or ours. */
const add = async (kind, data, stock, sourceId = null) =>
  (await db(`INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ($1, $2, $3, $4, ${sourceId ? "'logistics'" : "'manual'"}) RETURNING id`, [kind, sourceId, data, stock])).rows[0].id;
const item = async (id) => (await db('SELECT * FROM logistics_items WHERE id = $1', [id])).rows[0];
const ofKind = async (kind, where = '') => (await db(`SELECT * FROM logistics_items WHERE kind = $1 AND deleted_at IS NULL ${where} ORDER BY id`, [kind])).rows;
const activity = async () => (await db("SELECT data->>'text' AS t FROM logistics_items WHERE kind = 'activity' ORDER BY id")).rows.map((r) => r.t);
const lastActivity = async () => (await activity()).at(-1);
const events = async (id) => (await db('SELECT action, changes, user_id FROM logistics_events WHERE item_id = $1 ORDER BY id', [id])).rows;

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
let ed, viewer, edId;
const act = (key, id, input) => ed.call('POST', `/api/logistics${id ? `/items/${id}` : ''}/act/${key}`, input || {});
const form = (key, id) => ed.call('GET', `/api/logistics${id ? `/items/${id}` : ''}/act/${key}`);

const ids = {};

test('the fixture: our watches and clients, the logistics clients, and the app’s records as copied', async () => {
  const person = async (fore, sur) => (await db('INSERT INTO clients(forename, surname, origin) VALUES ($1, $2, $3) RETURNING id', [fore, sur, 'manual'])).rows[0].id;
  ids.robin = await person('Robin', 'Casanova');
  ids.seller = await person('Khawar', 'Saeed');
  const watch = async (no, status, from = null) => (await db("INSERT INTO watches(stock_no, brand, model, origin, status, purchased_from_client_id) VALUES ($1, 'Rolex', 'Daytona', 'manual', $2, $3) RETURNING id", [no, status, from])).rows[0].id;
  ids.w5101 = await watch('5101', 'in_stock', ids.seller);
  ids.w5102 = await watch('5102', 'in_stock');
  ids.w5103 = await watch('5103', 'sold');
  ids.w5104 = await watch('5104', 'sold');
  ids.w5106 = await watch('5106', 'in_stock');
  ids.lgRobin = await add('clients', { id: 'c-robin', name: 'Robin Casanova', country: 'Switzerland' }, [], 'c-robin');

  // Stock as the app keeps it: a Dubai row in stock, a London row in stock, a Dubai row on consignment, an HK stock row.
  ids.d5101 = await add('dubaiStock', { id: 'D-5101', stockNumber: '5101', brand: 'Rolex', watchModel: 'Daytona', watchReference: '126500LN', status: 'current', accessoriesPresent: 'Box, Papers', photos: [] }, ['5101'], 'D-5101');
  ids.l5102 = await add('londonStock', { id: 'L-5102', stockNumber: '5102', brand: 'Omega', watchModel: 'Speedmaster', status: 'current', inMayfair: true }, ['5102'], 'L-5102');
  ids.d5106 = await add('dubaiStock', { id: 'D-5106', stockNumber: '5106', brand: 'Tudor', watchModel: 'BB58', status: 'consignment', notes: 'old note', consignment: { direction: 'to_client', with: 'Someone', date: '2026-10-01', accessories: 'Watch', returnDate: '', notes: '', photosBefore: ['lgfile:1'] } }, ['5106'], 'D-5106');
  ids.h5107 = await add('hkStock', { id: 'H-5107', stockNumber: '5107', brand: 'Patek Philippe', description: 'Nautilus 5711', reference: '5711/1A', status: 'current' }, ['5107'], 'H-5107');

  // A sale delivered (no date), a sale sold from HK, one waiting for delivery, one waiting with a linked shipment.
  ids.s5103 = await add('soldStocks', { id: 'S-5103', stockNumber: '5103', brand: 'Rolex', watchModel: 'Daytona', watchReference: '126500LN', originKey: 'london', originLocation: '🇬🇧 London', originRow: { id: 'L-5103', stockNumber: '5103', brand: 'Rolex', watchModel: 'Daytona', status: 'consignment', consignment: { with: 'X' }, accessoriesPresent: 'Box', accessoriesMissing: 'Papers', photos: [] }, soldPrice: 90000, soldCurrency: 'GBP', soldPriceUsd: 114300, soldDate: '2026-10-10', soldToBuyer: 'Robin Casanova', soldFromLocation: 'Mayfair', soldNotes: '', photos: [], deliveredVia: 'in_person', deliveredAt: null, shipmentId: 'SH1', ts: 1 }, ['5103'], 'S-5103');
  ids.s5104 = await add('soldStocks', { id: 'S-5104', stockNumber: '5104', brand: 'Patek Philippe', watchModel: 'Aquanaut', originKey: 'hk', originLocation: '🌐 HK', originRow: { id: 'H-5104', stockNumber: '5104', brand: 'Patek Philippe', description: 'Aquanaut 5167A', reference: '5167A' }, soldPrice: 50000, soldCurrency: 'USD', soldPriceUsd: 50000, soldDate: '2026-10-11', soldToBuyer: '', deliveredAt: Date.UTC(2026, 9, 12, 9, 30), ts: 2 }, ['5104'], 'S-5104');
  ids.r5105 = await add('readyForDelivery', { id: 'R-5105', stockNumber: '5105', brand: 'Rolex', watchModel: 'GMT', watchReference: '126710', originKey: 'dubai', originLocation: '🇦🇪 Dubai', originRow: { id: 'D-5105', stockNumber: '5105', brand: 'Rolex', watchModel: 'GMT', status: 'consignment', consignment: { with: 'Y' } }, soldPrice: 10000, soldCurrency: 'USD', soldPriceUsd: 10000, soldDate: '2026-10-20', soldToBuyer: 'Parsa', soldFromLocation: 'Dubai office', soldNotes: 'n', photos: ['lgfile:2'], shipmentId: null, status: 'pending_ship', ts: 3 }, ['5105'], 'R-5105');
  ids.r5108 = await add('readyForDelivery', { id: 'R-5108', stockNumber: '5108', brand: 'Rolex', watchModel: 'Sub', originKey: 'london', originLocation: '🇬🇧 London', originRow: { id: 'L-5108', stockNumber: '5108' }, soldPrice: 8000, soldCurrency: 'AED', soldPriceUsd: 2160, soldDate: '2026-10-21', soldToBuyer: 'Robin Casanova', photos: [], shipmentId: 'SH1', status: 'shipped', ts: 4 }, ['5108'], 'R-5108');
  ids.ship = await add('shipments', { id: 'SH1', stockNumber: '5108', date: '2026-10-21', items: 'Sub', fromText: 'London', toText: 'Geneva', status: 'in_transit', readyForDeliveryId: 'R-5108' }, ['5108'], 'SH1');
  ids.ship2 = await add('shipments', { id: 'SH2', stockNumber: '5105', date: '2026-10-22', items: 'GMT for Parsa', fromText: 'Dubai', toText: 'Riyadh', status: 'pending' }, ['5105'], 'SH2');
  ids.shipDone = await add('shipments', { id: 'SH3', stockNumber: '5105', date: '2026-10-01', items: 'old', status: 'delivered' }, ['5105'], 'SH3');
  ids.e1 = await add('externalPolish', { id: 'E1', description: 'Josh’s Daytona', sentTo: 'Sina Star', sentDate: '2026-10-22', expectedBack: '', cost: 0, costCurrency: 'USD', notes: '', photos: [], status: 'at_polish', returnDate: '', returnNotes: '', returnPhotos: [] }, [], 'E1');

  ed = client();
  assert.equal((await ed.login('ed@example.com', 'editor-password-1')).status, 200);
  edId = (await db("SELECT id FROM users WHERE email = 'ed@example.com'")).rows[0].id;
  viewer = client();
  assert.equal((await viewer.login('view@example.com', 'viewer-password-1')).status, 200);
});

test('the catalog carries every sales action, with its page and kinds; a viewer gets none of them', async () => {
  const meta = (await ed.call('GET', '/api/meta')).body;
  const acts = Object.fromEntries((meta.logistics?.actions || []).map((a) => [a.key, a]));
  assert.deepEqual(acts['cons-out'] && [acts['cons-out'].kinds, acts['cons-out'].page], [null, 'consignment']);
  assert.deepEqual(acts['ref-add'] && [acts['ref-add'].kinds, acts['ref-add'].page], [null, 'refinement']);
  assert.deepEqual(acts['sale-cancel'] && [acts['sale-cancel'].kinds, acts['sale-cancel'].danger], [['soldStocks', 'readyForDelivery'], true]);
  assert.equal(acts['sale-handover'].has_form, true);
  // The extra typed fields (FIELDS) are exported for the catalog; /api/meta merging them is wanted in server.js (see the report).
  assert.ok(m.sales.FIELDS.soldStocks.some((f) => f.key === 'deliveryNotes' && f.type === 'longtext'));
  assert.ok(m.sales.FIELDS.readyForDelivery.some((f) => f.key === 'soldToClientId' && f.type === 'client'));
  assert.equal((await viewer.call('GET', '/api/logistics/act/cons-out')).status, 403);
  assert.equal((await viewer.call('POST', `/api/logistics/items/${ids.s5103}/act/sale-delete`, {})).status, 403);
  assert.equal((await ed.call('GET', `/api/logistics/items/${ids.e1}/act/sale-deliver`)).status, 400, 'an action on the wrong kind is refused');
});

/* ── Sold Stocks ── */

test('set delivery date: the app’s saveDateEdit — only the day moves, the time of day kept; the field locked; its activity line', async () => {
  const f = await form('sale-deliver', ids.s5104);
  assert.equal(f.status, 200);
  assert.equal(f.body.values.deliveredAt, '2026-10-12', 'opens on the day held');
  assert.equal((await act('sale-deliver', ids.s5104, { deliveredAt: '2026-13-40' })).status, 400, 'not a date');
  const r = await act('sale-deliver', ids.s5104, { deliveredAt: '2026-10-15', deliveredVia: 'shipment' });
  assert.equal(r.status, 200, r.body.error);
  const it = await item(ids.s5104);
  assert.equal(it.data.deliveredAt, Date.UTC(2026, 9, 15, 9, 30), 'the day moved, 09:30 kept');
  assert.equal(it.data.deliveredVia, 'shipment');
  assert.deepEqual(it.locked_fields.sort(), ['deliveredAt', 'deliveredVia'], 'locked against the sync');
  assert.equal(await lastActivity(), '📅 Delivery date for stock #5104 set to 15 Oct 2026');
  const ev = await events(ids.s5104);
  assert.deepEqual([ev.at(-1).action, ev.at(-1).user_id, ev.at(-1).changes.deliveredVia], ['update', edId, [null, 'shipment']]);

  // A sale with no date yet gets noon in Dubai on that day.
  assert.equal((await act('sale-deliver', ids.s5103, { deliveredAt: '2026-10-14', deliveredVia: 'in_person' })).status, 200);
  assert.equal((await item(ids.s5103)).data.deliveredAt, Date.UTC(2026, 9, 14, 8));
});

test('hold in safe: the app’s _safeRowForSale — a Safe row for the buyer with its movement, the sale left as it is; refused twice, refused with no buyer', async () => {
  assert.equal((await act('sale-safe', ids.s5104)).status, 400, 'no buyer name: nobody to hold it for');
  const r = await act('sale-safe', ids.s5103);
  assert.equal(r.status, 200, r.body.error);
  assert.match(r.body.message, /Held in the safe for Robin Casanova/);
  const [safe] = await ofKind('safeStock');
  const d = safe.data;
  assert.deepEqual(
    [d.stockNumber, d.from, d.brand, d.watchReference, d.accessoriesPresent, d.accessoriesMissing, d.status, d.heldForBuyer, d.soldId, d.inSafe, d.withClient, d.notes],
    ['5103', 'Robin Casanova', 'Rolex', '126500LN', 'Box', 'Papers', 'current', true, 'S-5103', '', '', '']
  );
  assert.equal(d.movements.length, 1);
  assert.deepEqual([d.movements[0].destination, d.movements[0].moveType, d.movements[0].notes], ['🔒 In Safe', 'sold_held_in_safe', 'Sold to Robin Casanova — held in our safe at their request.']);
  assert.ok(d.id && d.receivedAt && d.createdAt);
  assert.equal(safe.origin, 'manual');
  assert.deepEqual(safe.stock_nos, ['5103']);
  assert.equal(await lastActivity(), '🔒 #5103 Rolex 126500LN — sold to Robin Casanova, held in our safe');
  assert.equal((await item(ids.s5103)).deleted_at, null, 'the sale stays');
  assert.equal((await act('sale-safe', ids.s5103)).status, 400, 'already in the safe');
});

test('cancel a sale sold from HK: restored into HK stock (the list it came from — the app puts it in HK Situation), a fresh id; the sale deleted; the shipment unlinked', async () => {
  const before = (await ofKind('hkStock')).length;
  const r = await act('sale-cancel', ids.s5104);
  assert.equal(r.status, 200, r.body.error);
  const hk = await ofKind('hkStock');
  assert.equal(hk.length, before + 1);
  const back = hk.at(-1);
  assert.deepEqual([back.data.stockNumber, back.data.description, back.origin, back.stock_nos], ['5104', 'Aquanaut 5167A', 'manual', ['5104']]);
  assert.notEqual(back.data.id, 'H-5104', 'a fresh id, as cancelSoldStock mints one');
  assert.equal((await ofKind('hkSituation')).length, 0, 'not into HK Situation');
  assert.ok((await item(ids.s5104)).deleted_at, 'the sold record is gone (softly)');
  assert.equal(await lastActivity(), '↩️ Cancelled sale 5104 (USD 50000) — restored to 🌐 HK');
  assert.equal(r.body.open, `#/lg/${back.id}`);
});

test('cancel a sale sold from London: back as current stock, the snapshot as the app took it; the linked shipment keeps its history but loses the link', async () => {
  // The safe row made above names this sale: the sale itself can still be cancelled (the app does not check).
  const r = await act('sale-cancel', ids.s5103);
  assert.equal(r.status, 200, r.body.error);
  const [back] = await ofKind('londonStock', "AND data->>'stockNumber' = '5103'");
  assert.equal(back.data.status, 'current', 'cancelSoldStock sets the status current and leaves the rest of the snapshot as it was');
  assert.deepEqual(back.data.consignment, { with: 'X' }, 'the app clears the consignment when the snapshot is TAKEN (confirmSold), not here — this fixture’s snapshot was written raw');
  const ship = await item(ids.ship);
  assert.equal(ship.data.readyForDeliveryId, undefined, 'unlinked');
  assert.ok(ship.locked_fields.includes('readyForDeliveryId'), 'the unlink is locked against the sync');
  assert.equal(await lastActivity(), '↩️ Cancelled sale 5103 (GBP 90000) — restored to 🇬🇧 London');
});

test('delete a sold record: softly, nothing restored, no activity line (as the app)', async () => {
  const id = await add('soldStocks', { id: 'S-X', stockNumber: '5199', soldPrice: 1, soldCurrency: 'USD' }, ['5199'], 'S-X');
  const n = (await activity()).length;
  const r = await act('sale-delete', id);
  assert.equal(r.status, 200);
  assert.ok((await item(id)).deleted_at);
  assert.equal((await activity()).length, n);
  assert.deepEqual((await events(id)).map((e) => e.action), ['delete']);
});

/* ── Ready for delivery ── */

test('link to shipment: the form offers live shipments, the one naming the watch first; the sale is shipped, the shipment carries the link', async () => {
  const f = await form('sale-ship', ids.r5105);
  assert.equal(f.status, 200);
  const opts = f.body.form[0].options;
  assert.deepEqual(opts.map((o) => o.value), [String(ids.ship2), String(ids.ship)], 'SH2 names 5105 and comes first; the delivered SH3 is not offered');
  assert.match(opts[0].label, /^★ 2026-10-22 · Dubai → Riyadh/);
  assert.equal((await act('sale-ship', ids.r5105, { shipment: ids.shipDone })).status, 400, 'a delivered shipment is not offered, nor taken');
  const r = await act('sale-ship', ids.r5105, { shipment: ids.ship2 });
  assert.equal(r.status, 200, r.body.error);
  const ready = await item(ids.r5105);
  assert.deepEqual([ready.data.shipmentId, ready.data.status], ['SH2', 'shipped']);
  assert.deepEqual(ready.locked_fields.sort(), ['shipmentId', 'status']);
  assert.equal((await item(ids.ship2)).data.readyForDeliveryId, 'R-5105');
});

test('mark delivered: the app’s finalizeReadyAsSold — a Sold Stocks row with every field of the sale, delivered now by shipment (one is linked), the Ready row gone; its activity line; the WhatsApp text to copy', async () => {
  const f = await form('sale-handover', ids.r5105);
  assert.match(f.body.form[0].hint, /delivered by shipment/);
  const t0 = Date.now();
  const r = await act('sale-handover', ids.r5105, { deliveryNotes: 'left with the concierge' });
  assert.equal(r.status, 200, r.body.error);
  const sold = await item(r.body.created[0]);
  const d = sold.data;
  assert.equal(sold.kind, 'soldStocks');
  assert.deepEqual(
    [d.stockNumber, d.brand, d.watchModel, d.watchReference, d.originKey, d.originLocation, d.originRow.id, d.soldPrice, d.soldCurrency, d.soldPriceUsd, d.soldDate, d.soldToBuyer, d.soldFromLocation, d.soldNotes, d.photos, d.deliveredVia, d.shipmentId, d.deliveryNotes, d.deliveryPhotos],
    ['5105', 'Rolex', 'GMT', '126710', 'dubai', '🇦🇪 Dubai', 'D-5105', 10000, 'USD', 10000, '2026-10-20', 'Parsa', 'Dubai office', 'n', ['lgfile:2'], 'shipment', 'SH2', 'left with the concierge', []]
  );
  assert.ok(d.deliveredAt >= t0 && d.ts >= t0 && d.id && d.id !== 'R-5105');
  assert.deepEqual([sold.origin, sold.stock_nos], ['manual', ['5105']]);
  assert.ok((await item(ids.r5105)).deleted_at, 'the Ready row is gone');
  assert.equal(await lastActivity(), '📦➡️💰 5105 delivered to Parsa');
  assert.match(r.body.message, /not one of our watches/, '5105 is no watch of ours — said, not refused');
  assert.match(r.body.message, /✅ Watch Delivered\n📦 Rolex · GMT \(Stock 5105\)\n👤 To: Parsa\n📅 \d{4}-\d{2}-\d{2}\n💰 USD 10,000\n📝 left with the concierge/);
  assert.equal(r.body.open, '#/logistics/soldstocks');
  assert.deepEqual((await events(sold.id)).map((e) => e.action), ['create']);
});

test('hold in safe from Ready for delivery: finalized as sold, held in the safe (the app’s words), then the Safe row', async () => {
  const r = await act('sale-safe', ids.r5108);
  assert.equal(r.status, 200, r.body.error);
  const [sold] = await ofKind('soldStocks', "AND data->>'stockNumber' = '5108'");
  assert.deepEqual([sold.data.deliveredVia, sold.data.deliveryNotes, sold.data.shipmentId], ['held_in_safe', 'Client asked us to keep it in our safe.', 'SH1']);
  assert.ok((await item(ids.r5108)).deleted_at);
  const [safe] = await ofKind('safeStock', "AND data->>'stockNumber' = '5108'");
  assert.deepEqual([safe.data.from, safe.data.soldId], ['Robin Casanova', sold.data.id]);
  assert.equal(r.body.open, '#/logistics/safe');
});

test('cancel a Ready for delivery sale: the snapshot keeps its id and comes back as current stock', async () => {
  const id = await add('readyForDelivery', { id: 'R-5109', stockNumber: '5109', originKey: 'dubai', originLocation: '🇦🇪 Dubai', originRow: { id: 'D-5109', stockNumber: '5109', status: 'consignment', consignment: { with: 'Q' } }, soldPrice: 5, soldCurrency: 'USD', status: 'pending_ship' }, ['5109'], 'R-5109');
  const r = await act('sale-cancel', id);
  assert.equal(r.status, 200, r.body.error);
  const [back] = await ofKind('dubaiStock', "AND data->>'stockNumber' = '5109'");
  assert.deepEqual([back.data.id, back.data.status, back.data.consignment], ['D-5109', 'current', undefined]);
  assert.equal(await lastActivity(), '↩️ Cancelled ready-for-delivery 5109 — restored to 🇦🇪 Dubai');
  // No snapshot at all: the row is removed, nothing restored.
  const bare = await add('readyForDelivery', { id: 'R-5110', stockNumber: '5110', soldPrice: 5, soldCurrency: 'USD', status: 'pending_ship' }, ['5110'], 'R-5110');
  const r2 = await act('sale-cancel', bare);
  assert.equal(r2.status, 200);
  assert.match(r2.body.message, /nothing was restored/);
  assert.ok((await item(bare)).deleted_at);
});

/* ── In Consignment ── */

test('our watch → client (page-level): the picker lists London and Dubai rows in stock; the row gets status consignment and the app’s consignment object, our client by id with the typed name; the activity line', async () => {
  const f = await form('cons-out');
  assert.equal(f.status, 200);
  const pick = f.body.form[0];
  assert.equal(pick.type, 'choice');
  assert.deepEqual(pick.options.map((o) => o.label), ['#5101 · Rolex Daytona · Dubai', '#5102 · Omega Speedmaster · London', '#5103 · Rolex Daytona · London', '#5109 · Dubai'].slice(0, 4), 'in stock, by number; the consigned 5106 is not offered');
  assert.ok(f.body.form.some((x) => x.key === 'clientId' && x.type === 'client'));
  assert.equal((await act('cons-out', null, { row: ids.d5101 })).status, 400, 'nobody named');
  assert.equal((await act('cons-out', null, { row: ids.d5101, clientId: 'c-nobody' })).status, 400, 'a client not on the list');
  const r = await act('cons-out', null, { row: ids.d5101, clientId: 'c-robin', with: 'Robin C.', date: '2026-10-26', accessories: 'Watch, Box', returnDate: '2026-11-10', notes: 'for a week' });
  assert.equal(r.status, 200, r.body.error);
  const it = await item(ids.d5101);
  assert.equal(it.data.status, 'consignment');
  assert.deepEqual(it.data.consignment, { direction: 'to_client', with: 'Robin C.', clientId: 'c-robin', date: '2026-10-26', accessories: 'Watch, Box', returnDate: '2026-11-10', notes: 'for a week', photosBefore: [] });
  assert.deepEqual(it.locked_fields.sort(), ['consignment', 'status']);
  assert.equal(await lastActivity(), '🤝 gave to client: Stock #5101 (Daytona) with Robin C.');
  assert.match(r.body.message, /On consignment with Robin C\./);
  assert.match(r.body.message, /🤝 Consignment — Rolex Daytona \(Stock 5101\)\n👤 Robin C\.\n📅 2026-10-26\n↩️ Return by 2026-11-10\n🎁 Watch, Box/, 'the WhatsApp notice to copy');
  assert.equal(r.body.open, '#/logistics/consignment');
  assert.equal((await act('cons-out', null, { row: ids.d5101, with: 'Again' })).status, 400, 'no longer in stock');
});

test("client's watch → us: the direction from_client, the name as typed when no client is picked; the app's own line", async () => {
  const r = await act('cons-in', null, { row: ids.l5102, with: 'Zed Nobody', date: '2026-10-25' });
  assert.equal(r.status, 200, r.body.error);
  const it = await item(ids.l5102);
  assert.deepEqual([it.data.consignment.direction, it.data.consignment.with, it.data.consignment.clientId, it.data.consignment.accessories], ['from_client', 'Zed Nobody', undefined, '']);
  assert.equal(await lastActivity(), '📥 client gave us: Stock #5102 (Speedmaster) with Zed Nobody');
});

test('on a record: put on consignment is refused for a row already on it; edit consignment opens on what is held and keeps the before-photos', async () => {
  assert.equal((await act('cons-consign', ids.d5106, { with: 'X' })).status, 400);
  assert.equal((await act('cons-edit', ids.h5107, { with: 'X' })).status, 400, 'not a London / Dubai row');
  const f = await form('cons-edit', ids.d5106);
  assert.deepEqual([f.body.values.with, f.body.values.date, f.body.values.accessories, f.body.values.direction], ['Someone', '2026-10-01', 'Watch', 'to_client']);
  const r = await act('cons-edit', ids.d5106, { direction: 'to_client', with: 'Someone Else', date: '2026-10-01', accessories: 'Watch', returnDate: '2026-12-01', notes: 'extended' });
  assert.equal(r.status, 200, r.body.error);
  const c = (await item(ids.d5106)).data.consignment;
  assert.deepEqual([c.with, c.returnDate, c.notes, c.photosBefore], ['Someone Else', '2026-12-01', 'extended', ['lgfile:1']]);
  assert.equal(await lastActivity(), '🤝 gave to client: Stock #5106 (BB58) with Someone Else');
});

test('move back to the same place: status current, the consignment kept as consignmentRecord with photosAfter, the note appended; to HK: a new HK Situation row, the stock row gone', async () => {
  const r = await act('cons-back', ids.d5106, { dest: 'dubai', notes: 'came back fine' });
  assert.equal(r.status, 200, r.body.error);
  const it = await item(ids.d5106);
  assert.equal(it.data.status, 'current');
  assert.equal(it.data.consignment, undefined);
  assert.deepEqual(it.data.consignmentRecord, { direction: 'to_client', with: 'Someone Else', date: '2026-10-01', accessories: 'Watch', returnDate: '2026-12-01', notes: 'extended', photosBefore: ['lgfile:1'], photosAfter: [] });
  assert.equal(it.data.notes, 'old note | came back fine');
  assert.equal(await lastActivity(), '↩️ Stock #5106 recalled from consignment → back to 🇦🇪 Dubai Stock (came back fine)');
  assert.equal((await act('cons-back', ids.d5106, { dest: 'dubai' })).status, 400, 'not on consignment any more');

  // 5101 (on consignment with Robin) recalled to HK.
  const r2 = await act('cons-back', ids.d5101, { dest: 'hk', notes: '' });
  assert.equal(r2.status, 200, r2.body.error);
  assert.ok((await item(ids.d5101)).deleted_at);
  const [hk] = await ofKind('hkSituation');
  assert.deepEqual([hk.data.stockNumber, hk.data.brand, hk.data.section, hk.data.holder, hk.data.stockStatus, hk.data.description, hk.data.notes, hk.data.movements, hk.data.photos, hk.data.consignmentRecord.with], ['5101', 'Rolex', 'in_hand', '', 'IN HAND', 'Daytona | Ref 126500LN | Recalled from consignment', '', [], [], 'Robin C.']);
  assert.equal(await lastActivity(), '↩️ Stock #5101 recalled from consignment → HK Situation');
  assert.equal(r2.body.open, `#/lg/${hk.id}`);

  // To the other place: a moved copy with a fresh id.
  const r3 = await act('cons-back', ids.l5102, { dest: 'dubai', notes: 'flew it over' });
  assert.equal(r3.status, 200, r3.body.error);
  const [moved] = await ofKind('dubaiStock', "AND data->>'stockNumber' = '5102'");
  assert.deepEqual([moved.data.status, moved.data.consignment, moved.data.consignmentRecord.with, moved.data.notes, moved.data.inMayfair], ['current', undefined, 'Zed Nobody', 'flew it over', true]);
  assert.notEqual(moved.data.id, 'L-5102');
  assert.equal(await lastActivity(), '↩️ Stock #5102 recalled from consignment → 🇦🇪 Dubai Stock (flew it over)');
});

test('mark sold: the app’s confirmSold — a Ready for delivery row with the snapshot (a consignment reset to current), dollars at the converter’s rates, the buyer our client by id with the typed name; the source row gone; the activity line', async () => {
  await act('cons-consign', ids.d5106, { direction: 'to_client', with: 'Someone', date: '2026-10-27' });
  const f = await form('cons-sold', ids.d5106);
  assert.match(f.body.form[0].hint, /^our watch #5106$/);
  assert.equal((await act('cons-sold', ids.d5106, { soldPrice: '0' })).status, 400, 'a price is required');
  const r = await act('cons-sold', ids.d5106, { soldPrice: '12,500', soldCurrency: 'GBP', soldDate: '2026-10-27', soldToClientId: 'c-robin', soldToBuyer: '', soldFromLocation: 'Dubai office', soldNotes: 'wire' });
  assert.equal(r.status, 200, r.body.error);
  const ready = await item(r.body.created[0]);
  const d = ready.data;
  assert.equal(ready.kind, 'readyForDelivery');
  assert.deepEqual(
    [d.stockNumber, d.brand, d.watchModel, d.originLocation, d.originKey, d.originRow.id, d.originRow.status, d.originRow.consignment, d.soldPrice, d.soldCurrency, d.soldPriceUsd, d.soldDate, d.soldToBuyer, d.soldToClientId, d.soldFromLocation, d.soldNotes, d.photos, d.shipmentId, d.status],
    ['5106', 'Tudor', 'BB58', '🇦🇪 Dubai', 'dubai', 'D-5106', 'current', undefined, 12500, 'GBP', 15625, '2026-10-27', 'Robin Casanova', 'c-robin', 'Dubai office', 'wire', [], null, 'pending_ship'],
    'the buyer’s name from our client; 12,500 GBP at 0.8 per dollar'
  );
  assert.ok(d.ts && d.id);
  assert.deepEqual(ready.stock_nos, ['5106']);
  assert.ok((await item(ids.d5106)).deleted_at, 'out of Dubai stock');
  assert.equal(await lastActivity(), '💵 SOLD 5106 · GBP 12,500 ≈ $15,625 · from 🇦🇪 Dubai to Robin Casanova → 📦 Ready for Delivery');
  assert.match(r.body.message, /💵 Sold — Tudor · BB58 \(Stock 5106\)\n👤 Robin Casanova\n💰 GBP 12,500\n📅 2026-10-27\n📍 From Dubai office/);
  assert.equal(r.body.open, '#/logistics/shipments');

  // From HK stock: the words come from description / reference; a currency with no rate leaves the dollar figure at 0 and says so.
  const r2 = await act('cons-sold', ids.h5107, { soldPrice: 100, soldCurrency: 'JPY', soldToBuyer: 'walk-in' });
  assert.equal(r2.status, 200, r2.body.error);
  const h = (await item(r2.body.created[0])).data;
  assert.deepEqual([h.watchModel, h.watchReference, h.originKey, h.originLocation, h.soldPriceUsd, h.soldToBuyer, h.soldToClientId], ['Nautilus 5711', '5711/1A', 'hk', '🌐 HK', 0, 'walk-in', undefined]);
  assert.match(r2.body.message, /no rate for JPY/);
});

test('delete a row on consignment: softly; a row in stock is not deleted here', async () => {
  const r = await act('cons-delete', ids.d5106);
  assert.equal(r.status, 404, 'already sold — gone');
  const row = await add('dubaiStock', { id: 'D-5111', stockNumber: '5111', status: 'current' }, ['5111'], 'D-5111');
  assert.equal((await act('cons-delete', row)).status, 400);
  await act('cons-consign', row, { with: 'P' });
  assert.equal((await act('cons-delete', row)).status, 200);
  assert.ok((await item(row)).deleted_at);
});

/* ── Refinement: external polish ── */

test('external polish: add (the app writes no cost line), mark done, edit, delete — each with the app’s activity line', async () => {
  assert.equal((await act('ref-add', null, { description: '', sentTo: 'Sina' })).status, 400);
  assert.equal((await act('ref-add', null, { description: 'x', sentTo: '' })).status, 400);
  const costsBefore = (await ofKind('logisticCosts')).length;
  const r = await act('ref-add', null, { description: '5101', sentTo: 'Sina Star', sentDate: '2026-10-27', expectedBack: '2026-10-30', cost: '350', costCurrency: 'aed', notes: 'bezel' });
  assert.equal(r.status, 200, r.body.error);
  const ep = await item(r.body.created[0]);
  assert.equal(ep.kind, 'externalPolish');
  assert.deepEqual(ep.data, { id: ep.data.id, createdAt: ep.data.createdAt, description: '5101', sentTo: 'Sina Star', sentDate: '2026-10-27', expectedBack: '2026-10-30', cost: 350, costCurrency: 'AED', notes: 'bezel', photos: [], status: 'at_polish', returnDate: '', returnNotes: '', returnPhotos: [] });
  assert.equal((await ofKind('logisticCosts')).length, costsBefore, 'no cost line — the app writes none for an external polish');
  assert.equal(await lastActivity(), '✨ External watch sent to polish: 5101 → Sina Star');
  assert.doesNotMatch(r.body.message, /not one of our watches/, 'a bare number is our watch 5101');

  const e = await act('ref-edit', ids.e1, { description: 'Josh’s Daytona', sentTo: 'RK', sentDate: '2026-10-22', cost: 20, costCurrency: 'USD' });
  assert.equal(e.status, 200, e.body.error);
  const edited = await item(ids.e1);
  assert.deepEqual([edited.data.sentTo, edited.data.cost, edited.data.status], ['RK', 20, 'at_polish']);
  assert.deepEqual(edited.locked_fields.sort(), ['cost', 'sentTo']);
  assert.equal(await lastActivity(), '✏️ External polish edited: Josh’s Daytona');

  const done = await act('ref-done', ids.e1, { returnDate: '2026-10-28', returnNotes: 'like new' });
  assert.equal(done.status, 200, done.body.error);
  const back = await item(ids.e1);
  assert.deepEqual([back.data.status, back.data.returnDate, back.data.returnNotes, back.data.returnPhotos], ['done', '2026-10-28', 'like new', []]);
  assert.equal(await lastActivity(), '✅ External polish done: Josh’s Daytona');
  assert.equal((await act('ref-done', ids.e1, {})).status, 400, 'done twice');

  const del = await act('ref-delete', ep.id);
  assert.equal(del.status, 200);
  assert.ok((await item(ep.id)).deleted_at);
  assert.equal(del.body.open, '#/logistics/refinement');
});

test('usdOf: the converter’s rates, never the app’s table', async () => {
  assert.equal(await m.sales.usdOf(3672.5, 'AED'), 1000);
  assert.equal(await m.sales.usdOf(10, 'USD'), 10);
  assert.equal(await m.sales.usdOf(10, 'XXX'), null);
});
