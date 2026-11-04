import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import sharp from 'sharp';

/*
 * The accounts app inside the ERP: its page and script served at /acc-app/
 * from a stand-in Railway, rewritten and behind the sign-in; its API passed on
 * with the person's accounts cookie; the copy of its state into accounts_items
 * (signed in as the ERP) and the rules it keeps; which of our clients its
 * clients are; what the watch page's Accounts window is told. Against a real
 * Postgres (TEST_DATABASE_URL), EMPTIED.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let server, base, pool, dataDir, railway, railwayBase, accapp, sync, db;
const hits = [];
const sessions = new Set();
let state;
let revs = { entries: 3, clients: 2, currencies: 1 };

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>Purosangue Watches — Accounts</title>
    <script>(function(){try{document.documentElement.setAttribute('data-theme','dark')}catch(e){}})();</script>
    <script type="module" crossorigin src="/assets/index-Dlk5CG7T.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-DJTJe81U.css">
  </head>
  <body><div id="root"></div></body>
</html>`;
const SCRIPT = 'const api=e({baseURL:`/api`,withCredentials:!0});await fetch(`/api/upload`+r,{method:`POST`});n.src=`https://maps.googleapis.com/maps/api/js?key=${k}`;fetch("/api/state/x/merge");';

async function fixture() {
  const inline = (await sharp({ create: { width: 40, height: 30, channels: 3, background: '#3a3' } }).jpeg().toBuffer()).toString('base64');
  return {
    clients: [
      { id: 'CL-001', name: 'Dealer One', company: '', emails: ['d1@example.com'] },
      { id: 'CL-002', name: 'Omar F' },
      { id: 'CL-003', name: 'Sam Twice' },
    ],
    entries: [
      { id: 'e1', type: 'PAYABLE', clientId: 'CL-001', stock: '1668', model: 'ROLEX LADY-DATEJUST', amount: 46000, ccy: 'AED', date: '2026-09-05', payments: [{ id: 'p1', date: '2026-09-06', amount: 46000, method: 'Cash' }], _createdByName: 'Kashan' },
      { id: 'e2', type: 'RECEIVABLE', clientId: 'CL-002', stock: '1668', amount: 14000, ccy: 'USD', date: '2026-09-25', invoiceNo: 'INV-001', payments: [{ id: 'p2', date: '2026-09-26', amount: 10000, applied: 10000, method: 'Crypto', _walletAccId: 'w1', proofs: [{ id: 'pr1', name: 'receipt.pdf', type: 'application/pdf', url: '/uploads/CL-002/receipt.pdf' }] }], invoiceProof: { dataUrl: `data:image/jpeg;base64,${inline}` }, apiKey: 'should-not-be-kept' },
      { id: 'e3', type: 'PAYABLE', clientId: 'CL-001', stock: '1700', amount: 98000, ccy: 'EUR', date: '2026-10-01', payments: [] },
      { id: 'e4', type: 'RECEIVABLE', clientId: 'CL-003', stock: '', amount: 5, ccy: 'USD', date: '2026-10-02', _cancelled: true },
    ],
    invoices: [{ id: 'i1', invoiceNo: 'inv-001', clientId: 'CL-002', date: '2026-09-25', status: 'Sent', items: [{ id: 'it1', desc: '1668 · Rolex', qty: 1, unitPrice: 14000 }] }],
    quickSales: [{ id: 'q1', item: 'Strap', stock: '1701', saleAmount: 300, ccy: 'AED', date: '2026-10-11' }],
    expenses: [{ id: 'x1', title: 'Commission', description: '1668 | Partner | Commission', amount: 500, ccy: 'USD', date: '2026-10-03' }],
    commissionSettlements: [{ id: 's1', employee: 'Kashan', date: '2026-10-30', lines: [{ stock: '1668', commission: 200, role: 'sold' }, { stock: '1700', commission: 50 }] }],
    accounts: [{ id: 'w1', name: 'WISE (USD)', company: 'PUROSANGUE WATCHES LTD', bankName: 'WISE', ccy: 'USD', kind: 'bank' }],
    currencies: [{ code: 'USD', name: 'US Dollar' }, { code: 'AED', name: 'Dirham' }],
    employeeCodes: { kashan: 'EMP-001' },
    expenseCategories: ['Travel', 'Office'],
    exchangeRates: { USD: 1, AED: 0.27 },
    driverTxns: Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, amount: i })),
  };
}

before(async () => {
  state = await fixture();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-accapp-'));
  railway = http
    .createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      hits.push(`${req.method} ${url.pathname}`);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const cookie = req.headers.cookie || '';
        const signedIn = [...sessions].some((s) => cookie.includes(`connect.sid=${s}`));
        const json = (code, obj) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(obj));
        };
        if (url.pathname === '/api/auth/login' && req.method === 'POST') {
          const b = JSON.parse(body.toString() || '{}');
          if (b.username === 'erp@example.com' && b.password === 'erp-password-1') {
            const sid = `s${sessions.size + 1}`;
            sessions.add(sid);
            res.setHeader('Set-Cookie', `connect.sid=${sid}; Path=/; Expires=Wed, 04 Dec 2026 08:00:00 GMT; HttpOnly; Secure; SameSite=Lax`);
            return json(200, { username: b.username, isAdmin: false });
          }
          return json(401, { error: 'Invalid email or password' });
        }
        if (url.pathname === '/api/auth/me') return signedIn ? json(200, { username: 'erp@example.com' }) : json(401, { error: 'Not authenticated' });
        if (url.pathname === '/api/echo') return json(200, { method: req.method, query: url.search, type: req.headers['content-type'] || '', cookie, bytes: body.length });
        if (url.pathname === '/api/state/revs') return signedIn ? json(200, revs) : json(401, { error: 'Not authenticated' });
        if (url.pathname === '/api/state') {
          if (!signedIn) return json(401, { error: 'Not authenticated' });
          const only = url.searchParams.get('only');
          if (!only) return json(200, state);
          return json(200, Object.fromEntries(only.split(',').filter((k) => k in state).map((k) => [k, state[k]])));
        }
        if (url.pathname.startsWith('/uploads/')) {
          if (!signedIn && url.pathname !== '/uploads/public.png') {
            res.statusCode = 403;
            return res.end('no');
          }
          res.setHeader('Content-Type', 'image/png');
          return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        }
        if (url.pathname === '/assets/index-Dlk5CG7T.js') {
          res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          res.setHeader('ETag', '"js1"');
          return res.end(SCRIPT);
        }
        if (url.pathname === '/assets/index-DJTJe81U.css') {
          res.setHeader('Content-Type', 'text/css; charset=utf-8');
          return res.end('body{color:#fff}');
        }
        if (url.pathname.startsWith('/api/')) return json(404, { error: 'no' });
        // Any other address is the page (the app's router owns them), as Railway serves it.
        res.setHeader('ETag', '"v1"');
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(PAGE);
      });
    })
    .listen(0);
  railwayBase = `http://127.0.0.1:${railway.address().port}`;
  Object.assign(process.env, {
    DATABASE_URL: DB,
    DATA_DIR: dataDir,
    ADMIN_EMAIL: 'boss@example.com',
    ADMIN_PASSWORD: 'admin-password-1',
    SYNC: 'off',
    LOGISTICS_APP_URL: 'off',
    ACCOUNTS_APP_URL: railwayBase,
    ACCOUNTS_USERNAME: 'erp@example.com',
    ACCOUNTS_PASSWORD: 'erp-password-1',
  });
  const reset = new pg.Client({ connectionString: DB });
  await reset.connect();
  await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await reset.end();
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/auth/index.js')).ensureFirstAdmin(() => {});
  db = await import('../src/db/index.js');
  pool = db.pool;
  accapp = await import('../src/web/accapp.js');
  sync = await import('../src/import/accounts/sync.js');
  const app = (await import('../src/web/server.js')).createServer();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  railway.close();
  await pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function client() {
  const jar = new Map();
  const call = async (method, url, body, { headers: extra = {}, raw = false } = {}) => {
    const headers = { 'X-Requested-With': 'masterapp', ...extra };
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (raw) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [k, v] = c.split(';')[0].split('=');
      jar.set(k, v);
    }
    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    return { status: res.status, text, body: type.includes('json') ? JSON.parse(text || 'null') : text, type, headers: res.headers, setCookies: res.headers.getSetCookie() };
  };
  return { call, jar, login: (email, password) => call('POST', '/api/login', { email, password }) };
}

let admin, editor, viewer;

test('the app is served at /acc-app/ to editors only, its page and script rewritten for the ERP', async () => {
  admin = client();
  assert.equal((await admin.login('boss@example.com', 'admin-password-1')).status, 200);
  assert.equal((await admin.call('POST', '/api/users', { email: 'ed@example.com', role: 'editor', password: 'editor-password' })).status, 201);
  assert.equal((await admin.call('POST', '/api/users', { email: 'vi@example.com', role: 'viewer', password: 'viewer-password' })).status, 201);
  editor = client();
  viewer = client();
  await editor.login('ed@example.com', 'editor-password');
  await viewer.login('vi@example.com', 'viewer-password');

  assert.equal((await client().call('GET', '/acc-app/')).status, 401, 'signed out: nothing');
  assert.equal((await viewer.call('GET', '/acc-app/')).status, 403, 'a viewer cannot load it — the app writes');
  assert.equal(hits.filter((h) => h === 'GET /').length, 0, 'Railway was not asked for either');
  assert.equal((await admin.call('GET', '/acc-app')).status, 302, '/acc-app goes to /acc-app/');

  const page = await editor.call('GET', '/acc-app/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline' https:\/\/maps\.googleapis\.com/);
  assert.match(page.text, /<head>\n<script src="\/accapp-bridge\.js"><\/script>/, 'the bridge first in <head>');
  assert.match(page.text, /src="\/acc-app\/assets\/index-Dlk5CG7T\.js"/, 'its script under /acc-app/');
  assert.match(page.text, /href="\/acc-app\/assets\/index-DJTJe81U\.css"/);
  assert.match(page.text, /href="\/acc-app\/favicon\.svg"/);
  assert.match(page.text, /data-theme/, 'its own inline script stays');

  // The app's router's addresses are all the page.
  const deep = await editor.call('GET', '/acc-app/clients/CL-001');
  assert.equal(deep.status, 200);
  assert.match(deep.text, /accapp-bridge/);
  assert.equal(hits.filter((h) => h === 'GET /').length, 1, 'held: one fetch for both');

  const js = await editor.call('GET', '/acc-app/assets/index-Dlk5CG7T.js');
  assert.equal(js.status, 200);
  assert.match(js.type, /javascript/);
  assert.equal(js.text, 'const api=e({baseURL:`/acc-app/api`,withCredentials:!0});await fetch(`/acc-app/api/upload`+r,{method:`POST`});n.src=`https://maps.googleapis.com/maps/api/js?key=${k}`;fetch("/acc-app/api/state/x/merge");');
  assert.equal(js.headers.get('cache-control'), 'private, max-age=86400', 'a fingerprinted file is kept a day');
  assert.equal((await editor.call('GET', '/acc-app/assets/index-DJTJe81U.css')).text, 'body{color:#fff}');

  const bridge = await editor.call('GET', '/accapp-bridge.js');
  assert.equal(bridge.status, 200);
  assert.match(bridge.text, /acc-app\/links/);
});

test('a frame asking the ERP for one of the app’s routes gets the app’s page, never the console', async () => {
  const framed = await editor.call('GET', '/clients/CL-001', undefined, { headers: { 'Sec-Fetch-Dest': 'iframe' } });
  assert.equal(framed.status, 200);
  assert.match(framed.text, /accapp-bridge/);
  const plain = await editor.call('GET', '/clients/CL-001');
  assert.doesNotMatch(plain.text, /accapp-bridge/, 'the same address from the browser itself is not the app');
  assert.equal((await client().call('GET', '/clients', undefined, { headers: { 'Sec-Fetch-Dest': 'iframe' } })).status, 401);
  assert.equal((await editor.call('GET', '/api/me', undefined, { headers: { 'Sec-Fetch-Dest': 'iframe' } })).body.user.email, 'ed@example.com', 'the API is never the app');
});

test('the app’s API is passed on with the person’s accounts cookie — and its cookie comes back for this origin, never the ERP’s own', async () => {
  const origin = { Origin: base };
  // Sign in to the accounts app, through the ERP: its Set-Cookie comes back rewritten.
  const bad = await editor.call('POST', '/acc-app/api/auth/login', { username: 'erp@example.com', password: 'wrong' }, { headers: origin });
  assert.equal(bad.status, 401);
  const ok = await editor.call('POST', '/acc-app/api/auth/login', { username: 'erp@example.com', password: 'erp-password-1' }, { headers: origin });
  assert.equal(ok.status, 200);
  assert.equal(ok.setCookies.length, 1);
  assert.match(ok.setCookies[0], /^connect\.sid=s\d+; Expires=[^;]+; HttpOnly; SameSite=Lax; Path=\/$/, 'no Domain, for the whole site, Secure only in production');
  assert.ok(editor.jar.has('connect.sid') && editor.jar.has('ma_session'));

  // From then on the accounts cookie goes with every call — the ERP's never.
  const echo = await editor.call('GET', '/acc-app/api/echo?a=1');
  assert.equal(echo.status, 200);
  assert.equal(echo.body.query, '?a=1');
  assert.match(echo.body.cookie, /^connect\.sid=s\d+$/);
  assert.equal((await editor.call('GET', '/acc-app/api/auth/me')).body.username, 'erp@example.com');

  const big = Buffer.alloc(2 * 1024 * 1024, 'x');
  const r = await editor.call('POST', '/acc-app/api/echo?n=5', big, { raw: true, headers: { ...origin, 'Content-Type': 'application/octet-stream' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.bytes, big.length, 'over the ERP’s own 1 MB JSON limit: passed on whole');
  assert.equal(r.body.type, 'application/octet-stream');

  assert.equal((await editor.call('POST', '/acc-app/api/echo', { a: 1 })).status, 403, 'a write with no origin of ours is refused');
  assert.equal((await editor.call('POST', '/acc-app/api/echo', { a: 1 }, { headers: { Origin: 'https://elsewhere.example' } })).status, 403);
  assert.equal((await viewer.call('GET', '/acc-app/api/echo')).status, 403, 'a viewer: refused');
  assert.equal((await client().call('GET', '/acc-app/api/echo')).status, 401);
  assert.equal((await editor.call('GET', '/acc-app/api/not-there')).status, 404, "Railway's answer, as it is");

  // Its uploads, by either address, with the cookie.
  for (const u of ['/acc-app/uploads/CL-001/proof.png', '/uploads/CL-001/proof.png']) {
    const f = await editor.call('GET', u);
    assert.equal(f.status, 200, u);
    assert.match(f.type, /image\/png/);
    assert.equal(f.headers.get('cache-control'), 'private, max-age=86400');
  }
  // A viewer has no accounts session: the file comes through the ERP's own (it signs in for it), as on the watch page.
  const logins = hits.filter((h) => h === 'POST /api/auth/login').length;
  const asViewer = await viewer.call('GET', '/uploads/CL-001/proof.png');
  assert.equal(asViewer.status, 200);
  assert.match(asViewer.type, /image\/png/);
  assert.equal(hits.filter((h) => h === 'POST /api/auth/login').length, logins + 1, 'the ERP signed in once for it');
  assert.equal((await viewer.call('GET', '/acc-app/uploads/CL-001/proof.png')).status, 200, 'and again without a second sign-in');
  assert.equal(hits.filter((h) => h === 'POST /api/auth/login').length, logins + 1);
  assert.equal((await client().call('GET', '/uploads/public.png')).status, 401, 'nothing of the app’s without the ERP’s sign-in');
});

test('the copy: every collection, signed in as the ERP; records by id or code, the rest whole; stock numbers and clients read off each record', async () => {
  const signIns = () => hits.filter((h) => h === 'POST /api/auth/login').length;
  const before = signIns();
  const st = await sync.syncAccounts();
  assert.ok(signIns() <= before + 1, 'signed in at most once (an earlier file fetch may have signed the ERP in already)');
  assert.equal(st.failed, 0, JSON.stringify(st.failures));
  assert.equal(st.kinds, 12);
  // 3 clients + 4 entries + 1 invoice + 1 quick sale + 1 expense + 1 settlement + 1 wallet + 2 currencies + 20 driver txns + 3 whole collections
  assert.equal(st.created, 37);
  assert.equal(st.files, 1, 'the inline invoice picture became a file');

  const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
  const kinds = Object.fromEntries((await q('SELECT kind, count(*)::int AS n FROM accounts_items GROUP BY kind')).map((r) => [r.kind, r.n]));
  assert.deepEqual(kinds, { clients: 3, entries: 4, invoices: 1, quickSales: 1, expenses: 1, commissionSettlements: 1, accounts: 1, currencies: 2, driverTxns: 20, employeeCodes: 1, expenseCategories: 1, exchangeRates: 1 });
  const whole = await q("SELECT kind, source_id, data FROM accounts_items WHERE source_id = '*' ORDER BY kind");
  assert.deepEqual(whole.map((r) => [r.kind, r.source_id]), [['employeeCodes', '*'], ['exchangeRates', '*'], ['expenseCategories', '*']]);
  assert.deepEqual(whole.find((r) => r.kind === 'expenseCategories').data, { value: ['Travel', 'Office'] });
  assert.deepEqual((await q("SELECT source_id FROM accounts_items WHERE kind = 'currencies' ORDER BY source_id")).map((r) => r.source_id), ['AED', 'USD'], 'currencies by their code');

  const e2 = (await q("SELECT * FROM accounts_items WHERE kind = 'entries' AND source_id = 'e2'"))[0];
  assert.deepEqual(e2.stock_nos, ['1668']);
  assert.deepEqual(e2.client_ids, ['CL-002']);
  assert.equal(e2.origin, 'accounts');
  assert.match(e2.data.invoiceProof.dataUrl, /^acfile:\d+$/);
  assert.equal(e2.data.apiKey, undefined, 'a key is never kept');
  assert.equal(new Date(e2.happened_at).toISOString(), '2026-09-25T00:00:00.000Z');
  const raw = (await q("SELECT data FROM accounts_records WHERE kind = 'entries' AND source_id = 'e2'"))[0].data;
  assert.match(raw.invoiceProof.dataUrl, /^acfile:/, 'the raw record keeps the file reference too, not the bytes');
  assert.deepEqual((await q("SELECT stock_nos FROM accounts_items WHERE kind = 'expenses' AND source_id = 'x1'"))[0].stock_nos, ['1668'], 'the expense’s "1668 | Partner | Commission"');
  assert.deepEqual((await q("SELECT stock_nos FROM accounts_items WHERE kind = 'commissionSettlements' AND source_id = 's1'"))[0].stock_nos, ['1668', '1700'], 'a settlement’s lines');
  assert.deepEqual((await q("SELECT stock_nos FROM accounts_items WHERE kind = 'entries' AND source_id = 'e4'"))[0].stock_nos, []);
  assert.equal((await q("SELECT count(*)::int AS n FROM import_runs WHERE source = 'accounts' AND mode = 'full' AND ok"))[0].n, 1);
});

test('unchanged: nothing written, no run kept; a dead session is renewed once', async () => {
  const st = await sync.syncAccounts();
  assert.deepEqual([st.created, st.updated, st.unchanged, st.gone], [0, 0, 37, 0]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM import_runs WHERE source = 'accounts'")).rows[0].n, 1);
  sessions.clear(); // the app forgot the ERP's session
  const before = hits.filter((h) => h === 'POST /api/auth/login').length;
  const again = await sync.syncAccounts();
  assert.equal(again.unchanged, 37);
  assert.equal(hits.filter((h) => h === 'POST /api/auth/login').length, before + 1);
});

test('a change is applied — except a field locked here; a dropped record is deleted softly and comes back; a broken read is refused', async () => {
  const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);
  // A person edited the note of e1 here: the app's later note never overwrites it.
  await pool.query("UPDATE accounts_items SET locked_fields = ARRAY['note'], data = data || '{\"note\":\"ours\"}' WHERE kind = 'entries' AND source_id = 'e1'");
  state.entries[0] = { ...state.entries[0], note: 'theirs', amount: 46500 };
  state.quickSales = []; // one record of one dropped
  let st = await sync.syncAccounts({ only: ['entries', 'quickSales'] });
  assert.equal(st.updated, 1);
  assert.equal(st.gone, 1);
  const e1 = (await q("SELECT data FROM accounts_items WHERE kind = 'entries' AND source_id = 'e1'"))[0].data;
  assert.equal(e1.amount, 46500);
  assert.equal(e1.note, 'ours');
  const ev = (await q("SELECT changes FROM accounts_events e JOIN accounts_items i ON i.id = e.item_id WHERE i.source_id = 'e1' AND e.action = 'sync'"))[0].changes;
  assert.deepEqual(ev, { amount: [46000, 46500] });
  const q1 = (await q("SELECT deleted_at, source_gone_at FROM accounts_items WHERE kind = 'quickSales' AND source_id = 'q1'"))[0];
  assert.ok(q1.deleted_at && +q1.deleted_at === +q1.source_gone_at);

  state.quickSales = [(await fixture()).quickSales[0]];
  st = await sync.syncAccounts({ only: ['quickSales'] });
  assert.equal(st.restored, 1);
  assert.equal((await q("SELECT deleted_at FROM accounts_items WHERE kind = 'quickSales' AND source_id = 'q1'"))[0].deleted_at, null);

  // 20 driver transactions, 18 missing from one read: not a clear-out.
  const all = state.driverTxns;
  state.driverTxns = all.slice(0, 2);
  st = await sync.syncAccounts({ only: ['driverTxns'] });
  assert.equal(st.gone, 0);
  assert.deepEqual(st.refused, { driverTxns: 18 });
  assert.equal((await q("SELECT count(*)::int AS n FROM accounts_items WHERE kind = 'driverTxns' AND deleted_at IS NULL"))[0].n, 20);
  state.driverTxns = all;

  // An answer without the ledger is not an empty app.
  await assert.rejects(sync.syncAccounts({ state: { foo: [] } }), /without its ledger/);
  assert.equal((await q("SELECT count(*)::int AS n FROM accounts_items WHERE deleted_at IS NULL"))[0].n, 37);
});

test('which of our clients the app’s clients are: by the watches on their ledger, else a full name — and what the watch page is told', async () => {
  const mk = async (body) => {
    const r = await editor.call('POST', '/api/watches', body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const w1668 = await mk({ brand: 'Rolex', model: 'Lady-Datejust', reference: '278274', serial: 'S1668', stock_no: '1668' });
  const w1700 = await mk({ brand: 'Patek Philippe', model: 'Nautilus', stock_no: '1700' });
  await mk({ brand: 'Rolex', model: 'Daytona', stock_no: '1701' });
  const dealer = (await editor.call('POST', '/api/clients', { forename: 'Dealer', surname: 'One', type: 'dealer' })).body;
  const omar = (await editor.call('POST', '/api/clients', { forename: 'Omar', surname: 'F', type: 'retail' })).body;
  for (let i = 0; i < 2; i++) assert.equal((await editor.call('POST', '/api/clients', { forename: 'Sam', surname: 'Twice', type: 'retail' })).status, 201);
  for (const [w, role, c] of [[w1668, 'purchase', dealer], [w1668, 'sale', omar], [w1700, 'purchase', dealer]]) {
    const r = await editor.call('PUT', `/api/watches/${w.id}/client`, { role, client_id: c.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }

  const links = await editor.call('POST', '/api/acc-app/links', { stock: ['1668', '1700', '9999', '2026'], clients: ['Dealer One', 'Omar F', 'Sam Twice', 'Nobody', 'omar  f'] });
  assert.equal(links.status, 200);
  assert.deepEqual(Object.keys(links.body.watches).sort(), ['1668', '1700']);
  assert.equal(links.body.watches['1668'].id, w1668.id);
  assert.deepEqual(links.body.clients, {
    'Dealer One': { id: dealer.id, name: 'Dealer One' },
    'Omar F': { id: omar.id, name: 'Omar F' },
    'omar  f': { id: omar.id, name: 'Omar F' },
  }, 'a shared name links nowhere; an unknown one neither');

  // The link worked out from the ledger, not the name: the app's CL-001 bought 1668 and 1700 from us — our Dealer One.
  const acc = await import('../src/accounts/clients.js');
  const byId = await acc.linksByClientId(['CL-001', 'CL-002', 'CL-003']);
  assert.equal(byId.get('CL-001').client_id, dealer.id);
  assert.equal(byId.get('CL-001').how, 'watches');
  assert.equal(byId.get('CL-002').client_id, omar.id, 'one watch, and the names alike');
  assert.equal(byId.get('CL-003').client_id, null, 'two of ours carry the name, no watch decides');
  assert.equal(await acc.accountsClientIdFor('dealer one'), 'CL-001');
  assert.equal((await editor.call('GET', '/api/acc-app/client?name=Omar%20F')).body.acc_client_id, 'CL-002');
  assert.equal((await editor.call('GET', '/api/acc-app/client?name=Nobody')).body.acc_client_id, null);

  // The watch page's window: the ledger on 1668, with its arithmetic, who the clients are, and the invoice by its number.
  const s = await viewer.call('GET', '/api/acc-app/stock/1668');
  assert.equal(s.status, 200, 'for every role: it reads our copy');
  assert.deepEqual(s.body.entries.map((e) => [e.source_id, e.status, e.paid, e.outstanding]), [['e2', 'partial', 10000, 4000], ['e1', 'partial', 46000, 500]]);
  assert.equal(s.body.clients['CL-002'].client_id, omar.id);
  assert.equal(s.body.clients['CL-001'].name, 'Dealer One');
  assert.deepEqual(s.body.invoices.map((i) => i.source_id), ['i1']);
  assert.deepEqual(s.body.expenses.map((i) => i.source_id), ['x1']);
  assert.deepEqual(s.body.settlements.map((i) => i.source_id), ['s1']);
  assert.ok(s.body.read_at);
  assert.deepEqual(s.body.wallets, { w1: { name: 'WISE (USD)', company: 'PUROSANGUE WATCHES LTD', bank: 'WISE', ccy: 'USD', kind: 'bank' } }, 'the wallet the payment went through');
  const e2 = s.body.entries.find((e) => e.source_id === 'e2');
  assert.deepEqual(e2.data.payments[0].proofs[0].url, '/uploads/CL-002/receipt.pdf', 'an upload stays a reference, shown through the ERP');
  // The invoice picture the pass copied, served from our copy — full size and as a thumbnail.
  const fileId = e2.data.invoiceProof.dataUrl.match(/^acfile:(\d+)$/)[1];
  const full = await viewer.call('GET', `/api/acc-app/file/${fileId}`);
  assert.equal(full.status, 200);
  assert.match(full.type, /image\/jpeg/);
  assert.equal((await viewer.call('GET', `/api/acc-app/file/${fileId}?thumb=1`)).status, 200);
  assert.equal((await viewer.call('GET', '/api/acc-app/file/999999')).status, 404);
  assert.equal((await client().call('GET', `/api/acc-app/file/${fileId}`)).status, 401);
  assert.equal((await viewer.call('GET', '/api/acc-app/stock/1701')).body.quick_sales.length, 1);
  assert.deepEqual((await viewer.call('GET', '/api/acc-app/stock/5555')).body.entries, []);

  // The client page's panel: our Dealer One in the app, and what stands open with them.
  const c = await viewer.call('GET', `/api/acc-app/our-client/${dealer.id}`);
  assert.equal(c.status, 200);
  assert.deepEqual(c.body.links.map((l) => [l.acc_client_id, l.how]), [['CL-001', 'watches']]);
  assert.deepEqual(c.body.balances, { AED: { owed_to_us: 0, we_owe: 500 }, EUR: { owed_to_us: 0, we_owe: 98000 } }, 'the 500 left on e1 after its amount grew, and the unpaid 1700');
  assert.equal(c.body.entries, 2);
  const o = await viewer.call('GET', `/api/acc-app/our-client/${omar.id}`);
  assert.deepEqual(o.body.balances, { USD: { owed_to_us: 4000, we_owe: 0 } });
  assert.deepEqual((await viewer.call('GET', '/api/acc-app/our-client/999999')).body.links, []);

  // The page's own facts.
  const meta = await viewer.call('GET', '/api/meta');
  assert.equal(meta.body.accounts.app_embedded, true);
  assert.equal(meta.body.accounts.sync, true);
  assert.ok(meta.body.accounts.pages.some((p) => p.key === 'stock' && p.path === '/reports/stock'));
  const status = await admin.call('GET', '/api/import/status');
  assert.equal(status.body.counts.accounts_items, 37);
  assert.equal(status.body.counts.accounts_entries, 4);
  assert.equal(status.body.configured.accounts, true);
  assert.equal((await admin.call('POST', '/api/import/run', { job: 'accounts' })).status, 202);
});

test('without the copy, the window reads the accounts app live — with the person’s own sign-in, else the ERP’s', async () => {
  // The pass the previous test started must finish first, or it copies everything straight back.
  for (let i = 0; i < 50 && (await admin.call('GET', '/api/import/status')).body.running; i++) await new Promise((r) => setTimeout(r, 100));
  await pool.query('DELETE FROM accounts_records; DELETE FROM accounts_items');
  const acc = await import('../src/accounts/index.js');
  acc.forgetLive();
  const reads = () => hits.filter((h) => h === 'GET /api/state').length;
  const before = reads();
  // The editor signed in to the app earlier (connect.sid in the jar): their own session reads it.
  const s = await editor.call('GET', '/api/acc-app/stock/1668');
  assert.equal(s.status, 200);
  assert.equal(s.body.source, 'live');
  assert.deepEqual(s.body.entries.map((e) => e.source_id).sort(), ['e1', 'e2']);
  assert.equal(s.body.entries.find((e) => e.source_id === 'e2').status, 'partial');
  assert.equal(s.body.clients['CL-002'].name, 'Omar F');
  assert.ok(s.body.clients['CL-002'].client_id, 'our Omar F, by the name');
  assert.ok(s.body.clients['CL-001'].client_id, 'our Dealer One, by the name');
  assert.equal(s.body.clients['CL-001'].how, 'name', 'live: by the name only — the ledger match needs the copy');
  assert.deepEqual(s.body.wallets.w1.name, 'WISE (USD)');
  assert.deepEqual(s.body.invoices.map((i) => i.source_id), ['i1'], 'the invoice by its number');
  assert.equal(reads(), before + 1);
  assert.equal((await editor.call('GET', '/api/acc-app/stock/1700')).body.entries.length, 1);
  assert.equal(reads(), before + 1, 'the app’s answer is held a minute per session');
  // A viewer has no accounts session: the ERP's own reads it.
  const v = await viewer.call('GET', '/api/acc-app/stock/1668');
  assert.equal(v.body.source, 'live');
  assert.equal(v.body.entries.length, 2);
  assert.deepEqual((await viewer.call('GET', '/api/acc-app/stock/5555')).body.entries, []);
  // Signed out of the ERP: nothing, as ever.
  assert.equal((await client().call('GET', '/api/acc-app/stock/1668')).status, 401);
});

test('the rewrites, on their own', () => {
  assert.equal(accapp.rewriteScript('x("/api")+y(\'/api/a\')+z(`/api/${b}`)+"https://h/api/x"+"/apix"'), 'x("/acc-app/api")+y(\'/acc-app/api/a\')+z(`/acc-app/api/${b}`)+"https://h/api/x"+"/apix"');
  assert.equal(accapp.rewriteSetCookie('connect.sid=abc; Domain=up.railway.app; Path=/; Secure; HttpOnly', { secure: true }), 'connect.sid=abc; HttpOnly; Path=/; Secure');
  assert.equal(accapp.accountsCookies('ma_session=1; connect.sid=2; x=3'), 'connect.sid=2; x=3');
  assert.deepEqual(sync.stockNosOf('entries', { stock: '1385, 1390 and 1400' }), ['1385', '1390', '1400']);
  assert.deepEqual(sync.stockNosOf('entries', { stock: 'loan ref' }), []);
  assert.deepEqual(sync.recordsOf([{ id: 'a' }, { id: 'a' }, { id: 'b' }]).map(([k]) => k), ['a', 'a~2', 'b']);
  assert.deepEqual(sync.recordsOf({ k: 1 }), [['*', { value: { k: 1 } }]]);
  assert.deepEqual(sync.recordsOf([{ name: 'no id' }]), [['*', { value: [{ name: 'no id' }] }]]);
});
