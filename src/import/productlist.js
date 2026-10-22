import { FIELDS, parseMoney, realDate } from '../watches/fields.js';

/*
 * Chrono Key's PRODUCT LIST — one row per purchase — read into our fields.
 *
 * The same reader serves the CSV export somebody downloads from Chrono Key and
 * uploads here, and the live grid the sync reads (`/Stock/ProductsDataTable`).
 * The export comes under column headings; the grid answers in objects keyed by
 * its own field names (see GRID_KEYS). Either way columns are matched BY NAME,
 * never by position, so a column Chrono Key inserts tomorrow cannot shift
 * every value one place to the left.
 *
 * Two things in this list are not what they say, and both were checked
 * against the real export (22 Oct 2026, 1,664 rows):
 *
 *   "Purchase Price (£)" is NOT pounds. It is the figure in whatever currency
 *   the deal was done in — stock 1668 reads 46000 and was AED 46,000; 1692
 *   reads 111500 and was USD 111,500; 1325 reads 78000 and was £78,000. The
 *   only place the currency is written is the hand-typed Description ("aed
 *   46,000 = usd 12,534 as of 23-09-2026"), so it is read from there — and
 *   when it cannot be, it is left BLANK rather than assumed.
 *
 *   "Category" is the LOCATION, and two of its values are not places:
 *   Watch means Europe and Jewellery means Hong Kong.
 *
 * The payment split (Cash, Card, Bank Transfer, Crypto, PayPal / Chrono24)
 * appears TWICE under identical headings — once for the purchase, once for
 * the sale. Which is which is decided by position relative to "Sold To".
 */

const squash = (t) =>
  String(t ?? '')
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9%]+/gi, '')
    .toLowerCase();

/* Heading (squashed) → our field. Several spellings where the grid and the
   export are known or likely to differ. */
const COLUMNS = {
  productid: 'ck_product_id',
  stockno: 'stock_no',
  stocknumber: 'stock_no',
  serialnumber: 'serial',
  marca: 'brand',
  brand: 'brand',
  modello: 'model',
  model: 'model',
  referenza: 'reference',
  reference: 'reference',
  sellername: 'purchased_from',
  purchasedfrom: 'purchased_from',
  ordertype: 'order_type',
  purchasedate: 'purchase_date',
  purchaseprice: 'purchase_price',
  retailprice: 'retail_price',
  websiteprice: 'website_price',
  watchmonth: 'watch_month',
  watchyear: 'watch_year',
  watchdate: 'watch_date',
  displaycase: 'display_case',
  pouchnumber: 'pouch_number',
  inspectedby: 'inspected_by',
  customisation: 'customisation',
  dial: 'dial',
  size: 'case_size',
  case: 'case_material',
  bezel: 'bezel',
  bracelet: 'bracelet',
  description: 'description',
  papers: 'papers',
  servicepapers: 'service_papers',
  box: 'box',
  condition: 'condition',
  accessoriescost: 'accessories_cost',
  consignmentcommission: 'consignment_pct', // "Consignment Commission (%)"
  'consignmentcommission%': 'consignment_pct',
  consignmentcommissionprice: 'consignment_price',
  consignmentactualcost: 'consignment_cost',
  soldto: 'sold_to',
  saledate: 'sale_date',
  solddate: 'sale_date',
  saleprice: 'sale_price',
  soldprice: 'sale_price',
  category: 'location',
  stateprovince: 'location',
};

const PAYMENTS = { cash: 'cash', card: 'card', banktransfer: 'bank', crypto: 'crypto', paypalchrono24: 'paypal', paypal: 'paypal' };

/*
 * The live grid's own field names → our fields. Seen on the first live read
 * (22 Oct 2026: 1,665 rows, each an object with the same 54 keys) and checked
 * against the export watch by watch. Matched EXACTLY and before the headings,
 * because two of them say the opposite of what they look like: the grid's
 * `retailPrice` is the export's Website Price and its `wholeSalePrice` the
 * export's Retail Price (all 16 watches where the two differ).
 *
 * Not read, but kept in the raw row: shelfBox (null on every row, so not
 * known to be the display case), clientName / clientType / clientId /
 * soldToId, isSold, imgProduct, and the purchase / sale exchange rates.
 */
