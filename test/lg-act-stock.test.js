import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';

/*
 * The stock-by-place actions (src/logistics/actions/stock.js) — the
 * logistics app's London / Dubai / HK Stock, In Safe and Checkout workflows
 * done here — run through the API as an editor against a fixture: what each
 * writes (every record, field, lock, event, activity line), what it refuses,
 * a viewer refused. Against a real Postgres (TEST_DATABASE_URL), which is
 * EMPTIED first; no worker — the records are inserted as the sync would leave
 * them (origin 'logistics', so a change here locks the field).
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lg-act-stock-'));
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
    stock: await import('../src/logistics/actions/stock.js'),
    actions: await import('../src/logistics/actions/index.js'),
    auth: await import('../src/auth/index.js'),
  };
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await m.auth.ensureFirstAdmin(() => {});
  await m.auth.createUser({ email: 'viewer@example.com', role: 'viewer', password: 'viewer-password-1' });
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

/* A record as the sync leaves the app's copy (origin logistics), or one of ours. */
const add = async (kind, data, stock, sourceId = null, origin = 'logistics') =>
  (await db('INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ($1, $2, $3, $4, $5) RETURNING id', [kind, sourceId, data, stock, origin])).rows[0].id;
const item = async (id) => (await db('SELECT * FROM logistics_items WHERE id = $1', [id])).rows[0];
const live = async (kind) => (await db('SELECT * FROM logistics_items WHERE kind = $1 AND deleted_at IS NULL ORDER BY id', [kind])).rows;
const activity = async () => (await db("SELECT data->>'text' AS text FROM logistics_items WHERE kind = 'activity' AND deleted_at IS NULL ORDER BY id")).rows.map((r) => r.text);
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
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };
  return { call, login: (email, password) => call('POST', '/api/login', { email, password }) };
}
let editor;
const act = (key, id, input = {}) => editor.call('POST', `/api/logistics${id ? `/items/${id}` : ''}/act/${key}`, input);
const form = (key, id) => editor.call('GET', `/api/logistics${id ? `/items/${id}` : ''}/act/${key}`);

const ids = {};

test('the fixture: our watches and clients, the logistics clients, and the app’s records as copied', async () => {
  const ourClient = async (fore, sur) => (await db('INSERT INTO clients(forename, surname, origin) VALUES ($1, $2, $3) RETURNING id', [fore, sur, 'manual'])).rows[0].id;
  ids.seller = await ourClient('Khawar', 'Saeed');
  ids.robin = await ourClient('Robin', 'Casanova');
  const watch = async (no, status, from = null) =>
    (await db("INSERT INTO watches(stock_no, brand, model, origin, status, purchased_from_client_id) VALUES ($1, 'Rolex', 'Daytona', 'manual', $2, $3) RETURNING id", [no, status, from])).rows[0].id;
  ids.w4201 = await watch('4201', 'in_stock', ids.seller);
  ids.w4202 = await watch('4202', 'in_stock');
  ids.w4203 = await watch('4203', 'in_stock');
  ids.lgRobin = await add('clients', { id: 'c-robin', name: 'Robin Casanova', country: 'Switzerland' }, [], 'c-robin');
  ids.lgRk = await add('thirdPartyMovers', { id: 'm-rk', name: 'RK', country: 'HK' }, [], 'm-rk');

  ids.l4201 = await add('londonStock', { id: 'L-4201', stockNumber: '4201', from: 'Khawar Saeed', brand: 'Rolex', watchModel: 'Rolex Daytona', watchReference: '126500LN', status: 'current', accessoriesPresent: 'Watch, Box, Papers', accessoriesMissing: '', inMayfair: '✓', needPolish: false, movements: [], photos: [], createdAt: 1792000000000 }, ['4201'], 'L-4201');
  ids.d4202 = await add('dubaiStock', { id: 'D-4202', stockNumber: '4202', brand: 'Rolex', watchModel: 'Submariner', status: 'current', accessoriesPresent: 'Watch, Card', notes: 'old note', movements: [], createdAt: 1792000000000 }, ['4202'], 'D-4202');
  ids.h4203 = await add('hkSituation', { id: 'H-4203', stockNumber: '4203', brand: 'Patek Philippe', description: 'Nautilus 5711', section: 'in_hand', holder: 'IN SAFE', stockStatus: 'IN SAFE', movements: [], createdAt: 1792000000000 }, ['4203'], 'H-4203');
  ids.s4204 = await add('safeStock', { id: 'S-4204', stockNumber: '4204', from: 'Robin Casanova', brand: 'Cartier', watchModel: 'Santos', status: 'current', accessoriesPresent: 'Watch', movements: [], createdAt: 1792000000000 }, ['4204'], 'S-4204');
  ids.r4290 = await add('readyForDelivery', { id: 'R-4290', stockNumber: '4290', brand: 'Rolex', soldPrice: 1, soldCurrency: 'USD', status: 'pending_ship' }, ['4290'], 'R-4290');
  ids.trip = await add('personTrips', { id: 'T-1', personName: 'Ben', fromLocation: 'London', toLocation: 'Dubai', startDate: '2026-11-01', status: 'planned', stockIds: ['lon-L-9999'] }, [], 'T-1');
  ids.ship = await add('shipments', { id: 'SH-1', stockNumber: '4299', items: 'Daytona', date: '2026-10-20', status: 'pending' }, ['4299'], 'SH-1');
  ids.spare = await add('londonSpares', { id: 'SP-1', brand: 'Rolex', accessory: 'Links', qty: 2, fromStock: '4100', addedAt: 1792000000000 }, ['4100'], 'SP-1');

  editor = client();
  assert.equal((await editor.login('boss@example.com', 'admin-password-1')).status, 200);
});

