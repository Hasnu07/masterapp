import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';

/*
 * The logistics app's Incomings and Owner Decisions buttons, done in
 * masterapp (src/logistics/actions/incoming.js and decisions.js), run
 * through the API as an editor against a fixture of the app's records as
 * the sync leaves them: what each writes (every record, field, lock, event
 * and activity line, as the app's own function writes them), what each
 * refuses, and that a viewer is refused. Against a real Postgres
 * (TEST_DATABASE_URL), EMPTIED first; no worker, no internet (a stand-in
 * rate source).
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lg-act-inc-'));
  Object.assign(process.env, {
    DATABASE_URL: DB,
    DATA_DIR: dataDir,
    VAULT_URL: `${base}/api/state`,
    VAULT_TOKEN: 'vault-key',
    CHRONOKEY_USERNAME: '',
    CHRONOKEY_PASSWORD: '',
    ADMIN_EMAIL: 'boss@example.com',
    ADMIN_PASSWORD: 'admin-password-1',
    ADMIN_NAME: 'Hasnain',
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
    auth: await import('../src/auth/index.js'),
    incoming: await import('../src/logistics/actions/incoming.js'),
    decisions: await import('../src/logistics/actions/decisions.js'),
    odPage: await import('../src/logistics/pages/ownerdecisions.js'),
  };
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await m.auth.ensureFirstAdmin(() => {});
  await m.auth.createUser({ email: 'ed@example.com', name: 'Eddie Editor', role: 'editor', password: 'editor-password-1' });
  await m.auth.createUser({ email: 'view@example.com', name: 'Vera Viewer', role: 'viewer', password: 'viewer-password-1' });
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

const add = async (kind, data, stock, sourceId = null) =>
  (await db("INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ($1, $2, $3, $4, 'logistics') RETURNING id", [kind, sourceId, data, stock])).rows[0].id;
const item = async (id) => (await db('SELECT * FROM logistics_items WHERE id = $1', [id])).rows[0];
const ofKind = async (kind, deleted = false) => (await db(`SELECT * FROM logistics_items WHERE kind = $1 AND deleted_at IS ${deleted ? 'NOT NULL' : 'NULL'} ORDER BY id`, [kind])).rows;
const lastOf = async (kind) => (await ofKind(kind)).at(-1);
const activity = async () => (await ofKind('activity')).map((r) => r.data.text);
const events = async (id) => (await db('SELECT * FROM logistics_events WHERE item_id = $1 ORDER BY id', [id])).rows;

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
const ed = client();
const ids = {};
const act = (key, body, q = '') => ed.call('POST', `/api/logistics/act/${key}${q}`, body);
const actOn = (id, key, body, q = '') => ed.call('POST', `/api/logistics/items/${id}/act/${key}${q}`, body);
const formOf = (key, id = null, q = '') => ed.call('GET', `/api/logistics${id ? `/items/${id}` : ''}/act/${key}${q}`);
const ok = (r) => {
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
};

/* ── the fixture ── */

test('the fixture: our watches and clients; the app’s clients, incomings, a decision, stock and a sale as copied', async () => {
  const ours = async (fore, sur) => (await db('INSERT INTO clients(forename, surname, origin) VALUES ($1, $2, $3) RETURNING id', [fore, sur, 'manual'])).rows[0].id;
  ids.khawar = await ours('Khawar', 'Saeed');
  ids.robin = await ours('Robin', 'Casanova');
  const watch = async (no, status, more = {}) =>
    (
      await db("INSERT INTO watches(stock_no, brand, model, reference, serial, origin, status, location, purchase_price, purchase_currency, purchased_from_client_id) VALUES ($1, 'Rolex', 'Daytona', '126500LN', $5, 'manual', $2, $3, $4, $6, $7) RETURNING id", [
        no,
        status,
        more.location || '',
        more.price ?? null,
        more.serial || '',
        more.currency || '',
        more.from || null,
      ])
    ).rows[0].id;
  ids.w4301 = await watch('4301', 'incoming', { location: 'Dubai', price: 50000, currency: 'USD', from: ids.khawar, serial: 'SN4301' });
  ids.w4302 = await watch('4302', 'in_stock');
  ids.w4303 = await watch('4303', 'incoming', { from: ids.robin });
  ids.w4307 = await watch('4307', 'incoming');
  ids.w4305 = await watch('4305', 'in_stock');

  ids.coDubai = await add('clients', { id: 'c-co-dubai', name: 'Company', country: 'Dubai', isCompany: true }, [], 'c-co-dubai');
  ids.coUk = await add('clients', { id: 'c-co-uk', name: 'Company', country: 'United Kingdom', isCompany: true }, [], 'c-co-uk');
  ids.lgRobin = await add('clients', { id: 'c-robin', name: 'Robin Casanova', country: 'Switzerland' }, [], 'c-robin');

  ids.i4303 = await add('incomings', { id: 'I-4303', stockNumber: '4303', brand: 'Rolex', reference: '126500LN', serial: 'SN4303', supplier: 'Robin Casanova', location: 'Switzerland', destination: 'Dubai', status: 'pending', buyPrice: 25000, buyCurrency: 'EUR', notes: 'box only', photos: [], shipmentId: null }, ['4303'], 'I-4303');
  ids.i4304 = await add('incomings', { id: 'I-4304', stockNumber: '4304', brand: 'Omega', reference: '310.30', supplier: 'Nobody Typed', location: 'Italy', status: 'in_transit', fromFob: true, photos: [] }, ['4304'], 'I-4304');
  ids.i4306 = await add('incomings', { id: 'I-4306', stockNumber: '4306', brand: 'Patek Philippe', reference: '5711', supplier: 'Robin Casanova', location: 'Switzerland', status: 'pending', ownerDecisionId: 'OD1', buyPrice: 90000, buyCurrency: 'USD' }, ['4306'], 'I-4306');
  ids.od1 = await add('ownerDecisions', { id: 'OD1', incomingId: 'I-4306', stockNumber: '4306', status: 'APPROVED', action: 'SHIP', destination: 'Dubai', collector: 'Ben', confirmedAt: 1760000000000, events: [{ type: 'created', by: 'manager', ts: 1760000000000 }] }, ['4306'], 'OD1');
  ids.l4302 = await add('londonStock', { id: 'L-4302', stockNumber: '4302', brand: 'Rolex', watchModel: 'Daytona', status: 'current', receivedAt: 1760000000000 }, ['4302'], 'L-4302');
  await add('soldStocks', { id: 'S-4399', stockNumber: '4399', brand: 'Tudor', soldPrice: 1, soldCurrency: 'USD' }, ['4399'], 'S-4399');

  assert.equal((await ed.login('ed@example.com', 'editor-password-1')).status, 200);
});