const GRID_KEYS = {
  id: 'ck_product_id', // the export's Product ID — equal on all 1,664
  stockNumber: 'stock_no',
  makeName: 'brand',
  model: 'model',
  subModel: 'reference',
  serialNumber: 'serial',
  orderType: 'order_type',
  purchasedFrom: 'purchased_from',
  purchaseDate: 'purchase_date',
  purchasePrice: 'purchase_price',
  wholeSalePrice: 'retail_price',
  retailPrice: 'website_price',
  watchMonth: 'watch_month',
  watchYear: 'watch_year',
  pouchNumber: 'pouch_number',
  inspectedBy: 'inspected_by',
  customization: 'customisation',
  dial: 'dial',
  size: 'case_size',
  material: 'case_material',
  bezel: 'bezel',
  bracelet: 'bracelet',
  description: 'description',
  paperWork: 'papers',
  servicePaper: 'service_papers',
  box: 'box',
  condition: 'condition',
  accessoriesCost: 'accessories_cost',
  consignmentCommission: 'consignment_pct',
  consignmentCommissionPrice: 'consignment_price',
  consignmentActualCost: 'consignment_cost',
  soldTo: 'sold_to',
  saleDate: 'sale_date',
  salePrice: 'sale_price',
  category: 'location',
};

/* purchaseCash … saleZellVenmo: the side and the kind are in the name. */
const GRID_PAYMENTS = { Cash: 'cash', Card: 'card', Wire: 'bank', Crypto: 'crypto', ZellVenmo: 'paypal' };

/**
 * Which field each column feeds, from the heading row (or the grid's keys).
 * @returns {Array<{field?: string, payment?: {side, kind}}>} one per column
 */
export function columnMap(headers) {
  const soldAt = headers.findIndex((h) => squash(h) === 'soldto');
  return headers.map((h, i) => {
    if (Object.hasOwn(GRID_KEYS, h)) return { field: GRID_KEYS[h] };
    const gridPay = String(h).match(/^(purchase|sale)(Cash|Card|Wire|Crypto|ZellVenmo)$/);
    if (gridPay) return { payment: { side: gridPay[1], kind: GRID_PAYMENTS[gridPay[2]] } };
    const key = squash(h);
    if (PAYMENTS[key]) {
      // Before "Sold To" it is how we paid; after, how we were paid.
      const side = soldAt === -1 || i < soldAt ? 'purchase' : 'sale';
      return { payment: { side, kind: PAYMENTS[key] } };
    }
    return COLUMNS[key] ? { field: COLUMNS[key] } : {};
  });
}

/** Does this heading row look like Chrono Key's product list at all? */
export function looksLikeProductList(headers) {
  const keys = new Set(columnMap(headers).map((c) => c.field).filter(Boolean));
  return keys.has('stock_no') && (keys.has('brand') || keys.has('reference') || keys.has('serial'));
}

const LOCATIONS = { watch: 'Europe', jewellery: 'HK', jewelry: 'HK', dubai: 'Dubai', uk: 'UK' };
export const locationOf = (v) => {
  const raw = String(v ?? '').trim();
  return raw ? LOCATIONS[raw.toLowerCase()] || raw : '';
};

const tidy = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** "21/04/2023" → "2023-04-21". Chrono Key writes day first; a day that does not exist is refused. */
export function dmyToIso(v) {
  const m = tidy(v).match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return realDate(iso) ? iso : null;
}

/**
 * A list date as "YYYY-MM-DD": the export's "21/04/2023", or the live grid's
 * "2023-04-21T13:05:07.84" (Chrono Key's own clock, no zone — the day is the
 * day it says). A day that does not exist is refused.
 */
export function listDate(v) {
  const m = tidy(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/);
  if (!m) return dmyToIso(v);
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  return realDate(iso) ? iso : null;
}

/*
 * The grid writes the order type as a code where the export writes the word.
 * Only R has been seen (every row of the first live read, the export's
 * INVENTORY); any other code is kept as Chrono Key wrote it, not guessed at.
 */
const ORDER_TYPES = { r: 'INVENTORY' };
const orderType = (v) => ORDER_TYPES[tidy(v).toLowerCase()] || tidy(v);

/*
 * The watch itself, as opposed to the deal: the Watch and Specification
 * fields. An EMPTY cell for one of these on the list says nothing — the vault
 * or the watch's page may well have filled it (85 sizes and bezels on the
 * first live read), and clearing it would have every sync blank it and the
 * vault fill it again. The list stays the authority for the purchase and the
 * sale, where an empty cell is meant: a sale taken back must clear here too.
 */
const SPEC = new Set(FIELDS.filter((x) => x.group === 'Watch' || x.group === 'Specification').map((x) => x.key));

const yesNo = (v) => {
  const t = tidy(v).toLowerCase();
  if (t === 'yes' || t === 'y' || t === 'true') return true;
  if (t === 'no' || t === 'n' || t === 'false') return false;
  return null;
};

