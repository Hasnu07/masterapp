import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import sharp from 'sharp';

/*
 * The HTTP API: accounts and roles, editing, photos. Against a real Postgres
 * (TEST_DATABASE_URL) which is EMPTIED first.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let server, base, pool, dataDir, rateSource, config;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-api-'));
  // Stand-ins for the two rate sources: the "live" one answers without AED.
  rateSource = http
    .createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          req.url === '/live'
            ? { data: { rates: { USD: '1', EUR: '0.86', GBP: '0.75' } } }
            : { result: 'success', rates: { USD: 1, EUR: 0.86, GBP: 0.75, AED: 3.6725, BTC: 'x' } }
        )
      );
    })
    .listen(0);
  const rateBase = `http://127.0.0.1:${rateSource.address().port}`;
  Object.assign(process.env, {
    RATES_LIVE_URL: `${rateBase}/live`,
    RATES_DAILY_URL: `${rateBase}/daily`,
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
  config = (await import('../src/config.js')).config;
  const app = (await import('../src/web/server.js')).createServer();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  rateSource.close();
  await pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* The tests run with SYNC=off; the import routes are tried with it on. */
async function syncOn(fn) {
  config.sync.enabled = true;
  try {
    return await fn();
  } finally {
    config.sync.enabled = false;
  }
}

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
  assert.equal((await editor.call('POST', `/api/watches/${id}/photos/order`, { ids: [p2, p2] })).status, 400, 'not one photo twice');
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

test('what a reference has sold for: newest first, the vault beside it, the ones in stock', async () => {
  const add = async (w) => (await editor.call('POST', '/api/watches', { brand: 'Rolex', reference: '278271', ...w })).body.id;
  const old = await add({ stock_no: '6001', status: 'sold', sale_date: '2026-05-09', sale_price: '22500', sale_price_eur: '19080' });
  const recent = await add({ stock_no: '6002', status: 'sold', sale_date: '2026-10-06', sale_price: '71000' });
  await add({ stock_no: '6003', status: 'sold', sale_date: '2026-10-07' });
  const shelf = await add({ stock_no: '6004', status: 'in_stock' });
  const gone = await add({ stock_no: '6005', status: 'in_stock' });
  await editor.call('DELETE', `/api/watches/${gone}`);
  await add({ stock_no: '6006', status: 'in_stock', reference: '126334' });
  await pool.query(
    `INSERT INTO vault_records(vault_id, list, stock_no, data, watch_id) VALUES
       ('v-6002', 'soldStocks', '6002', '{"soldPrice": 71000, "soldCurrency": "AED", "soldDate": "2026-10-06"}', $1),
       ('v-6001', 'soldStocks', '6001', '{"soldPrice": 1, "soldCurrency": "USD"}', $2)`,
    [recent, old]
  );

  const s = (await viewer.call('GET', `/api/watches/${shelf}/sold-for`)).body;
  assert.equal(s.reference, '278271');
  assert.deepEqual(s.sold.map((x) => x.stock_no), ['6002', '6001'], 'newest first; a sale with no figure is not listed');
  assert.equal(s.soldTotal, 3, 'but it is counted');
  assert.deepEqual(s.sold[0].vault, { price: 71000, currency: 'AED' });
  assert.equal(s.sold[1].eur, 19080);
  assert.equal(s.sold[1].vault, null, "the vault's 1 is a placeholder, not a sale");
  assert.deepEqual(s.inStock.map((x) => [x.stock_no, x.self]), [['6004', true]], 'deleted and other references left out');
});