/* ── Incomings ── */

test('inc-add: the app’s saveIncoming — refused without a stock # or reference, refused on a stock # already somewhere, else the record, the supplier made a client, the activity line', async () => {
  const f = ok(await formOf('inc-add'));
  assert.deepEqual(
    f.form.map((x) => x.key).slice(0, 6),
    ['stockNumber', 'reference', 'brand', 'location', 'supplierClientId', 'supplier']
  );
  assert.deepEqual(f.values, { status: 'pending', buyCurrency: 'USD', costCurrency: 'AED', showInVault: true });
  const none = await act('inc-add', { supplier: 'X' });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /Stock # or Reference required/);
  const dup = await act('inc-add', { stockNumber: '4302', reference: 'x' });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /already exists in 🇬🇧 London Stock · Rolex · Daytona/);
  const dup2 = await act('inc-add', { stockNumber: '4399', reference: 'x' });
  assert.match(dup2.body.error, /✅ Sold Stocks/);

  const r = ok(await act('inc-add', { stockNumber: '4310', reference: '5711/1A', brand: 'Patek Philippe', supplier: 'New Supplier', location: 'Spain', status: 'pending', eta: '2026-11-20', buyPrice: '1,000', buyCurrency: 'usd', costAmount: '250', costCurrency: 'aed', notes: 'full set', showInVault: true }));
  assert.match(r.message, /Incoming 4310 added · not one of our watches/);
  ids.i4310 = r.created[0];
  const it = await item(ids.i4310);
  assert.equal(it.origin, 'manual');
  assert.deepEqual(it.stock_nos, ['4310']);
  const d = it.data;
  assert.ok(/^[a-z0-9]{8,}$/i.test(d.id), 'the app’s own kind of id');
  assert.ok(Number(d.createdAt) > 0);
  assert.deepEqual(
    [d.stockNumber, d.reference, d.brand, d.supplier, d.location, d.status, d.eta, d.buyPrice, d.buyCurrency, d.costAmount, d.costCurrency, d.cost, d.notes, d.hideFromVault, d.photos, d.shipmentId],
    ['4310', '5711/1A', 'Patek Philippe', 'New Supplier', 'Spain', 'pending', '2026-11-20', 1000, 'USD', 250, 'AED', 'AED 250', 'full set', false, [], null]
  );
  const sup = (await ofKind('clients')).find((c) => c.data.name === 'New Supplier');
  assert.deepEqual([sup.origin, sup.data.country, sup.data.notes], ['manual', 'Spain', 'Auto-added from incoming/shipment'], 'suppliers ARE clients: made as the app makes one');
  const lines = await activity();
  assert.ok(lines.includes('Auto-created client New Supplier (Spain)'));
  assert.ok(lines.includes('Added incoming 4310 from New Supplier'));
  assert.equal((await events(ids.i4310))[0].action, 'create');

  // A chosen client is the supplier, by id; its name goes on the record as the app keeps it.
  const r2 = ok(await act('inc-add', { stockNumber: '4330', reference: '5726', brand: 'Patek Philippe', supplierClientId: 'c-robin', location: 'Switzerland', destination: 'Dubai', status: 'pending', buyPrice: 30000, buyCurrency: 'EUR', notes: 'papers coming' }));
  ids.i4330 = r2.created[0];
  assert.equal((await item(ids.i4330)).data.supplier, 'Robin Casanova');
  assert.equal((await ofKind('clients')).filter((c) => c.data.name === 'Robin Casanova').length, 1, 'no second Robin');
});

test('inc-edit: the same form on the app’s copy — what changed is locked, what the form only filled in blank is not', async () => {
  const f = ok(await formOf('inc-edit', ids.i4303));
  assert.deepEqual([f.values.stockNumber, f.values.supplier, f.values.supplierClientId, f.values.showInVault, f.values.buyPrice], ['4303', 'Robin Casanova', 'c-robin', true, 25000]);
  ok(await actOn(ids.i4303, 'inc-edit', { ...f.values, notes: 'box only · papers to follow', eta: '2026-11-05' }));
  const it = await item(ids.i4303);
  assert.deepEqual(it.locked_fields.sort(), ['eta', 'notes']);
  assert.deepEqual([it.data.notes, it.data.eta, it.data.buyPrice, it.data.supplier], ['box only · papers to follow', '2026-11-05', 25000, 'Robin Casanova']);
  assert.ok((await activity()).includes('Updated incoming 4303'));
  const dup = await actOn(ids.i4303, 'inc-edit', { ...f.values, stockNumber: '4304' });
  assert.match(dup.body.error, /📥 Incomings · Omega · 310.30/);
});

