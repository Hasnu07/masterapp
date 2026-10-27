import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';

/*
 * The four Dubai-side pages of the logistics app, as masterapp shows them:
 * Driver Deliveries, Pickup Codes, Logistics Addresses and Gold Souk. A
 * stand-in worker holds a small document; a real Postgres (TEST_DATABASE_URL)
 * is EMPTIED first; the sync copies it; then each page's data, its links to
 * our watches and clients, its figures, and what it says on a watch.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let worker, base, m, db, dataDir, server, api, state;

function fixture() {
  return {
    settings: { fobPassword: 'secret-fob' },
    clients: [
      { id: 'c1', name: 'Parsa Nouri', country: 'UAE' },
      { id: 'c2', name: 'Sina Star', country: 'UAE' },
      { id: 'c3', name: 'Fiaz' },
    ],
    londonStock: [],
    dubaiStock: [],
    hkStock: [],
    safeStock: [],
    soldStocks: [],
    incomings: [],
    shipments: [],
    logisticCosts: [],
    driverDeliveries: [
      {
        id: 'dd1', driverName: 'Fiaz', dateGiven: '2026-06-23', stockNumbers: '4101', destination: 'Parsa Nouri', notes: '', status: 'delivered',
        deliveredTo: 'Parsa Nouri', deliveryLocation: 'Dubai Marina', deliveredDate: '2026-06-23', moneyCurrency: 'AED', moneyCollected: 400000,
        deliveryNotes: 'Watch delivered and cash collected', givenPhotos: [], deliveryPhotos: ['https://example.com/proof.jpg', `${base}/photos/p1.jpg`], ts: 1782223671517,
      },
      { id: 'dd2', driverName: 'Fiaz', dateGiven: '2026-08-03', stockNumbers: 'DAV Links', destination: 'UK', notes: '2 links', status: 'delivered', deliveredTo: 'UK', deliveredDate: '2026-08-04', moneyCurrency: 'AED', moneyCollected: 0, ts: 1785757376474 },
      { id: 'dd3', driverName: 'Imran', dateGiven: '2026-10-20', stockNumbers: '4102, 4199', destination: 'Gold souk', notes: 'collect AED 50k', status: 'out', givenPhotos: [`${base}/photos/p1.jpg`], ts: 1790000000000 },
      { id: 'dd4', driverName: 'Imran', dateGiven: '2026-10-21', stockNumbers: '4101', destination: 'Back to office', status: 'returned', ts: 1790000100000 },
      { id: 'dd5', driverName: 'Fiaz', dateGiven: '2026-09-01', stockNumbers: '-', destination: 'Bank', status: 'delivered', deliveredDate: '2026-09-01', moneyCurrency: 'USD', moneyCollected: 1000, ts: 1788000000000 },
    ],
    logisticsAddresses: [
      { id: 'la1', name: 'Grand Horology Limited', address: 'Grand Horology Limited\nRoom 1007, 10/F, Star House\n3 Salisbury Road, Tsim Sha Tsui\nKowloon, HKSAR', notes: '', createdAt: '2026-06-22T22:14:17.514Z' },
      { id: 'la2', name: 'Nicholas email', address: 'nicholas@example.com', notes: '', createdAt: '2026-08-06T13:49:14.849Z' },
      { id: 'la3', name: 'Link of invoice', address: 'https://example.com/invoices/1', notes: 'the May invoice', createdAt: '2026-07-08T08:49:32.206Z' },
      { id: 'la4', name: 'Dubai Home', address: 'Recipient: Ummay Abbas\nBuilding: Grand Address\nApartment: 3902, Tower 1, Creek Harbour\nDubai, UAE\n+971 58 549 1619', notes: 'buzz 42', createdAt: '2026-06-22T22:14:47.173Z' },
    ],
    pickupCodes: [
      {
        id: 'pc1', type: 'pickup', code: '01GEB37Z1G', messageA: 'Please collect 5000HKD', messageB: 'Guy will collect from you 5000HKd', addressId: 'la1', address: 'an old copy of the address', addressName: 'Grand Horology Limited',
        date: '2026-09-28', timeFrom: '16:30', timeTo: '18:30', personA: null, personB: null, messageSentA: null, messageSentB: null, status: 'pending', notes: '', createdAt: '2026-09-28T10:31:36.949Z',
      },
      {
        id: 'pc2', type: 'delivery', code: 'QFEUX8SN0V', messageA: 'Please deliver Stock # 4101 to the shop', messageB: 'Guy will bring 4101', addressId: '', address: '', addressName: '',
        date: '2026-06-24', timeFrom: '18:00', timeTo: '', personA: { id: '120363418803258211@g.us', name: 'Hk Office shipments' }, personB: { id: '971500000000@c.us', name: 'RK x Hasan' },
        messageSentA: 1782293365835, messageSentB: 1782216772968, status: 'completed', completedAt: '2026-06-25T10:22:29.369Z', notes: 'Call first', createdAt: '2026-06-23T12:12:51.396Z',
      },
      { id: 'pc3', type: 'pickup', code: 'ZZZ', messageA: 'collect 4199', messageB: '', addressId: 'la-gone', address: 'Grand Horology Limited\nRoom 1007, 10/F, Star House\n3 Salisbury Road, Tsim Sha Tsui\nKowloon, HKSAR', addressName: 'Grand Horology Limited', date: '2026-05-01', status: 'cancelled', createdAt: '2026-05-01T00:00:00.000Z' },
    ],
    goldSoukTasks: [
      { id: 'g1', shopName: 'Sina Star', whoGoing: 'Fiaz', date: '2026-09-28', taking: 'Need to go to Sina Star and collect Watches', notes: '', photos: [], status: 'pending', resultPhotos: [], ts: 1790601209049 },
      { id: 'g2', shopName: 'Syed Khalil', whoGoing: 'Fiaz', date: '2026-06-22', taking: 'Stock # 4101 5212A-001', notes: 'Need to give today', status: 'done', completedAt: 1782309223992, resultNotes: 'delivered', resultPhotos: [`${base}/photos/p1.jpg`], ts: 1782120956223 },
      { id: 'g3', shopName: 'Asif', whoGoing: 'Jonny', date: '2026-06-19', taking: 'Stock #: 4199 Rolex · 126508', notes: '', status: 'done', completedAt: 1782119906648, resultNotes: '', ts: 1781869601235 },
      { id: 'g4', shopName: 'Sina Star', whoGoing: 'Fiaz', date: '2026-06-30', taking: '5811 need to give today', notes: '', status: 'done', completedAt: 1782986703613, ts: 1782825948518 },
      { id: 'g5', shopName: 'Arsalan', whoGoing: 'Fiaz', date: '2026-06-20', taking: 'cash', notes: '- collect 100.000 aed from Asif - give 200+100=300 to Arslan', photos: ['https://example.com/cash.jpg'], status: 'done', completedAt: 1782117053569, resultNotes: 'done', ts: 1782117046228 },
      { id: 'g6', shopName: 'Ben', whoGoing: 'Fiaz', date: '2026-06-16', taking: 'Datejust and 4102  Daytona', notes: '', status: 'pending', ts: 1781612779447 },
    ],
    activity: [],
  };
}

before(async () => {
  const photo = Buffer.from(
    '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64'
  );
  worker = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/rates/live') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ data: { rates: { USD: '1', EUR: '0.9', GBP: '0.8', AED: '3.6725', HKD: '7.8', CHF: '0.9' } } }));
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
    if (url.pathname === '/photos/p1.jpg') {
      res.setHeader('Content-Type', 'image/jpeg');
      return res.end(photo);
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => worker.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${worker.address().port}`;
  state = fixture();

  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-lg-dubai-'));
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
    dd: await import('../src/logistics/pages/driverdeliveries.js'),
    pc: await import('../src/logistics/pages/pickupcodes.js'),
    la: await import('../src/logistics/pages/addresses.js'),
    gs: await import('../src/logistics/pages/goldsouk.js'),
  };
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/auth/index.js')).ensureFirstAdmin(() => {});
  db = m.db.query;
  server = (await import('../src/web/server.js')).createServer().listen(0);
  api = `http://127.0.0.1:${server.address().port}`;

  // Our watches and clients: 4101 sold to Parsa (bought from Khawar), 4102 in stock; 4199 is nobody's.
  const seller = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Khawar', 'Saeed', 'manual') RETURNING id")).rows[0].id;
  const buyer = (await db("INSERT INTO clients(forename, surname, origin) VALUES ('Parsa', 'Nouri', 'manual') RETURNING id")).rows[0].id;
  await db(
    "INSERT INTO watches(stock_no, brand, model, reference, origin, status, purchased_from_client_id, sold_to_client_id) VALUES ('4101', 'Richard Mille', 'Automatic Oversize Date', 'RM 032', 'manual', 'sold', $1, $2)",
    [seller, buyer]
  );
  await db("INSERT INTO watches(stock_no, brand, model, origin, status) VALUES ('4102', 'Rolex', 'Daytona', 'manual', 'in_stock')");
  Object.assign(state, { ourSeller: seller, ourBuyer: buyer });
  await m.sync.syncLogistics();
});

after(async () => {
  server.close();
  worker.close();
  await m.db.pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/* ── stock numbers typed into words ── */