const money = (v) => {
  const t = tidy(v);
  if (!t) return null;
  const n = parseMoney(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
};

/* ── the currency the purchase was in, read from the Description ───── */

const CURRENCY_WORDS = [
  [/usdt\b/i, 'USDT'],
  [/usdc\b/i, 'USDT'],
  [/hk\$|\bhkd\b/i, 'HKD'],
  [/£|\bgbp\b|\bsterlin[ge]\b|\bsterline\b|\bpounds?\b/i, 'GBP'],
  [/€|\beur\b|\beuros?\b/i, 'EUR'],
  [/\$|\busd\b|\bdollars?\b/i, 'USD'],
  [/\baed\b|\bdirhams?\b|\bdhs?\b/i, 'AED'],
  [/\bchf\b|\bfrancs?\b/i, 'CHF'],
];

const currencyIn = (text) => {
  for (const [re, code] of CURRENCY_WORDS) if (re.test(text)) return code;
  return null;
};

/**
 * The currency a purchase price was written in, from the note beside it.
 *
 * Only believed when the note names the SAME AMOUNT with a currency against
 * it: "aed 46,000 = usd 12,534" names two currencies, and the one that goes
 * with 46,000 is the answer. A note that never mentions the figure says
 * nothing about it, and the currency is then left blank — a guess here would
 * put a pound sign on a dirham price, which is the 5× mistake this column
 * already makes by its heading.
 *
 * @returns {string|null}
 */
export function currencyFromNote(note, amount) {
  if (!note || !Number.isFinite(amount) || amount <= 0) return null;
  const text = String(note);
  // An amount, with whatever currency sits right against it on either side.
  const re = /((?:\b[a-z]{2,9}\b\$?|hk\$|[£€$])\s{0,2})?(\d[\d.,']*\d|\d)(\s{0,2}(?:k\b)?\s{0,2}(?:[a-z$]{2,9}|[£€$])?)?/gi;
  let m;
  while ((m = re.exec(text))) {
    let n = parseMoney(m[2]);
    if (/^\s*k\b/i.test(m[3] || '')) n *= 1000;
    if (!Number.isFinite(n) || Math.abs(n - amount) > Math.max(1, amount * 0.001)) continue;
    const code = currencyIn(m[1] || '') || currencyIn(m[3] || '');
    if (code) return code;
  }
  return null;
}

/**
 * One row of the product list as watch fields.
 *
 * @param headers the heading row
 * @param values  the row, aligned to the headings
 * @returns {{fields: object, raw: object}} `raw` is the row by heading, kept as
 *   Chrono Key wrote it so anything read wrongly here can be read again.
 */
export function readRow(headers, values, map = columnMap(headers)) {
  const raw = {};
  const f = {};
  const pay = { purchase: {}, sale: {} };

  headers.forEach((h, i) => {
    const v = values[i];
    const name = tidy(h) || `col${i}`;
    raw[raw[name] !== undefined ? `${name} (sale)` : name] = v ?? '';
    const c = map[i];
    if (c.payment) {
      const n = money(v);
      if (n) pay[c.payment.side][c.payment.kind] = n;
    } else if (c.field) {
      f[c.field] = v;
    }
  });

  const out = {
    stock_no: tidy(f.stock_no),
    ck_product_id: Number(tidy(f.ck_product_id)) || null,
    brand: tidy(f.brand),
    model: tidy(f.model),
    reference: tidy(f.reference),
    serial: tidy(f.serial),
    purchased_from: tidy(f.purchased_from),
    order_type: orderType(f.order_type),
    purchase_date: listDate(f.purchase_date),
    purchase_price: money(f.purchase_price),
    purchase_payments: pay.purchase,
    retail_price: money(f.retail_price),
    website_price: money(f.website_price),
    display_case: tidy(f.display_case),
    pouch_number: tidy(f.pouch_number),
    inspected_by: tidy(f.inspected_by),
    customisation: tidy(f.customisation),
    dial: tidy(f.dial),
    case_size: tidy(f.case_size),
    case_material: tidy(f.case_material),
    bezel: tidy(f.bezel),
    bracelet: tidy(f.bracelet),
    description: String(f.description ?? '').trim(),
    papers: yesNo(f.papers),
    service_papers: yesNo(f.service_papers),
    box: yesNo(f.box),
    condition: tidy(f.condition),
    accessories_cost: money(f.accessories_cost),
    consignment_pct: money(f.consignment_pct),
    consignment_price: money(f.consignment_price),
    consignment_cost: money(f.consignment_cost),
    sold_to: tidy(f.sold_to),
    sale_date: listDate(f.sale_date),
    sale_price: money(f.sale_price),
    sale_payments: pay.sale,
    location: locationOf(f.location),
  };

  // "4" + "2026" → "04/2026", the way it is written on a card.
  const month = Number(tidy(f.watch_month));
  const year = tidy(f.watch_year);
  out.watch_date =
    tidy(f.watch_date) || (year ? (month >= 1 && month <= 12 ? `${String(month).padStart(2, '0')}/${year}` : year) : '');

  out.purchase_currency = currencyFromNote(out.description, out.purchase_price) || '';
  // Retail and website prices on this list are Chrono Key's own figures, kept
  // in euros like every price it computes (see the Chrono Key notes).
  out.retail_currency = out.retail_price ? 'EUR' : '';
  out.website_currency = out.website_price ? 'EUR' : '';
  // The sale currency is not on this list at all: it is left out, so it is
  // neither assumed nor cleared.
  // A sale date that is there but cannot be read is still a sale.
  out.status = tidy(f.sale_date) || out.sold_to || out.sale_price ? 'sold' : 'in_stock';

  /*
   * Only the fields this list actually HAS a column for. A grid that does not
   * carry, say, the Description must not read as "the description is now
   * blank" and wipe the one we hold.
   */
  const has = new Set(map.map((c) => c.field).filter(Boolean));
  const paySides = new Set(map.map((c) => c.payment?.side).filter(Boolean));
  const derived = {
    watch_date: ['watch_date', 'watch_month', 'watch_year'],
    purchase_currency: ['description'],
    retail_currency: ['retail_price'],
    website_currency: ['website_price'],
    status: ['sale_date', 'sold_to', 'sale_price'],
  };
  for (const k of Object.keys(out)) {
    const keep =
      k === 'purchase_payments' ? paySides.has('purchase')
      : k === 'sale_payments' ? paySides.has('sale')
      : derived[k] ? derived[k].some((x) => has.has(x))
      : has.has(k);
    if (!keep) delete out[k];
    // An empty spec cell leaves ours alone (see SPEC).
    else if (SPEC.has(k) && (out[k] === '' || out[k] === null)) delete out[k];
  }
  // A date that is written but cannot be read is not a blank: it leaves ours
  // alone rather than clearing it.
  for (const k of ['purchase_date', 'sale_date']) {
    if (k in out && out[k] === null && tidy(f[k])) delete out[k];
  }

  return { fields: out, raw };
}

/**
 * Does a stored list row (ck_records.list_row, as readRow kept it) have a
 * column for this spec field and leave it EMPTY — the one case the list does
 * not clear (see SPEC)?
 */
export function leftBlank(raw, key) {
  if (!SPEC.has(key) || !raw || typeof raw !== 'object') return false;
  const headers = Object.keys(raw).filter((h) => h !== '_repeated');
  const map = columnMap(headers);
  const from = key === 'watch_date' ? ['watch_date', 'watch_month', 'watch_year'] : [key];
  if (!map.some((c) => from.includes(c.field))) return false;
  const { fields } = readRow(headers, headers.map((h) => raw[h]), map);
  return !(key in fields);
}

/**
 * The whole list, one entry per stock number.
 *
 * A stock number appears more than once only when Chrono Key has the sale
 * recorded twice (stock 238: four rows, two sale dates two days apart, same
 * price). The latest sale wins and the others are kept in `others`, so
 * nothing in the export is thrown away.
 */
export function readList(headers, rows) {
  const map = columnMap(headers);
  const byStock = new Map();
  const skipped = [];
  for (const values of rows) {
    if (!values.some((v) => tidy(v))) continue;
    const row = readRow(headers, values, map);
    if (!row.fields.stock_no) {
      skipped.push(row.raw);
      continue;
    }
    const have = byStock.get(row.fields.stock_no);
    if (!have) {
      byStock.set(row.fields.stock_no, { ...row, others: [] });
      continue;
    }
    const later = (row.fields.sale_date || '') > (have.fields.sale_date || '');
    const keep = later ? { ...row, others: [...have.others, have.raw] } : { ...have, others: [...have.others, row.raw] };
    // Identical rows are not worth keeping twice.
    keep.others = keep.others.filter(
      (o, i, all) => JSON.stringify(o) !== JSON.stringify(keep.raw) && all.findIndex((x) => JSON.stringify(x) === JSON.stringify(o)) === i
    );
    byStock.set(row.fields.stock_no, keep);
  }
  return { rows: [...byStock.values()], skipped };
}

/* ── CSV ──────────────────────────────────────────────────────────── */

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes (245
 * cells in the real export have them — descriptions typed over several lines)
 * and a byte-order mark at the start.
 */
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
