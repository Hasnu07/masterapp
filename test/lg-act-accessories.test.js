import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import { picture } from './fakes.js';

/*
 * The logistics app's accessory and record workflows, done here (asked 27
 * Oct 2026): every action of actions/accessories.js and actions/records.js
 * run through the API as an editor against a fixture — what it writes (the
 * records, their fields, the locks, the events, the activity line), what it
 * refuses, a viewer refused. Against a real Postgres (TEST_DATABASE_URL),
 * EMPTIED first; no worker — the app's records are inserted as the sync
 * would leave them (source_id = the app's id, origin manual is ours).
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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lg-act-acc-'));
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
  m = { db: await import('../src/db/index.js'), auth: await import('../src/auth/index.js') };
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

/* The app's copy of a record, as the sync leaves it (source_id = its id, origin logistics). */
const copy = async (kind, sourceId, data, stock = []) =>
  (await db("INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ($1, $2, $3, $4, 'logistics') RETURNING id", [kind, sourceId, { id: sourceId, ...data }, stock])).rows[0].id;
const item = async (id) => (await db('SELECT * FROM logistics_items WHERE id = $1', [id])).rows[0];
const activity = async () => (await db("SELECT data->>'text' AS t FROM logistics_items WHERE kind = 'activity' AND deleted_at IS NULL ORDER BY id DESC")).rows.map((r) => r.t);
const events = async (id) => (await db('SELECT action, changes FROM logistics_events WHERE item_id = $1 ORDER BY id', [id])).rows;
const ofKind = async (kind) => (await db('SELECT * FROM logistics_items WHERE kind = $1 AND deleted_at IS NULL ORDER BY id', [kind])).rows;
const today = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const headers = { 'X-Requested-With': 'masterapp' };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(api + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  return {
    call,
    login: (email, password) => call('POST', '/api/login', { email, password }),
    act: (key, id, input = {}) => call('POST', `/api/logistics${id ? `/items/${id}` : ''}/act/${key}`, input),
    form: (key, id) => call('GET', `/api/logistics${id ? `/items/${id}` : ''}/act/${key}`),
  };
}

const ids = {};
const ed = client();

test('the fixture: our watches and clients, the logistics clients, a transaction with pending items, a Dubai row, the vault’s tracking and a pending notification, a company', async () => {
  assert.equal((await ed.login('boss@example.com', 'admin-password-1')).status, 200);
  const person = async (fore, sur) => (await db('INSERT INTO clients(forename, surname, origin) VALUES ($1, $2, $3) RETURNING id', [fore, sur, 'manual'])).rows[0].id;
  ids.seller = await person('Khawar', 'Saeed');
  ids.robin = await person('Robin', 'Casanova');
  const watch = async (no, status, from) => (await db("INSERT INTO watches(stock_no, brand, model, origin, status, purchased_from_client_id) VALUES ($1, 'Rolex', 'Daytona', 'manual', $2, $3) RETURNING id", [no, status, from || null])).rows[0].id;
  ids.w5101 = await watch('5101', 'in_stock', ids.seller);
  ids.w5102 = await watch('5102', 'in_stock');
  ids.lgRobin = await copy('clients', 'c-robin', { name: 'Robin Casanova', country: 'Switzerland', createdAt: 1 });
  ids.lgSina = await copy('clients', 'c-sina', { name: 'Sina Star', country: 'Dubai', createdAt: 2 });
  ids.t1 = await copy(
    'transactions',
    'T1',
    { type: 'bought', date: '2026-10-01', clientId: 'c-robin', reference: '126500LN', stockNumber: '5101', brand: 'Rolex', notes: '', createdAt: 3, items: [{ id: 'i1', accessory: 'Box', qty: 1, direction: 'receive', status: 'pending', settledBy: null }, { id: 'i2', accessory: 'Links', qty: 3, direction: 'receive', status: 'pending', settledBy: null }] },
    ['5101']
  );
  ids.t2 = await copy('transactions', 'T2', { type: 'sold', date: '2026-10-02', clientId: 'c-sina', reference: '5711', stockNumber: '5102', brand: 'Patek Philippe', items: [{ id: 'i3', accessory: 'Strap', qty: 1, direction: 'give', status: 'pending', settledBy: null }] }, ['5102']);
  ids.d5101 = await copy('dubaiStock', 'D-5101', { stockNumber: '5101', brand: 'Rolex', watchModel: 'Daytona', watchReference: '126500LN', status: 'current', inOffice: true, accessoriesPresent: 'Watch', accessoriesMissing: 'Box, 2 Links', movements: [] }, ['5101']);
  ids.track = (await db("INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin) VALUES ('vaultTracking', 'D-5101', $1, $2, 'logistics') RETURNING id", [{ status: 'In Office', holder: '', updatedAt: '2026-10-01' }, ['5101']])).rows[0].id;
  ids.n1 = await copy('vaultNotifications', 'N1', { ts: 1761500000000, type: 'accessory', loc: 'dubai', watchId: 'D-5101', stockNumber: '5101', brand: 'Rolex', oldPresent: 'Watch', newPresent: 'Watch, Papers', oldMissing: 'Box, 2 Links', newMissing: 'Box', status: 'pending' }, ['5101']);
  ids.n2 = await copy('vaultNotifications', 'N2', { ts: 1761500001000, type: 'price', loc: 'dubai', watchId: 'D-5101', stockNumber: '5101', brand: 'Rolex', newB2BPrice: 100, newB2BCurrency: 'USD', status: 'pending' }, ['5101']);
  ids.co = await copy('companies', 'CO1', { name: 'Estival Habitual', description: 'TRN 1', ts: 4 });
});