test('stock numbers in words: "Stock # n" always, a bare number only as a candidate; references and sums never', () => {
  const { stockNosIn } = m.gs;
  assert.deepEqual(stockNosIn('Stock # 1229 5212A-001'), { explicit: ['1229'], bare: [] });
  assert.deepEqual(stockNosIn('Stock #: 1402 Rolex · 126508'), { explicit: ['1402'], bare: [] });
  assert.deepEqual(stockNosIn('5269R-001 Stock 1212'), { explicit: ['1212'], bare: [] });
  assert.deepEqual(stockNosIn('1229 - PP 5212'), { explicit: [], bare: ['1229', '5212'] });
  assert.deepEqual(stockNosIn('Datejust and 1411  Daytona'), { explicit: [], bare: ['1411'] });
  assert.deepEqual(stockNosIn('5712/1R and 7010G-013', 'Take 5980/1400G-001 Links'), { explicit: [], bare: [] }, 'a reference is no stock number');
  assert.deepEqual(stockNosIn('- collect 100.000 aed from Asif - give 200+100=300 to Arslan', '223,900 Cash', '5000HKD'), { explicit: [], bare: [] }, 'sums and amounts are no stock numbers');
  assert.deepEqual(stockNosIn('collect #1668 and 1700'), { explicit: ['1668'], bare: ['1700'] });
});