test('inc-import: the app’s CSV template and import — added, a stock # already there updated, a row missing a column skipped and said', async () => {
  const t = await ed.call('GET', '/api/logistics/act/inc-import/template');
  assert.equal(t.status, 200);
  assert.ok(String(t.body).startsWith('stockNumber,reference,client,location,brand,eta,status,serial,cost,notes\n1240,5711/1A-014,Robin Casanova,Switzerland,Patek Philippe,2026-06-10,in_transit'));
  assert.deepEqual(m.incoming.parseCSV('a,"b, c",d\n1,"say ""hi""",\n\n'), [
    ['a', 'b, c', 'd'],
    ['1', 'say "hi"', ''],
  ]);
  const csv = ['﻿Stock #,Ref,Client,Country,Brand,ETA,Status,Serial,Cost,Notes', '4320,15510OR,Igor,Switzerland,Audemars Piguet,2026-12-01,In Transit,WJ1,"USD 40,000","gold, 40th"', '4303,126500LN,Robin Casanova,Switzerland,Rolex,,arrived,SN4303-X,,', '4321,,Hayat,United Kingdom,Rolex,,,,,"no reference"', ',,,,,,,,,'].join('\n');
  const bad = await act('inc-import', { csv: 'stockNumber,reference\n1,2' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /missing required column\(s\): Client/);
  const r = ok(await act('inc-import', { csv }));
  assert.match(r.message, /added 1, updated 1, skipped 1\. Skipped: Line 4: missing reference/);
  ids.i4320 = r.created[0];
  const d = (await item(ids.i4320)).data;
  assert.deepEqual([d.stockNumber, d.reference, d.brand, d.location, d.supplier, d.eta, d.status, d.serial, d.cost, d.notes, d.photos, d.shipmentId], ['4320', '15510OR', 'Audemars Piguet', 'Switzerland', 'Igor', '2026-12-01', 'in_transit', 'WJ1', 'USD 40,000', 'gold, 40th', [], null]);
  const up = await item(ids.i4303);
  assert.deepEqual([up.data.status, up.data.serial, up.data.eta, up.data.notes], ['arrived', 'SN4303-X', '2026-11-05', 'box only · papers to follow'], 'the app’s merge: status always, serial when given, eta and notes kept when blank');
  assert.ok(up.locked_fields.includes('status') && up.locked_fields.includes('serial'));
  assert.ok((await ofKind('clients')).some((c) => c.data.name === 'Igor' && c.data.country === 'Switzerland'));
  assert.ok((await activity()).includes('CSV import — added 1, updated 1, skipped 1'));
  // Back to pending for the tests below (the app's edit does the same).
  ok(await actOn(ids.i4303, 'inc-edit', { ...ok(await formOf('inc-edit', ids.i4303)).values, status: 'pending' }));
});

test('inc-arrive: the app’s confirmArrive — arrived, the arrival record, the supplier (made a client when only typed) owes what is missing in a bought transaction', async () => {
  const f = ok(await formOf('inc-arrive', ids.i4304));
  assert.deepEqual([f.values.present, f.values.missing, f.values.supplierClientId], ['Watch', 'Warranty Card, Manual, Box, Outer Box, Pusher Tool, Polishing Cloth', ''], 'Omega’s list: Watch ticked, the rest missing until ticked');
  const r = ok(await actOn(ids.i4304, 'inc-arrive', { location: 'Italy', arriveDate: '2026-10-26', brand: 'Omega', present: 'Watch, Box', missing: 'Warranty Card, Manual', notes: 'scratch on bezel' }));
  assert.match(r.message, /Arrived · 2 missing items owed by the supplier \(transaction written\)/);
  const it = await item(ids.i4304);
  const d = it.data;
  assert.equal(d.status, 'arrived');
  assert.equal(new Date(d.arrivedAt).toISOString().slice(0, 10), '2026-10-26');
  assert.equal(d.notes, 'On arrival: scratch on bezel');
  assert.deepEqual(d.arrivalRecord, { arrivedAt: d.arrivedAt, location: 'Italy', brand: 'Omega', arrived: ['Watch', 'Box'], missing: ['Warranty Card', 'Manual'], notes: 'scratch on bezel', photoCount: 0 });
  const tx = await lastOf('transactions');
  assert.equal(d.arrivalTransactionId, tx.data.id);
  const sup = (await ofKind('clients')).find((c) => c.data.name === 'Nobody Typed');
  assert.deepEqual([sup.data.country, tx.data.clientId], ['Italy', `ma-${sup.id}`], 'the typed supplier became a client, the app’s way; the transaction names it by id');
  assert.deepEqual([tx.data.type, tx.data.date, tx.data.reference, tx.data.stockNumber, tx.data.brand, tx.data.incomingId, tx.data.notes], ['bought', '2026-10-26', '310.30', '4304', 'Omega', 'I-4304', 'Auto-created on arrival of incoming 4304. Supplier owes us these accessories.']);
  assert.deepEqual(
    tx.data.items.map((x) => [x.accessory, x.qty, x.direction, x.status, x.settledBy, x.settlementId]),
    [
      ['Warranty Card', 1, 'receive', 'pending', null, null],
      ['Manual', 1, 'receive', 'pending', null, null],
    ]
  );
  assert.deepEqual(tx.stock_nos, ['4304']);
  assert.ok(it.locked_fields.includes('status') && it.locked_fields.includes('arrivalRecord'));
  assert.ok((await activity()).includes('📥 Arrived 4304 — 2 present, 2 missing (auto-tx created)'));
});

test('inc-receive: the app’s confirmReceiveToInventory — the Dubai stock row, the incoming to history with the link, the supplier-owes transaction, refused a second time', async () => {
  const f = ok(await formOf('inc-receive', ids.i4303));
  assert.deepEqual([f.values.dest, f.values.costCurrency, f.values.costAmount, f.values.model, f.values.present, f.values.owed, f.values.supplierClientId], ['london', 'EUR', '25000', '126500LN', 'Watch', true, 'c-robin'], 'Switzerland guesses London; the price is the buy price');
  const r = ok(
    await actOn(ids.i4303, 'inc-receive', {
      ...f.values,
      dest: 'dubai',
      receiveDate: '2026-10-27',
      present: 'Watch, Box',
      missing: 'Links',
      owed: true,
      inOffice: 'yes',
      needPolish: true,
      caseMaterial: 'Steel',
      notes: 'received in Dubai',
    })
  );
  assert.match(r.message, /^Stock #4303 → 🇦🇪 Dubai Stock · 1 owed by supplier\./);
  const row = await item(r.created[0]);
  assert.equal(row.kind, 'dubaiStock');
  const s = row.data;
  assert.deepEqual(
    [s.stockNumber, s.from, s.brand, s.watchReference, s.watchModel, s.watchSerial, s.caseMaterial, s.accessoriesPresent, s.accessoriesMissing, s.photos, s.receivingPhotos, s.notes, s.status, s.receivedFromIncomingId, s.cost, s.costCurrency, s.costAmount, s.buyPrice, s.buyCurrency, s.inOffice, s.inSafe, s.needPolish],
    ['4303', 'Robin Casanova', 'Rolex', '126500LN', '126500LN', 'SN4303-X', 'Steel', 'Watch, Box', 'Links', [], [], 'received in Dubai', 'current', 'I-4303', 'EUR 25000', 'EUR', '25000', 25000, 'EUR', 'yes', '', true]
  );
  assert.equal(new Date(s.receivedAt).toISOString().slice(0, 10), '2026-10-27');
  const inc = (await item(ids.i4303)).data;
  assert.deepEqual([inc.inventoryDest, inc.inventoryId, inc.status, Boolean(inc.inventoryMovedAt), Boolean(inc.arrivedAt)], ['dubai', s.id, 'arrived', true, true]);
  const tx = await lastOf('transactions');
  assert.deepEqual([tx.data.clientId, tx.data.incomingId, tx.data.notes, tx.data.items.map((x) => x.accessory)], ['c-robin', 'I-4303', 'Auto-created on receive of stock 4303 → 🇦🇪 Dubai Stock. Supplier owes us these accessories.', ['Links']]);
  assert.equal(inc.arrivalTransactionId, tx.data.id);
  assert.ok((await activity()).includes('📥➡️🏠 Received Stock 4303 from incoming → 🇦🇪 Dubai Stock · 1 missing (supplier owes)'));
  const again = await actOn(ids.i4303, 'inc-receive', { ...f.values, dest: 'dubai' });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /already been received/);
});

test('inc-ship: the app’s convertIncomingToShipment — one live shipment from the supplier to our company location, the incoming shipped', async () => {
  const f = ok(await formOf('inc-ship', ids.i4310));
  const sup = (await ofKind('clients')).find((c) => c.data.name === 'New Supplier');
  assert.deepEqual(f.values, { fromClientId: `ma-${sup.id}`, toClientId: 'c-co-dubai' }, 'no Spain company: the first company location');
  const r = ok(await actOn(ids.i4310, 'inc-ship', f.values));
  const ship = await item(r.created[0]);
  assert.equal(ship.kind, 'shipments');
  const d = ship.data;
  assert.deepEqual(
    [d.stockNumber, d.fromClientId, d.toClientId, d.items, d.tracking, d.cost, d.deliveryDate, d.situation, d.notes, d.status, d.deliveredAt, d.deliveryNotes, d.deliveryPhotos, d.missingItems],
    ['4310', `ma-${sup.id}`, 'c-co-dubai', '5711/1A (Patek Philippe)', '', 'AED 250', '2026-11-20', 'full set', 'full set', 'pending', null, '', [], []]
  );
  const inc = (await item(ids.i4310)).data;
  assert.equal(d.incomingId, inc.id);
  assert.equal(inc.shipmentId, d.id);
  assert.ok(Number(inc.shippedAt) > 0);
  assert.ok((await activity()).includes('📦 Shipped incoming 4310 (note: full set) → live shipment'));
  assert.match((await actOn(ids.i4310, 'inc-ship', {})).body.error, /already on a shipment/);
});

test('inc-collect: the app’s Delivery Planner — the waiting incomings to tick (an execution group ticked from Owner Decisions), one shipment carrying the ticked ones', async () => {
  const f = ok(await formOf('inc-collect'));
  const keys = f.form.map((x) => x.key);
  assert.ok(keys.includes(`pick_${ids.i4320}`) && keys.includes(`pick_${ids.i4306}`) && keys.includes(`pick_${ids.i4330}`));
  assert.ok(!keys.includes(`pick_${ids.i4303}`) && !keys.includes(`pick_${ids.i4310}`), 'received and shipped ones are not waiting');
  assert.match(f.form.find((x) => x.key === `pick_${ids.i4320}`).label, /^Switzerland · Igor · #4320 15510OR$/);
  const g = ok(await formOf('inc-collect', null, '?from=Switzerland&to=Dubai&collector=Ben'));
  assert.deepEqual(g.values, { [`pick_${ids.i4306}`]: true }, 'the approved group from the execution queue, ticked');
  assert.match((await act('inc-collect', {})).body.error, /Tick at least one/);
  const r = ok(await act('inc-collect', { [`pick_${ids.i4320}`]: true, [`pick_${ids.i4330}`]: true }));
  assert.match(r.message, /Collection of 2 created — one live shipment from Switzerland to Dubai/);
  const d = (await item(r.created[0])).data;
  assert.deepEqual([d.stockNumber, d.fromClientId, d.toClientId, d.fromText, d.toText, d.items, d.situation, d.status], ['4330, 4320', '', 'c-co-dubai', 'Switzerland', 'Dubai', '5726, 15510OR', 'Collection of 2 from Switzerland', 'pending'], 'two suppliers: no from client; the company of the place');
  for (const id of [ids.i4320, ids.i4330]) assert.equal((await item(id)).data.shipmentId, d.id);
  assert.ok((await activity()).includes('🚚 Collection of 2 incomings from Switzerland → Dubai'));
});

test('inc-sold: the app’s confirmSold on an incoming — Ready for delivery with the buyer by id, dollars at the converter’s rate, the incoming off the list', async () => {
  const no = await actOn(ids.i4304, 'inc-sold', { soldPrice: '0' });
  assert.match(no.body.error, /Sold price required/);
  const r = ok(await actOn(ids.i4304, 'inc-sold', { soldPrice: '10,800', soldCurrency: 'eur', soldDate: '2026-10-27', buyerClientId: 'c-robin', soldFromLocation: 'Milan', soldNotes: 'cash' }));
  assert.match(r.message, /^Sold · EUR 10,800 → Ready for delivery · not one of our watches\./);
  const ready = await item(r.created[0]);
  assert.equal(ready.kind, 'readyForDelivery');
  const d = ready.data;
  assert.deepEqual(
    [d.stockNumber, d.brand, d.watchModel, d.watchReference, d.originLocation, d.originKey, d.soldPrice, d.soldCurrency, d.soldPriceUsd, d.soldDate, d.soldToBuyer, d.soldToClientId, d.soldFromLocation, d.soldNotes, d.photos, d.shipmentId, d.status],
    ['4304', 'Omega', '310.30', '310.30', '📥 Incomings', 'incomings', 10800, 'EUR', 12000, '2026-10-27', 'Robin Casanova', 'c-robin', 'Milan', 'cash', [], null, 'pending_ship']
  );
  assert.equal(d.originRow.id, 'I-4304', 'the row as it was, kept for Cancel sale');
  assert.ok(Number(d.ts) > 0);
  assert.ok((await item(ids.i4304)).deleted_at, 'the app takes it off the list');
  assert.ok((await activity()).includes('💵 SOLD 4304 · EUR 10,800 ≈ $12,000 · from 📥 Incomings to Robin Casanova → 📦 Ready for Delivery'));
});

test('inc-cost, inc-date, inc-vault, inc-cancel, inc-delete: the cost line naming the watch; the receiving date moved on the incoming and its stock row; the vault switch; cancelled; deleted', async () => {
  const c = ok(await actOn(ids.i4310, 'inc-cost', { title: 'Courier', amount: '100', currency: 'aed', date: '2026-10-27' }));
  const line = (await item(c.created[0])).data;
  assert.deepEqual([line.title, line.stockNumber, line.amount, line.currency, line.date, line.shipmentId], ['Courier', '4310', 100, 'AED', '2026-10-27', null]);
  assert.ok((await activity()).includes('💰 Added logistic cost: Courier · AED 100'));

  const f = ok(await formOf('inc-date', ids.i4303));
  assert.equal(f.values.day, '2026-10-27', 'the stock row’s receivedAt, as the report shows it');
  ok(await actOn(ids.i4303, 'inc-date', { day: '2026-10-01' }));
  const inc = (await item(ids.i4303)).data;
  const row = (await ofKind('dubaiStock')).find((r) => r.data.stockNumber === '4303').data;
  assert.equal(new Date(inc.arrivedAt).toISOString().slice(0, 10), '2026-10-01');
  assert.equal(row.receivedAt, inc.arrivedAt, 'both move, or they drift apart');
  assert.ok((await activity()).includes('📅 Receiving date for stock #4303 set to 01 Oct 2026'));

  ok(await actOn(ids.i4310, 'inc-vault', {}));
  assert.equal((await item(ids.i4310)).data.hideFromVault, true);
  assert.ok((await activity()).includes('🚫 4310 hidden from Watch Vault'));
  ok(await actOn(ids.i4310, 'inc-vault', {}));
  assert.ok((await activity()).includes('🌐 4310 shown in Watch Vault again'));

  ok(await actOn(ids.i4310, 'inc-cancel', {}));
  assert.equal((await item(ids.i4310)).data.status, 'cancelled');
  assert.ok((await activity()).includes('Incoming 4310 → cancelled'));
  assert.match((await actOn(ids.i4310, 'inc-cancel', {})).body.error, /already cancelled/);

  const del = ok(await actOn(ids.i4310, 'inc-delete', {}));
  assert.equal(del.open, '#/logistics/incoming');
  assert.ok((await item(ids.i4310)).deleted_at);
  assert.ok((await activity()).includes('Deleted incoming'));
  assert.equal((await actOn(ids.i4310, 'inc-edit', {})).status, 404, 'a deleted record takes no action');
});

test('inc-fob-pick / inc-fob-send / inc-fob-drop: our incoming watches the app does not hold, picked as the app picks from FOB, sent to Incomings as it sends them', async () => {
  const f = ok(await formOf('inc-fob-pick'));
  const choice = f.form.find((x) => x.key === 'watchId');
  assert.deepEqual(
    choice.options,
    [
      { value: String(ids.w4301), label: '#4301 · Rolex Daytona 126500LN' },
      { value: String(ids.w4307), label: '#4307 · Rolex Daytona 126500LN' },
    ],
    '4303 is already in the app'
  );
  assert.equal(choice.hint, '1 of our 3 incoming watches already held');
  assert.match((await act('inc-fob-pick', { watchId: ids.w4305 })).body.error, /is in_stock, not incoming/);
  const r = ok(await act('inc-fob-pick', { watchId: ids.w4301, destination: 'Dubai', eta: '2026-11-10', send: false }));
  assert.match(r.message, /#4301 picked — in the box/);
  const picked = await item(r.created[0]);
  assert.equal(picked.kind, 'fobPicked');
  const p = picked.data;
  assert.deepEqual(
    [p.stockNumber, p.reference, p.brand, p.watchModel, p.serial, p.supplier, p.location, p.destination, p.eta, p.status, p.buyPrice, p.buyCurrency, p.notes, p.fobStatus, Number(p.ts) > 0],
    ['4301', '126500LN', 'Rolex', 'Daytona', 'SN4301', 'Khawar Saeed', 'Dubai', 'Dubai', '2026-11-10', 'in_transit', '50000', 'USD', '', 'incoming', true],
    'the app’s fobDerive, from our record: the client we bought it from, Chrono Key’s category, the purchase price'
  );
  assert.deepEqual(picked.stock_nos, ['4301']);
  assert.ok((await activity()).includes('📥 Picked 1 watch from FOB'));
  assert.match((await act('inc-fob-pick', { watchId: ids.w4301 })).body.error, /already in the app \(fobPicked\)/);

  const s = ok(await actOn(picked.id, 'inc-fob-send', {}));
  const inc = await item(s.created[0]);
  assert.equal(inc.kind, 'incomings');
  const d = inc.data;
  assert.deepEqual([d.stockNumber, d.reference, d.brand, d.watchModel, d.serial, d.supplier, d.location, d.destination, d.eta, d.status, d.buyPrice, d.buyCurrency, d.notes, d.photos, d.shipmentId, d.fromFob], ['4301', '126500LN', 'Rolex', 'Daytona', 'SN4301', 'Khawar Saeed', 'Dubai', 'Dubai', '2026-11-10', 'in_transit', 50000, 'USD', '', [], null, true]);
  assert.ok((await item(picked.id)).deleted_at, 'out of the box');
  assert.ok((await ofKind('clients')).some((c) => c.data.name === 'Khawar Saeed' && c.data.country === 'Dubai'), 'the supplier made a client, as the app does');
  assert.ok((await activity()).includes('📥 Added 1 FOB pick to Incomings'));
  ids.i4301 = inc.id;

  assert.match((await act('inc-fob-pick', { watchId: ids.w4303 })).body.error, /#4303 is already in the app \(dubaiStock\)/);
  const r2 = ok(await act('inc-fob-pick', { watchId: ids.w4307 }));
  const dropped = ok(await actOn(r2.created[0], 'inc-fob-drop', {}));
  assert.equal(dropped.open, '#/logistics/incoming');
  assert.ok((await item(r2.created[0])).deleted_at);
});

/* ── Owner decisions ── */

test('od-decide: the app’s saveOwnerDecisionEdit through odSet — the record made when first needed, its events appended, the incoming pointing at it; conflicts said, never acted on', async () => {
  const f = ok(await formOf('od-decide', ids.i4330));
  assert.deepEqual(f.values, { status: 'DECISION_NEEDED', action: '', destination: 'Dubai', collector: '', reviewAt: '', rawInstruction: '' });
  assert.match(f.form[0].hint, /It is already on a shipment\./, 'the conflicts, as the app shows them');
  const r = ok(await actOn(ids.i4330, 'od-decide', { status: 'APPROVED', action: 'COLLECT', destination: 'London', collector: 'Ben', reviewAt: '', rawInstruction: 'Collect and bring to London' }));
  assert.match(r.message, /^Decision recorded: Approved · ⚠ Its destination is Dubai; this says London\./);
  const od = await lastOf('ownerDecisions');
  assert.equal(od.origin, 'manual');
  assert.deepEqual(od.stock_nos, ['4330']);
  const d = od.data;
  const inc = (await item(ids.i4330)).data;
  assert.deepEqual([d.incomingId, inc.ownerDecisionId, d.stockNumber, d.status, d.action, d.destination, d.collector, d.rawInstruction, d.confirmedBy, d.source, d.briefId, d.priority, d.aiInterpretation], [inc.id, d.id, '4330', 'APPROVED', 'COLLECT', 'London', 'Ben', 'Collect and bring to London', 'Eddie Editor', 'APP', '', '', null]);
  assert.ok(d.confirmedAt > 0 && d.updatedAt >= d.createdAt);
  assert.deepEqual(d.events.map((e) => [e.type, e.by, e.source, e.text]), [
    ['created', 'Eddie Editor', undefined, undefined],
    ['updated', 'Eddie Editor', 'APP', 'Entered in the app'],
  ]);
  assert.deepEqual(d.events[1].from, { status: 'DECISION_NEEDED', action: '', destination: '', collector: '' });
  assert.deepEqual(d.events[1].to, { status: 'APPROVED', action: 'COLLECT', destination: 'London', collector: 'Ben' });
  assert.ok((await activity()).includes('🗂 Owner decision for #4330 → Approved'));
  assert.match((await actOn(ids.i4330, 'od-decide', { status: 'NOPE' })).body.error, /Status: "NOPE" is not one of/);
  ids.od4330 = od.id;

  // The same action from the decision's own record.
  const g = ok(await formOf('od-decide', ids.od4330));
  assert.deepEqual([g.values.status, g.values.collector], ['APPROVED', 'Ben']);
});

test('od-start / od-done / od-status: the card’s buttons and its ••• menu — only from the status they fit; each an event and an activity line; the app’s copy locked', async () => {
  assert.match((await actOn(ids.i4330, 'od-done', {})).body.error, /Done is for a decision in execution; this one is Approved/);
  ok(await actOn(ids.i4330, 'od-start', {}));
  assert.equal((await item(ids.od4330)).data.status, 'IN_EXECUTION');
  assert.ok((await activity()).includes('🗂 Owner decision → In Execution'));
  assert.match((await actOn(ids.od4330, 'od-start', {})).body.error, /Start is for an approved decision/);
  ok(await actOn(ids.od4330, 'od-done', {}));
  const d = (await item(ids.od4330)).data;
  assert.equal(d.status, 'COMPLETED');
  assert.deepEqual(d.events.slice(-2).map((e) => [e.text, e.from.status, e.to.status]), [
    ['Set in the app', 'APPROVED', 'IN_EXECUTION'],
    ['Set in the app', 'IN_EXECUTION', 'COMPLETED'],
  ]);

  // The app's own decision (OD1 on 4306): a status set here locks it against the sync.
  const f = ok(await formOf('od-status', ids.i4306));
  assert.deepEqual(f.values, { status: 'APPROVED' });
  ok(await actOn(ids.i4306, 'od-status', { status: 'HOLD' }));
  const od1 = await item(ids.od1);
  assert.equal(od1.data.status, 'HOLD');
  assert.ok(od1.locked_fields.includes('status') && od1.locked_fields.includes('events') && od1.locked_fields.includes('updatedAt'));
  assert.equal(od1.data.events.length, 2);
  assert.ok((await activity()).includes('🗂 Owner decision → Hold'));
  ok(await actOn(ids.od1, 'od-status', { status: 'APPROVED' }));
  assert.equal((await item(ids.od1)).data.confirmedBy, 'Eddie Editor');
  // No decision yet, from a FOB pick: NOT_ASKED, as the app counts it.
  assert.deepEqual(ok(await formOf('od-status', ids.i4301)).values, { status: 'NOT_ASKED' });
});

test('od-assign / od-arranged: the execution queue’s group (place → destination, collector) — the collector set on each, then all in execution', async () => {
  const q = '?from=Switzerland&to=Dubai&collector=Ben';
  assert.deepEqual(ok(await formOf('od-assign', null, q)).values, { collector: 'Ben' });
  assert.match((await act('od-assign', { collector: 'X' }, '?from=Mars&to=Dubai&collector=')).body.error, /Nothing approved in that group/);
  ok(await act('od-assign', { collector: 'Fiaz' }, q));
  const od1 = (await item(ids.od1)).data;
  assert.equal(od1.collector, 'Fiaz');
  assert.equal(od1.events.at(-1).text, 'Collector set in the app');
  assert.ok((await activity()).includes('🚚 Collector Fiaz for 1 from Switzerland'));
  ok(await act('od-arranged', {}, '?from=Switzerland&to=Dubai&collector=Fiaz'));
  const after = (await item(ids.od1)).data;
  assert.equal(after.status, 'IN_EXECUTION');
  assert.equal(after.events.at(-1).text, 'Marked arranged');
  assert.ok((await activity()).includes('🚚 1 watch marked arranged (Switzerland → Dubai)'));
});

test('od-brief: the app’s brief, built as odBriefText builds it, marked as sent — the ownerBriefs record, every watch in it Sent to Owner with the brief’s id; nothing twice', async () => {
  // A watch that needs a decision: 4301 is not asked (from FOB); make 4340 — new, from Igor in Switzerland.
  const a = ok(await act('inc-add', { stockNumber: '4340', reference: '26240ST', brand: 'Audemars Piguet', supplier: 'Igor', location: 'Switzerland', destination: 'Dubai', status: 'pending', buyPrice: 55000, buyCurrency: 'USD', notes: 'new in box, a long note that goes on and on past seventy characters for the cut' }));
  ids.i4340 = a.created[0];
  const f = ok(await formOf('od-brief', null, '?group=supplier&fields=stock,ref,price,dest,notes'));
  assert.equal(f.form[1].hint, '1 watch will be marked Sent to Owner');
  assert.equal(
    f.values.text,
    [
      '📦 INCOMINGS — FOR YOUR DECISION',
      '',
      'When you have a moment, could I please have your instructions on 1 watch?',
      '',
      '🇨🇭 IGOR — SWITZERLAND',
      '1 watch',
      '',
      '#4340  26240ST',
      'Audemars Piguet',
      'Buy: USD 55,000',
      'Destination: Dubai',
      'Note: new in box, a long note that goes on and on past seventy characters fo',
      '',
      '🎙 Whenever it suits you, please send a voice note with how you would like these handled. Thank you.',
    ].join('\n')
  );
  // Picked by location, none of them Switzerland: nothing.
  assert.match((await act('od-brief', {}, '?pick=location&picked=Italy')).body.error, /Nothing to ask about/);
  const r = ok(await act('od-brief', { to: '+971 50 000 1234', text: '' }, '?group=supplier'));
  assert.match(r.message, /1 watch now with the owner/);
  const brief = await item(r.created[0]);
  assert.equal(brief.kind, 'ownerBriefs');
  const inc = await item(ids.i4340);
  assert.deepEqual([brief.data.by, brief.data.to, brief.data.group, brief.data.count, brief.data.incomingIds, Number(brief.data.ts) > 0], ['Eddie Editor', '+971 50 000 1234', 'supplier', 1, [inc.data.id], true]);
  assert.equal(brief.data.text, f.values.text);
  const od = await lastOf('ownerDecisions');
  assert.deepEqual([od.data.incomingId, od.data.status, od.data.briefId, inc.data.ownerDecisionId, Number(od.data.requestedAt) > 0], [inc.data.id, 'SENT_TO_OWNER', brief.data.id, od.data.id, true]);
  assert.deepEqual(od.data.events.at(-1).type, 'sent_to_owner');
  assert.deepEqual([od.data.events.at(-1).source, od.data.events.at(-1).text], ['WHATSAPP', 'Sent to the owner on WhatsApp']);
  assert.ok((await activity()).includes('🎙 Owner brief sent — 1 watch'));
  assert.match((await act('od-brief', {}, '?group=supplier')).body.error, /Nothing to ask about/, 'already with him');
  const again = ok(await formOf('od-brief', null, '?group=location&sent=1&fields=stock'));
  assert.match(
    again.values.text,
    /These are ones I sent before — sorry to ask again\.\n1 of them you have seen before — something has changed since\.\n\n🇨🇭 SWITZERLAND\n1 watch\n\n#4340\nAudemars Piguet\n↩ sent before/,
    'the app counts an asked-before one among the changed — line for line'
  );
  // The page shows it (its rows, the page's own reading of the records).
  const page = await m.odPage.page();
  assert.equal(page.briefs[0].count, 1);
});

test('od-delete: the decision record gone softly, the incoming back to Decision needed', async () => {
  const od = await lastOf('ownerDecisions');
  const r = ok(await actOn(od.id, 'od-delete', {}));
  assert.equal(r.open, '#/logistics/ownerdecisions');
  assert.ok((await item(od.id)).deleted_at);
  assert.equal((await item(ids.i4340)).data.ownerDecisionId, undefined);
  assert.deepEqual(ok(await formOf('od-status', ids.i4340)).values, { status: 'DECISION_NEEDED' });
  assert.ok((await activity()).includes('🗂 Owner decision for #4340 deleted'));
  assert.equal((await actOn(ids.i4340, 'od-delete', {})).status, 400, 'not on an incoming');
});

test('the pure parts: the brief’s options as the page sends them; the text with the fields off and more than four in a group', async () => {
  const opts = m.decisions.briefOptions({ pick: 'supplier', picked: 'Igor|Robin Casanova', group: 'location', fields: 'stock,serial', sent: '1' });
  assert.deepEqual([opts.pick, [...opts.picked], opts.group, opts.includeSent, opts.fields], ['supplier', ['Igor', 'Robin Casanova'], 'location', true, { stock: true, ref: false, price: false, dest: false, notes: false, serial: true }]);
  const rows = Array.from({ length: 5 }, (_, n) => ({ id: n, status: 'DECISION_NEEDED', supplier: 'Igor', location: 'Italy', stock_no: `50${n}`, reference: `R${n}`, brand: 'Rolex', serial: `S${n}`, buy: { amount: 1000, currency: 'EUR' }, destination: n < 3 ? 'Dubai' : 'London', notes: '' }));
  const items = m.decisions.briefCandidates(rows, opts);
  assert.equal(items.length, 5);
  const text = m.decisions.briefText(items, opts);
  assert.match(text, /🇮🇹 ITALY\n5 watches\n\n#500\nRolex · SN S0\n\n#501/);
  assert.match(text, /\+1 more watch\n\n💡 3 of these share the same destination — Dubai\. They may be able to travel together\./);
  assert.ok(!text.includes('Buy:') && !text.includes('R0'), 'the fields left out stay out');
  assert.equal(m.decisions.briefText([], opts), 'Nothing to ask about.');
});

test('who may: a viewer is refused every action (403), nobody signed in is refused (401)', async () => {
  const viewer = client();
  assert.equal((await viewer.login('view@example.com', 'viewer-password-1')).status, 200);
  assert.equal((await viewer.call('GET', '/api/logistics/act/inc-add')).status, 403);
  assert.equal((await viewer.call('POST', '/api/logistics/act/inc-add', { stockNumber: '9', reference: 'x' })).status, 403);
  assert.equal((await viewer.call('POST', `/api/logistics/items/${ids.i4306}/act/od-start`, {})).status, 403);
  assert.equal((await viewer.call('GET', '/api/logistics/act/inc-import/template')).status, 403);
  const anon = client();
  assert.equal((await anon.call('POST', `/api/logistics/items/${ids.i4306}/act/inc-cancel`, {})).status, 401);
  assert.equal((await ed.call('POST', '/api/logistics/act/no-such', {})).status, 404);
  assert.equal((await actOn(ids.l4302, 'inc-arrive', {})).status, 400, 'not on a stock row');
});