/* ── transactions ── */

test('tx-new: the app’s saveTransaction — one direction, each item pending with its own id; the client by id; the activity line; our watch named', async () => {
  const r = await ed.act('tx-new', null, { type: 'sold', date: '2026-10-20', clientId: 'c-robin', stockNumber: '5101, 9999', brand: 'Rolex', reference: 'REF-A', items: 'Box\nLinks × 2, 2 Pushers, Strap x3', notes: 'n' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  ids.t3 = r.body.created[0];
  const it = await item(ids.t3);
  assert.equal(it.origin, 'manual');
  assert.deepEqual(it.stock_nos, ['5101', '9999']);
  assert.deepEqual([it.data.type, it.data.date, it.data.clientId, it.data.reference, it.data.brand, it.data.notes, it.data.stockNumber], ['sold', '2026-10-20', 'c-robin', 'REF-A', 'Rolex', 'n', '5101, 9999']);
  assert.ok(typeof it.data.createdAt === 'number' && typeof it.data.id === 'string');
  assert.deepEqual(
    it.data.items.map((x) => [x.accessory, x.qty, x.direction, x.status, x.settledBy]),
    [['Box', 1, 'give', 'pending', null], ['Links', 2, 'give', 'pending', null], ['Pushers', 2, 'give', 'pending', null], ['Strap', 3, 'give', 'pending', null]],
    'sold → every item is ours to give'
  );
  assert.equal(new Set(it.data.items.map((x) => x.id)).size, 4, 'each item its own id');
  assert.equal((await activity())[0], 'Sold REF-A to Robin Casanova');
  assert.match(r.body.message, /our watch #5101 · #9999 not one of our watches/);
  assert.equal(r.body.open, `#/lg/${ids.t3}`);
  assert.equal((await events(ids.t3))[0].action, 'create');

  assert.equal((await ed.act('tx-new', null, { type: 'bought', reference: 'x' })).status, 400, 'pick a client');
  assert.equal((await ed.act('tx-new', null, { type: 'bought', clientId: 'c-robin' })).status, 400, 'reference required');
  assert.equal((await ed.act('tx-new', null, { type: 'bought', clientId: 'nobody', reference: 'x' })).status, 400, 'a client not in the list');
});

test('tx-item-add / tx-item-edit / tx-item-remove on the app’s copy: the items list changes and is locked; the app’s lines', async () => {
  let r = await ed.act('tx-item-add', ids.t1, { accessory: 'Papers', qty: '2' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  let it = await item(ids.t1);
  assert.deepEqual(it.data.items.at(-1) && [it.data.items.at(-1).accessory, it.data.items.at(-1).qty, it.data.items.at(-1).direction, it.data.items.at(-1).status], ['Papers', 2, 'receive', 'pending']);
  assert.deepEqual(it.locked_fields, ['items'], 'the changed field is locked against the sync');
  assert.equal((await activity())[0], 'Updated transaction 126500LN · Rolex');

  const form = await ed.form('tx-item-edit', ids.t1);
  assert.deepEqual(form.body.form[0].options.map((o) => o.label), ['Box', 'Links × 3', 'Papers × 2']);
  const papersId = form.body.form[0].options[2].value;
  r = await ed.act('tx-item-edit', ids.t1, { itemId: papersId, accessory: 'Warranty Card', qty: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await activity())[0], '✏️ Edited pending accessory on 126500LN: Papers × 2 → Warranty Card × 1');
  assert.equal((await ed.act('tx-item-edit', ids.t1, { itemId: papersId, accessory: '', qty: 1 })).status, 400);
  assert.equal((await ed.act('tx-item-edit', ids.t1, { itemId: papersId, accessory: 'x', qty: 0 })).status, 400);

  r = await ed.act('tx-item-remove', ids.t1, { itemId: papersId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  it = await item(ids.t1);
  assert.deepEqual(it.data.items.map((x) => x.id), ['i1', 'i2']);
  assert.equal((await activity())[0], '🗑️ Removed pending "Warranty Card" from 126500LN');
  assert.equal((await ed.act('tx-item-remove', ids.t1, { itemId: 'nope' })).status, 400);
});

test('tx-settle: the app’s confirmSettle — a settlement record naming the items, the items done and linked, the activity line; photos through the files route; tx-settle-undo puts it all back', async () => {
  let r = await ed.act('tx-settle', ids.t1, { itemId: 'all', notes: 'handed over at the office' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const sId = r.body.created[0];
  const s = await item(sId);
  assert.equal(s.kind, 'settlements');
  assert.deepEqual([s.data.txId, s.data.itemIds, s.data.direction, s.data.notes, s.data.photos], ['T1', ['i1', 'i2'], 'receive', 'handed over at the office', []]);
  assert.ok(typeof s.data.ts === 'number');
  let t = await item(ids.t1);
  assert.deepEqual(t.data.items.map((x) => [x.status, x.settlementId]), [['done', s.data.id], ['done', s.data.id]]);
  assert.equal((await activity())[0], 'Received Box, Links for 126500LN');
  assert.equal(r.body.message, 'Received: Box, Links × 3');
  assert.equal((await ed.act('tx-settle', ids.t1, { itemId: 'all' })).status, 400, 'nothing pending');

  // Proof photos: the files route appends to the settlement's photos.
  const fd = new FormData();
  fd.append('files', new Blob([await picture(1)], { type: 'image/jpeg' }), 'proof.jpg');
  r = await ed.call('POST', `/api/logistics/items/${sId}/files?field=photos`, fd);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match((await item(sId)).data.photos[0], /^lgfile:\d+$/);

  r = await ed.act('tx-settle-undo', sId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await item(sId)).deleted_at, 'the settlement is gone (softly)');
  t = await item(ids.t1);
  assert.deepEqual(t.data.items.map((x) => [x.status, x.settlementId, x.settledBy]), [['pending', null, null], ['pending', null, null]]);
  assert.equal((await activity())[0], 'Undid settlement on 126500LN');
  assert.equal(r.body.open, `#/lg/${ids.t1}`);

  // One item alone.
  r = await ed.act('tx-settle', ids.t1, { itemId: 'i2' });
  assert.equal(r.status, 200);
  t = await item(ids.t1);
  assert.deepEqual(t.data.items.map((x) => x.status), ['pending', 'done']);
  assert.equal((await activity())[0], 'Received Links for 126500LN');
  ids.s2 = r.body.created[0];
});

test('swap-new / swap-delete: the app’s saveSwap — both items done with settledBy = the swap; deleting re-opens both; a swap is dropped with its transaction', async () => {
  const form = await ed.form('swap-new');
  assert.equal(form.status, 200);
  const give = form.body.form[0].options.find((o) => o.value === `${ids.t2}|i3`);
  const receive = form.body.form[1].options.find((o) => o.value === `${ids.t1}|i1`);
  assert.equal(give.label, 'Sina Star · 5711 · Strap');
  assert.equal(receive.label, 'Robin Casanova · 126500LN · Box');
  assert.ok(!form.body.form[1].options.some((o) => o.value === `${ids.t1}|i2`), 'a settled item is not offered');
  let r = await ed.act('swap-new', null, { give: give.value, receive: receive.value, notes: 'even' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const swId = r.body.created[0];
  const sw = await item(swId);
  assert.deepEqual([sw.data.giveTxId, sw.data.giveItemId, sw.data.receiveTxId, sw.data.receiveItemId, sw.data.notes], ['T2', 'i3', 'T1', 'i1', 'even']);
  assert.deepEqual((await item(ids.t2)).data.items[0] && [(await item(ids.t2)).data.items[0].status, (await item(ids.t2)).data.items[0].settledBy], ['done', sw.data.id]);
  assert.deepEqual([(await item(ids.t1)).data.items[0].status, (await item(ids.t1)).data.items[0].settledBy], ['done', sw.data.id]);
  assert.equal((await activity())[0], 'Swapped Strap (5711) ↔ Box (126500LN)');
  assert.equal((await ed.act('swap-new', null, { give: give.value, receive: receive.value })).status, 400, 'items no longer pending');

  r = await ed.act('swap-delete', swId);
  assert.equal(r.status, 200);
  assert.ok((await item(swId)).deleted_at);
  assert.deepEqual([(await item(ids.t2)).data.items[0].status, (await item(ids.t2)).data.items[0].settledBy], ['pending', null]);
  assert.deepEqual([(await item(ids.t1)).data.items[0].status, (await item(ids.t1)).data.items[0].settledBy], ['pending', null]);
  assert.equal((await activity())[0], 'Removed swap');

  r = await ed.act('swap-new', null, { give: give.value, receive: receive.value });
  const sw2 = r.body.created[0];
  r = await ed.act('tx-delete', ids.t2);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await item(ids.t2)).deleted_at && (await item(sw2)).deleted_at, 'the transaction and the swap naming it');
  assert.equal((await activity())[0], 'Deleted transaction 5711');
  assert.match(r.body.message, /1 swap/);
});

test('tx-edit: the typed fields, the items untouched, every changed field locked', async () => {
  const r = await ed.act('tx-edit', ids.t1, { type: 'bought', date: '2026-10-03', clientId: 'c-sina', stockNumber: '5101', brand: 'Rolex', reference: '126500LN-2', notes: 'moved' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = await item(ids.t1);
  assert.deepEqual([t.data.date, t.data.clientId, t.data.reference, t.data.notes, t.data.items.length], ['2026-10-03', 'c-sina', '126500LN-2', 'moved', 2]);
  assert.deepEqual([...t.locked_fields].sort(), ['clientId', 'date', 'items', 'notes', 'reference']);
  assert.equal((await activity())[0], 'Updated transaction 126500LN-2 · Rolex');
  assert.equal((await ed.act('tx-edit', ids.t1, { type: 'bought', clientId: 'c-sina', reference: 'x', brand: 'Nope' })).status, 400, 'a brand off the app’s list');
});

/* ── to collect / to give ── */

test('acc-collect-add / done: the entry as the app writes it, the client’s name AND id, the movement on the watch’s row; collected = received movement, accessoriesPresent grown, the entry gone', async () => {
  let r = await ed.act('acc-collect-add', null, { stockNumber: '5101', items: 'Box, Papers', fromClientId: 'c-robin', receivedFrom: 'his driver', notes: 'by Friday' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cId = r.body.created[0];
  const c = await item(cId);
  assert.deepEqual([c.data.stockNumber, c.data.items, c.data.fromClient, c.data.fromClientId, c.data.receivedFrom, c.data.notes, c.data.photos], ['5101', 'Box, Papers', 'Robin Casanova', 'c-robin', 'his driver', 'by Friday', []]);
  let d = await item(ids.d5101);
  assert.equal(d.data.movements.length, 1);
  const mv = d.data.movements[0];
  assert.deepEqual([mv.destination, mv.moveType, mv.notes, mv.date, mv.photos, mv.takenAccessories], ['Pending — Collect Accessories', 'accessories_pending_collect', 'To collect · Box, Papers · from Robin Casanova · by Friday', today(), [], []]);
  assert.ok(d.locked_fields.includes('movements'));
  assert.equal((await activity())[0], '📥 To collect for Stock #5101: Box, Papers from Robin Casanova');
  assert.match(r.body.message, /our watch #5101 · written on the watch’s history/);
  assert.equal((await ed.act('acc-collect-add', null, { stockNumber: '5101', items: '' })).status, 400);

  // An edit that changes the items writes "(updated)" history; one that does not, none.
  r = await ed.act('acc-collect-edit', cId, { stockNumber: '5101', items: 'Box', fromClientId: 'c-robin', receivedFrom: 'his driver', notes: 'by Friday' });
  assert.equal(r.status, 200);
  d = await item(ids.d5101);
  assert.equal(d.data.movements.length, 2);
  assert.equal(d.data.movements[0].notes, 'To collect (updated) · Box · from Robin Casanova · by Friday');
  r = await ed.act('acc-collect-edit', cId, { stockNumber: '5101', items: 'Box', fromClientId: 'c-robin', receivedFrom: 'Robin himself', notes: 'by Friday' });
  assert.equal((await item(ids.d5101)).data.movements.length, 2, 'no history line for the received-from alone');

  r = await ed.act('acc-collect-done', cId, { extra: 'all there' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  d = await item(ids.d5101);
  assert.deepEqual([d.data.movements[0].destination, d.data.movements[0].moveType, d.data.movements[0].notes], ['Accessories Received', 'accessories_received', 'Accessories received: Box from Robin himself · all there']);
  assert.equal(d.data.accessoriesPresent, 'Watch, Box');
  assert.ok((await item(cId)).deleted_at);
  assert.equal((await activity())[0], '📦 Accessories received for Stock #5101: Box from Robin himself');
  assert.equal(r.body.message, "Collected — logged to Stock #5101's history");
});

test('acc-give-add / done: inSafe stamped on the way in only; given = the movement, the items off accessoriesMissing (case-insensitive), the entry gone', async () => {
  let r = await ed.act('acc-give-add', null, { stockNumber: '5101', items: 'box, Spring bar', toClientId: 'c-sina', inSafe: 'true', notes: '' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const gId = r.body.created[0];
  let g = await item(gId);
  assert.deepEqual([g.data.toClient, g.data.toClientId, g.data.inSafe, g.data.items], ['Sina Star', 'c-sina', true, 'box, Spring bar']);
  assert.ok(typeof g.data.inSafeAt === 'number');
  const stamp = g.data.inSafeAt;
  assert.equal((await item(ids.d5101)).data.movements[0].moveType, 'accessories_pending_give');
  assert.equal((await activity())[0], '📤 To give for Stock #5101: box, Spring bar to Sina Star (in the safe)');

  r = await ed.act('acc-give-edit', gId, { stockNumber: '5101', items: 'box, Spring bar', toClientId: 'c-sina', inSafe: 'true', notes: 'n' });
  assert.equal((await item(gId)).data.inSafeAt, stamp, 'still in the safe: the day it went in stays');
  r = await ed.act('acc-give-edit', gId, { stockNumber: '5101', items: 'box, Spring bar', toClientId: 'c-sina', inSafe: 'false', notes: 'n' });
  assert.equal((await item(gId)).data.inSafeAt, null);

  r = await ed.act('acc-give-done', gId, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = await item(ids.d5101);
  assert.deepEqual([d.data.movements[0].destination, d.data.movements[0].moveType, d.data.movements[0].notes], ['Accessories Given to Client', 'accessories_given', 'Accessories given: box, Spring bar to Sina Star']);
  assert.equal(d.data.accessoriesMissing, '2 Links', 'Box given — gone from what is missing');
  assert.ok((await item(gId)).deleted_at);
  assert.equal((await activity())[0], '📤 Accessories given for Stock #5101: box, Spring bar to Sina Star');

  r = await ed.act('acc-give-add', null, { stockNumber: '5102', items: 'Tag' });
  const g2 = r.body.created[0];
  assert.equal((await ed.act('acc-give-delete', g2)).status, 200);
  assert.ok((await item(g2)).deleted_at);
});

test('acc-missing: the app’s checkbox grids — the brand’s list ticked from the row, links with a quantity, custom items; the row-update activity line', async () => {
  const form = await ed.form('acc-missing', ids.d5101);
  assert.equal(form.status, 200, JSON.stringify(form.body));
  const labels = form.body.form.map((f) => f.label);
  assert.deepEqual(labels.slice(0, 10), ['Watch', 'Warranty Card', 'Warranty Card Holder', 'Booklet', 'Manual', 'Box', 'Green Tag', 'White Tag', 'Strap', 'Links'], 'Rolex’s own list');
  assert.deepEqual(labels.slice(10), ['How many links', 'Other missing items']);
  const key = (label) => form.body.form[labels.indexOf(label)].key;
  assert.deepEqual(form.body.values, { linksQty: 2, [key('Links')]: true, custom: '' }, '"2 Links" ticks Links with 2');
  const r = await ed.act('acc-missing', ids.d5101, { [key('Box')]: 'true', [key('Links')]: 'true', linksQty: '3', custom: 'Spring bar, box' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = await item(ids.d5101);
  assert.equal(d.data.accessoriesMissing, 'Box, 3 Links, Spring bar');
  assert.ok(d.locked_fields.includes('accessoriesMissing'));
  assert.equal((await activity())[0], '🇦🇪 Dubai Stock 5101 updated · present: 2 · missing: 3');
  assert.equal(r.body.message, 'Missing: Box, Link × 3, Spring Bar');
  assert.equal((await ed.form('acc-missing', ids.t1)).status, 400, 'not on a transaction');
});

/* ── clients, companies ── */

test('cl-add / cl-company-location / cl-edit / cl-delete: as the app’s saveClient, addCompanyLocation and deleteClient (with the client’s transactions)', async () => {
  let r = await ed.act('cl-add', null, { name: 'Josh Lee', country: 'UK', phone: '+44 1', notes: 'n', isCompany: 'false' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cId = r.body.created[0];
  const c = await item(cId);
  assert.deepEqual([c.data.name, c.data.country, c.data.phone, c.data.notes, c.data.isCompany], ['Josh Lee', 'UK', '+44 1', 'n', false]);
  assert.ok(typeof c.data.createdAt === 'number' && typeof c.data.id === 'string');
  assert.equal((await activity())[0], 'Added client Josh Lee (UK)');
  assert.equal((await ed.act('cl-add', null, { name: 'x' })).status, 400, 'name and country required');
  r = await ed.act('cl-add', null, { name: 'ignored', country: 'Italy', isCompany: 'true' });
  assert.equal((await item(r.body.created[0])).data.name, 'Company', 'one of our places is filed as "Company"');
  assert.equal((await activity())[0], 'Added 🏢 Company · Italy');

  r = await ed.act('cl-company-location', null, { country: 'Spain' });
  assert.equal(r.status, 200);
  const loc = await item(r.body.created[0]);
  assert.deepEqual([loc.data.name, loc.data.country, loc.data.isCompany, loc.data.notes], ['Company', 'Spain', true, 'Company location · this represents us']);
  assert.equal((await activity())[0], 'Added Company location: Spain');
  assert.equal((await ed.act('cl-company-location', null, { country: 'spain' })).status, 400, 'already exists');

  r = await ed.act('cl-edit', ids.lgRobin, { name: 'Robin Casanova', country: 'Geneva', phone: '', notes: 'vip', isCompany: 'false' });
  assert.equal(r.status, 200);
  const rb = await item(ids.lgRobin);
  assert.equal(rb.data.country, 'Geneva');
  assert.deepEqual([...rb.locked_fields].sort(), ['country', 'isCompany', 'notes', 'phone']);
  assert.equal((await activity())[0], 'Updated client Robin Casanova');

  // Its transactions go with a client; one added here is named "ma-<row id>" by every record (shared.js CLIENT_ID).
  const tx = await ed.act('tx-new', null, { type: 'bought', clientId: `ma-${cId}`, reference: 'J1' });
  assert.equal(tx.status, 200, JSON.stringify(tx.body));
  r = await ed.act('cl-delete', cId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok((await item(cId)).deleted_at && (await item(tx.body.created[0])).deleted_at);
  assert.equal((await activity())[0], 'Deleted client Josh Lee');
  assert.match(r.body.message, /1 transaction/);
});

test('co-add / co-edit / co-delete: the app’s saveCompany and deleteCompany', async () => {
  let r = await ed.act('co-add', null, { name: 'Purosangue FZE', description: 'TRN 100\nBank X' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.created[0];
  const c = await item(id);
  assert.deepEqual([c.data.name, c.data.description], ['Purosangue FZE', 'TRN 100\nBank X']);
  assert.ok(typeof c.data.ts === 'number');
  assert.equal((await activity())[0], '🏢 Added company Purosangue FZE');
  assert.equal((await ed.act('co-add', null, { name: '' })).status, 400);
  r = await ed.act('co-edit', ids.co, { name: 'Estival Habitual LDA', description: 'TRN 1' });
  assert.equal(r.status, 200);
  assert.deepEqual([(await item(ids.co)).data.name, (await item(ids.co)).locked_fields], ['Estival Habitual LDA', ['name']]);
  assert.equal((await activity())[0], '🏢 Updated company Estival Habitual LDA');
  r = await ed.act('co-delete', id);
  assert.equal(r.status, 200);
  assert.ok((await item(id)).deleted_at);
  assert.equal((await activity())[0], '🏢 Deleted company Purosangue FZE');
});

/* ── shipment documents, receiving pictures ── */

test('doc-add: the app’s saveShipDoc — company and client by id with their names, a stock number in the system, the line; the file through the files route then doc-attach; doc-delete', async () => {
  const form = await ed.form('doc-add');
  assert.equal(form.status, 200, JSON.stringify(form.body));
  assert.deepEqual(form.body.form[0].options, [{ value: 'CO1', label: 'Estival Habitual LDA' }]);
  assert.deepEqual([form.body.values.docType, form.body.values.date], ['Invoice', today()]);
  assert.equal((await ed.act('doc-add', null, { companyId: 'CO1', clientId: 'c-robin', stockNumber: '7777', docType: 'Label' })).status, 400, 'a stock number not in the system');
  assert.equal((await ed.act('doc-add', null, { companyId: 'CO1', stockNumber: '5101' })).status, 400, 'enter the client');
  let r = await ed.act('doc-add', null, { companyId: 'CO1', clientId: 'c-robin', stockNumber: '5102', docType: 'Label', date: '2026-10-25', notes: 'DHL' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.created[0];
  const d = await item(id);
  assert.deepEqual(
    [d.data.companyId, d.data.companyName, d.data.clientId, d.data.clientName, d.data.stockNumber, d.data.docType, d.data.fileUrl, d.data.date, d.data.notes],
    ['CO1', 'Estival Habitual LDA', 'c-robin', 'Robin Casanova', '5102', 'Label', '', '2026-10-25', 'DHL']
  );
  assert.deepEqual(d.stock_nos, ['5102']);
  assert.equal((await activity())[0], '📄 Label added for Robin Casanova · stock 5102 · via Estival Habitual LDA');

  assert.equal((await ed.act('doc-attach', id, { ref: 'lgfile:1', name: 'x' })).status, 400, 'only a file added to the document');
  const fd = new FormData();
  fd.append('files', new Blob([await picture(2)], { type: 'image/jpeg' }), 'label.jpg');
  r = await ed.call('POST', `/api/logistics/items/${id}/files?field=files`, fd);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ref = r.body.files[0];
  r = await ed.act('doc-attach', id, { ref, name: 'label.jpg', type: 'image/jpeg' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([(await item(id)).data.fileUrl, (await item(id)).data.fileName, (await item(id)).data.fileType], [ref, 'label.jpg', 'image/jpeg']);
  const page = await ed.call('GET', '/api/logistics/page/shipmentdocs');
  assert.deepEqual([page.body.docs[0].file.kind, page.body.docs[0].watch.id, page.body.docs[0].company.name], ['copy', ids.w5102, 'Estival Habitual LDA']);

  r = await ed.act('doc-delete', id);
  assert.equal(r.status, 200);
  assert.ok((await item(id)).deleted_at);
  assert.equal((await activity())[0], '🗑️ Label deleted · stock 5102');
});

test('pic-add / pic-edit / pic-delete: the app’s saveOtherPics — a client by id or a name not in the list; pictures through the files route', async () => {
  assert.equal((await ed.act('pic-add', null, { notes: 'x' })).status, 400, 'a name is required');
  let r = await ed.act('pic-add', null, { clientId: 'c-sina', stockNumber: '5101', notes: 'passport' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.created[0];
  const e = await item(id);
  assert.deepEqual([e.data.clientName, e.data.clientId, e.data.stockNumber, e.data.notes, e.data.photos], ['Sina Star', 'c-sina', '5101', 'passport', []]);
  assert.ok(typeof e.data.createdAt === 'number');
  assert.deepEqual(e.stock_nos, ['5101']);
  const fd = new FormData();
  fd.append('files', new Blob([await picture(3)], { type: 'image/jpeg' }), 'p.jpg');
  r = await ed.call('POST', `/api/logistics/items/${id}/files?field=photos`, fd);
  assert.equal(r.status, 200);
  r = await ed.act('pic-edit', id, { clientNameOther: 'A walk-in', notes: 'passport, box' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([(await item(id)).data.clientName, (await item(id)).data.clientId, (await item(id)).data.photos.length], ['A walk-in', '', 1]);
  const page = await ed.call('GET', '/api/logistics/page/otherreceiving');
  assert.deepEqual([page.body.entries[0].client_name, page.body.entries[0].photos.length], ['A walk-in', 1]);
  r = await ed.act('pic-delete', id);
  assert.equal(r.status, 200);
  assert.ok((await item(id)).deleted_at);
});

/* ── watch vault activity ── */

test('va-approve / va-dismiss: the app’s approveVaultNotif applies the accessory lists (or prices) to the stock row and marks the notification; a handled one is refused', async () => {
  let r = await ed.act('va-approve', ids.n1);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = await item(ids.d5101);
  assert.deepEqual([d.data.accessoriesPresent, d.data.accessoriesMissing], ['Watch, Papers', 'Box']);
  assert.equal((await item(ids.n1)).data.status, 'approved');
  assert.ok((await item(ids.n1)).locked_fields.includes('status'));
  assert.equal((await activity())[0], '✏️ WatchVault accessory update approved — Rolex #5101');
  assert.equal((await ed.act('va-approve', ids.n1)).status, 400, 'already approved');

  r = await ed.act('va-dismiss', ids.n2);
  assert.equal(r.status, 200);
  assert.equal((await item(ids.n2)).data.status, 'dismissed');
  assert.equal((await item(ids.d5101)).data.b2bPrice, undefined, 'a dismissed price never reaches the row');
  assert.equal((await activity())[0], '🚫 WatchVault accessory update dismissed — Rolex #5101');
  const page = await ed.call('GET', '/api/logistics/page/vaultactivity');
  assert.equal(page.body.pending, 0);
});

test('va-holder: the vault’s saveTrackStatus — status, holder and the day on the tracking row; a location notification as the vault writes it; a client needs a name; "back" places clear the holder', async () => {
  assert.equal((await ed.act('va-holder', ids.track, { status: 'Out with Client', holder: '' })).status, 400, 'who has the watch?');
  assert.equal((await ed.act('va-holder', ids.track, { status: 'Somewhere', holder: 'x' })).status, 400);
  let r = await ed.act('va-holder', ids.track, { status: 'Out with Client', holder: 'Josh' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = await item(ids.track);
  assert.deepEqual([t.data.status, t.data.holder, t.data.updatedAt], ['Out with Client', 'Josh', today()]);
  assert.deepEqual([...t.locked_fields].sort(), ['holder', 'status', 'updatedAt']);
  const n = await item(r.body.created[0]);
  assert.equal(n.kind, 'vaultNotifications');
  assert.deepEqual([n.data.type, n.data.loc, n.data.watchId, n.data.stockNumber, n.data.brand, n.data.watchRef, n.data.from, n.data.to, n.data.status], ['location', 'dubai', 'D-5101', '5101', 'Rolex', '126500LN', 'In Office', 'Out with Client · Josh', 'approved']);
  assert.deepEqual(n.stock_nos, ['5101']);
  assert.equal((await activity())[0], '🔐 Vault: Stock #5101 In Office → Out with Client · Josh');
  const page = await ed.call('GET', '/api/logistics/page/vaultactivity');
  const h = page.body.holders.find((x) => x.id === ids.track);
  assert.deepEqual([h.status, h.holder, h.where, h.watch.id], ['Out with Client', 'Josh', 'client', ids.w5101]);
  assert.equal(page.body.notifications[0].words, 'Location: In Office → Out with Client · Josh');

  r = await ed.act('va-holder', ids.track, { status: 'In Home', holder: 'ignored' });
  assert.equal(r.status, 200);
  assert.deepEqual([(await item(ids.track)).data.status, (await item(ids.track)).data.holder], ['In Home', '']);
  assert.equal((await item(r.body.created[0])).data.from, 'Out with Client · Josh');
});

/* ── who may ── */

test('a viewer is refused (403), nobody signed in (401); the catalog carries every action', async () => {
  const viewer = client();
  assert.equal((await viewer.login('viewer@example.com', 'viewer-password-1')).status, 200);
  assert.equal((await viewer.act('tx-new', null, { type: 'bought', clientId: 'c-robin', reference: 'x' })).status, 403);
  assert.equal((await viewer.form('acc-missing', ids.d5101)).status, 403);
  assert.equal((await viewer.act('va-holder', ids.track, { status: 'In Office' })).status, 403);
  const anon = client();
  assert.equal((await anon.act('co-add', null, { name: 'x' })).status, 401);
  const meta = await ed.call('GET', '/api/meta');
  const keys = new Set((meta.body.logistics?.actions || []).map((a) => a.key));
  for (const k of ['tx-new', 'tx-settle', 'tx-settle-undo', 'swap-new', 'acc-collect-add', 'acc-give-done', 'acc-missing', 'cl-add', 'co-add', 'doc-add', 'doc-attach', 'pic-add', 'va-approve', 'va-holder']) assert.ok(keys.has(k), k);
  assert.equal((await ed.act('no-such', null, {})).status, 404);
});
