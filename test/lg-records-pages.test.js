import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';
import sharp from 'sharp';

/*
 * Five of the logistics app's smaller pages, as masterapp shows them
 * (src/logistics/pages): Companies, Shipment Documents, Activity, Watch Vault
 * Activity and Other Receiving Pics. Against a stand-in worker and a real
 * Postgres (TEST_DATABASE_URL), which is EMPTIED first. What each test
 * checks is the rule every tab keeps — a stock number is OUR watch with its
 * clients, a typed name links as far as it goes — and each page's own
 * counters, groupings and facts for the watch's card.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let worker, base, m, db, dataDir, server, api, state;

const jpeg = (w, h, color) => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();

function fixture() {
  return {
    settings: { fobPassword: 'secret-fob', workerToken: 'tok' },
    clients: [
      { id: 'c1', name: 'Robin Casanova', country: 'Switzerland' },
      { id: 'c2', name: 'Company', isCompany: true, country: 'Dubai' },
      { id: 'c3', name: 'Kashif Rana', country: 'UAE' },
    ],
    companies: [
      { id: 'co1', name: 'Estival Habitual LDA', description: 'ESTIVAL HABITUAL LDA\nRua X 1, Lisboa\nVAT PT 500', ts: 1781774744797 },
      { id: 'co2', name: 'Purosangue Motors LLC', description: '', ts: 1781774732814 },
    ],
    shipmentDocs: [
      { id: 'sd1', companyId: 'co1', companyName: 'Estival Habitual LDA', clientId: 'c1', clientName: 'Robin Casanova', stockNumber: '4101', docType: 'Invoice', fileUrl: `${base}/photos/doc.pdf`, fileName: 'INV-1.pdf', fileType: 'application/pdf', date: '2026-06-25', notes: 'proforma', ts: 1782393650808 },
      { id: 'sd2', companyId: 'co1', companyName: 'Estival Habitual LDA', clientId: null, clientName: 'Kashif Rana', stockNumber: '4101', docType: 'Label', fileUrl: 'https://example.supabase.co/storage/v1/object/public/watch-photos/label.pdf', fileName: 'label.pdf', fileType: 'application/pdf', date: '2026-06-26', notes: '', ts: 1782393683090 },
      { id: 'sd3', companyId: 'co2', companyName: 'Purosangue Motors LLC', clientId: null, clientName: 'Walk-in', stockNumber: '4102', docType: 'Delivery Note', fileUrl: `${base}/photos/p1.jpg`, fileName: 'note.jpg', fileType: 'image/jpeg', date: '2026-06-20', notes: '', ts: 1782300000000 },
    ],
    dubaiStock: [
      { id: 'D1', stockNumber: '4101', brand: 'Rolex', watchModel: 'Daytona', watchReference: '126506', status: 'current' },
      { id: 'D2', stockNumber: '4102', brand: 'Patek Philippe', watchModel: 'Nautilus', status: 'current', polish: { status: 'at_polish', sentTo: 'Asif' } },
    ],
    londonStock: [],
    hkStock: [],
    // The vault's holder of a stock row, keyed by the row's id; GONE1's row the app no longer lists.
    vaultTracking: {
      D1: { status: 'Out with Client', holder: 'Josh', updatedAt: '2026-08-05' },
      D2: { status: 'In Office', holder: '', updatedAt: '2026-08-01' },
      GONE1: { status: 'In Home', holder: '', updatedAt: '2026-07-30' },
    },
    vaultNotifications: [
      { id: 'n1', ts: 1792699467080, type: 'location', loc: 'dubai', watchId: 'D1', stockNumber: '4101', brand: 'Rolex', watchRef: '126506', from: '—', to: 'Out with Client · Josh', status: 'approved' },
      { id: 'n2', ts: 1792699000000, type: 'accessory', loc: 'dubai', watchId: 'D2', stockNumber: '4102', brand: 'Patek Philippe', oldPresent: 'Box', newPresent: 'Box, Papers', oldMissing: 'Papers, Hang tag', newMissing: 'Hang tag', status: 'approved' },
      { id: 'n3', ts: 1792698000000, type: 'price', loc: 'dubai', watchId: 'D2', stockNumber: '4102', brand: 'Patek Philippe', newB2BPrice: 50000, newB2BCurrency: 'USD', oldB2BPrice: 48000, oldB2BCurrency: 'USD', newB2CPrice: null, status: 'pending' },
      { id: 'n4', ts: 1792697000000, type: 'location', loc: 'dubai', watchId: 'GONE1', stockNumber: '4103', brand: 'Cartier', watchRef: 'WHSA0015', from: 'In Office', to: 'In Home', status: 'approved' },
    ],
    otherReceivingPics: [
      { id: 'op1', clientName: 'Kashif Rana', notes: 'passport copy', photos: [`${base}/photos/p1.jpg`, `${base}/photos/p2.jpg`], createdAt: 1787670409711 },
      { id: 'op2', clientName: 'Walk-in', notes: '', photos: [], createdAt: 1787670457513, stockNumber: '4101' },
    ],
    activity: [
      { id: 'a1', text: '🇦🇪 Dubai Stock 4101 updated · present: 8 · missing: 0', ts: 1793102725965, type: 'info' },
      { id: 'a2', text: 'Delivered shipment "Rolex Day-Date 36 Ref 128238-0106 , box" (nothing missing)', ts: 1793101423826, type: 'info' },
      { id: 'a3', text: '🚛 Updated 3rd party shipment: Ferrari · 4101, 4102, 9999', ts: 1793101000000, type: 'info' },
      { id: 'a4', text: '💵 SOLD 4102 · USD 70000 ≈ $70,000 · from 🇦🇪 Dubai to Osman ARIF → 📦 Ready for Delivery', ts: 1793100000000, type: 'info' },
    ],
    todoItems: [{ id: 't1', text: 'Call Josh', done: false }],
  };
}

before(async () => {
  const photo = await jpeg(60, 40, '#3a6');
  const photo2 = await jpeg(50, 50, '#36a');
  worker = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/rates/live') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: { rates: { USD: '1', EUR: '0.9', GBP: '0.8', AED: '3.6725', HKD: '7.8' } } }));
    }
    if (url.pathname === '/photos/doc.pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      return res.end(Buffer.from('%PDF-1.4\n% an invoice\n%%EOF\n'));
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-worker-token'] !== 'vault-key') {
        res.statusCode = 401;
        return res.end('{"error":"Unauthorized"}');
      }
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/state') return res.end(JSON.stringify({ data: state }));
      if (url.pathname === '/api/vault-photos') return res.end('{"data":{}}');
      if (url.pathname === '/api/version') return res.end('{"version":1}');
    }
    if (url.pathname === '/photos/p1.jpg' || url.pathname === '/photos/p2.jpg') {
      res.setHeader('Content-Type', 'image/jpeg');
      return res.end(url.pathname === '/photos/p1.jpg' ? photo : photo2);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => worker.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${worker.address().port}`;
  state = fixture();

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lgp-'));
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

  m = {
    db: await import('../src/db/index.js'),
    sync: await import('../src/import/logistics/sync.js'),
    pages: await import('../src/logistics/pages/index.js'),
    log: await import('../src/logistics/pages/log.js'),
    vault: await import('../src/logistics/pages/vaultactivity.js'),
  };
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/auth/index.js')).ensureFirstAdmin(() => {});
  db = m.db.query;
  server = (await import('../src/web/server.js')).createServer().listen(0);
  api = `http://127.0.0.1:${server.address().port}`;

  // Our watches and clients: 4101 bought from Robin, 4102 sold to Kashif — Chrono Key's ids, never the typed names.
  const robin = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Robin', 'Casanova', 'manual') RETURNING id")).rows[0].id;
  const kashif = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Kashif', 'Rana', 'manual') RETURNING id")).rows[0].id;
  await db("INSERT INTO watches(stock_no, brand, model, reference, origin, status, purchased_from_client_id) VALUES ('4101', 'Rolex', 'Daytona', '126506', 'manual', 'in_stock', $1)", [robin]);
  await db("INSERT INTO watches(stock_no, brand, model, origin, status, sold_to_client_id) VALUES ('4102', 'Patek Philippe', 'Nautilus', 'manual', 'sold', $1)", [kashif]);
  state.ourIds = { robin, kashif };
  await m.sync.syncLogistics();
});

after(async () => {
  server.close();
  worker.close();
  await m.db.pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('companies: newest first, the documents issued through each, our watch on every one, and the app’s own “Company · place” rows apart', async () => {
  const r = await m.pages.page('companies');
  assert.deepEqual(
    r.companies.map((c) => c.name),
    ['Estival Habitual LDA', 'Purosangue Motors LLC']
  );
  const [estival, motors] = r.companies;
  assert.equal(estival.details, 'ESTIVAL HABITUAL LDA\nRua X 1, Lisboa\nVAT PT 500');
  assert.equal(estival.link, null, 'not a client of anybody’s');
  assert.deepEqual(estival.docs.map((d) => [d.doc_type, d.date, d.stock_no, d.client_name]), [['Label', '2026-06-26', '4101', 'Kashif Rana'], ['Invoice', '2026-06-25', '4101', 'Robin Casanova']], 'newest first');
  assert.equal(estival.docs[0].watch.stock_no, '4101');
  assert.equal(estival.docs[0].watch.bought_from.id, state.ourIds.robin, 'our watch, with our client by id');
  assert.deepEqual(estival.doc_types, [{ type: 'Invoice', n: 1 }, { type: 'Label', n: 1 }]);
  assert.deepEqual(estival.clients, ['Kashif Rana', 'Robin Casanova']);
  assert.equal(estival.last_used, '2026-06-26');
  assert.equal(motors.docs.length, 1);
  assert.equal(motors.details, '');
  assert.equal(r.documents, 3);
  assert.deepEqual(r.places.map((p) => [p.name, p.country]), [['Company', 'Dubai']], 'the app’s company-location client, not a company');
});

test('shipment documents: the app’s filters’ choices, each doc’s client by id or name, its company, its file, and the watch’s fact', async () => {
  const r = await m.pages.page('shipmentdocs');
  assert.deepEqual(r.types.slice(0, 4), ['Invoice', 'Label', 'Delivery Note', 'Purchase Agreement'], 'the app’s four, in its order');
  assert.deepEqual(r.clients, ['Kashif Rana', 'Robin Casanova', 'Walk-in']);
  assert.deepEqual(r.companies, ['Estival Habitual LDA', 'Purosangue Motors LLC']);
  assert.deepEqual(r.stock_nos, ['4101', '4102']);
  assert.deepEqual(
    r.docs.map((d) => [d.doc_type, d.date]),
    [['Label', '2026-06-26'], ['Invoice', '2026-06-25'], ['Delivery Note', '2026-06-20']],
    'newest first'
  );
  const [label, invoice, note] = r.docs;
  // The app's own client id: the logistics client, and ours as that one is linked (by its full name, no watch deciding otherwise).
  assert.equal(invoice.client.name, 'Robin Casanova');
  assert.equal(invoice.client.link.name, 'Robin Casanova');
  assert.equal(invoice.client.link.client_id, state.ourIds.robin);
  // A typed name with no id: linksByName.
  assert.equal(label.client.link.client_id, state.ourIds.kashif);
  assert.equal(note.client.link, null, 'a name no logistics client carries links nowhere');
  const companies = await m.pages.page('companies');
  assert.equal(invoice.company.id, companies.companies[0].id, 'the company’s record here');
  assert.equal(invoice.watch.stock_no, '4101');
  assert.equal(invoice.watch.bought_from.id, state.ourIds.robin);
  assert.equal(note.watch.sold_to.id, state.ourIds.kashif);
  // The file: copied here (a PDF off the worker), a picture copied here, or still on the app's own storage.
  assert.equal(invoice.file.kind, 'copy');
  assert.match(invoice.file.ref, /^lgfile:\d+$/);
  assert.equal(invoice.file.picture, false);
  assert.equal(invoice.file.name, 'INV-1.pdf');
  assert.deepEqual(label.file, { kind: 'external', url: 'https://example.supabase.co/storage/v1/object/public/watch-photos/label.pdf', name: 'label.pdf', type: 'application/pdf', picture: false });
  assert.equal(note.file.kind, 'copy');
  assert.equal(note.file.picture, true);

  const facts = await m.pages.factsFor(['4101', '4102']);
  const docFact = facts.get('4101').find((f) => f.page === 'shipmentdocs');
  assert.deepEqual(docFact, { page: 'shipmentdocs', text: '2 documents: invoice, label · via Estival Habitual LDA', link: '#/logistics/shipmentdocs', tone: '' });
  assert.equal(facts.get('4102').find((f) => f.page === 'shipmentdocs').text, '1 document: delivery note · via Purosangue Motors LLC');
});

test('activity: the lines newest first, a stock number picked out only where the app’s wording puts one, linked to our watch', async () => {
  const { stockNosInLine } = m.log;
  assert.deepEqual(stockNosInLine('📥➡️🏠 Received Stock 1698 from incoming → 🇦🇪 Dubai Stock'), ['1698']);
  assert.deepEqual(stockNosInLine('📦 Accessories given for Stock #1698: Box to Salva (1 photo)'), ['1698']);
  assert.deepEqual(stockNosInLine('Added incoming 1760 from Chrono Key (InvoiceWEB bot)'), ['1760']);
  assert.deepEqual(stockNosInLine('Updated note on stock 1698: "call him"'), ['1698']);
  assert.deepEqual(stockNosInLine('📦➡️💰 1698 delivered to Joe DXB'), ['1698']);
  assert.deepEqual(stockNosInLine('🚫 1698 hidden from Watch Vault'), ['1698']);
  assert.deepEqual(stockNosInLine('✅ Polish done for 1698 · returned from Asif'), ['1698']);
  assert.deepEqual(stockNosInLine('↩️ Cancelled sale 1698 (USD 70000) — restored to 🇦🇪 Dubai'), ['1698']);
  assert.deepEqual(stockNosInLine('🔒 #1668 Other NAZKN — sold to Mark, held in our safe'), ['1668']);
  assert.deepEqual(stockNosInLine('🚛 Updated 3rd party shipment: Ferrari · 1601, 1602, 1603'), ['1601', '1602', '1603']);
  assert.deepEqual(stockNosInLine('🤖 AI auto-filled Rolex 126720VTNR — 7 fields from rolex.com'), [], 'a reference is not a stock number');
  assert.deepEqual(stockNosInLine('Delivered shipment "Rolex Day-Date 36 Ref 128238-0106 , box" (nothing missing)'), []);
  assert.deepEqual(stockNosInLine('💰 Shipment cost: EUR 1200 · 🏢 HK → Germany'), [], 'an amount is not a stock number');
  assert.deepEqual(stockNosInLine('📦 Accessories received for Stock #: 1 set of straps'), [], 'no number after the #');

  const r = await m.pages.page('log');
  assert.deepEqual(
    r.lines.map((l) => l.stock_nos),
    [['4101'], [], ['4101', '4102', '9999'], ['4102']],
    'newest first'
  );
  assert.equal(r.lines[0].ts, new Date(1793102725965).toISOString());
  assert.deepEqual(Object.keys(r.watches).sort(), ['4101', '4102'], 'ours only — 9999 is nobody’s');
  assert.equal(r.watches['4101'].bought_from.id, state.ourIds.robin);
  assert.equal(r.app_keeps, 200);
  assert.ok(!r.lines.some((l) => /Call Josh/.test(l.text)), 'the notepad’s to-do items are not activity');
});

test('vault activity: each notification read the app’s way, who holds which watch (polish wins, a gone row still named), and the watch’s fact', async () => {
  const { detailOf, wordsOf, whereOf } = m.vault;
  assert.equal(whereOf('Out with Client'), 'client');
  assert.equal(whereOf('Back in Vault'), 'vault');
  assert.equal(wordsOf({ type: 'location', from: '—', to: 'In Home' }), 'Location: — → In Home');
  assert.deepEqual(detailOf({ type: 'accessory', oldPresent: 'Box', newPresent: 'Box, Papers', oldMissing: 'Papers, Hang tag', newMissing: 'Hang tag' }), {
    added: ['Papers'],
    removed: [],
    now_missing: [],
    present: ['Box', 'Papers'],
    missing: ['Hang tag'],
  });
  assert.equal(wordsOf({ type: 'price', newB2BPrice: 50000, newB2BCurrency: 'USD', newB2CPrice: 55000 }), 'Price updated: B2B USD 50,000 · B2C USD 55,000', 'USD when the currency is not stated, as the app');

  const r = await m.pages.page('vaultactivity');
  assert.deepEqual(
    r.notifications.map((n) => [n.type, n.stock_no, n.status]),
    [['location', '4101', 'approved'], ['accessory', '4102', 'approved'], ['price', '4102', 'pending'], ['location', '4103', 'approved']],
    'newest first'
  );
  const [loc, acc, price, gone] = r.notifications;
  assert.equal(loc.watch.bought_from.id, state.ourIds.robin, 'our watch and our client');
  assert.equal(loc.place, 'Dubai');
  assert.equal(loc.words, 'Location: — → Out with Client · Josh');
  assert.equal(acc.words, 'Accessories updated: marked present: Papers');
  assert.equal(acc.watch.sold_to.id, state.ourIds.kashif);
  assert.equal(price.words, 'Price updated: B2B USD 50,000');
  assert.equal(price.detail.b2b_was, 'USD 48,000');
  assert.equal(gone.watch, null, 'not one of ours');
  assert.deepEqual(r.by_type, [{ type: 'location', n: 2 }, { type: 'accessory', n: 1 }, { type: 'price', n: 1 }]);
  assert.equal(r.pending, 1);

  assert.deepEqual(
    r.holders.map((h) => [h.stock_no, h.status, h.holder, h.where, h.from_polish, h.row_gone, h.place]),
    [
      ['4101', 'Out with Client', 'Josh', 'client', false, false, 'Dubai'],
      ['4102', 'Gold Souk', 'Asif', 'souk', true, false, 'Dubai'],
      ['4103', 'In Home', '', 'vault', false, true, 'Dubai'],
    ],
    'newest first; a watch at polish shows as Gold Souk with its polisher (the vault’s own rule); a row the app dropped is named through the vault’s notification'
  );
  assert.equal(r.holders[0].watch.stock_no, '4101');
  assert.equal(r.holders[2].brand, 'Cartier');
  assert.deepEqual(r.holders_by_where, [{ where: 'client', n: 1 }, { where: 'souk', n: 1 }, { where: 'vault', n: 1 }]);

  const facts = await m.pages.factsFor(['4101', '4102']);
  assert.deepEqual(
    facts.get('4101').find((f) => f.page === 'vaultactivity'),
    { page: 'vaultactivity', text: 'Vault: out with Josh (Dubai), 5 Aug 2026', link: '#/logistics/vaultactivity', tone: 'warn' }
  );
  assert.deepEqual(
    facts.get('4102').find((f) => f.page === 'vaultactivity'),
    { page: 'vaultactivity', text: 'Vault: at the Gold Souk with Asif (Dubai), 1 Aug 2026', link: '#/logistics/vaultactivity', tone: 'warn' }
  );
});

test('other receiving pics: entries newest first, pictures as our copies, the typed name linked as far as it goes, the stock number our watch', async () => {
  const r = await m.pages.page('otherreceiving');
  assert.deepEqual(
    r.entries.map((e) => [e.client_name, e.photos.length, e.stock_nos]),
    [['Walk-in', 0, ['4101']], ['Kashif Rana', 2, []]]
  );
  const [walkIn, kashif] = r.entries;
  assert.equal(walkIn.link, null);
  assert.equal(walkIn.watches[0].stock_no, '4101');
  assert.equal(walkIn.watches[0].bought_from.id, state.ourIds.robin);
  assert.equal(kashif.link.client_id, state.ourIds.kashif);
  assert.ok(kashif.photos.every((p) => /^lgfile:\d+$/.test(p)), 'copied here, served behind the sign-in');
  assert.equal(kashif.notes, 'passport copy');
  assert.equal(kashif.created_at, new Date(1787670409711).toISOString());
  assert.equal(r.photos, 2);

  const facts = await m.pages.factsFor(['4101']);
  const fact = facts.get('4101').find((f) => f.page === 'otherreceiving');
  assert.equal(fact.text, 'Receiving pictures from Walk-in, 25 Aug 2026');
  assert.equal(fact.link, `#/lg/${walkIn.id}`);
});

test('the API serves each page to anyone signed in, and nothing to anyone else', async () => {
  let cookie = '';
  const call = async (url, body) => {
    const headers = { 'X-Requested-With': 'masterapp' };
    if (cookie) headers.Cookie = cookie;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(api + url, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
  for (const key of ['companies', 'shipmentdocs', 'log', 'vaultactivity', 'otherreceiving']) assert.equal((await call(`/api/logistics/page/${key}`)).status, 401, key);
  await call('/api/login', { email: 'boss@example.com', password: 'admin-password-1' });
  const docs = await call('/api/logistics/page/shipmentdocs');
  assert.equal(docs.status, 200);
  assert.equal(docs.body.docs.length, 3);
  const file = await fetch(`${api}/api/logistics/files/${docs.body.docs[1].file.ref.slice(7)}?download=1`, { headers: { Cookie: cookie } });
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('content-disposition') || '', /attachment/);
  for (const key of ['companies', 'log', 'vaultactivity', 'otherreceiving']) assert.equal((await call(`/api/logistics/page/${key}`)).status, 200, key);
});