test('the catalog lists the stock actions: page-level ones on their tabs, a record’s on its kinds, the CSV template', async () => {
  const meta = (await editor.call('GET', '/api/meta')).body;
  const acts = meta.logistics.actions;
  const by = (k) => acts.find((a) => a.key === k);
  assert.equal(by('stock-add-london').page, 'londonstock');
  assert.equal(by('stock-add-safe').page, 'safe');
  assert.equal(by('stock-import-dubai').has_template, true);
  assert.deepEqual(by('stock-move').kinds, ['londonStock', 'dubaiStock', 'hkStock', 'safeStock']);
  assert.deepEqual(by('stock-checkout-return').kinds, ['checkoutStock']);
  assert.equal(by('stock-take').ai, true, 'the stock take needs the AI key');
  assert.equal(by('stock-take').ai_ready, false, 'none on this machine');
  assert.equal(by('stock-delete').danger, true);
  // The Edit form gets the app's own fields: the corners, the Vault switch, the three prices (merged into the catalog by actions/index.js).
  const extra = m.actions.EXTRA_FIELDS;
  for (const key of ['inMayfair', 'inNcl', 'hideFromVault', 'buyPrice', 'b2bCurrency', 'b2cPrice']) assert.ok(extra.londonStock.some((f) => f.key === key), `londonStock types ${key}`);
  assert.ok(!extra.safeStock.some((f) => f.key === 'buyPrice'), 'a client’s watch in the safe is not priced');
  const t = await editor.call('GET', '/api/logistics/act/stock-import-dubai/template');
  assert.equal(t.status, 200);
  assert.equal(String(t.body).split('\n')[0], 'stockNumber,from,brand,watchModel,watchReference,watchDate,watchSerial,accessoriesPresent,accessoriesMissing,inOffice,inSafe,needPolish');
  assert.match(String(t.body), /^1184,Adam Rasul,Patek Philippe/m);
});