test('clients: added, searched, tied to a watch, and the watch listed on the client', async () => {
  assert.equal((await viewer.call('POST', '/api/clients', { forename: 'Viewer' })).status, 403, 'editors add clients');
  assert.equal((await editor.call('POST', '/api/clients', { email: 'x@example.com' })).status, 400, 'a client needs a name');
  const c = await editor.call('POST', '/api/clients', { forename: 'Ahmed', surname: 'Khan', type: 'dealer', phone: '+92 300 1234567' });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  const found = (await viewer.call('GET', '/api/clients?q=khan')).body;
  assert.deepEqual(found.clients.map((x) => x.name), ['Ahmed Khan']);
  assert.equal((await viewer.call('GET', '/api/clients?q=3001234567')).body.total, 1, 'by phone digits');

  const w = (await editor.call('POST', '/api/watches', { stock_no: '7001', brand: 'Rolex', purchase_date: '2026-10-01' })).body.id;
  assert.equal((await viewer.call('PUT', `/api/watches/${w}/client`, { role: 'purchase', client_id: c.body.id })).status, 403);
  assert.equal((await editor.call('PUT', `/api/watches/${w}/client`, { role: 'purchase', client_id: c.body.id })).status, 200);
  assert.equal((await editor.call('PUT', `/api/watches/${w}/client`, { role: 'sale', client_id: 999999 })).status, 404);
  const page = (await viewer.call('GET', `/api/watches/${w}`)).body;
  assert.deepEqual(page.clients.purchase, { id: c.body.id, name: 'Ahmed Khan', locked: false }, 'a watch added here locks nothing');
  assert.equal(page.clients.sale.id, null);
  const client = (await viewer.call('GET', `/api/clients/${c.body.id}`)).body;
  assert.deepEqual(client.bought.map((x) => x.stock_no), ['7001']);
  assert.equal((await viewer.call('GET', '/api/clients?q=khan')).body.clients[0].bought, 1);

  assert.equal((await editor.call('PATCH', `/api/clients/${c.body.id}`, { type: 'wholesale' })).status, 400);
  assert.deepEqual((await editor.call('PATCH', `/api/clients/${c.body.id}`, { nickname: 'AK' })).body.changed, ['nickname']);
});

test('expenses: added with a payment copy, searched, totalled in euros, deleted', async () => {
  assert.equal((await viewer.call('POST', '/api/expenses', { title: 'x', amount: 1, currency: 'EUR' })).status, 403);
  assert.equal((await editor.call('POST', '/api/expenses', { title: 'Rent', amount: '5000' })).status, 400, 'a currency is said, never assumed');
  const rent = await editor.call('POST', '/api/expenses', {
    title: 'Dubai office rent | October', type: 'RENT', amount: '5,000', currency: 'aed', payment_method: 'bank', expense_date: '2026-10-01',
  });
  assert.equal(rent.status, 201, JSON.stringify(rent.body));
  const fuel = await editor.call('POST', '/api/expenses', { title: 'Petrol', type: 'Local Expense Petrol', amount: '80', currency: 'EUR', expense_date: '2026-10-02' });
  assert.equal((await viewer.call('GET', `/api/expenses/${fuel.body.id}`)).body.cost_eur, 80, 'an amount in euros is its own euro figure');

  const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n');
  const fd = new FormData();
  fd.append('files', new Blob([pdf], { type: 'application/pdf' }), 'transfer slip.pdf');
  fd.append('files', new Blob([await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } }).jpeg().toBuffer()]), 'receipt.jpg');
  const up = await editor.call('POST', `/api/expenses/${rent.body.id}/files`, fd);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const bad = new FormData();
  bad.append('files', new Blob([Buffer.from('MZ not a document')]), 'evil.exe');
  assert.equal((await editor.call('POST', `/api/expenses/${rent.body.id}/files`, bad)).status, 415);

  const e = (await viewer.call('GET', `/api/expenses/${rent.body.id}`)).body;
  assert.equal(e.currency, 'AED');
  assert.equal(e.amount, 5000);
  assert.equal(e.cost_eur, null, 'no euro figure is made up');
  assert.deepEqual(e.files.map((f) => [f.name, f.content_type]), [['transfer slip.pdf', 'application/pdf'], ['receipt.jpg', 'image/jpeg']]);
  const file = await viewer.call('GET', `/api/expense-files/${e.files[0].id}`);
  assert.equal(file.type, 'application/pdf');
  assert.ok(file.body.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.equal((await client().call('GET', `/api/expense-files/${e.files[0].id}`)).status, 401, 'behind the sign-in');

  const found = (await viewer.call('GET', '/api/expenses?q=rent')).body;
  assert.deepEqual(found.expenses.map((x) => x.title), ['Dubai office rent | October']);
  assert.equal(found.expenses[0].files, 2);
  assert.equal((await viewer.call('GET', '/api/expenses?q=5000')).body.total, 1, 'by its amount');
  const all = (await viewer.call('GET', '/api/expenses?from=2026-10-01&to=2026-10-31')).body;
  assert.equal(all.total, 2);
  assert.equal(all.sum_eur, 80);
  assert.equal(all.without_eur, 1, 'and says how many the total leaves out');
  assert.deepEqual((await viewer.call('GET', '/api/expenses/types')).body.types.sort(), ['Local Expense Petrol', 'RENT']);

  assert.equal((await editor.call('DELETE', `/api/expenses/${rent.body.id}/files/${e.files[1].id}`)).status, 200);
  assert.equal((await editor.call('DELETE', `/api/expenses/${fuel.body.id}`)).status, 200);
  assert.equal((await viewer.call('GET', '/api/expenses')).body.total, 1);
});

