import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { startChronoKey, startVault, HEADERS, PRODUCTS, GRID, DETAILS, picture } from './fakes.js';

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
  assert.equal(b.ck_id, null, 'the grid names no detail page; the search finds it later');
  assert.equal(b.purchase_currency, '', 'no description, no currency');
  assert.equal((await watch('1701')).status, 'incoming', 'on the incoming page and unsold');
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
    await m.ck.syncList();
    const a = await watch('1668');
    assert.equal(a.status, 'in_stock');
    assert.equal(a.sold_to, '');
    assert.equal(a.sale_date, null);
    assert.equal(a.sale_price, null);
    assert.deepEqual(a.sale_payments, {});
    assert.equal(a.dial, 'Pink', 'the spec is untouched');
  } finally {
    Object.assign(GRID[0], sold);
  }
  await m.ck.syncList();
  assert.equal((await watch('1668')).status, 'sold');
});

test('a wrong Chrono Key password and a wrong vault key are said, not read as empty', async () => {
  const bad = new m.client.ChronoKeyClient('ck-user', 'wrong');
  await assert.rejects(bad.login(), /rejected the sign-in/);
  process.env.VAULT_TOKEN = 'nope';
  const { config } = await import('../src/config.js');
  config.vault.token = 'nope';
  await assert.rejects(m.vault.syncVault({ photos: false }), /rejected its key/);
  config.vault.token = 'vault-key';
});