test('Add row: the app’s saveLondonRow — the row with its status, the activity line; a number already held anywhere is refused; one we do not hold is flagged', async () => {
  const r = await act('stock-add-london', null, { stockNumber: '4205', from: 'Robin Casanova', brand: 'Rolex', watchModel: 'GMT-Master II', watchReference: '126710BLRO', accessoriesPresent: 'Watch, Box , Card', accessoriesMissing: '3 Links', inMayfair: '✓', needPolish: 'true', showInVault: false, receivedAt: '2026-10-27', buyPrice: '12,500', buyCurrency: 'aed', notes: 'new' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.message, /not one of our watches/);
  const row = await item(r.body.created[0]);
  assert.equal(row.kind, 'londonStock');
  assert.equal(row.origin, 'manual');
  assert.deepEqual(row.stock_nos, ['4205']);
  const d = row.data;
  assert.deepEqual(
    [d.stockNumber, d.from, d.brand, d.watchModel, d.accessoriesPresent, d.accessoriesMissing, d.inMayfair, d.inNcl, d.needPolish, d.hideFromVault, d.receivedAt, d.buyPrice, d.buyCurrency, d.b2bPrice, d.b2bCurrency, d.status, d.movements, d.photos, d.notes],
    ['4205', 'Robin Casanova', 'Rolex', 'GMT-Master II', 'Watch, Box, Card', '3 Links', '✓', '', true, true, Date.UTC(2026, 9, 27), 12500, 'AED', null, 'USD', 'current', [], [], 'new']
  );
  assert.ok(typeof d.id === 'string' && d.id.length > 6 && typeof d.createdAt === 'number', 'the app’s own id and createdAt');
  assert.ok((await activity()).includes('Added 🇬🇧 London Stock 4205 · present: 3 · missing: 1'));
  assert.equal((await events(row.id))[0].action, 'create');

  const dup = await act('stock-add-dubai', null, { stockNumber: '4290', watchModel: 'Anything' });
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /already exists in 📦 Ready for Delivery/);
  const dup2 = await act('stock-add-dubai', null, { stockNumber: ' 4201 ', watchModel: 'Anything' });
  assert.match(dup2.body.error, /🇬🇧 London Stock · Rolex · Rolex Daytona/);
  assert.equal((await act('stock-add-hk', null, { stockNumber: '4206' })).status, 400, 'the model is required');
  assert.equal((await act('stock-add-london', null, { stockNumber: '4206', watchModel: 'X', receivedAt: '2026-13-01' })).status, 400, 'a day that does not exist');
  ids.l4205 = row.id;
});

test('Import CSV: the app’s importStockCsv — the template’s columns, a number already there updated, a line without a model skipped', async () => {
  const csv = `${m.stock.template(m.stock.PLACES.dubaiStock).split('\n')[0]}\n4202,STEFANO,Rolex,Rolex Submariner Date,126610LV,05/2024,ABC,"Watch, Card, Box","Booklet",✓,,no\n4207,HAYAT,Rolex,Rolex Daytona,116508,,,"Watch",,,✓,yes\n4208,,,,,,,,,,,\n`;
  const r = await act('stock-import-dubai', null, { csv });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.message, /added 1, updated 1, skipped 1/);
  assert.match(r.body.message, /Line 4: missing watchModel/);
  assert.match(r.body.message, /Not one of our watches: 4207/);
  const upd = await item(ids.d4202);
  assert.deepEqual([upd.data.watchModel, upd.data.from, upd.data.inOffice, upd.data.inSafe, upd.data.needPolish, upd.data.notes], ['Rolex Submariner Date', 'STEFANO', '✓', '', false, 'old note'], 'updated in place, the rest kept');
  assert.ok(upd.locked_fields.includes('watchModel') && upd.locked_fields.includes('from'), 'a field changed on the app’s copy is locked');
  const added = (await live('dubaiStock')).find((x) => x.data.stockNumber === '4207');
  assert.deepEqual([added.data.needPolish, added.data.inSafe, added.data.status, added.data.movements, added.origin], [true, '✓', 'current', [], 'manual']);
  assert.ok((await activity()).includes('Dubai Stock CSV import — added 1, updated 1, skipped 1'));
  assert.equal((await act('stock-import-london', null, { csv: 'brand,model\nRolex,Daytona\n' })).status, 400, 'the required columns');
  ids.d4207 = added.id;
});