/* ── driver deliveries ── */

test('driver deliveries: out until delivered, money in dollars at the converter’s rates, every number our watch and its buyer', async () => {
  const r = await m.pages.page('driverdeliveries');
  assert.deepEqual(r.counts, { out: 2, delivered: 3 }, "'out' and 'returned' are both out — the app's own rule");
  assert.deepEqual(r.money.by_currency, { AED: 400000, USD: 1000 });
  assert.equal(r.money.usd, Math.round(400000 / 3.6725 + 1000), 'at the converter’s rates, not the app’s 0.27');
  assert.deepEqual(r.money.missing, []);
  assert.deepEqual(r.out.map((x) => x.id > 0 && x.driver), ['Imran', 'Imran']);
  assert.deepEqual(
    r.out.map((x) => [x.date_given, x.status_word]),
    [
      ['2026-10-21', 'returned'],
      ['2026-10-20', 'out'],
    ],
    'newest first'
  );
  const out = r.out.find((x) => x.stock_text === '4102, 4199');
  assert.deepEqual(
    out.stocks.map((s) => [s.no, s.watch?.status || null]),
    [
      ['4102', 'in_stock'],
      ['4199', null],
    ],
    'each number as typed: ours with its status, a stranger with none'
  );
  assert.equal(out.given_photos.length, 1, 'the worker’s photo was copied');
  assert.match(out.given_photos[0].file, /^lgfile:\d+$/);
  const parsa = r.delivered.find((x) => x.stock_text === '4101');
  assert.deepEqual(parsa.stocks[0].watch.sold_to, { id: state.ourBuyer, name: 'Parsa Nouri' }, 'the buyer the driver delivered to, by Chrono Key’s id');
  assert.deepEqual(parsa.stocks[0].watch.bought_from, { id: state.ourSeller, name: 'Khawar Saeed' });
  assert.deepEqual(parsa.money, { amount: 400000, currency: 'AED' });
  assert.equal(parsa.driver_link?.lg_client_id > 0, true, 'the driver is a logistics client');
  assert.equal(parsa.delivered_to_link?.lg_client_id > 0, true, 'the typed "delivered to" links to the logistics client of that name');
  assert.deepEqual(
    parsa.delivery_photos.map((p) => Object.keys(p)[0]),
    ['url', 'file'],
    'a picture the app kept elsewhere is only a link; the worker’s one is held here'
  );
  const links = r.delivered.find((x) => x.stock_text === 'DAV Links');
  assert.deepEqual(links.stocks, [{ no: 'DAV Links', watch: null }], 'words that are no watch stay words');
  assert.equal(links.money, null, 'zero collected is nothing collected');
  const bank = r.delivered.find((x) => x.stock_text === '-');
  assert.deepEqual(bank.stocks, [], '"-" is the app’s own "none"');
});

