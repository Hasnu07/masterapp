import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRow, readList, listDate, columnMap, looksLikeProductList, leftBlank } from '../src/import/productlist.js';
import { gridRows } from '../src/import/chronokey/parse.js';
import { GRID, HEADERS, PRODUCTS } from './fakes.js';

/*
 * The product-list reader on its own — no database. The live grid's shape is
 * the one seen on the first live read (see GRID in fakes.js).
 */

const fromGrid = (rows) => {
  const got = gridRows({ data: rows }, []);
  return readList(got[0].headers, got.map((r) => r.values)).rows.map((r) => r.fields);
};

test('list dates: the export day-first, the grid ISO with a clock time', () => {
  assert.equal(listDate('21/04/2023'), '2023-04-21');
  assert.equal(listDate('2023-04-21T00:00:00'), '2023-04-21');
  assert.equal(listDate('2026-10-22T13:05:07.84'), '2026-10-22');
  assert.equal(listDate('2023-04-21T00:00:00.1234567'), '2023-04-21');
  assert.equal(listDate('2023-04-21'), '2023-04-21');
  assert.equal(listDate('2023-02-30T00:00:00'), null, 'a day that does not exist');
  assert.equal(listDate('2023-04-21T23:00:00Z'), null, 'a zone is not read rather than guessed at');
  assert.equal(listDate(''), null);
});

test("the grid's keys, including the two that say the opposite", () => {
  const [a, b] = fromGrid(GRID);
  assert.equal(a.stock_no, '1668');
  assert.equal(a.ck_product_id, 9001);
  assert.equal(a.brand, 'Rolex');
  assert.equal(a.reference, '278274');
  assert.equal(a.case_material, 'SS');
  assert.equal(a.order_type, 'INVENTORY');
  assert.equal(a.retail_price, 11538);
  assert.equal(a.website_price, 11900);
  assert.equal(a.purchase_date, '2026-09-05');
  assert.equal(a.sale_date, '2026-09-25');
  assert.deepEqual(a.purchase_payments, { cash: 46000 });
  assert.deepEqual(a.sale_payments, { crypto: 14000 });
  assert.equal(a.papers, true);
  assert.equal(a.service_papers, false);
  assert.equal(a.watch_date, '03/2026');
  assert.equal(a.location, 'Dubai');
  assert.equal(b.location, 'Europe');
  assert.deepEqual(b.purchase_payments, { bank: 98000 });
  assert.ok(looksLikeProductList(Object.keys(GRID[0])));
});

test("the export's headings still mean what they say", () => {
  const map = columnMap(HEADERS);
  assert.equal(map[HEADERS.indexOf('Retail Price')].field, 'retail_price');
  assert.equal(map[HEADERS.indexOf('Website Price')].field, 'website_price');
  const [a] = readList(HEADERS, PRODUCTS).rows.map((r) => r.fields);
  assert.equal(a.retail_price, 11538);
  assert.equal(a.website_price, 11900);
  assert.equal(a.purchase_date, '2026-09-05');
});

test('an empty spec cell is not a clear; an empty sale cell is', () => {
  const [, b] = fromGrid(GRID);
  for (const k of ['case_size', 'bezel', 'dial', 'case_material', 'bracelet']) {
    assert.ok(!(k in b), `${k} left out, so ours stays`);
  }
  assert.ok('sold_to' in b && b.sold_to === '', 'the sale is the list’s to clear');
  assert.ok('sale_date' in b && b.sale_date === null);
  assert.ok('sale_price' in b && b.sale_price === null);
  assert.equal(b.status, 'in_stock');
});

test('a date written in a way not read leaves ours alone, and a sale is still a sale', () => {
  const [a] = fromGrid([{ ...GRID[0], purchaseDate: '31/02/2026', saleDate: 'yesterday', soldTo: '', salePrice: null }]);
  assert.ok(!('purchase_date' in a));
  assert.ok(!('sale_date' in a));
  assert.equal(a.status, 'sold');
});

test('an order type code not seen yet is kept as written, not guessed at', () => {
  const [a] = fromGrid([{ ...GRID[0], orderType: 'C' }]);
  assert.equal(a.order_type, 'C');
});

test('the array shape is still read, aligned to the headings', () => {
  const headers = ['Photo', 'STOCK NUMBER', 'Marca', 'Purchase Date', 'Sold Date', 'Category', 'Actions'];
  const got = gridRows({ data: [['<img>', '<a href="/Stock/InstockDetailPage/77">12</a>', 'Rolex', '01/02/2024', '', 'Watch', '']] }, headers);
  assert.equal(got[0].ckId, 77);
  const [f] = readList(got[0].headers, got.map((r) => r.values)).rows.map((r) => r.fields);
  assert.equal(f.stock_no, '12');
  assert.equal(f.brand, 'Rolex');
  assert.equal(f.purchase_date, '2024-02-01');
  assert.equal(f.location, 'Europe');
});

test('leftBlank: a spec column the stored list row leaves empty — and only that', () => {
  const keys = Object.keys(GRID[1]);
  const { raw } = readRow(keys, keys.map((k) => String(GRID[1][k] ?? '')));
  assert.equal(leftBlank(raw, 'case_size'), true, 'size is null on the grid');
  assert.equal(leftBlank(raw, 'brand'), false, 'it has one');
  assert.equal(leftBlank(raw, 'sale_price'), false, 'not spec: the list clears it itself');
  assert.equal(leftBlank(raw, 'movement'), false, 'no such column on the list');
  const csv = readRow(HEADERS, PRODUCTS[1]).raw;
  assert.equal(leftBlank(csv, 'case_size'), true, "the export's empty Size");
  assert.equal(leftBlank(csv, 'watch_date'), false, 'month and year make one');
});

test('readRow keeps the grid row as Chrono Key wrote it', () => {
  const keys = Object.keys(GRID[0]);
  const { raw } = readRow(keys, keys.map((k) => String(GRID[0][k] ?? '')));
  assert.equal(raw.makeName, 'Rolex');
  assert.equal(raw.purchaseExchangeRate, '0.234', 'kept though not read');
});