test('rates for the converter: a source without AED is refused, the daily one is used, and it says so', async () => {
  assert.equal((await client().call('GET', '/api/rates')).status, 401, 'signed in only');
  const r = (await viewer.call('GET', '/api/rates')).body;
  assert.equal(r.base, 'USD');
  assert.equal(r.kind, 'daily');
  assert.equal(r.rates.AED, 3.6725);
  assert.equal(r.rates.BTC, undefined, 'not a number, not passed on');
  assert.equal(r.stale, false);
  assert.ok(r.currencies.some((c) => c.code === 'HKD'));
});

test('what a request names that is not a field is refused, never taken for a column', async () => {
  const w = (await editor.call('POST', '/api/watches', { stock_no: '8001', brand: 'Rolex', toString: 'x', constructor: 'x' }));
  assert.equal(w.status, 201, 'unknown keys on a watch are dropped, as ids and timestamps are');
  assert.deepEqual((await editor.call('PATCH', `/api/watches/${w.body.id}`, { constructor: 'x' })).body, { changed: [] });
  assert.equal((await editor.call('POST', `/api/watches/${w.body.id}/unlock`, { field: 'constructor' })).status, 400);
  assert.equal((await editor.call('POST', '/api/clients', { forename: 'A', constructor: 'x' })).status, 400);
  assert.equal((await editor.call('PUT', `/api/watches/${w.body.id}/client`, { role: 'constructor', client_id: null })).status, 400);
  const x = await editor.call('POST', '/api/expenses', { title: 'T', amount: 1, currency: 'EUR' });
  assert.equal((await editor.call('PATCH', `/api/expenses/${x.body.id}`, { valueOf: 'x' })).status, 400);
  assert.equal(await syncOn(async () => (await admin.call('POST', '/api/import/run', { job: 'constructor' })).status), 400);
  const ids = async (sort) => {
    const r = await editor.call('GET', `/api/watches?sort=${sort}`);
    assert.equal(r.status, 200, `sort=${sort}`);
    return r.body.watches.map((x) => x.id);
  };
  assert.deepEqual(await ids('constructor'), await ids('newest'), 'a sort that is not one of ours is the newest first');
});

test('too many files, or a mangled cookie, is a refusal — not a server error', async () => {
  const x = await editor.call('POST', '/api/expenses', { title: 'Receipts', amount: 1, currency: 'EUR' });
  const fd = new FormData();
  const pic = await jpeg(20, 20, '#33a');
  for (let i = 0; i < 11; i += 1) fd.append('files', new Blob([pic], { type: 'image/jpeg' }), `r${i}.jpg`);
  const r = await editor.call('POST', `/api/expenses/${x.body.id}/files`, fd);
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'Too many files at once');

  const res = await fetch(`${base}/api/me`, { headers: { Cookie: 'ma_session=%E0%A4%A' } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { user: null }, 'no session, and the page still loads');
});

const csv = () => {
  const fd = new FormData();
  fd.append('file', new Blob(['Stock No,Brand\n9001,Rolex\n'], { type: 'text/csv' }), 'ProductList.csv');
  return fd;
};

