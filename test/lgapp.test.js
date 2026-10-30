import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';

/*
 * The logistics app inside the ERP: its page served at /lg-app/ from a
 * stand-in Vercel, rewritten and behind the sign-in; its functions passed on;
 * the bridge's lookup. Against a real Postgres (TEST_DATABASE_URL), EMPTIED.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let server, base, pool, dataDir, vercel, vercelBase, lgapp;
const hits = [];

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<script>fetch('/api/app-version', {cache: 'no-store'})</script>
</head>
<body>
<div id="authScreen">Sign in</div>
<script>
const CF_URL = 'https://puro-sync.example';
fetch("/api/claude", { method: 'POST' });
fetch(CF_URL + '/api/state', { cache: 'no-store' });
</script>
</body></html>`;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lgapp-'));
  vercel = http
    .createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      hits.push(`${req.method} ${url.pathname}`);
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (url.pathname === '/') {
          if (req.headers['if-none-match'] === '"v1"') {
            res.statusCode = 304;
            return res.end();
          }
          res.setHeader('ETag', '"v1"');
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.end(PAGE);
        }
        if (url.pathname === '/vault.html' || url.pathname === '/vault') {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.end('<!DOCTYPE html><html><head></head><body>vault <script>fetch("/api/x")</script></body></html>');
        }
        if (url.pathname === '/manifest.json') {
          res.setHeader('Content-Type', 'application/manifest+json');
          return res.end('{"name":"Purosangue"}');
        }
        if (url.pathname === '/api/echo') {
          res.setHeader('Content-Type', 'application/json');
          return res.end(
            JSON.stringify({ method: req.method, query: url.search, type: req.headers['content-type'] || '', cookie: req.headers.cookie || '', bytes: body.length })
          );
        }
        res.statusCode = 404;
        res.end('no');
      });
    })
    .listen(0);
  vercelBase = `http://127.0.0.1:${vercel.address().port}`;
  Object.assign(process.env, {
    DATABASE_URL: DB,
    DATA_DIR: dataDir,
    ADMIN_EMAIL: 'boss@example.com',
    ADMIN_PASSWORD: 'admin-password-1',
    SYNC: 'off',
    LOGISTICS_APP_URL: vercelBase,
  });
  const reset = new pg.Client({ connectionString: DB });
  await reset.connect();
  await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await reset.end();
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/auth/index.js')).ensureFirstAdmin(() => {});
  pool = (await import('../src/db/index.js')).pool;
  lgapp = await import('../src/web/lgapp.js');
  const app = (await import('../src/web/server.js')).createServer();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  vercel.close();
  await pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const call = async (method, url, body, { headers: extra = {}, raw = false } = {}) => {
    const headers = { 'X-Requested-With': 'masterapp', ...extra };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (raw) payload = body;
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    const text = await res.text();
    return { status: res.status, text, body: type.includes('json') ? JSON.parse(text || 'null') : text, type, headers: res.headers };
  };
  return { call, login: (email, password) => call('POST', '/api/login', { email, password }) };
}

let admin, editor, viewer;

test('the app is served at /lg-app/ to editors only, rewritten for the ERP', async () => {
  admin = client();
  assert.equal((await admin.login('boss@example.com', 'admin-password-1')).status, 200);
  assert.equal((await admin.call('POST', '/api/users', { email: 'ed@example.com', role: 'editor', password: 'editor-password' })).status, 201);
  assert.equal((await admin.call('POST', '/api/users', { email: 'vi@example.com', role: 'viewer', password: 'viewer-password' })).status, 201);
  editor = client();
  viewer = client();
  await editor.login('ed@example.com', 'editor-password');
  await viewer.login('vi@example.com', 'viewer-password');

  assert.equal((await client().call('GET', '/lg-app/')).status, 401, 'signed out: nothing');
  assert.equal((await viewer.call('GET', '/lg-app/')).status, 403, 'a viewer cannot load it — the app writes');
  assert.equal(hits.filter((h) => h === 'GET /').length, 0, 'Vercel was not asked for either');

  const r = (await admin.call('GET', '/lg-app')).status;
  assert.equal(r, 302, '/lg-app goes to /lg-app/');

  const page = await editor.call('GET', '/lg-app/');
  assert.equal(page.status, 200);
  assert.match(page.type, /text\/html/);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline' https:\/\/cdnjs\.cloudflare\.com/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self' https:\/\/puro-sync\.purosangue\.workers\.dev wss:\/\/puro-sync/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.text, /<head>\n<script src="\/lgapp-bridge\.js"><\/script>/, 'the bridge first in <head>');
  assert.match(page.text, /fetch\('\/lg-app\/api\/app-version'/, "the app's own functions go through the ERP");
  assert.match(page.text, /fetch\("\/lg-app\/api\/claude"/);
  assert.match(page.text, /fetch\(CF_URL \+ '\/api\/state'/, 'its worker calls are untouched');
  assert.match(page.text, /id="authScreen"/, 'nothing else of the page is changed');

  // The bridge itself is a plain file of the console's.
  const bridge = await editor.call('GET', '/lgapp-bridge.js');
  assert.equal(bridge.status, 200);
  assert.match(bridge.text, /authScreen/);
});

test('a copy is held a minute, then asked for again with its ETag; the held copy serves when Vercel is down', async () => {
  const before = hits.filter((h) => h === 'GET /').length;
  assert.equal((await editor.call('GET', '/lg-app/')).status, 200);
  assert.equal((await editor.call('GET', '/lg-app/')).status, 200);
  assert.equal(hits.filter((h) => h === 'GET /').length, before, 'two more visits, no more fetches');

  lgapp.HOLD.ms = 0;
  const again = await editor.call('GET', '/lg-app/');
  assert.equal(again.status, 200);
  assert.match(again.text, /lgapp-bridge/);
  assert.equal(hits.filter((h) => h === 'GET /').length, before + 1, 'held too long: asked once more (304)');
  lgapp.HOLD.ms = 60_000;

  // Other files pass through as they are; an HTML one gets the policy and the rewrite, not the bridge.
  const manifest = await editor.call('GET', '/lg-app/manifest.json');
  assert.equal(manifest.status, 200);
  assert.match(manifest.type, /manifest\+json/);
  assert.equal(manifest.text, '{"name":"Purosangue"}');
  const vault = await editor.call('GET', '/lg-app/vault.html');
  assert.equal(vault.status, 200);
  assert.match(vault.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.match(vault.text, /fetch\("\/lg-app\/api\/x"\)/);
  assert.doesNotMatch(vault.text, /lgapp-bridge/);
  assert.equal((await editor.call('GET', '/lg-app/nothing-here.png')).status, 404);

  // Vercel down: the page held is served, marked stale; a file never held is a plain refusal.
  const port = vercel.address().port;
  await new Promise((r) => vercel.close(r));
  lgapp.HOLD.ms = 0;
  const held = await editor.call('GET', '/lg-app/');
  assert.equal(held.status, 200);
  assert.equal(held.headers.get('x-masterapp-stale'), '1');
  assert.match(held.text, /lgapp-bridge/);
  lgapp.forgetHeld();
  const gone = await editor.call('GET', '/lg-app/');
  assert.equal(gone.status, 502);
  assert.match(gone.text, /did not answer/);
  lgapp.HOLD.ms = 60_000;
  await new Promise((r) => vercel.listen(port, r));
});

test("the app's own functions are passed on whole — method, query, body — never the ERP's cookie", async () => {
  const origin = { Origin: base };
  const big = Buffer.alloc(2 * 1024 * 1024, 'x'); // over the ERP's own 1 MB JSON limit
  const r = await editor.call('POST', '/lg-app/api/echo?n=5', big, { raw: true, headers: { ...origin, 'Content-Type': 'application/json' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { method: 'POST', query: '?n=5', type: 'application/json', cookie: '', bytes: big.length });

  assert.equal((await editor.call('GET', '/lg-app/api/echo?a=1', undefined, { headers: {} })).body.query, '?a=1');
  assert.equal((await editor.call('POST', '/lg-app/api/echo', { a: 1 })).status, 403, 'a write with no origin of ours is refused');
  assert.equal((await editor.call('POST', '/lg-app/api/echo', { a: 1 }, { headers: { Origin: 'https://elsewhere.example' } })).status, 403);
  assert.equal((await viewer.call('POST', '/lg-app/api/echo', { a: 1 }, { headers: origin })).status, 403, 'a viewer: refused');
  assert.equal((await client().call('GET', '/lg-app/api/echo')).status, 401);
  assert.equal((await editor.call('GET', '/lg-app/api/not-there')).status, 404, "Vercel's answer, as it is");
});

test('the bridge asks which stock numbers and client names are ours', async () => {
  const made = await editor.call('POST', '/api/watches', { brand: 'Tudor', reference: '79000B', stock_no: '1461' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const r = await editor.call('POST', '/api/lg-app/links', { stock: ['1461', '9999', ''], clients: ['Nobody Known'] });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.watches), ['1461']);
  assert.equal(r.body.watches['1461'].id, made.body.id);
  assert.match(r.body.watches['1461'].title, /Tudor/);
  assert.deepEqual(r.body.clients, {}, 'a name no logistics client carries links nowhere');
  assert.equal((await viewer.call('POST', '/api/lg-app/links', { stock: ['1461'] })).status, 200, 'reading is for every role');
  assert.equal((await client().call('POST', '/api/lg-app/links', { stock: ['1461'] })).status, 401);
});