test('Move: the app’s confirmLondonMove — the movement on the row, spares left behind, the row created in the other place, the trip given the watch, the lines', async () => {
  const f = await form('stock-move', ids.l4201);
  assert.equal(f.status, 200);
  const moveType = f.body.form.find((x) => x.key === 'moveType');
  assert.deepEqual(moveType.options.map((o) => o.value), ['external', 'dubai', 'hk', 'safe']);
  assert.ok(f.body.form.find((x) => x.key === 'linkedTripId').options.some((o) => o.value === 'T-1'));
  assert.ok(f.body.form.find((x) => x.key === 'linkedShipmentId').options.some((o) => o.value === 'SH-1'));
  assert.equal(f.body.values.takenAccessories, 'Watch, Box, Papers');

  const r = await act('stock-move', ids.l4201, { moveType: 'dubai', date: '2026-10-28', carrier: 'Ben', takenAccessories: 'Watch, Papers', spareAccessories: 'Box, Links ×2', linkedTripId: 'T-1', linkedShipmentId: 'SH-1', notes: 'by hand' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.message, /Created in 🇦🇪 Dubai Stock\. 2 spare items added to 🇬🇧 London Spares/);
  const src = await item(ids.l4201);
  assert.equal(src.data.status, 'moved');
  assert.ok(typeof src.data.movedAt === 'number');
  const mv = src.data.movements[0];
  assert.deepEqual([mv.date, mv.destination, mv.carrier, mv.takenAccessories, mv.leftSpareAccessories, mv.notes, mv.moveType, mv.linkedShipmentId, mv.linkedTripId, mv.sendingPhotos], ['2026-10-28', 'Dubai Stock', 'Ben', ['Watch', 'Papers'], ['Box', 'Links ×2'], 'by hand', 'dubai', 'SH-1', 'T-1', []]);
  assert.ok(src.locked_fields.includes('status') && src.locked_fields.includes('movements'));
  const spares = (await live('londonSpares')).filter((s) => s.data.fromStock === '4201');
  assert.deepEqual(spares.map((s) => [s.data.brand, s.data.accessory, s.data.qty, s.data.fromWatch, s.data.notes]), [['Rolex', 'Box', 1, 'Rolex Daytona', 'Left when 4201 moved to Dubai Stock'], ['Rolex', 'Links', 2, 'Rolex Daytona', 'Left when 4201 moved to Dubai Stock']]);
  const dest = (await live('dubaiStock')).find((x) => x.data.stockNumber === '4201');
  assert.ok(dest, 'the row in Dubai');
  assert.deepEqual([dest.data.from, dest.data.accessoriesPresent, dest.data.status, dest.data.inMayfair, dest.data.receivedAt, dest.data.movements[0].destination, dest.data.movements[0].moveType, dest.data.movements[0].notes], ['Khawar Saeed', 'Watch, Papers', 'current', '', Date.UTC(2026, 9, 28), 'From 🇬🇧 London Stock', 'arrival_from_london', 'Arrived from 🇬🇧 London. 2 items left as 🇬🇧 London spare.']);
  assert.deepEqual(dest.stock_nos, ['4201']);
  const trip = await item(ids.trip);
  assert.deepEqual(trip.data.stockIds, ['lon-L-9999', `dubai-${dest.data.id}`], 'the trip names the row where the watch now is');
  assert.ok(trip.locked_fields.includes('stockIds'));
  const lines = await activity();
  assert.ok(lines.includes('📤 Moved 🇬🇧 London Stock 4201 to Dubai Stock · 2 acc taken · 2 spare Created in 🇦🇪 Dubai Stock.'), lines.join('\n'));
  assert.ok(lines.includes('🚗 Attached 4201 to trip "Ben · London → Dubai" (cost now splits across 2 stocks)'));
  assert.equal((await act('stock-move', ids.l4201, { moveType: 'external' })).status, 400, 'moved already');
  assert.equal((await act('stock-move', dest.id, { moveType: 'external', destination: '' })).status, 400, 'an external move needs a destination');
  ids.d4201 = dest.id;
});

test('Move back: the app’s londonMoveBack — a returned movement, current again', async () => {
  const r = await act('stock-move-back', ids.l4201);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const src = await item(ids.l4201);
  assert.deepEqual([src.data.status, src.data.movedAt, src.data.movements.length, src.data.movements[0].returned, src.data.movements[0].destination, src.data.movements[0].notes], ['current', null, 2, true, 'BACK TO LONDON', 'Moved back from outside London']);
  assert.ok((await activity()).includes('↺ Moved 🇬🇧 London Stock 4201 back to current'));
  assert.equal((await act('stock-move-back', ids.l4201)).status, 400, 'in stock already');
});

test('Check out and Return: the app’s confirmCheckout / returnFromCheckout — the entry with its snapshot, the row gone and back as it was', async () => {
  const r = await act('stock-checkout', ids.l4205, { checkedOutBy: 'Given to Khawar', checkedOutDate: '2026-10-30', notes: 'for a week' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const co = await item(r.body.created[0]);
  assert.equal(co.kind, 'checkoutStock');
  assert.deepEqual([co.data.stockNumber, co.data.brand, co.data.watchModel, co.data.originLocation, co.data.originKey, co.data.checkedOutDate, co.data.checkedOutBy, co.data.notes, co.data.checkoutPhotos, co.data.originRow.id], ['4205', 'Rolex', 'GMT-Master II', 'london', 'londonStock', '2026-10-30', 'Given to Khawar', 'for a week', [], (await item(ids.l4205)).data.id]);
  assert.ok((await item(ids.l4205)).deleted_at);
  assert.ok((await activity()).includes('📤 Checked out 4205 from london stock · Given to Khawar'));
  assert.equal((await act('stock-checkout', ids.l4201, { checkedOutBy: '' })).status, 400, 'a reason is required');

  const back = await act('stock-checkout-return', co.id);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const row = await item(ids.l4205);
  assert.equal(row.deleted_at, null, 'the same row, restored — not a second one');
  assert.equal(row.data.watchModel, 'GMT-Master II');
  assert.ok((await item(co.id)).deleted_at);
  assert.ok((await activity()).includes('↩ Returned 4205 from Checkout to london stock'));
  assert.equal((await act('stock-checkout-return', co.id)).status, 404, 'gone from checkout');

  // An HK board row checks out too (the app's openCheckoutModal looks there); Delete removes an entry outright.
  const hk = await act('stock-checkout', ids.h4203, { checkedOutBy: 'With Winnie' });
  assert.equal(hk.status, 200);
  const hkCo = await item(hk.body.created[0]);
  assert.deepEqual([hkCo.data.originLocation, hkCo.data.originKey, hkCo.data.watchModel], ['hk', 'hkSituation', 'Nautilus 5711']);
  assert.equal((await act('stock-checkout-delete', hkCo.id)).status, 200);
  assert.ok((await item(hkCo.id)).deleted_at);
  // The board row stays deleted (checked out, then the entry deleted): restore it by hand for the HK tests.
  await db('UPDATE logistics_items SET deleted_at = NULL WHERE id = $1', [ids.h4203]);
});

test('A note, the Vault switch, Delete — the app’s updateStockNote / toggleVaultVisibility / deleteLondonRow, with their lines', async () => {
  assert.equal((await act('stock-notes', ids.d4202, { notes: 'old note' })).body.message, 'The note is unchanged');
  await act('stock-notes', ids.d4202, { notes: 'Polished, back in the office' });
  assert.equal((await item(ids.d4202)).data.notes, 'Polished, back in the office');
  assert.ok((await activity()).includes('Updated note on stock 4202: "Polished, back in the office"'));

  await act('stock-vault', ids.d4202);
  assert.equal((await item(ids.d4202)).data.hideFromVault, true);
  await act('stock-vault', ids.d4202);
  assert.equal((await item(ids.d4202)).data.hideFromVault, false);
  const lines = await activity();
  assert.ok(lines.includes('🚫 4202 hidden from Watch Vault') && lines.includes('🌐 4202 shown in Watch Vault again'));

  const del = await act('stock-delete', ids.d4207);
  assert.equal(del.status, 200);
  assert.ok((await item(ids.d4207)).deleted_at);
  assert.ok((await activity()).includes('Deleted 🇦🇪 Dubai Stock 4207 (deleted here)'));
  assert.equal((await act('stock-notes', ids.d4207, { notes: 'x' })).status, 404, 'a deleted row');
});

test('The safe: Give back to owner is the app’s Move (external, to the owner); spares added by hand and deleted', async () => {
  const r = await act('stock-safe-give', ids.s4204, { date: '2026-11-02', takenAccessories: 'Watch', notes: 'collected' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await item(ids.s4204);
  assert.deepEqual([row.data.status, row.data.movements[0].destination, row.data.movements[0].moveType, row.data.movements[0].takenAccessories], ['moved', 'Given back to Robin Casanova', 'external', ['Watch']]);
  assert.ok((await activity()).includes('📤 Moved 🔒 In Safe Stock 4204 to Given back to Robin Casanova · 1 acc taken · 0 spare'));

  const sp = await act('stock-spare-add-safe', null, { brand: 'Rolex', accessory: 'Buckle', qty: '3' });
  assert.equal(sp.status, 200);
  const spare = await item(sp.body.created[0]);
  assert.deepEqual([spare.kind, spare.data.brand, spare.data.accessory, spare.data.qty, spare.data.fromStock, spare.data.notes], ['safeSpares', 'Rolex', 'Buckle', 3, '', 'Added manually']);
  assert.equal((await act('stock-spare-add-london', null, { accessory: '' })).status, 400);
  assert.equal((await act('stock-spare-delete', ids.spare)).status, 200);
  assert.ok((await item(ids.spare)).deleted_at);
});

test('The HK board: Add HK row, Move on the board with a sale (the transaction, the cost line, the mover’s shipment), Cancel sale back into the section it left', async () => {
  const add1 = await act('stock-hk-add', null, { stockNumber: '4209', brand: 'Rolex', section: 'incoming', holder: 'By Ferrari', description: 'Daytona', notes: '' });
  assert.equal(add1.status, 200, JSON.stringify(add1.body));
  const n = await item(add1.body.created[0]);
  assert.deepEqual([n.kind, n.data.section, n.data.holder, n.data.movements], ['hkSituation', 'incoming', 'By Ferrari', []]);
  assert.ok((await activity()).includes('HK row 4209 added to Incomings to HK'));
  assert.equal((await act('stock-hk-add', null, { section: 'in_hand' })).status, 400, 'a number or a description');
  assert.equal((await act('stock-hk-add', null, { stockNumber: '4290', section: 'in_hand' })).status, 400, 'a number held elsewhere');

  const f = await form('stock-hk-move', ids.h4203);
  assert.equal(f.body.values.toSection, 'outgoing', 'from In Hand the app offers Going out');
  assert.equal((await act('stock-hk-move', ids.h4203, { toSection: 'outgoing', isSale: true })).status, 400, 'a sale needs its client');
  assert.equal((await act('stock-hk-move', ids.h4203, { toSection: 'nowhere' })).status, 400, 'a section the board has');
  const r = await act('stock-hk-move', ids.h4203, { toSection: 'outgoing', toHolder: 'By RK', date: '2026-11-03', carrier: 'RK', destination: 'Dubai', costAmount: '1,500', costCurrency: 'HKD', isSale: true, saleClientId: 'c-robin', saleBrand: 'Patek Philippe', salePrice: 'USD 150,000', givenAccessories: 'Watch, Box', owedAccessories: 'Booklet, Links ×2', notes: 'sold on the way out' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await item(ids.h4203);
  const mv = row.data.movements[0];
  assert.deepEqual([row.data.section, row.data.holder, row.data.stockStatus, mv.fromSection, mv.fromHolder, mv.toSection, mv.toHolder, mv.carrier, mv.destination, mv.cost, mv.notes], ['sold', 'By RK', '', 'in_hand', 'IN SAFE', 'outgoing', 'By RK', 'RK', 'Dubai', 'HKD 1,500', 'sold on the way out']);
  assert.deepEqual([mv.sale.clientId, mv.sale.clientName, mv.sale.brand, mv.sale.price, mv.sale.givenAccessories, mv.sale.remainingAccessories], ['c-robin', 'Robin Casanova', 'Patek Philippe', 'USD 150,000', ['Watch', 'Box'], ['Booklet', 'Links']]);
  const tx = (await live('transactions')).find((t) => t.data.id === mv.transactionId);
  assert.ok(tx, 'the sold transaction');
  assert.deepEqual([tx.data.type, tx.data.clientId, tx.data.stockNumber, tx.data.hkRowId, tx.data.items.map((i) => [i.accessory, i.qty, i.direction, i.status])], ['sold', 'c-robin', '4203', 'H-4203', [['Booklet', 1, 'give', 'pending'], ['Links', 2, 'give', 'pending']]]);
  assert.equal(tx.data.notes, 'Sold from HK Stock for USD 150,000. Given: Watch, Box. Owed: Booklet, Links.');
  const cost = (await live('logisticCosts')).find((c) => c.data.hkMovementId === mv.id);
  assert.deepEqual([cost.data.title, cost.data.stockNumber, cost.data.fromName, cost.data.toName, cost.data.date, cost.data.currency, cost.data.amount], ['HK 4203 move to Dubai (RK)', '4203', '🇭🇰 HK', 'Dubai', '2026-11-03', 'HKD', 1500]);
  const ship = (await live('thirdPartyShipments')).find((s) => s.data.hkMovementId === mv.id);
  assert.deepEqual([ship.data.moverId, ship.data.moverName, ship.data.isOurStock, ship.data.stockNumber, ship.data.fromCountry, ship.data.toCountry, ship.data.currency, ship.data.amount, ship.data.status, ship.data.shipmentDate], ['m-rk', 'RK', true, '4203', 'HK', 'Dubai', 'HKD', 1500, 'in_transit', '2026-11-03']);
  const lines = await activity();
  for (const l of ['💰 SOLD 4203 to Robin Casanova — 2 items pending', 'HK 4203: HK Stock (In Hand) → Going out from HK (By RK)', '💰 HK Move cost: HKD 1,500', '🚛 Logged shipment under RK: HK 4203 → Dubai · HKD 1,500']) assert.ok(lines.includes(l), l);

  const cancel = await act('stock-hk-cancel-sale', ids.h4203);
  assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
  const back = await item(ids.h4203);
  assert.deepEqual([back.data.section, back.data.holder, Boolean(back.data.movements[0].cancelledAt)], ['in_hand', 'IN SAFE', true], 'back in the section it left — the board, not another list');
  assert.ok((await item(tx.id)).deleted_at, 'the sold transaction withdrawn');
  assert.ok((await activity()).includes('↩️ Cancelled HK sale 4203 to Robin Casanova — restored to HK Stock (In Hand)'));
  assert.equal((await act('stock-hk-cancel-sale', ids.h4203)).status, 400, 'not sold');

  // A move into Dubai: the HK row stays "outgoing" and the row is created there, as the app does it.
  ids.h4205 = await add('hkSituation', { id: 'H-4205', stockNumber: '4205', brand: 'Rolex', description: 'GMT-Master II | Ref 126710BLRO', section: 'in_hand', holder: '', movements: [] }, ['4205'], 'H-4205');
  await db('UPDATE logistics_items SET deleted_at = now() WHERE id = $1', [ids.l4205]);
  const toDubai = await act('stock-hk-move', ids.h4205, { toSection: 'dubai', toHolder: 'Winnie', date: '2026-11-04' });
  assert.equal(toDubai.status, 200, JSON.stringify(toDubai.body));
  const hk = await item(ids.h4205);
  assert.deepEqual([hk.data.section, hk.data.stockStatus], ['outgoing', 'WITH WINNIE']);
  const dub = (await live('dubaiStock')).find((x) => x.data.stockNumber === '4205');
  assert.deepEqual([dub.data.from, dub.data.watchModel, dub.data.status, dub.data.movements[0].moveType, dub.data.movements[0].destination], ['HK', hk.data.description, 'current', 'arrival_from_hk', 'From HK']);
  assert.ok((await activity()).includes('📤 HK 4205 moved to 🇦🇪 Dubai Stock'));
});

test('Stock take by AI: refused without the key; the app’s prompt and the reading of its answer, on a stand-in answer', () => {
  const current = [{ stockNumber: '1057', brand: 'Rolex', watchModel: 'Oyster Perpetual 41', watchReference: '134300', watchSerial: 'P4X00292' }, { stockNumber: '911', brand: 'Patek Philippe', watchReference: '7010G-013' }];
  const prompt = m.stock.stockTakePrompt(current, 2);
  assert.match(prompt, /^You are a luxury watch inventory expert doing a physical stock take for a Dubai showroom\./);
  assert.match(prompt, /I have uploaded 2 photos taken by our Dubai employee/);
  assert.match(prompt, /DUBAI STOCK — 2 watches that SHOULD be present:\nStock#: 1057 \| Brand: Rolex \| Model: Oyster Perpetual 41 \| Ref: 134300 \| Serial: P4X00292\nStock#: 911 \| Brand: Patek Philippe \| Ref: 7010G-013/);
  assert.match(prompt, /Return ONLY valid JSON/);
  const report = m.stock.stockTakeReport('```json\n{"confirmed":[{"stockNumber":"1057","confidence":"high","note":"dial"}],"missing":[{"stockNumber":"911","note":"not seen"}],"unexpected":["A Cartier Santos"],"summary":"1 of 2 confirmed","photoQuality":"fair","photoNotes":"dark"}\n```', current);
  assert.deepEqual([report.confirmed.length, report.confirmed[0].row.stockNumber, report.missing[0].row.watchReference, report.unexpected, report.total, report.tone, report.summary, report.photoQuality], [1, '1057', '7010G-013', ['A Cartier Santos'], 2, 'bad', '1 of 2 confirmed', 'fair']);
  assert.equal(m.stock.stockTakeReport({}, current).tone, 'good');
});

test('the API: the stock take refused without a key; a viewer refused; nobody signed in refused', async () => {
  const st = await act('stock-take', null, { brand: '' });
  assert.equal(st.status, 409);
  assert.match(st.body.error, /No AI key/);
  const viewer = client();
  assert.equal((await viewer.login('viewer@example.com', 'viewer-password-1')).status, 200);
  assert.equal((await viewer.call('GET', `/api/logistics/items/${ids.l4201}/act/stock-move`)).status, 403);
  assert.equal((await viewer.call('POST', `/api/logistics/items/${ids.l4201}/act/stock-notes`, { notes: 'x' })).status, 403);
  assert.equal((await viewer.call('POST', '/api/logistics/act/stock-add-london', { stockNumber: '1', watchModel: 'x' })).status, 403);
  assert.equal((await client().call('POST', `/api/logistics/items/${ids.l4201}/act/stock-notes`, { notes: 'x' })).status, 401);
  assert.equal((await act('stock-move', ids.trip, { moveType: 'external', destination: 'x' })).status, 400, 'not a stock row');
});