/* ── pickup codes ── */

test('pickup codes: pending / completed / total, the saved address read live, the messages as the app sends them, a number in a message our watch', async () => {
  const r = await m.pages.page('pickupcodes');
  assert.deepEqual(r.counts, { pending: 1, completed: 1, total: 3 });
  assert.deepEqual(
    r.codes.map((c) => [c.code, c.status, c.type]),
    [
      ['01GEB37Z1G', 'pending', 'pickup'],
      ['QFEUX8SN0V', 'completed', 'delivery'],
      ['ZZZ', 'cancelled', 'pickup'],
    ],
    'newest first; any other status is cancelled, as the app shows it'
  );
  const hk = r.codes[0];
  assert.equal(hk.address.saved, true);
  assert.match(hk.address.address, /^Grand Horology Limited\nRoom 1007/, 'the saved address, not the copy the code kept');
  assert.equal(hk.address.id > 0, true, 'the address links to its own record');
  assert.equal(hk.created_at, '2026-09-28T10:31:36.949Z', 'the time it was made is kept');
  assert.equal(
    hk.text_a,
    'Please collect 5000HKD\nGrand Horology Limited\nRoom 1007, 10/F, Star House\n3 Salisbury Road, Tsim Sha Tsui\nKowloon, HKSAR\n\n⏰ Time: 16:30 - 18:30\n📅 Date: 28 September 2026\n\n🔑 Pickup code: 01GEB37Z1G'
  );
  assert.equal(hk.text_b, 'Guy will collect from you 5000HKd\n\n⏰ Time: 16:30 - 18:30\n📅 Date: 28 September 2026\n\n🔑 Pickup code: 01GEB37Z1G');
  assert.deepEqual([hk.person_a, hk.sent_a], [null, null]);

  const done = r.codes[1];
  assert.deepEqual(done.person_a, { name: 'Hk Office shipments', group: true });
  assert.deepEqual(done.person_b, { name: 'RK x Hasan', group: false });
  assert.equal(done.sent_a, new Date(1782293365835).toISOString());
  assert.equal(done.address, null);
  assert.equal(done.text_a, 'Please deliver Stock # 4101 to the shop\n\n⏰ Time: 18:00\n📅 Date: 24 June 2026\n\n🔑 Pickup code: QFEUX8SN0V', 'no address line when none is set; the time alone');
  assert.deepEqual(done.stocks.map((s) => [s.no, s.watch?.stock_no, s.watch?.sold_to?.name]), [['4101', '4101', 'Parsa Nouri']], 'the number in the message is our watch, with its buyer');
  assert.equal(done.completed_at, '2026-06-25T10:22:29.369Z');

  const gone = r.codes[2];
  assert.equal(gone.address.saved, false, 'an address the app no longer lists: the words the code kept');
  assert.equal(gone.address.name, 'Grand Horology Limited');
  assert.deepEqual(gone.stocks, [], 'a bare number that is not our watch is no stock number');
});

