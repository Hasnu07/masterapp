import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { startChronoKey, startVault, HEADERS, PRODUCTS } from './fakes.js';

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

test('the product grid becomes our watches, read by heading', async () => {
  const s = await m.ck.syncList();
  assert.equal(s.created, 3);
  const a = await watch('1668');
  assert.equal(a.brand, 'Rolex');
  assert.equal(a.purchased_from, 'Dealer One', 'double spaces tidied');
  assert.equal(a.purchase_price, 46000);
  assert.equal(a.purchase_currency, 'AED', 'read from the description, not the (£) heading');
  assert.deepEqual(a.purchase_payments, { cash: 46000 });
  assert.deepEqual(a.sale_payments, { crypto: 14000 }, 'the second payment block is the sale');
  assert.equal(a.sale_currency, '', 'never assumed');
  assert.equal(a.watch_date, '03/2026');
  assert.equal(a.purchase_date, '2026-09-05');
  assert.equal(a.status, 'sold');
  assert.equal(a.box, false);
  assert.equal(a.papers, true);
  const b = await watch('1700');
  assert.equal(b.location, 'Europe', 'Category "Watch" is Europe');
  assert.equal(b.ck_id, 26002, 'purchase id read from the row markup');
  assert.equal(b.purchase_currency, '', 'no description, no currency');
  assert.equal((await watch('1701')).status, 'incoming', 'on the incoming page and unsold');
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
  assert.equal(pa.length, 2, 'two gallery photos; the data: placeholder skipped');
  assert.deepEqual(pa.map((p) => p.source_ref), ['/images/a1.jpg', '/images/a2.jpg'], 'paths cleaned');
  assert.ok(pa.every((p) => p.source === 'chronokey' && p.thumb_key && p.width === 900));
  const b = await watch('1700');
  assert.equal((await photos(b.id)).length, 1, 'a photo on another host is never fetched');
  assert.equal(b.purchase_currency, 'EUR', 'list figure equal to the euro figure: the deal was in euros');
  assert.equal((await watch('1701')).movement, '4131', 'a blank field filled from the page');
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
  await m.ck.syncDetails({ mode: 'full' });
  const live = await photos(a.id);
  assert.equal(live.length, 1);
  assert.equal((await photos(a.id, true)).length, 2, 'no duplicate rows');
});

test('the vault adds prices, its photos and the watches only it holds', async () => {
  const s = await m.vault.syncVault();
  const a = await watch('1668');
  assert.equal(a.b2b_price, 13500);
  assert.equal(a.b2b_currency, 'USD');
  assert.equal(a.b2c_price, 52000, 'a zero in the final prices is skipped, not taken');
  assert.equal(a.b2c_currency, 'AED');
  assert.equal(a.dial, 'Pink', "Chrono Key's value is not replaced by the vault's");
  assert.equal(a.location, 'Dubai');
  const vp = (await photos(a.id)).filter((p) => p.source === 'vault');
  assert.equal(vp.length, 1, 'one vault photo, though named in two places');

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
  assert.equal((await watch('1701')).status, 'incoming', 'without the incoming page, a known incoming stays so');
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
