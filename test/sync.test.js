import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { startChronoKey, startVault, HEADERS, PRODUCTS, GRID, DETAILS, EXPENSES, CLIENTS, LISTS, picture } from './fakes.js';

/*
 * The import and sync, end to end, against stand-ins for Chrono Key and the
 * vault and a real Postgres (TEST_DATABASE_URL, default a local one). The
 * database is EMPTIED first — never point this at a database you care about.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let ck, vault, m, db, dataDir;

before(async () => {
  ck = await startChronoKey();
  vault = await startVault();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-test-'));
  Object.assign(process.env, {
    DATABASE_URL: DB,
    DATA_DIR: dataDir,
    CHRONOKEY_URL: ck.url,
    CHRONOKEY_USERNAME: 'ck-user',
    CHRONOKEY_PASSWORD: 'ck-pass',
    VAULT_URL: vault.url,
    VAULT_TOKEN: 'vault-key',
    SYNC_PAUSE_MS: '0',
  });
  const reset = new pg.Client({ connectionString: DB });
  await reset.connect();
  await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await reset.end();

  m = {
    db: await import('../src/db/index.js'),
    migrate: await import('../src/db/migrate.js'),
    ck: await import('../src/import/chronokey/sync.js'),
    vault: await import('../src/import/vault/sync.js'),
    list: await import('../src/import/listimport.js'),
    watches: await import('../src/watches/index.js'),
    client: await import('../src/import/chronokey/client.js'),
    ckClients: await import('../src/import/chronokey/clients.js'),
    clients: await import('../src/clients/index.js'),
    ckExpenses: await import('../src/import/chronokey/expenses.js'),
    expenses: await import('../src/expenses/index.js'),
    gone: await import('../src/import/gone.js'),
  };
  await m.migrate.migrate({ log: () => {} });
  db = m.db.query;
});

after(async () => {
  ck.close();
  vault.close();
  await m.db.pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const watch = async (stock) => (await db('SELECT * FROM watches WHERE stock_no = $1', [stock])).rows[0];
const photos = async (id, all = false) =>
  (await db(`SELECT * FROM watch_photos WHERE watch_id = $1 ${all ? '' : 'AND deleted_at IS NULL'} ORDER BY sort`, [id])).rows;

test('the live product grid becomes our watches, read by its own field names', async () => {
  const s = await m.ck.syncList();
  assert.equal(s.created, 3);
  const a = await watch('1668');
  assert.equal(a.brand, 'Rolex', 'makeName');
  assert.equal(a.reference, '278274', 'subModel is the reference');
  assert.equal(a.case_material, 'SS', 'material');
  assert.equal(a.ck_product_id, 9001, 'id is the Product ID');
  assert.equal(a.purchased_from, 'Dealer One', 'double spaces tidied');
  assert.equal(a.order_type, 'INVENTORY', 'the grid writes R');
  assert.equal(a.purchase_price, 46000);
  assert.equal(a.purchase_currency, 'AED', 'read from the description, not the (£) heading');
  assert.deepEqual(a.purchase_payments, { cash: 46000 }, 'zeros are not payments');
  assert.deepEqual(a.sale_payments, { crypto: 14000 }, 'saleCrypto is the sale');
  assert.equal(a.sale_currency, '', 'never assumed');
  assert.equal(a.retail_price, 11538, "wholeSalePrice is the export's Retail Price");
  assert.equal(a.website_price, 11900, "retailPrice is the export's Website Price");
  assert.equal(a.watch_date, '03/2026');
  assert.equal(a.purchase_date, '2026-09-05', 'the day of an ISO date with a clock time');
  assert.equal(a.sale_date, '2026-09-25');
  assert.equal(a.status, 'sold');
  assert.equal(a.box, false);
  assert.equal(a.papers, true);
  assert.equal(a.service_papers, false);
  const b = await watch('1700');
  assert.equal(b.location, 'Europe', 'Category "Watch" is Europe');
  assert.deepEqual(b.purchase_payments, { bank: 98000 }, 'purchaseWire is a bank transfer');
  assert.equal(b.ck_id, 26002, "the grid names no page, but the Inventory tab's card does");
  assert.equal(s.lists.trusted, true, JSON.stringify(s.lists));
  assert.equal(s.statusFrom, 'lists');
  assert.equal(b.status, 'in_stock', 'on the Inventory tab');
  assert.equal(b.purchase_currency, '', 'no description, no currency');
  assert.equal((await watch('1701')).status, 'incoming', 'on the incoming page and unsold');
});

test("a watch returned to its client is not in stock here: Chrono Key's own lists decide", async () => {
  const w = await watch('1700');
  const statusEvents = async () =>
    (await db("SELECT changes->'status' AS s FROM watch_events WHERE watch_id = $1 AND action = 'sync' AND changes ? 'status' ORDER BY id", [w.id])).rows.map((r) => r.s);
  const why = async () => (await m.watches.getWatch(w.id)).status_why;
  assert.equal((await why()).ck.lists.inventory.badge, 'Available');

  // 1722's case: off the Inventory tab, on Returned consignments. (An empty
  // tab is never real, and is refused: another watch stays on it.)
  LISTS.inventory = ['1999'];
  LISTS.returned = ['1700'];
  try {
  let s = await m.ck.syncList();
  assert.equal(s.statusFrom, 'lists');
  assert.deepEqual(s.statusMoves, { 'in_stock→returned': 1 });
  assert.equal((await watch('1700')).status, 'returned');
  assert.deepEqual((await why()).ck.lists.returned, { date: '2026-10-16', ck_id: 26002 });
  assert.deepEqual(await statusEvents(), [['in_stock', 'returned']]);

  // A sold watch still on To-be-shipped (1708, 1737) stays sold.
  LISTS.incoming.push('1668');
  await m.ck.syncList();
  assert.equal((await watch('1668')).status, 'sold');
  LISTS.incoming.pop();

  // Reads that cannot be trusted change no status — they never put it back on the shelf.
  for (const [broken, declared, reason] of [
    ['card', null, /cards without a readable stock number/],
    ['returned', null, /no table with STOCK NUMBER and RETURN DATE/],
    [null, 5, /the page declares 5/],
  ]) {
    Object.assign(LISTS, { broken, declared });
    s = await m.ck.syncList();
    assert.equal(s.lists.trusted, false);
    assert.match(s.lists.why.join(' '), reason);
    assert.equal(s.statusFrom, 'no trusted lists: statuses kept');
    assert.equal((await watch('1700')).status, 'returned', `still returned (${reason})`);
    assert.equal((await watch('1701')).status, 'incoming', 'To-be-shipped still read');
  }
  Object.assign(LISTS, { broken: null, declared: null });
  const csv = [HEADERS, ...PRODUCTS].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  await m.list.importProductCsv(csv);
  assert.equal((await watch('1700')).status, 'returned', 'nor does a CSV upload');
  assert.deepEqual(await statusEvents(), [['in_stock', 'returned']], 'no flip back and forth in the history');

  // On no list: kept for one pass (it may be moving between two), then 'other'.
  // (Several returned last time and none now would be refused: only one was.)
  LISTS.returned = [];
  await m.ck.syncList();
  assert.equal((await watch('1700')).status, 'returned', 'one pass on no list: kept');
  await m.ck.syncList();
  assert.equal((await watch('1700')).status, 'other', 'two in a row: other');
  assert.equal((await why()).ck.lists.none, 2);

  // A status set here stands, and the page says so.
  await m.watches.updateWatch(w.id, { status: 'reserved' }, null);
  LISTS.inventory = ['1700', '1999'];
  await m.ck.syncList();
  assert.equal((await watch('1700')).status, 'reserved');
  assert.equal((await why()).locked, true);
  await m.watches.unlockField(w.id, 'status', null);
  await m.ck.syncList();
  assert.equal((await watch('1700')).status, 'in_stock', 'handed back: on the tab again');
  } finally {
    Object.assign(LISTS, { inventory: ['1700'], incoming: ['1701'], returned: [], declared: null, broken: null });
  }
});

test('a mass change of statuses is refused once, and taken when the next read says the same', () => {
  const sixty = Array.from({ length: 60 }, (_, i) => ({ fields: { stock_no: String(5000 + i), status: 'in_stock' } }));
  const known = new Map(sixty.map(({ fields: f }) => [f.stock_no, { status: 'in_stock', locked: false }]));
  known.set('5000', { status: 'reserved', locked: true });
  const lists = { incoming: new Map(), inventory: new Map(), returned: new Map(sixty.map(({ fields: f }) => [f.stock_no, { date: null, ckId: null }])) };

  const first = m.list.planStatuses(sixty, { lists, known });
  assert.match(first.statusFrom, /^refused: 59 statuses/, 'the locked one is not even proposed');
  assert.equal(first.proposal.length, 59);
  assert.ok([...first.statuses.values()].every((s) => s === undefined), 'nothing moves');
  assert.equal(first.onLists.size, 0, 'nor is the read kept');

  const second = m.list.planStatuses(sixty, { lists, known, previous: first.proposal });
  assert.match(second.statusFrom, /the same change on two reads in a row/);
  assert.equal(second.statuses.get('5001'), 'returned');
  assert.equal(second.statuses.get('5000'), undefined, 'a status set here stays theirs');
  assert.equal(second.proposal, null);

  // A different change the second time is still a glitch.
  const other = m.list.planStatuses(sixty, { lists, known, previous: first.proposal.slice(0, 20) });
  assert.match(other.statusFrom, /^refused/);
});

test('without a declared total, the Inventory tab is compared with the last read', async () => {
  try {
    LISTS.declared = 'none';
    let s = await m.ck.syncList();
    assert.equal(s.lists.trusted, true, 'the same count as the read before');
    LISTS.inventory = ['1700', ...Array.from({ length: 12 }, (_, i) => String(3000 + i))];
    s = await m.ck.syncList();
    assert.equal(s.lists.trusted, false);
    assert.match(s.lists.why.join(' '), /13 cards, 1 last time, and the page declares no total/);
    s = await m.ck.syncList();
    assert.equal(s.lists.trusted, true, 'seen twice: accepted, not refused for ever');
  } finally {
    Object.assign(LISTS, { inventory: ['1700'], declared: null });
  }
  await m.ck.syncList();
});

test("Chrono Key's clients come across, and every watch is tied to both sides of its deals by id", async () => {
  const s = await m.ckClients.syncClients();
  assert.equal(s.clients, 4);
  assert.equal(s.created, 4);
  const byCk = async (id) => (await db('SELECT * FROM clients WHERE ck_id = $1', [id])).rows[0];
  const one = await byCk('c-one');
  const omar = await byCk('c-omar');
  assert.equal(one.forename, 'Dealer One', 'stray spaces trimmed');
  assert.equal(one.type, 'dealer');
  assert.equal(one.company, 'One Watches LLC');
  assert.equal(one.address, 'Gold Souk 4\nDubai');
  assert.equal(one.country, 'United Arab Emirates');
  assert.equal(omar.type, 'retail');
  assert.equal((await byCk('c-idle')).type, 'retail_company', 'any type but D and I, as Chrono Key shows it');
  assert.equal((await db("SELECT count(*)::int AS n FROM ck_clients")).rows[0].n, 4, 'the raw rows are kept');

  assert.equal((await watch('1668')).purchased_from_client_id, one.id);
  assert.equal((await watch('1668')).sold_to_client_id, omar.id);
  assert.equal((await watch('1700')).sold_to_client_id, null);
  const page = await m.clients.getClient(one.id);
  assert.deepEqual(page.bought.map((w) => w.stock_no), ['1701', '1668'], 'newest purchase first');
  assert.deepEqual((await m.clients.getClient(omar.id)).sold.map((w) => w.stock_no), ['1668']);

  const find = async (q) => (await m.clients.listClients({ q })).clients.map((c) => c.name);
  assert.deepEqual(await find('omar'), ['Omar F']);
  assert.deepEqual(await find('collector'), ['Omar F'], 'by nickname');
  assert.deepEqual(await find('+971501234567'), ['Dealer One'], 'a phone by its digits, however written');
  assert.deepEqual(await find('one watches'), ['Dealer One'], 'by company');
  const listed = (await m.clients.listClients({})).clients.find((c) => c.name === 'Dealer One');
  assert.equal(listed.bought, 2);

  // An edit here, and a link changed here, survive the next read of Chrono Key.
  await m.clients.updateClient(one.id, { forename: 'Dealer One (Dubai)' }, null);
  const w1700 = await watch('1700');
  await m.clients.linkWatch(w1700.id, 'sale', omar.id, null);
  const again = await m.ckClients.syncClients();
  assert.equal(again.created, 0);
  assert.equal(again.watchesLinked, 0, 'nothing moves the second time');
  assert.equal((await byCk('c-one')).forename, 'Dealer One (Dubai)');
  assert.equal((await watch('1700')).sold_to_client_id, omar.id);
  assert.ok((await watch('1700')).locked_fields.includes('sold_to_client'));

  // Handed back: Chrono Key's grid names no buyer for 1700.
  await m.clients.linkWatch(w1700.id, 'sale', 'chronokey', null);
  assert.equal((await watch('1700')).sold_to_client_id, null);
  assert.ok(!(await watch('1700')).locked_fields.includes('sold_to_client'));
  const ev = (await db("SELECT action, changes FROM watch_events WHERE watch_id = $1 ORDER BY id", [w1700.id])).rows;
  assert.deepEqual(ev.find((e) => e.changes.sold_to_client)?.changes.sold_to_client, [null, 'Omar F'], 'the history names the client');
});

test("Chrono Key's expenses: the list, then each one's own page for its currency, rate and payment", async () => {
  const pages = () => ck.calls.filter((c) => c.startsWith('GET /Stock/AddEditExpense/')).length;
  const s = await m.ckExpenses.syncExpenses();
  assert.equal(s.listed, 5);
  assert.equal(s.created, 5);
  assert.equal(s.pages, 5);
  const byCk = async (id) => (await db('SELECT * FROM expenses WHERE ck_id = $1', [id])).rows[0];
  const ferrari = await byCk(2044);
  assert.equal(ferrari.amount, 4300, 'the cost in its own currency, from its page');
  assert.equal(ferrari.currency, 'AED');
  assert.equal(ferrari.exchange_rate, 0.24);
  assert.equal(ferrari.cost_eur, 1032, "the list's booked figure: 4,300 × 0.24");
  assert.equal(ferrari.payment_method, 'cash');
  assert.equal(ferrari.type, 'Logistics Expense');
  assert.equal(ferrari.expense_date, '2026-10-20');
  const meta = await byCk(2041);
  assert.equal(meta.currency, 'USD');
  assert.equal(meta.payment_method, 'card');
  const trip = await byCk(2030);
  assert.equal(trip.currency, 'EUR', "Chrono Key's \"GBP\" is its base, which is euros");
  assert.equal((await byCk(1987)).currency, 'GBP', 'booked under "EUR" at 1.18, and the title says gbp 3,000');
  assert.equal((await byCk(1987)).cost_eur, 3540);
  assert.equal((await byCk(2007)).currency, '', '"EUR" at 1.18 with nothing saying which: not stated, never guessed');
  assert.equal(trip.payment_method, '', 'no payment type picked');
  assert.equal(trip.exclude_from_profit, true);
  assert.equal(trip.description, 'Complete\n2026-10-14 Flight / Ticket EUR 585\nTotal $1,701.8', 'its lines kept');

  // Nothing changed: the list is read, no page is.
  const n = pages();
  const again = await m.ckExpenses.syncExpenses();
  assert.equal(pages(), n, 'no page re-read when its line on the list is unchanged');
  assert.equal(again.created + again.updated, 0);

  // An edit here survives; a change on Chrono Key's list re-reads that one page.
  await m.expenses.updateExpense(meta.id, { title: 'Meta ads — October' }, null);
  EXPENSES[2041].booked = '£180.00';
  EXPENSES[2041].cost = '200.00';
  await m.ckExpenses.syncExpenses();
  assert.equal(pages(), n + 1, 'only the changed expense');
  const meta2 = await byCk(2041);
  assert.equal(meta2.amount, 200);
  assert.equal(meta2.cost_eur, 180);
  assert.equal(meta2.title, 'Meta ads — October', 'the edit made here is kept');

  // Deleted here, it stays deleted.
  await m.expenses.deleteExpense(ferrari.id, null);
  await m.ckExpenses.syncExpenses();
  assert.ok((await byCk(2044)).deleted_at);
  const list = await m.expenses.listExpenses({});
  assert.equal(list.total, 4);
  assert.equal(list.sum_eur, 180 + 1575.93 + 3540 + 590);
  assert.deepEqual((await m.expenses.listExpenses({ q: 'salary' })).expenses.map((e) => e.ck_id), [1987]);
});

test("what Chrono Key drops is removed here, comes back with it — and a person's choice stands", async () => {
  const take = (stock) => GRID.splice(GRID.findIndex((r) => r.stockNumber === stock), 1)[0];
  const events = async (id) => (await db("SELECT action, source FROM watch_events WHERE watch_id = $1 AND action IN ('delete','restore') ORDER BY id", [id])).rows;

  // 1700 deleted here by a person first; then 1700 and 1701 both vanish from Chrono Key.
  const w1700 = await watch('1700');
  await m.watches.deleteWatch(w1700.id, null);
  const r1700 = take(1700);
  const r1701 = take(1701);
  const s = await m.ck.syncList();
  assert.deepEqual(s.goneFromList, { gone: 2, back: 0, refused: 0 });
  assert.equal(s.watchesGone.deleted, 1, "only 1701: 1700 was already a person's deletion");
  const g = await watch('1701');
  assert.ok(g.deleted_at && +g.deleted_at === +g.source_gone_at, 'removed by the sync, and marked so');
  assert.deepEqual(await events(g.id), [{ action: 'delete', source: 'chronokey' }]);

  // They come back: the sync's own deletion is undone, the person's is not.
  GRID.push(r1700, r1701);
  const back = await m.ck.syncList();
  assert.equal(back.watchesGone.restored, 1);
  assert.equal((await watch('1701')).deleted_at, null);
  assert.equal((await watch('1701')).source_gone_at, null);
  assert.ok((await watch('1700')).deleted_at, "a person's deletion stays");

  // Removed by the sync, restored by a person: kept, never removed a second time.
  take(1701);
  await m.ck.syncList();
  await m.watches.restoreWatch(g.id, null);
  await m.ck.syncList();
  assert.equal((await watch('1701')).deleted_at, null, 'a person restored it: it stays');
  GRID.push(r1701);
  await m.ck.syncList();
  assert.equal((await watch('1701')).source_gone_at, null);
  await m.watches.restoreWatch(w1700.id, null);

  // An expense deleted on Chrono Key, then listed again.
  const harissa = EXPENSES[2007];
  delete EXPENSES[2007];
  const ex = await m.ckExpenses.syncExpenses();
  assert.equal(ex.expensesGone.deleted, 1);
  assert.ok((await db('SELECT deleted_at FROM expenses WHERE ck_id = 2007')).rows[0].deleted_at);
  EXPENSES[2007] = harissa;
  assert.equal((await m.ckExpenses.syncExpenses()).expensesGone.restored, 1);
  assert.equal((await db('SELECT deleted_at FROM expenses WHERE ck_id = 2007')).rows[0].deleted_at, null);

  // A client gone from the list: removed when no watch names it, kept while one does.
  const idle = CLIENTS.splice(CLIENTS.findIndex((c) => c.id === 'c-idle'), 1)[0];
  const omar = CLIENTS.splice(CLIENTS.findIndex((c) => c.id === 'c-omar'), 1)[0];
  const cs = await m.ckClients.syncClients();
  assert.equal(cs.clientsGone.deleted, 1, 'Nobody Yet goes; Omar F, who bought 1668, stays');
  assert.ok((await db("SELECT deleted_at FROM clients WHERE ck_id = 'c-idle'")).rows[0].deleted_at);
  assert.equal((await db("SELECT deleted_at FROM clients WHERE ck_id = 'c-omar'")).rows[0].deleted_at, null);
  CLIENTS.push(idle, omar);
  assert.equal((await m.ckClients.syncClients()).clientsGone.restored, 1);

  // A read that lists nothing is never a clear-out.
  assert.equal((await m.gone.markGone(m.db.pool, 'ck_records', 'stock_no', [])).refused, -1);
  assert.equal((await db('SELECT count(*)::int AS n FROM ck_records WHERE gone_at IS NOT NULL')).rows[0].n, 0);
});

test('watch pages bring euro figures, ticks and photos — only from Chrono Key', async () => {
  const s = await m.ck.syncDetails({ mode: 'new' });
  assert.equal(s.done, 3);
  assert.equal(s.failed, 0, JSON.stringify(s.errors));
  const a = await watch('1668');
  assert.equal(a.purchase_price_eur, 10989);
  assert.equal(a.sale_price_eur, 12950);
  assert.equal(a.box, false, "the list's own value is not replaced by the page");
  const pa = await photos(a.id);
  assert.equal(pa.length, 2, 'two gallery photos; the repeat and the data: placeholder not shown');
  assert.deepEqual(pa.map((p) => p.source_ref), ['/images/a1.jpg', '/images/a2.jpg'], 'paths cleaned');
  assert.ok(pa.every((p) => p.source === 'chronokey' && p.thumb_key && p.width === 900 && p.sha256 && p.dhash));
  const repeat = (await photos(a.id, true)).find((p) => p.source_ref === '/images/a1-again.jpg');
  assert.equal(repeat.duplicate_of, pa[0].id, 'a1 under a second name: recorded as a repeat of it');
  assert.equal(repeat.storage_key, null, 'and not stored twice');
  assert.ok(repeat.deleted_at);
  const b = await watch('1700');
  assert.equal(b.ck_id, 26002, 'found through the search');
  assert.equal((await photos(b.id)).length, 1, 'a photo on another host is never fetched');
  assert.equal(b.purchase_currency, 'EUR', 'list figure equal to the euro figure: the deal was in euros');
  assert.equal((await watch('1701')).movement, '4131', 'a blank field filled from the page');
  assert.equal((await photos((await watch('1701')).id, true)).length, 0, "Chrono Key's 'no image' graphic is not a photo");
  assert.ok(!ck.calls.includes('GET /images/no_image.png'), 'and is not even fetched');
  assert.ok(!ck.calls.some((c) => c.includes('evil')));

  const again = await m.ck.syncDetails({ mode: 'new' });
  assert.equal(again.todo, 0, 'nothing left to read');
});

test('an edit made here survives the next sync, and says so in the history', async () => {
  const a = await watch('1668');
  await m.watches.updateWatch(a.id, { sale_price: '14,500', sale_currency: 'usd' }, { id: null });
  await m.ck.syncList();
  await m.ck.syncDetails({ mode: 'full' });
  const after = await watch('1668');
  assert.equal(after.sale_price, 14500);
  assert.equal(after.sale_currency, 'USD');
  assert.deepEqual(after.locked_fields.sort(), ['sale_currency', 'sale_price']);
  const ev = await m.watches.watchEvents(a.id);
  assert.ok(ev.some((e) => e.action === 'update' && e.changes.sale_price));

  await m.watches.unlockField(a.id, 'sale_price', null);
  await m.ck.syncList();
  assert.equal((await watch('1668')).sale_price, 14000, 'handed back, Chrono Key’s value returns');
});

test('a photo removed here is not copied back, and a full re-read copies nothing twice', async () => {
  const a = await watch('1668');
  const [first] = await photos(a.id);
  await m.watches.removePhoto(a.id, first.id, null);
  const fetched = () => ck.calls.filter((c) => c === 'GET /images/a1-again.jpg').length;
  const before = fetched();
  await m.ck.syncDetails({ mode: 'full' });
  assert.equal(fetched(), before, 'a recorded repeat is never fetched again');
  const live = await photos(a.id);
  assert.equal(live.length, 1);
  assert.equal((await photos(a.id, true)).length, 3, 'no duplicate rows');

  // The removed picture turns up under yet another name: still not shown.
  DETAILS[26001].images.push('/images/a1-third.jpg');
  try {
    await m.ck.syncDetails({ mode: 'full' });
  } finally {
    DETAILS[26001].images.pop();
  }
  assert.equal((await photos(a.id)).length, 1, 'a removed picture does not come back under another name');
  const third = (await photos(a.id, true)).find((p) => p.source_ref === '/images/a1-third.jpg');
  assert.equal(third.duplicate_of, first.id);
});

test('the vault adds prices, its photos and the watches only it holds', async () => {
  const s = await m.vault.syncVault();
  const a = await watch('1668');
  assert.equal(a.b2b_price, 13500);
  assert.equal(a.b2b_currency, 'USD');
  assert.equal(a.b2c_price, 52000, 'a zero in the final prices is skipped, not taken');
  assert.equal(a.b2c_currency, 'AED');
  assert.equal(a.chrono24_price, 14900);
  assert.equal(a.chrono24_currency, 'USD');
  assert.equal(a.dial, 'Pink', "Chrono Key's value is not replaced by the vault's");
  assert.equal(a.location, 'Dubai');
  const vp = (await photos(a.id)).filter((p) => p.source === 'vault');
  assert.deepEqual(vp.map((p) => p.source_ref.split('/').pop()), ['v3.jpg'], 'the client copy, a box over a1, is its own picture');
  const all = await photos(a.id, true);
  const v1 = all.filter((p) => p.source_ref.endsWith('/photos/v1.jpg'));
  const a2 = all.find((p) => p.source_ref === '/images/a2.jpg');
  assert.equal(v1.length, 1, 'one row, though the vault names it in two places');
  assert.equal(v1[0].duplicate_of, a2.id, "Chrono Key's a2 saved again: recorded as a repeat, not shown");

  const only = await watch('1800');
  assert.equal(only.origin, 'vault');
  assert.equal(only.brand, 'Audemars Piguet');
  assert.equal(only.b2b_price, 41000);
  assert.equal(only.b2c_price, null, 'placeholder 1 and a currency field holding a note mean no price');
  assert.equal(only.location, 'Dubai');
  assert.equal((await photos(only.id)).length, 1, 'the data: photo is not copied');

  assert.equal((await watch('1700')).b2b_price, null, 'b2bUsd 1 is a placeholder');
  assert.equal(await watch('1900'), undefined, 'a cancelled order does not become a watch');
  assert.equal(s.cancelledSkipped, 1);

  const again = await m.vault.syncVault();
  assert.equal(again.created + again.updated, 0, 'a second read changes nothing');
  assert.equal(again.photos, 0);
});

test('a watch only the vault held goes when the vault drops it; one Chrono Key still lists stays', async () => {
  // While it is there: not in stock — Chrono Key, the master, does not list it.
  const only = await m.watches.getWatch((await watch('1800')).id);
  assert.equal(only.status, 'other');
  assert.deepEqual(only.status_why.vault, ['dubaiStock']);
  assert.equal(only.status_why.ck, null);
  assert.equal((await watch('1801')).status, 'sold', "a sale only the vault records is a sale");

  // Without a complete Chrono Key read in the last day, the vault does not decide this.
  await db('UPDATE watches SET status = $1 WHERE stock_no = $2', ['in_stock', '1800']);
  await db("UPDATE import_runs SET finished_at = finished_at - interval '2 days' WHERE source = 'chronokey' AND mode = 'list'");
  await m.vault.syncVault({ photos: false });
  assert.equal((await watch('1800')).status, 'in_stock', 'left as it was');
  await db("UPDATE import_runs SET finished_at = finished_at + interval '2 days' WHERE source = 'chronokey' AND mode = 'list'");
  await m.vault.syncVault({ photos: false });
  assert.equal((await watch('1800')).status, 'other');

  // A watch added here by hand that the vault also holds keeps the status a
  // person gave it (a manual watch locks nothing, so 'own' would overwrite it).
  await db("UPDATE watches SET origin = 'manual', status = 'reserved' WHERE stock_no = '1800'");
  await m.vault.syncVault({ photos: false });
  assert.equal((await watch('1800')).status, 'reserved', 'a person’s record');
  await db("UPDATE watches SET origin = 'vault' WHERE stock_no = '1800'");
  await m.vault.syncVault({ photos: false });
  assert.equal((await watch('1800')).status, 'other');
  vault.dropped.add('v-1800').add('v-1668');
  const s = await m.vault.syncVault({ photos: false });
  assert.equal(s.goneFromVault.gone, 2);
  assert.equal(s.watchesGone.deleted, 1);
  assert.ok((await watch('1800')).deleted_at, 'vault-only: gone');
  assert.equal((await watch('1668')).deleted_at, null, 'still on Chrono Key: kept');
  vault.dropped.clear();
  assert.equal((await m.vault.syncVault({ photos: false })).watchesGone.restored, 1);
  assert.equal((await watch('1800')).deleted_at, null);
});

test('an empty spec cell on the list leaves what the vault filled', async () => {
  const before = await watch('1700');
  assert.equal(before.case_size, '41mm', 'filled by the vault: the grid has none');
  assert.equal(before.bezel, 'Smooth');
  const s = await m.ck.syncList();
  assert.equal(s.updated, 0, 'nothing to change, so no clear-and-refill on every pass');
  const after = await watch('1700');
  assert.equal(after.case_size, '41mm');
  assert.equal(after.bezel, 'Smooth');
});

test("handing back a spec field Chrono Key leaves empty clears it, for the other sources to fill", async () => {
  const b = await watch('1700');
  await m.watches.updateWatch(b.id, { case_size: '40mm' }, { id: null });
  await m.ck.syncList();
  assert.equal((await watch('1700')).case_size, '40mm', 'edited here: locked');
  await m.watches.unlockField(b.id, 'case_size', null);
  const handed = await watch('1700');
  assert.equal(handed.case_size, '', "Chrono Key has none: cleared, not left looking like Chrono Key's");
  assert.deepEqual(handed.locked_fields, []);
  const ev = (await m.watches.watchEvents(b.id)).find((e) => e.action === 'unlock');
  assert.equal(ev.changes.cleared, '40mm');
  await m.vault.syncVault();
  assert.equal((await watch('1700')).case_size, '41mm', 'the vault fills it again');

  const a = await watch('1668');
  await m.watches.updateWatch(a.id, { dial: 'Blue' }, { id: null });
  await m.watches.unlockField(a.id, 'dial', null);
  assert.equal((await watch('1668')).dial, 'Blue', 'Chrono Key has a dial: the next sync replaces it');
  await m.ck.syncList();
  assert.equal((await watch('1668')).dial, 'Pink');
});

test('repeats copied before the check are hidden by the tidy; the client copy stays', async () => {
  const w = await watch('1701');
  const add = (buffer, ref) => m.watches.addPhotos(w.id, [{ buffer }], null, { source: 'vault', sourceRefs: [ref] });
  const p = await picture(5);
  await add(p, 'old/1');
  await add(Buffer.from(p), 'old/2');
  await add(await picture(5, { quality: 70 }), 'old/3');
  await add(await picture(5, { box: true }), 'old/4');
  // And Chrono Key's "no image" graphic, as the first copy stored it.
  const [fake] = await m.watches.addPhotos(w.id, [{ buffer: await picture(9, { format: 'png' }) }], null, {
    source: 'chronokey',
    sourceRefs: ['/images/no_image.png'],
  });
  assert.equal((await photos(w.id)).length, 5, 'copied without the check');
  // As photos stored before fingerprints were kept: the tidy works them out.
  await db('UPDATE watch_photos SET sha256 = NULL, dhash = NULL WHERE watch_id = $1', [w.id]);

  const s = await m.watches.tidyDuplicatePhotos();
  assert.ok((await photos(w.id, true)).filter((x) => x.id !== fake).every((x) => x.sha256 && x.dhash), 'fingerprints filled in');
  assert.equal(s.hidden, 2);
  assert.equal(s.placeholders, 1);
  const shown = await photos(w.id);
  assert.deepEqual(shown.map((x) => x.source_ref), ['old/1', 'old/4']);
  const repeats = (await photos(w.id, true)).filter((x) => x.duplicate_of);
  assert.equal(repeats.length, 2);
  assert.ok(repeats.every((x) => x.duplicate_of === shown[0].id && x.storage_key && x.deleted_at), 'marked as repeats, files kept');
  assert.ok((await photos(w.id, true)).find((x) => x.id === fake).deleted_at, 'the graphic hidden');
  const ev = await m.watches.watchEvents(w.id);
  assert.deepEqual(ev.find((e) => e.changes.duplicates).changes, { photos: repeats.map((x) => x.id), duplicates: true });
  assert.deepEqual(ev.find((e) => e.changes.placeholder).changes, { photos: [fake], placeholder: true });
  const again = await m.watches.tidyDuplicatePhotos();
  assert.equal(again.hidden + again.placeholders, 0, 'a second tidy finds nothing');
});

test('a CSV of the same list updates without clearing what it does not carry', async () => {
  const csv = [HEADERS, ...PRODUCTS]
    .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\r\n');
  const s = await m.list.importProductCsv('﻿' + csv);
  assert.equal(s.records, 3);
  assert.equal(s.created, 0);
  const b = await watch('1700');
  assert.equal(b.purchase_currency, 'EUR', 'a currency worked out from the page is not cleared');
  assert.equal(b.purchase_price_eur, 98000);
  assert.equal(b.case_size, '41mm', "the export's empty Size does not clear it either");
  assert.equal((await watch('1701')).status, 'incoming', 'without the incoming page, a known incoming stays so');
});

test('a sale taken back on Chrono Key is cleared here — the deal is not spec', async () => {
  const sold = { ...GRID[0] };
  Object.assign(GRID[0], { isSold: false, soldTo: '', saleDate: null, salePrice: null, saleCrypto: 0 });
  try {
    // Chrono Key puts a watch whose sale was taken back on its Inventory tab.
    LISTS.inventory.push('1668');
    await m.ck.syncList();
    const a = await watch('1668');
    assert.equal(a.status, 'in_stock');
    assert.equal(a.sold_to, '');
    assert.equal(a.sale_date, null);
    assert.equal(a.sale_price, null);
    assert.deepEqual(a.sale_payments, {});
    assert.equal(a.dial, 'Pink', 'the spec is untouched');
    // Sold again, then the sale taken back with the watch on no list: not kept as sold.
    Object.assign(GRID[0], sold);
    LISTS.inventory.pop();
    await m.ck.syncList();
    Object.assign(GRID[0], { isSold: false, soldTo: '', saleDate: null, salePrice: null, saleCrypto: 0 });
    await m.ck.syncList();
    assert.equal((await watch('1668')).status, 'sold', 'one pass on no list: it may be on its way back to the tab');
    await m.ck.syncList();
    assert.equal((await watch('1668')).status, 'other', 'its sale gone, and on none of the lists twice');
  } finally {
    Object.assign(GRID[0], sold);
    if (LISTS.inventory.at(-1) === '1668') LISTS.inventory.pop();
  }
  await m.ck.syncList();
  assert.equal((await watch('1668')).status, 'sold');
});

test('a wrong Chrono Key password and a wrong vault key are said, not read as empty', async () => {
  const bad = new m.client.ChronoKeyClient('ck-user', 'wrong');
  await assert.rejects(bad.login(), /rejected the sign-in/);
  // A pass with a password that no longer works tries it once, not once per list.
  const ckc = m.client.chronokey();
  const keep = ckc.password;
  Object.assign(ckc, { password: 'wrong', loggedIn: false, cookies: {} });
  const posts = () => ck.calls.filter((c) => c === 'POST /').length;
  const n = posts();
  await assert.rejects(m.ck.syncList(), /rejected the sign-in/);
  assert.equal(posts() - n, 1, 'one rejected sign-in, then the pass stops');
  Object.assign(ckc, { password: keep, loggedIn: false, cookies: {} });
  process.env.VAULT_TOKEN = 'nope';
  const { config } = await import('../src/config.js');
  config.vault.token = 'nope';
  await assert.rejects(m.vault.syncVault({ photos: false }), /rejected its key/);
  config.vault.token = 'vault-key';
});

test('the daily re-read of unsold pages: a few pages failing do not make it due again every 15 minutes', async () => {
  const { activeDetailsDue } = await import('../src/import/jobs.js');
  await db("DELETE FROM import_runs WHERE mode = 'details-active'");
  const run = (stats, { error = null, finished = true } = {}) =>
    db(
      `INSERT INTO import_runs(source, mode, started_at, finished_at, ok, stats, error)
       VALUES ('chronokey', 'details-active', now() - interval '1 hour', ${finished ? 'now()' : 'NULL'}, $1, $2, $3)`,
      [finished && !error && !stats.failed, stats, error]
    );
  assert.equal(await activeDetailsDue(), true, 'never read');
  // Finished, no error of its own, counts that are not numbers: the row the guarded casts are for.
  await run({ todo: 'many', failed: 'some' });
  await assert.rejects(
    db("SELECT (stats->>'todo')::numeric FROM import_runs WHERE mode = 'details-active' AND error IS NULL"),
    /invalid input syntax/,
    'cast without its guard, this row fails'
  );
  await assert.doesNotReject(activeDetailsDue(), 'a count that is not a number breaks nothing');
  await db("DELETE FROM import_runs WHERE mode = 'details-active'");
  await run({ todo: 200, done: 200, failed: 200 });
  assert.equal(await activeDetailsDue(), true, 'Chrono Key was down: every page failed');
  await run({ todo: 200, done: 1, failed: 1 }, { error: 'Chrono Key rejected the sign-in' });
  assert.equal(await activeDetailsDue(), true, 'the pass stopped');
  await run({ todo: 200, done: 80 }, { finished: false });
  assert.equal(await activeDetailsDue(), true, 'cut short by a deploy');
  await run({ todo: 200, done: 200, failed: 3 });
  assert.equal(await activeDetailsDue(), false, 'three pages failing is a pass done — the rolling pass retries them');
  assert.equal(await activeDetailsDue(Date.now() + 25 * 3600_000), true, 'and due again a day later');
});

test("the vault's photos come only from public addresses, or from the worker itself", () => {
  const ok = m.vault.fetchable;
  assert.equal(ok(`${new URL(vault.url).origin}/photos/v1.jpg`), true, "the worker's own");
  assert.equal(ok('https://firebasestorage.googleapis.com/v0/b/x/o/a.jpg'), true);
  for (const u of [
    'http://169.254.169.254/metadata/v1/',
    'http://127.0.0.1:9/x.jpg',
    'http://localhost/x.jpg',
    'http://10.0.0.5/x.jpg',
    'http://192.168.1.1/x.jpg',
    'http://2130706433/x.jpg',
    'http://[::1]/x.jpg',
    'http://[::ffff:127.0.0.1]/x.jpg',
    'http://metadata/computeMetadata',
  ]) {
    assert.equal(ok(u), false, u);
  }
});

test('a Chrono Key sign-in sent to another site is refused: its cookies go only to Chrono Key', async () => {
  const http = await import('node:http');
  const elsewhere = [];
  const other = http.createServer((req, res) => elsewhere.push(req.headers.cookie) && res.end('ok')).listen(0, '127.0.0.1');
  await new Promise((r) => other.once('listening', r));
  let signIns = 0;
  const ckSite = http
    .createServer((req, res) => {
      if (req.method === 'GET') return res.end('<input name="__RequestVerificationToken" value="t">');
      signIns += 1;
      res.writeHead(302, { Location: `http://localhost:${other.address().port}/welcome`, 'Set-Cookie': 'ck=secret; path=/' });
      res.end();
    })
    .listen(0, '127.0.0.1');
  await new Promise((r) => ckSite.once('listening', r));
  const { config } = await import('../src/config.js');
  const keep = { url: config.chronokey.url, concurrency: config.sync.concurrency };
  config.chronokey.url = `http://127.0.0.1:${ckSite.address().port}`;
  const ckc = m.client.chronokey();
  try {
    await assert.rejects(new m.client.ChronoKeyClient('u', 'p').login(), { message: /another site/, status: 401 });
    assert.deepEqual(elsewhere, [], 'nothing reached the other site');
    // A pass stops there, as at a rejected password — not a sign-in for every page.
    const pages = (await db('SELECT count(*)::int AS n FROM ck_records')).rows[0].n;
    assert.ok(pages >= 3, 'enough pages to tell');
    Object.assign(ckc, { loggedIn: false, cookies: {} });
    config.sync.concurrency = 1;
    signIns = 0;
    await assert.rejects(m.ck.syncDetails({ mode: 'full' }), /another site/);
    assert.equal(signIns, 1, 'one sign-in, then the pass stops');
  } finally {
    config.sync.concurrency = keep.concurrency;
    config.chronokey.url = keep.url;
    Object.assign(ckc, { loggedIn: false, cookies: {} });
    other.close();
    ckSite.close();
  }
});

test("a vault photo's redirect is checked hop by hop, and the worker's key never goes with it elsewhere", async () => {
  const http = await import('node:http');
  const seenElsewhere = [];
  const away = http
    .createServer((req, res) => seenElsewhere.push(req.headers) && res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(jpg))
    .listen(0, '127.0.0.1');
  await new Promise((r) => away.once('listening', r));
  const jpg = await picture(3);
  const worker = http
    .createServer((req, res) => {
      if (req.url === '/same.jpg') return res.writeHead(302, { Location: '/pic.jpg' }).end();
      if (req.url === '/private.jpg') return res.writeHead(302, { Location: `http://127.0.0.1:${away.address().port}/pic.jpg` }).end();
      if (req.url === '/public.jpg') return res.writeHead(302, { Location: 'https://photos.invalid/pic.jpg' }).end();
      if (req.url === '/slow.jpg') return; // never answers
      if (req.url === '/pic.jpg' && req.headers['x-worker-token'] === 'vault-key') return res.writeHead(200, { 'Content-Type': 'image/jpeg' }).end(jpg);
      res.writeHead(403).end();
    })
    .listen(0, '127.0.0.1');
  await new Promise((r) => worker.once('listening', r));
  const { config } = await import('../src/config.js');
  const keep = { url: config.vault.url, timeoutMs: config.vault.timeoutMs };
  const at = `http://127.0.0.1:${worker.address().port}`;
  Object.assign(config.vault, { url: `${at}/api/state`, timeoutMs: 300 });
  // A public host, played by `away`: getPhoto checks the public url, and the
  // request is delivered to the stand-in — nothing leaves this machine.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => realFetch(String(url).replace('https://photos.invalid', `http://127.0.0.1:${away.address().port}`), opts);
  try {
    assert.ok((await m.vault.getPhoto(`${at}/same.jpg`)).equals(jpg), 'a redirect on the worker keeps its key');
    assert.equal(await m.vault.getPhoto(`${at}/private.jpg`), null, 'to a private address: not followed');
    assert.deepEqual(seenElsewhere, [], 'not even asked');
    assert.ok((await m.vault.getPhoto(`${at}/public.jpg`)).equals(jpg), 'to a public host: followed');
    assert.equal(seenElsewhere.length, 1);
    assert.equal(seenElsewhere[0]['x-worker-token'], undefined, "and that host is not sent the worker's key");
    await assert.rejects(m.vault.getPhoto(`${at}/slow.jpg`), /abort|timeout/i, 'a photo that never comes is given up on');
  } finally {
    globalThis.fetch = realFetch;
    Object.assign(config.vault, keep);
    worker.closeAllConnections();
    worker.close();
    away.close();
  }
});

test('a vault photo over 50 MB is dropped as it arrives, even when its length is not given', async () => {
  const http = await import('node:http');
  // 50 MB and one byte, chunked (no Content-Length), and the body never finished:
  // read whole before measuring, it would wait for an end that never comes.
  const worker = http
    .createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      const mb = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < 50; i += 1) res.write(mb);
      res.write(Buffer.alloc(1));
    })
    .listen(0, '127.0.0.1');
  await new Promise((r) => worker.once('listening', r));
  const { config } = await import('../src/config.js');
  const keep = { url: config.vault.url, timeoutMs: config.vault.timeoutMs };
  const at = `http://127.0.0.1:${worker.address().port}`;
  Object.assign(config.vault, { url: `${at}/api/state`, timeoutMs: 10_000 });
  try {
    assert.equal(await m.vault.getPhoto(`${at}/huge.jpg`), null);
  } finally {
    Object.assign(config.vault, keep);
    worker.closeAllConnections();
    worker.close();
  }
});