/* ── addresses ── */

test('addresses: as saved, each with the pickup codes that use it (by id, else the same words), a map link only for a place', async () => {
  const r = await m.pages.page('addresses');
  assert.equal(r.count, 4);
  assert.equal(r.in_use, 1);
  assert.deepEqual(
    r.addresses.map((a) => [a.name, a.kind]),
    [
      ['Grand Horology Limited', 'place'],
      ['Dubai Home', 'place'],
      ['Link of invoice', 'link'],
      ['Nicholas email', 'email'],
    ],
    'oldest first, as the app lists them'
  );
  const hk = r.addresses[0];
  assert.deepEqual(
    hk.used_by.map((u) => [u.code, u.status]),
    [
      ['01GEB37Z1G', 'pending'],
      ['ZZZ', 'cancelled'],
    ],
    'by the app’s addressId, and by the same words when the id is gone'
  );
  assert.equal(hk.map_url, `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('Grand Horology Limited, Room 1007, 10/F, Star House, 3 Salisbury Road, Tsim Sha Tsui, Kowloon, HKSAR')}`);
  const home = r.addresses[1];
  assert.equal(home.map_url, `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('Building: Grand Address, Apartment: 3902, Tower 1, Creek Harbour, Dubai, UAE')}`, 'the recipient and the phone number are not part of a place');
  assert.equal(home.notes, 'buzz 42');
  assert.equal(r.addresses[2].map_url, '', 'a web link is not on a map');
  assert.equal(r.addresses[3].map_url, '', 'nor an e-mail');
  assert.deepEqual(r.addresses[3].used_by, []);
  assert.equal(m.la.kindOfAddress('Chrono24UK\nThe Victorian Barn\nHadham Road\nCM23 1JG\n+44 7704 005473\nestival@example.com'), 'place', 'a place with its phone and e-mail is still a place');
  assert.equal(m.la.kindOfAddress('fullname@example.com\ntk7stbjeuFxmMarino2'), 'email');
});

/* ── gold souk ── */

test('gold souk: open and completed as the app, by person and by shop, every number in a task our watch, the shop linked by name', async () => {
  const r = await m.pages.page('goldsouk');
  assert.deepEqual(r.counts, { open: 2, done: 4 });
  assert.deepEqual(r.people, [
    { name: 'Fiaz', n: 5 },
    { name: 'Jonny', n: 1 },
  ]);
  assert.deepEqual(
    r.shops.map((s) => [s.name, s.n]),
    [
      ['Sina Star', 2],
      ['Arsalan', 1],
      ['Asif', 1],
      ['Ben', 1],
      ['Syed Khalil', 1],
    ]
  );
  assert.deepEqual(r.open.map((t) => t.shop), ['Sina Star', 'Ben'], 'newest first');
  const ben = r.open[1];
  assert.deepEqual(ben.stocks.map((s) => [s.no, s.watch?.status]), [['4102', 'in_stock']], 'a bare number that is our watch');
  const khalil = r.done.find((t) => t.shop === 'Syed Khalil');
  assert.deepEqual(khalil.stocks.map((s) => [s.no, s.watch?.sold_to?.name, s.watch?.bought_from?.name]), [['4101', 'Parsa Nouri', 'Khawar Saeed']], 'our watch with both its clients');
  assert.equal(khalil.completed_at, new Date(1782309223992).toISOString());
  assert.equal(khalil.result_notes, 'delivered');
  assert.match(khalil.result_photos[0].file, /^lgfile:\d+$/);
  const asif = r.done.find((t) => t.shop === 'Asif');
  assert.deepEqual(asif.stocks, [{ no: '4199', watch: null }], '"Stock #: 4199" is a stock number even when we do not hold it');
  const sina = r.done.find((t) => t.taking.startsWith('5811'));
  assert.deepEqual(sina.stocks, [], 'a bare reference is no stock number');
  assert.equal(sina.shop_link?.lg_client_id > 0, true, 'the shop is a logistics client');
  assert.equal(sina.shop_link.client_id, null, 'not one of ours by name alone');
  const arsalan = r.done.find((t) => t.shop === 'Arsalan');
  assert.deepEqual(arsalan.stocks, [], 'sums of money are no stock numbers');
  assert.deepEqual(arsalan.photos, [{ url: 'https://example.com/cash.jpg' }]);
  assert.equal(arsalan.shop_link, null, 'a name no logistics client carries links nowhere');
});

