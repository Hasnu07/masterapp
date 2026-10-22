import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import sharp from 'sharp';

/*
 * The HTTP API: accounts and roles, editing, photos. Against a real Postgres
 * (TEST_DATABASE_URL) which is EMPTIED first.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let server, base, pool, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-api-'));
  Object.assign(process.env, {
    DATABASE_URL: DB,
    DATA_DIR: dataDir,
    ADMIN_EMAIL: 'boss@example.com',
    ADMIN_PASSWORD: 'admin-password-1',
    SYNC: 'off',
  });
  const reset = new pg.Client({ connectionString: DB });
  await reset.connect();
  await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await reset.end();
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/auth/index.js')).ensureFirstAdmin(() => {});
  pool = (await import('../src/db/index.js')).pool;
  const app = (await import('../src/web/server.js')).createServer();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const call = async (method, url, body, { csrf = true } = {}) => {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-Requested-With'] = 'masterapp';
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), type };
  };
  return { call, login: (email, password) => call('POST', '/api/login', { email, password }) };
}

const jpeg = (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();

let admin, editor, viewer, id;

test('accounts: sign-in, roles, and writes only from our own page', async () => {
  admin = client();
  assert.equal((await admin.login('boss@example.com', 'wrong-password')).status, 401);
  assert.equal((await admin.login('boss@example.com', 'admin-password-1')).status, 200);
  assert.equal((await admin.call('POST', '/api/users', { email: 'ed@example.com', role: 'editor', password: 'short' })).status, 400);
  assert.equal((await admin.call('POST', '/api/users', { email: 'ed@example.com', role: 'editor', password: 'editor-password' })).status, 201);
  assert.equal((await admin.call('POST', '/api/users', { email: 'vi@example.com', role: 'viewer', password: 'viewer-password' })).status, 201);
  editor = client();
  viewer = client();
  await editor.login('ed@example.com', 'editor-password');
  await viewer.login('vi@example.com', 'viewer-password');

  assert.equal((await client().call('GET', '/api/watches')).status, 401, 'signed out reads nothing');
  assert.equal((await viewer.call('POST', '/api/watches', { brand: 'Rolex' })).status, 403, 'a viewer cannot add');
  assert.equal((await editor.call('POST', '/api/watches', { brand: 'Rolex' }, { csrf: false })).status, 403, 'no header, no write');
  assert.equal((await editor.call('GET', '/api/users')).status, 403, 'only admins see accounts');
});

test('a watch is created, edited, deleted and restored, every step in its history', async () => {
  const r = await editor.call('POST', '/api/watches', {
    stock_no: '5000', brand: 'Patek Philippe', model: 'Aquanaut', reference: '5167A-001',
    purchase_price: '€55.000', purchase_currency: 'eur', purchase_payments: { bank: '55,000' }, status: 'in_stock', box: 'yes',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  id = r.body.id;
  const w = (await viewer.call('GET', `/api/watches/${id}`)).body;
  assert.equal(w.purchase_price, 55000, '"€55.000" is fifty-five thousand');
  assert.equal(w.purchase_currency, 'EUR');
  assert.deepEqual(w.purchase_payments, { bank: 55000 });
  assert.equal(w.box, true);
  assert.equal(w.display_title, 'Patek Philippe Aquanaut 5167A-001');

  assert.equal((await editor.call('POST', '/api/watches', { stock_no: '5000' })).status, 409, 'one stock number, one watch');
  assert.equal((await editor.call('PATCH', `/api/watches/${id}`, { purchase_date: '2026-02-31' })).status, 400, '31 Feb refused');
  assert.equal((await editor.call('PATCH', `/api/watches/${id}`, { sale_price: '310.92.44.50.06.001' })).status, 400, 'a reference is not a price');
  const e = await editor.call('PATCH', `/api/watches/${id}`, { dial: 'Blue', purchase_payments: { bank: 55000 } });
  assert.deepEqual(e.body.changed, ['dial'], 'an unchanged payment split is not a change');
  assert.equal((await editor.call('DELETE', `/api/watches/${id}`)).status, 200);
  assert.equal((await viewer.call('GET', '/api/watches?q=5000')).body.total, 0, 'deleted watches leave the list');
  assert.equal((await viewer.call('GET', '/api/watches?q=5000&deleted=1')).body.total, 1);
  assert.equal((await editor.call('POST', `/api/watches/${id}/restore`)).status, 200);
  const ev = (await viewer.call('GET', `/api/watches/${id}/events`)).body.events.map((x) => x.action);
  assert.deepEqual(ev, ['restore', 'delete', 'update', 'create']);
});

test('photos: upload, thumbnail, order, caption, remove — and only for the signed in', async () => {
  const fd = new FormData();
  fd.append('photos', new Blob([await jpeg(1600, 1200, '#a33')], { type: 'image/jpeg' }), 'a.jpg');
  fd.append('photos', new Blob([await jpeg(800, 800, '#3a3')], { type: 'image/jpeg' }), 'b.jpg');
  const up = await editor.call('POST', `/api/watches/${id}/photos`, fd);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const [p1, p2] = up.body.ids;

  const bad = new FormData();
  bad.append('photos', new Blob(['not a picture'], { type: 'image/jpeg' }), 'x.jpg');
  assert.equal((await editor.call('POST', `/api/watches/${id}/photos`, bad)).status, 415);

  const full = await viewer.call('GET', `/api/photos/${p1}`);
  assert.equal(full.type, 'image/jpeg');
  assert.equal((await sharp(full.body).metadata()).width, 1600, 'the original is kept as it came');
  const thumb = await viewer.call('GET', `/api/photos/${p1}?thumb=1`);
  assert.equal((await sharp(thumb.body).metadata()).width, 480, 'the grid gets a thumbnail');
  assert.equal((await client().call('GET', `/api/photos/${p1}`)).status, 401, 'photos are behind the sign-in');

  assert.equal((await editor.call('POST', `/api/watches/${id}/photos/order`, { ids: [p2] })).status, 400, 'every photo, once');
  assert.equal((await editor.call('POST', `/api/watches/${id}/photos/order`, { ids: [p2, p1] })).status, 200);
  await editor.call('PATCH', `/api/watches/${id}/photos/${p2}`, { caption: 'Dial' });
  let w = (await viewer.call('GET', `/api/watches/${id}`)).body;
  assert.deepEqual(w.photos.map((p) => p.id), [p2, p1]);
  assert.equal(w.photos[0].caption, 'Dial');
  const list = (await viewer.call('GET', '/api/watches?q=5000')).body.watches[0];
  assert.equal(list.photo_id, p2, 'the first photo is the one the grid shows');

  assert.equal((await viewer.call('DELETE', `/api/watches/${id}/photos/${p1}`)).status, 403);
  assert.equal((await editor.call('DELETE', `/api/watches/${id}/photos/${p1}`)).status, 200);
  w = (await viewer.call('GET', `/api/watches/${id}`)).body;
  assert.equal(w.photos.length, 1);
});

test('search: a bare number is a stock number, exactly', async () => {
  await editor.call('POST', '/api/watches', { stock_no: '500', brand: 'Rolex', reference: '126610LN' });
  const r = (await viewer.call('GET', '/api/watches?q=500')).body;
  assert.deepEqual(r.watches.map((w) => w.stock_no), ['500'], '"500" does not find 5000');
  assert.equal((await viewer.call('GET', '/api/watches?q=aquanaut%20blue')).body.total, 1, 'words narrow together');
  const f = (await viewer.call('GET', '/api/watches?brand=Rolex')).body.facets.brand;
  assert.ok(f.some((b) => b.k === 'Patek Philippe'), 'the brand counts ignore the brand filter itself');
});

test('an admin cannot lock themselves out', async () => {
  const me = (await admin.call('GET', '/api/me')).body.user;
  assert.equal((await admin.call('PATCH', `/api/users/${me.id}`, { role: 'viewer' })).status, 400);
  assert.equal((await admin.call('PATCH', `/api/users/${me.id}`, { disabled: true })).status, 400);
  const users = (await admin.call('GET', '/api/users')).body.users;
  const vi = users.find((u) => u.email === 'vi@example.com');
  assert.equal((await admin.call('PATCH', `/api/users/${vi.id}`, { disabled: true })).status, 200);
  assert.equal((await viewer.call('GET', '/api/watches')).status, 401, 'a disabled account is signed out at once');
});