test('a CSV upload waits its turn: refused while another import holds the lock', () => syncOn(async () => {
  const other = await pool.connect(); // another process (the CLI, a second container) mid-import
  await other.query('SELECT pg_advisory_lock(727002)');
  try {
    const r = await admin.call('POST', '/api/import/csv', csv());
    assert.equal(r.status, 409, JSON.stringify(r.body));
  } finally {
    await other.query('SELECT pg_advisory_unlock(727002)');
    other.release();
  }
  assert.equal((await admin.call('POST', '/api/import/csv', csv())).status, 200, 'and goes ahead once it is free');
}));

test('with sync off, the Import page copies nothing either', async () => {
  const run = await admin.call('POST', '/api/import/run', { job: 'chronokey-list' });
  assert.equal(run.status, 409);
  assert.match(run.body.error, /SYNC=off/);
  assert.equal((await admin.call('POST', '/api/import/csv', csv())).status, 409);
  assert.equal((await admin.call('GET', '/api/import/status')).body.configured.sync, false, 'and the page is told, to say so');
});

test('the page carries its script policy; the API and the files it serves do not', async () => {
  const page = await fetch(`${base}/`);
  const csp = page.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src 'self'(;|$)/, 'no inline script runs, whatever gets into the page');
  assert.match(csp, /object-src 'none'/);
  assert.match((await fetch(`${base}/index.html`)).headers.get('content-security-policy') || '', /script-src 'self'/, 'by its own name too');
  assert.equal((await fetch(`${base}/api/me`)).headers.get('content-security-policy'), null);
  assert.equal(page.headers.get('strict-transport-security'), null, 'https is only promised in production');
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

/* As on App Platform, where the person's address is in do-connecting-ip. */
async function inProduction(fn) {
  config.production = true;
  try {
    return await fn();
  } finally {
    config.production = false;
  }
}
const from = (address, email, password) =>
  fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'masterapp', 'do-connecting-ip': address },
    body: JSON.stringify({ email, password }),
  }).then((r) => r.status);

test('failed sign-ins count per person and per account — not for everybody behind the same proxy', () => inProduction(async () => {
  for (let i = 0; i < 10; i += 1) assert.equal(await from('203.0.113.1', 'ed@example.com', 'wrong-password'), 401);
  assert.equal(await from('203.0.113.1', 'boss@example.com', 'admin-password-1'), 429, 'that address waits');
  assert.equal(await from('203.0.113.2', 'ed@example.com', 'editor-password'), 200, 'the owner of that account still signs in, from their own');
  // That account is failing from everywhere: each other address gets three tries at it, not ten.
  for (let i = 0; i < 3; i += 1) assert.equal(await from('203.0.113.4', 'ed@example.com', 'wrong-password'), 401);
  assert.equal(await from('203.0.113.4', 'ed@example.com', 'editor-password'), 429, 'three, from there');
  assert.equal(await from('203.0.113.4', 'boss@example.com', 'admin-password-1'), 200, 'another account from there is not held up');
  assert.equal(await from('203.0.113.3', 'boss@example.com', 'admin-password-1'), 200, 'everybody else signs in');
}));

test('sign-ins sent all at once get no more tries than one after another', () => inProduction(async () => {
  const sent = await Promise.all(Array.from({ length: 30 }, () => from('198.51.100.7', 'nobody@example.com', 'wrong-password')));
  assert.equal(sent.filter((s) => s === 401).length, 10, 'ten passwords checked');
  assert.equal(sent.filter((s) => s === 429).length, 20, 'the rest refused before any was checked');
}));

test('the sign-in limit holds no long keys, and only so many', () => inProduction(async () => {
  const { reserveAttempt, attemptKeys } = await import('../src/web/server.js');
  assert.equal(await from('198.51.100.8', `${'x'.repeat(500_000)}@example.com`, 'wrong-password'), 401);
  assert.ok(attemptKeys().every((k) => k.length < 50), 'an email is held as a short hash, however long');
  for (let i = 0; i < 12_000; i += 1) reserveAttempt(`198.18.${i >> 8}.${i & 255}`, 'flood@example.com');
  assert.ok(attemptKeys().length <= 20_000, `bounded: ${attemptKeys().length} keys`);
}));