/* ── what each page says on a watch ── */

test('on our watch: with a driver, delivered, a pickup code, a gold souk task — and nothing from the addresses', async () => {
  const { rows } = await db("SELECT * FROM logistics_items WHERE deleted_at IS NULL AND kind IN ('driverDeliveries', 'pickupCodes', 'goldSoukTasks', 'logisticsAddresses') ORDER BY id");
  const facts = (no) =>
    [...m.dd.forStock(no, rows), ...m.pc.forStock(no, rows), ...m.gs.forStock(no, rows), ...m.la.forStock(no, rows)].map((f) => [f.text, f.tone, /^#\/lg\/\d+$/.test(f.link)]);
  assert.deepEqual(facts('4102'), [
    ['With driver Imran to Gold souk since 20 Oct 2026 — collect AED 50k', 'move', true],
    ['Gold souk: Datejust and 4102  Daytona with Fiaz at Ben (open)', 'move', true],
  ]);
  assert.deepEqual(facts('4101'), [
    ['Delivered by driver Fiaz to Parsa Nouri, 23 Jun 2026, collected AED 400,000', 'good', true],
    ['With driver Imran to Back to office since 21 Oct 2026', 'move', true],
    ['Delivery code QFEUX8SN0V for Hk Office shipments (completed)', 'good', true],
    ['Gold souk: Stock # 4101 5212A-001 with Fiaz at Syed Khalil (done)', 'good', true],
  ]);
  assert.deepEqual(facts('4199').map((f) => f[0]), ['With driver Imran to Gold souk since 20 Oct 2026 — collect AED 50k', 'Pickup code ZZZ at Grand Horology Limited (cancelled)', 'Gold souk: Stock #: 4199 Rolex · 126508 with Jonny at Asif (done)']);
  // Through the shared reader, the driver's facts reach the watch (its row carries the number); the others once stock_nos carries theirs.
  const all = await m.pages.factsFor(['4102']);
  assert.ok(all.get('4102').some((f) => f.page === 'driverdeliveries' && /With driver Imran/.test(f.text)));
});

/* ── the API ── */

test('the API serves each page behind the sign-in', async () => {
  let cookie = '';
  const call = async (method, url, body) => {
    const headers = { 'X-Requested-With': 'masterapp' };
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(api + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  assert.equal((await call('GET', '/api/logistics/page/goldsouk')).status, 401);
  assert.equal((await call('POST', '/api/login', { email: 'boss@example.com', password: 'admin-password-1' })).status, 200);
  for (const [key, check] of [
    ['driverdeliveries', (b) => b.counts.delivered === 3],
    ['pickupcodes', (b) => b.counts.total === 3],
    ['addresses', (b) => b.count === 4],
    ['goldsouk', (b) => b.counts.open === 2],
  ]) {
    const r = await call('GET', `/api/logistics/page/${key}`);
    assert.equal(r.status, 200, key);
    assert.ok(check(r.body), key);
  }
});
