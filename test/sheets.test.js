import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

/*
 * Sheets and Ask (7 Nov 2026), over the HTTP API against a real Postgres
 * (TEST_DATABASE_URL, EMPTIED first). Ask runs without an Anthropic key here:
 * what is tested is the read-only SQL it is allowed, the files, and the
 * answer when it is not set up.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let server, base, pool, dataDir, gcDir, sheets, ask, pdf, xlsx;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-sheets-'));
  gcDir = path.join(dataDir, 'gridcraft'); // empty: GridCraft "not installed" until a test writes an index.html there
  Object.assign(process.env, {
    DATABASE_URL: DB,
    DATA_DIR: dataDir,
    GRIDCRAFT_DIR: gcDir,
    ADMIN_EMAIL: 'boss@example.com',
    ADMIN_PASSWORD: 'admin-password-1',
    SYNC: 'off',
    RATES_LIVE_URL: 'http://127.0.0.1:9/none',
    RATES_DAILY_URL: 'http://127.0.0.1:9/none',
    RATES_TIMEOUT_MS: '300',
    ANTHROPIC_API_KEY: '',
  });
  const reset = new pg.Client({ connectionString: DB });
  await reset.connect();
  await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await reset.end();
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/auth/index.js')).ensureFirstAdmin(() => {});
  pool = (await import('../src/db/index.js')).pool;
  sheets = await import('../src/sheets/index.js');
  ask = await import('../src/ask/index.js');
  pdf = await import('../src/pdf/index.js');
  xlsx = await import('../src/xlsx/index.js');
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
  const call = async (method, url, body) => {
    const headers = { 'X-Requested-With': 'masterapp' };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), type, headers: res.headers };
  };
  return { call, login: (email, password) => call('POST', '/api/login', { email, password }), cookie: () => cookie };
}

let admin, w1, w2, clientId, sheetId;

test('setting: two watches, a client, a logistics cost', async () => {
  admin = client();
  assert.equal((await admin.login('boss@example.com', 'admin-password-1')).status, 200);
  clientId = (await admin.call('POST', '/api/clients', { forename: 'Diego', surname: 'Gimenez', type: 'dealer' })).body.id;
  w1 = (await admin.call('POST', '/api/watches', { stock_no: '1617', brand: 'Rolex', model: 'Daytona', reference: '116500LN', purchase_price: 25000, purchase_currency: 'EUR', purchase_date: '2026-03-01', status: 'in_stock' })).body.id;
  w2 = (await admin.call('POST', '/api/watches', { stock_no: '1618', brand: 'Patek Philippe', model: 'Nautilus', purchase_price: 90000, purchase_currency: 'USD', sale_price: 110000, sale_currency: 'USD', sale_date: '2026-05-02', status: 'sold' })).body.id;
  assert.ok(w1 && w2);
  assert.equal((await admin.call('PUT', `/api/watches/${w1}/client`, { role: 'purchase', client_id: clientId })).status, 200);
  assert.equal((await admin.call('PUT', `/api/watches/${w2}/client`, { role: 'sale', client_id: clientId })).status, 200);
  // A logistics cost naming both watches, as the app's copy holds it: split in two.
  await pool.query(
    `INSERT INTO logistics_items(kind, source_id, data, stock_nos, origin, happened_at) VALUES
       ('logisticCosts', 'c1', $1, '{1617,1618}', 'logistics', now()),
       ('shipments', 's1', $2, '{1617}', 'logistics', now())`,
    [JSON.stringify({ id: 'c1', title: 'DHL Dubai → London', amount: 300, currency: 'USD', stockNumber: '1617, 1618', date: '2026-04-01' }), JSON.stringify({ id: 's1', items: 'Daytona', costAmount: 120, costCurrency: 'GBP', stockNumber: '1617', date: '2026-04-03', status: 'delivered' })]
  );
});

test('a logistics sheet: the app’s costing, split over the watches, by area', async () => {
  const p = await admin.call('POST', '/api/sheets/preview', { kind: 'logistics', subject: { stock: '1617' } });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.row_count, 2);
  const cost = p.body.rows.find((r) => r.cells.area === 'Logistic cost');
  assert.equal(cost.cells.amount, 150, 'split across two watches');
  assert.equal(cost.cells.currency, 'USD');
  assert.equal(p.body.rows.find((r) => r.cells.area === 'Shipment').cells.amount, 120);
  assert.equal(cost.cells.eur, null, 'no rates reachable: ≈ EUR left blank, never guessed');
  const all = await admin.call('POST', '/api/sheets/preview', { kind: 'logistics', subject: {} });
  assert.equal(all.body.row_count, 3, 'every stock: 1617 twice, 1618 once');
});

test('a stock sheet is built, kept, edited, and a cell goes into the system only when asked', async () => {
  const r = await admin.call('POST', '/api/sheets', { kind: 'stock', subject: { status: 'all' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  sheetId = r.body.id;
  const s = (await admin.call('GET', `/api/sheets/${sheetId}`)).body;
  assert.equal(s.doc.rows.length, 2);
  assert.equal(s.title, 'Stock situation · every watch');
  const row = s.doc.rows.find((x) => x.ref.watch === w1);
  assert.equal(row.cells.stock, '1617');
  assert.equal(row.cells.purchase_price, 25000);
  assert.equal(row.cells.purchase_eur, 25000, 'a euro purchase is its own euro figure');
  const margin = s.doc.columns.find((c) => c.key === 'margin');
  assert.match(row.cells.margin, /^=IF\([A-Z]+2="","",[A-Z]+2-[A-Z]+2-[A-Z]+2\)$/, `a live formula per row: ${row.cells.margin}`);
  assert.ok(margin.formula.includes('{sale_eur}'));

  // Edit the dial on the sheet: the sheet changes, the watch does not.
  row.cells.location = 'Dubai';
  row.edited = { location: true };
  const save = await admin.call('PATCH', `/api/sheets/${sheetId}`, { doc: s.doc, version: s.version });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  assert.equal(save.body.version, s.version + 1);
  assert.equal((await admin.call('GET', `/api/watches/${w1}`)).body.location, '', 'the watch is untouched until asked');
  // A save from a page that still holds the old version is refused, not made over the other person's.
  assert.equal((await admin.call('PATCH', `/api/sheets/${sheetId}`, { doc: s.doc, version: s.version })).status, 409);

  // "Put it in the system too": the watch is changed as from its form — locked, logged.
  const ap = await admin.call('POST', `/api/sheets/${sheetId}/apply`, { row: row.key });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.deepEqual(ap.body.done[0].changed, ['location']);
  const w = (await admin.call('GET', `/api/watches/${w1}`)).body;
  assert.equal(w.location, 'Dubai');
  // Logged as any edit (a watch added here has no copy to lock against; one from Chrono Key would be locked).
  const ev = (await admin.call('GET', `/api/watches/${w1}/events`)).body.events[0];
  assert.equal(ev.action, 'update');
  assert.deepEqual(ev.changes.location, ['', 'Dubai']);
  const after = (await admin.call('GET', `/api/sheets/${sheetId}`)).body;
  assert.deepEqual(after.doc.rows.find((x) => x.ref.watch === w1).edited, {}, 'the row is no longer pending');

  // A new row on the stock sheet becomes a new watch.
  after.doc.rows.push({ key: 'new1', manual: true, cells: { stock: '1700', brand: 'Omega', model: 'Speedmaster', status: 'incoming' } });
  assert.equal((await admin.call('PATCH', `/api/sheets/${sheetId}`, { doc: after.doc, version: after.version })).status, 200);
  const made = await admin.call('POST', `/api/sheets/${sheetId}/apply`, { row: 'new1' });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.ok(made.body.done[0].created);
  assert.equal((await admin.call('GET', '/api/watches?q=1700')).body.total, 1);

  // Read again: the system's rows come back (now three), the typed edits kept.
  const rb = await admin.call('POST', `/api/sheets/${sheetId}/rebuild`);
  assert.equal(rb.status, 200);
  assert.equal(rb.body.doc.rows.length, 3);
});

test('accounting for a client and for stocks; a new line out becomes an expense naming the stock', async () => {
  const c = await admin.call('POST', '/api/sheets/preview', { kind: 'accounting', subject: { client: clientId } });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.row_count, 2, 'bought 1617 from them, sold 1618 to them');
  assert.ok(c.body.rows.some((r) => r.cells.out === 25000 && r.cells.currency === 'EUR'));
  assert.ok(c.body.rows.some((r) => r.cells.in === 110000 && r.cells.currency === 'USD'));

  const r = await admin.call('POST', '/api/sheets', { kind: 'accounting', subject: { stock: ['1617'] } });
  const s = (await admin.call('GET', `/api/sheets/${r.body.id}`)).body;
  assert.equal(s.doc.rows.length, 3, 'purchase + two logistics lines');
  s.doc.rows.push({ key: 'x1', manual: true, cells: { date: '2026-06-01', stock: '1617', what: 'Polish', out: 450, currency: 'AED' } });
  await admin.call('PATCH', `/api/sheets/${r.body.id}`, { doc: s.doc, version: s.version });
  const ap = await admin.call('POST', `/api/sheets/${r.body.id}/apply`, { row: 'x1' });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const x = (await admin.call('GET', `/api/expenses/${ap.body.done[0].id}`)).body;
  assert.equal(x.title, 'Stock 1617 · Polish');
  assert.equal(x.amount, 450);
  assert.equal(x.currency, 'AED');
  // …and the next read of the sheet finds the expense by the stock it names.
  const again = await admin.call('POST', '/api/sheets/preview', { kind: 'accounting', subject: { stock: ['1617'] } });
  assert.ok(again.body.rows.some((row) => row.ref?.expense === x.id), 'the expense is a line of the stock’s accounting');
});

test('a client sheet; a new row links the watch to the client', async () => {
  const r = await admin.call('POST', '/api/sheets', { kind: 'client', subject: { client: clientId } });
  const s = (await admin.call('GET', `/api/sheets/${r.body.id}`)).body;
  assert.equal(s.doc.rows.length, 2);
  s.doc.rows.push({ key: 'l1', manual: true, cells: { stock: '1700', role: 'Bought from them' } });
  await admin.call('PATCH', `/api/sheets/${r.body.id}`, { doc: s.doc, version: s.version });
  assert.equal((await admin.call('POST', `/api/sheets/${r.body.id}/apply`, { row: 'l1' })).status, 200);
  const links = (await admin.call('GET', '/api/watches?q=1700')).body;
  const id = links.watches?.[0]?.id || links.rows?.[0]?.id || links.items?.[0]?.id;
  const w = (await admin.call('GET', `/api/watches/${id}`)).body;
  assert.equal(w.purchased_from_client_id, clientId);
  assert.equal((await admin.call('POST', '/api/sheets/preview', { kind: 'client', subject: {} })).status, 400, 'a client sheet needs its client');
});

test('CSV and PDF of a sheet; formulas print their computed value', async () => {
  const s = (await admin.call('GET', `/api/sheets/${sheetId}`)).body;
  const row = s.doc.rows.find((x) => x.cells.stock === '1618');
  row.calc = { margin: 12345.5 };
  await admin.call('PATCH', `/api/sheets/${sheetId}`, { doc: s.doc, version: s.version });
  const csv = await admin.call('GET', `/api/sheets/${sheetId}/export`);
  assert.equal(csv.status, 200);
  const text = csv.body.toString('utf8');
  assert.ok(text.startsWith('﻿Stock,Brand'), text.slice(0, 40));
  assert.ok(text.includes('1618,Patek Philippe'), 'the row');
  assert.ok(text.includes('12345.5'), 'the margin as computed, not the formula');
  assert.ok(!text.includes('=IF('), 'no formula text in the CSV');
  const p = await admin.call('GET', `/api/sheets/${sheetId}/export?format=pdf`);
  assert.equal(p.status, 200);
  assert.ok(p.type.startsWith('application/pdf'));
  assert.ok(p.body.subarray(0, 5).toString() === '%PDF-');
  assert.ok(p.body.toString('latin1').includes('%%EOF'));
});

test('the XLSX writer and reader: strings, numbers, dates, booleans, formulas, hidden parts — and what is refused', () => {
  const buf = xlsx.writeXlsx({
    sheets: [
      { name: 'T', freeze: 1, cols: [{ hidden: true }, { width: 20 }], rows: [[{ v: '#', style: 'header' }, 'Name', 'Paid', 'When'], ['k1', 'Rolex & "Co" <x>', 25000.5, { v: '2026-03-01', style: 'date' }], ['k2', 'Patek', { f: '=C2*2', v: 50001, style: 'money' }, true]] },
      { name: 'erp', hidden: true, rows: [['masterapp-sheet', '7']] },
    ],
  });
  assert.ok(xlsx.isXlsx(buf));
  const r = xlsx.readXlsx(buf);
  assert.deepEqual(r.sheets.map((s) => [s.name, s.hidden]), [['T', false], ['erp', true]]);
  const c = r.sheets[0].cells;
  assert.equal(c.B2.v, 'Rolex & "Co" <x>', 'entities both ways');
  assert.equal(c.C2.v, 25000.5);
  assert.deepEqual(c.D2, { v: '2026-03-01', t: 'd' }, 'a date is a date again, by its number format');
  assert.deepEqual(c.C3, { f: '=C2*2', v: 50001, t: 'n' }, 'a formula with its cached value');
  assert.deepEqual(c.D3, { v: true, t: 'b' });
  assert.equal(xlsx.dateToSerial('2026-03-01'), 46082);
  assert.equal(xlsx.serialToDate(46082), '2026-03-01');
  assert.equal(xlsx.serialToDate(1), '1899-12-31');
  assert.equal(xlsx.isDateFormat(14), true);
  assert.equal(xlsx.isDateFormat(0, '#,##0.00'), false);
  assert.equal(xlsx.isDateFormat(170, 'dd/mm/yyyy'), true);
  assert.equal(xlsx.isDateFormat(171, '"Day "0'), false, 'quoted letters are not date codes');
  assert.throws(() => xlsx.readXlsx(Buffer.from('not a zip at all, really not')), /Not an \.xlsx/);
  assert.throws(() => xlsx.unzip(Buffer.alloc(40)), /zip/);
  // The zip itself: Node's own inflate reads every part back whole.
  const z = xlsx.unzip(buf);
  assert.ok(z.names.includes('xl/workbook.xml') && z.names.includes('[Content_Types].xml'));
  assert.match(z.read('xl/workbook.xml').toString(), /state="hidden"/);
});

test('the sheet as a workbook for GridCraft, saved back with edits: cells marked, rows added, versions kept', async () => {
  const s = (await admin.call('GET', `/api/sheets/${sheetId}`)).body;
  const wb = await admin.call('GET', `/api/sheets/${sheetId}/workbook`);
  assert.equal(wb.status, 200);
  assert.ok(wb.type.startsWith('application/vnd.openxmlformats'));
  assert.equal(wb.headers.get('x-sheet-version'), String(s.version));
  assert.ok(xlsx.isXlsx(wb.body));
  const read = xlsx.readXlsx(wb.body);
  const main = read.sheets[0];
  assert.equal(main.cells.A1.v, '#', 'column A carries the row keys, hidden');
  assert.equal(main.cells.B1.v, 'Stock');
  assert.equal(read.sheets[1].name, 'erp');
  assert.ok(read.sheets[1].hidden);
  assert.equal(read.sheets[1].cells.B1.v, String(sheetId));
  const row1617 = Object.entries(main.cells).find(([ref, c]) => /^B\d+$/.test(ref) && c.v === '1617')[0].slice(1);
  const dial = s.doc.columns.findIndex((c) => c.key === 'serial') + 1; // +1: column A is the key
  const serialRef = `${xlsx.colLetters(dial)}${row1617}`;
  assert.equal(main.cells[serialRef], undefined, 'no serial yet');

  // "Saved in GridCraft": the same workbook with the serial typed and a new row — written with our writer, read as GridCraft's would be.
  const rows = [];
  for (let r = 1; r <= main.maxRow; r++) rows.push(Array.from({ length: main.maxCol }, (_, ci) => { const c = main.cells[`${xlsx.colLetters(ci)}${r}`]; return c ? (c.f ? { f: c.f, v: c.v } : c.t === 'd' ? { v: c.v, style: 'date' } : c.v) : null; }));
  rows[Number(row1617) - 1][dial] = 'K8V21';
  rows.push([null, '1800', 'Cartier', 'Santos']);
  const erp = read.sheets[1];
  const erpRows = [];
  for (let r = 1; r <= erp.maxRow; r++) erpRows.push(Array.from({ length: erp.maxCol }, (_, ci) => erp.cells[`${xlsx.colLetters(ci)}${r}`]?.v ?? null));
  const edited = xlsx.writeXlsx({ sheets: [{ name: 'Stock', rows }, { name: 'erp', hidden: true, rows: erpRows }] });
  const stale = await fetch(`${base}/api/sheets/${sheetId}/workbook`, { method: 'PUT', headers: { 'X-Requested-With': 'masterapp', 'Content-Type': 'application/octet-stream', 'X-Sheet-Version': '1', Cookie: admin.cookie() }, body: edited });
  assert.equal(stale.status, 409, 'a save from a page that opened an older version is refused');
  const put = await fetch(`${base}/api/sheets/${sheetId}/workbook`, { method: 'PUT', headers: { 'X-Requested-With': 'masterapp', 'Content-Type': 'application/octet-stream', 'X-Sheet-Version': String(s.version), Cookie: admin.cookie() }, body: edited });
  const out = await put.json();
  assert.equal(put.status, 200, JSON.stringify(out));
  assert.equal(out.version, s.version + 1);
  assert.deepEqual(out.changed, [{ key: `w:${w1}`, cells: ['serial'] }]);
  assert.equal(out.added, 1);
  const r1617 = out.doc.rows.find((r) => r.key === `w:${w1}`);
  assert.equal(r1617.cells.serial, 'K8V21');
  assert.deepEqual(r1617.edited, { serial: true });
  assert.equal(r1617.ref.watch, w1, 'the row still stands for its watch');
  const added = out.doc.rows.find((r) => r.manual);
  assert.equal(added.cells.stock, '1800');
  // The kept workbook is now the one saved; a fresh one comes from the document.
  const again = await admin.call('GET', `/api/sheets/${sheetId}/workbook`);
  assert.equal(xlsx.readXlsx(again.body).sheets[0].cells[serialRef].v, 'K8V21');
  // Into the system, as from the page's own grid.
  const ap = await admin.call('POST', `/api/sheets/${sheetId}/apply`, { row: `w:${w1}` });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal((await admin.call('GET', `/api/watches/${w1}`)).body.serial, 'K8V21');
  // Not this sheet's workbook, not a workbook at all: refused, nothing changed.
  const other = xlsx.writeXlsx({ sheets: [{ name: 'X', rows: [['#', 'Stock'], ['k', '1']] }, { name: 'erp', hidden: true, rows: [['masterapp-sheet', '999']] }] });
  const wrong = await fetch(`${base}/api/sheets/${sheetId}/workbook`, { method: 'PUT', headers: { 'X-Requested-With': 'masterapp', 'Content-Type': 'application/octet-stream', Cookie: admin.cookie() }, body: other });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /sheet 999/);
  const junk = await fetch(`${base}/api/sheets/${sheetId}/workbook`, { method: 'PUT', headers: { 'X-Requested-With': 'masterapp', 'Content-Type': 'application/octet-stream', Cookie: admin.cookie() }, body: Buffer.from('hello') });
  assert.equal(junk.status, 400);
});

test('GridCraft at /gridcraft/: not installed → says so; installed → its page with a WebAssembly policy, framed by us only', async () => {
  assert.equal((await admin.call('GET', '/api/meta')).body.gridcraft.installed, false);
  const none = await admin.call('GET', '/gridcraft/');
  assert.equal(none.status, 404);
  assert.match(none.body.toString(), /npm run gridcraft/);
  assert.equal((await client().call('GET', '/gridcraft/')).status, 401, 'behind the sign-in');
  fs.mkdirSync(gcDir, { recursive: true });
  fs.writeFileSync(path.join(gcDir, 'index.html'), '<!doctype html><html><body><canvas id="gridcraft_canvas"></canvas><script type="module">import init from "/gridcraft/gridcraft-web-abcdef0123456789.js";init();</script></body></html>');
  fs.writeFileSync(path.join(gcDir, 'gridcraft-web-abcdef0123456789.js'), 'export default () => {}');
  fs.writeFileSync(path.join(gcDir, 'VERSION'), '0.17.0\n');
  assert.deepEqual((await admin.call('GET', '/api/meta')).body.gridcraft, { installed: true, version: '0.17.0' });
  const page = await admin.call('GET', '/gridcraft/');
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval' 'sha256-[A-Za-z0-9+/=]+'/, 'the inline module script allowed by its hash');
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  const js = await admin.call('GET', '/gridcraft/gridcraft-web-abcdef0123456789.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('cache-control'), /immutable/, 'a hashed file is kept for good');
  // Nothing above the folder: an encoded ".." reaches the server as a path segment (a plain one the client folds away first).
  const up = await admin.call('GET', '/gridcraft/%2e%2e/package.json');
  assert.ok(!up.body.toString().includes('"scripts"'), `package.json must not be served (status ${up.status})`);
});

test('the PDF writer: pages, headings, a wide table, and a character the fonts lack', () => {
  const rows = Array.from({ length: 120 }, (_, i) => [`Stock ${1000 + i}`, 'Rolex Daytona 116500LN with a long description that wraps', i % 2 ? '€16,800' : 'AED 71,000', String(i * 3)]);
  const buf = pdf.renderPdf({
    title: 'Everything sold · October 2026',
    subtitle: 'Figures in each deal’s own currency — محمد',
    blocks: [{ type: 'heading', text: 'By currency' }, { type: 'text', text: 'Two currencies, so no single total.' }, { type: 'table', columns: ['Stock', 'Watch', { label: 'Price', align: 'right' }, 'N'], rows, foot: [['Total', '', '—', '21420']] }],
  });
  const s = buf.toString('latin1');
  const pages = (s.match(/\/Type \/Page\b/g) || []).length;
  assert.ok(pages >= 3, `${pages} pages`);
  assert.ok(s.includes('/Count ' + pages));
  assert.ok(s.endsWith('%%EOF\n'));
  const t = pdf.tableBlock([{ stock_no: '1617', total: 1500.5, note: null }], { title: 'T' });
  assert.deepEqual(t.columns.map((c) => c.align), ['left', 'right', 'left']);
  assert.deepEqual(t.rows, [['1617', '1,500.5', '']]);
});

test('Ask: read-only SQL only — one statement, no users or sessions, people instead', async () => {
  const r = await ask.readOnlySql('SELECT stock_no, purchase_price FROM watches WHERE deleted_at IS NULL ORDER BY stock_no', { limit: 10 });
  assert.deepEqual(r.fields, ['stock_no', 'purchase_price']);
  assert.equal(r.total, 3);
  await assert.rejects(ask.readOnlySql("UPDATE watches SET brand = 'x'"), /Only a SELECT/);
  await assert.rejects(ask.readOnlySql('SELECT 1; DELETE FROM watches'), /Postgres/, 'a second statement is a syntax error to Postgres, not run');
  await assert.rejects(ask.readOnlySql('SELECT password_hash FROM users'), /not readable/);
  await assert.rejects(ask.readOnlySql('SELECT * FROM sessions'), /not readable/);
  await assert.rejects(ask.readOnlySql('WITH x AS (SELECT 1) SELECT pg_sleep(0.1), * FROM x; SELECT 2'), /Postgres/);
  const people = await ask.readOnlySql('SELECT email, role FROM people');
  assert.equal(people.rows[0].email, 'boss@example.com');
  assert.equal(people.fields.includes('password_hash'), false);
  // A function that writes is refused by the READ ONLY transaction itself.
  await assert.rejects(ask.readOnlySql("SELECT setval('watches_id_seq', 1)"), /read-only/i);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM watches')).rows[0].n, 3, 'nothing was changed');
});

test('Ask over HTTP without a key: says it is not set up; no thread is made', async () => {
  const meta = (await admin.call('GET', '/api/meta')).body;
  assert.equal(meta.ai.enabled, false);
  assert.ok(meta.sheetKinds.length === 4);
  const r = await admin.call('POST', '/api/ask', { question: 'How many watches are in stock?' });
  assert.equal(r.status, 200);
  assert.ok(r.type.startsWith('application/x-ndjson'));
  // One line, so the client read it as JSON already.
  const last = Buffer.isBuffer(r.body) ? JSON.parse(r.body.toString('utf8').trim().split('\n').at(-1)) : r.body;
  assert.match(last.error, /ANTHROPIC_API_KEY/);
  assert.deepEqual((await admin.call('GET', '/api/ask/threads')).body.threads, []);
  assert.equal((await admin.call('GET', '/api/ask/files/nope')).status, 404);
});
