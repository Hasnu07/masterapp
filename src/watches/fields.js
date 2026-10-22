/*
 * Every field a watch has, in one list.
 *
 * The API validates against it, the import fills it, and the console builds
 * its edit form from it (it is sent to the page at /api/meta). A field added
 * here — and as a column in a migration — appears in all three at once, so
 * the form cannot offer a field the server would throw away.
 */

export const STATUSES = [
  { key: 'incoming', label: 'Incoming' },
  { key: 'in_stock', label: 'In stock' },
  { key: 'reserved', label: 'Reserved' },
  { key: 'sold', label: 'Sold' },
  { key: 'returned', label: 'Returned' },
  { key: 'other', label: 'Other' },
];

export const LOCATIONS = ['Dubai', 'UK', 'Europe', 'HK'];
export const CURRENCIES = ['EUR', 'USD', 'GBP', 'AED', 'HKD', 'CHF', 'USDT'];

export const FIELDS = [
  { key: 'stock_no', label: 'Stock number', type: 'text', group: 'Watch' },
  { key: 'brand', label: 'Brand', type: 'text', group: 'Watch' },
  { key: 'model', label: 'Model', type: 'text', group: 'Watch' },
  { key: 'reference', label: 'Reference', type: 'text', group: 'Watch' },
  { key: 'serial', label: 'Serial', type: 'text', group: 'Watch' },
  { key: 'watch_date', label: 'Watch date', type: 'text', group: 'Watch', hint: 'As on the card, e.g. 04/2026' },
  { key: 'title', label: 'Title', type: 'text', group: 'Watch', hint: 'Blank: brand, model and reference' },
  { key: 'status', label: 'Status', type: 'enum', options: STATUSES.map((s) => s.key), group: 'Watch' },
  { key: 'location', label: 'Location', type: 'text', suggest: LOCATIONS, group: 'Watch' },

  { key: 'condition', label: 'Condition', type: 'text', suggest: ['New', 'Unworn', 'Pre Owned'], group: 'Specification' },
  { key: 'dial', label: 'Dial', type: 'text', group: 'Specification' },
  { key: 'case_material', label: 'Case', type: 'text', group: 'Specification' },
  { key: 'case_size', label: 'Size', type: 'text', group: 'Specification' },
  { key: 'bezel', label: 'Bezel', type: 'text', group: 'Specification' },
  { key: 'bracelet', label: 'Bracelet / strap', type: 'text', group: 'Specification' },
  { key: 'movement', label: 'Movement / calibre', type: 'text', group: 'Specification' },
  { key: 'box', label: 'Box', type: 'bool', group: 'Specification' },
  { key: 'papers', label: 'Papers', type: 'bool', group: 'Specification' },
  { key: 'service_papers', label: 'Service papers', type: 'bool', group: 'Specification' },
  { key: 'accessories', label: 'Accessories', type: 'text', group: 'Specification' },
  { key: 'customisation', label: 'Customisation', type: 'text', group: 'Specification' },

  { key: 'order_type', label: 'Order type', type: 'text', suggest: ['INVENTORY', 'CONSIGNMENT'], group: 'Purchase' },
  { key: 'purchase_date', label: 'Purchase date', type: 'date', group: 'Purchase' },
  { key: 'purchased_from', label: 'Purchased from', type: 'text', group: 'Purchase' },
  { key: 'purchase_price', label: 'Purchase price', type: 'money', currency: 'purchase_currency', group: 'Purchase' },
  { key: 'purchase_currency', label: 'Purchase currency', type: 'currency', group: 'Purchase' },
  { key: 'purchase_payments', label: 'Paid by', type: 'payments', group: 'Purchase' },
  { key: 'purchase_price_eur', label: 'Purchase price in EUR (Chrono Key)', type: 'money', fixedCurrency: 'EUR', group: 'Purchase' },
  { key: 'description', label: 'Description', type: 'longtext', group: 'Purchase', hint: 'Chrono Key\u2019s note: what was really paid, in what' },
  { key: 'accessories_cost', label: 'Accessories cost', type: 'money', group: 'Purchase' },
  { key: 'consignment_pct', label: 'Consignment commission %', type: 'number', group: 'Purchase' },
  { key: 'consignment_price', label: 'Consignment commission', type: 'money', group: 'Purchase' },
  { key: 'consignment_cost', label: 'Consignment actual cost', type: 'money', group: 'Purchase' },
  { key: 'inspected_by', label: 'Inspected by', type: 'text', group: 'Purchase' },
  { key: 'display_case', label: 'Display case', type: 'text', group: 'Purchase' },
  { key: 'pouch_number', label: 'Pouch number', type: 'text', group: 'Purchase' },

  { key: 'retail_price', label: 'Retail price', type: 'money', currency: 'retail_currency', group: 'Prices' },
  { key: 'retail_currency', label: 'Retail currency', type: 'currency', group: 'Prices' },
  { key: 'website_price', label: 'Website price', type: 'money', currency: 'website_currency', group: 'Prices' },
  { key: 'website_currency', label: 'Website currency', type: 'currency', group: 'Prices' },
  { key: 'b2b_price', label: 'B2B price', type: 'money', currency: 'b2b_currency', group: 'Prices' },
  { key: 'b2b_currency', label: 'B2B currency', type: 'currency', group: 'Prices' },
  { key: 'b2c_price', label: 'B2C price', type: 'money', currency: 'b2c_currency', group: 'Prices' },
  { key: 'b2c_currency', label: 'B2C currency', type: 'currency', group: 'Prices' },

  { key: 'sale_date', label: 'Sale date', type: 'date', group: 'Sale' },
  { key: 'sold_to', label: 'Sold to', type: 'text', group: 'Sale' },
  { key: 'sale_price', label: 'Sale price', type: 'money', currency: 'sale_currency', group: 'Sale' },
  { key: 'sale_currency', label: 'Sale currency', type: 'currency', group: 'Sale' },
  { key: 'sale_payments', label: 'Paid by', type: 'payments', group: 'Sale' },
  { key: 'sale_price_eur', label: 'Sale price in EUR (Chrono Key)', type: 'money', fixedCurrency: 'EUR', group: 'Sale' },

  { key: 'notes', label: 'Notes', type: 'longtext', group: 'Notes' },
];

/* The ways a deal is paid, as Chrono Key splits them. */
export const PAYMENT_KINDS = [
  { key: 'cash', label: 'Cash' },
  { key: 'card', label: 'Card' },
  { key: 'bank', label: 'Bank transfer' },
  { key: 'crypto', label: 'Crypto' },
  { key: 'paypal', label: 'PayPal / Chrono24' },
];

export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/**
 * One value, checked and put into the shape its column holds. Blank means
 * "nothing" — null for a price, a date or a yes/no, '' for text.
 */
export function cleanValue(key, value) {
  const f = FIELD[key];
  if (!f) throw bad(`Unknown field: ${key}`);
  const blank = value === null || value === undefined || String(value).trim() === '';

  switch (f.type) {
    case 'money': {
      if (blank) return null;
      const n = typeof value === 'number' ? value : parseMoney(value);
      if (!Number.isFinite(n) || n < 0) throw bad(`${f.label}: "${value}" is not an amount`);
      // A reference or a serial pasted into a price box — no watch here costs this.
      if (n > 50_000_000) throw bad(`${f.label}: ${n.toLocaleString('en-GB')} is not a watch price`);
      return Math.round(n * 100) / 100;
    }
    case 'number': {
      if (blank) return null;
      const n = Number(String(value).replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n > 1000) throw bad(`${f.label}: "${value}" is not a number`);
      return n;
    }
    case 'payments': {
      // {cash: 1000, bank: 2500} — kinds not listed and zero amounts are dropped.
      const src = typeof value === 'string' ? (value.trim() ? JSON.parse(value) : {}) : value || {};
      const out = {};
      for (const { key: kind } of PAYMENT_KINDS) {
        const v = src[kind];
        if (v === null || v === undefined || v === '') continue;
        const n = typeof v === 'number' ? v : parseMoney(v);
        if (!Number.isFinite(n) || n < 0) throw bad(`${f.label}: "${v}" is not an amount`);
        if (n > 0) out[kind] = Math.round(n * 100) / 100;
      }
      return out;
    }
    case 'date': {
      if (blank) return null;
      const iso = String(value).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !realDate(iso)) throw bad(`${f.label}: "${value}" is not a date`);
      return iso;
    }
    case 'bool':
      if (blank) return null;
      if (value === true || /^(true|yes|1|y)$/i.test(String(value))) return true;
      if (value === false || /^(false|no|0|n)$/i.test(String(value))) return false;
      throw bad(`${f.label}: say yes or no`);
    case 'enum':
      if (blank) throw bad(`${f.label} cannot be empty`);
      if (!f.options.includes(value)) throw bad(`${f.label}: "${value}" is not one of ${f.options.join(', ')}`);
      return value;
    case 'currency':
      if (blank) return '';
      if (!/^[A-Za-z]{3,4}$/.test(String(value).trim())) throw bad(`${f.label}: "${value}" is not a currency code`);
      return String(value).trim().toUpperCase();
    default:
      return blank ? '' : String(value).trim().slice(0, f.type === 'longtext' ? 20000 : 500);
  }
}

/** A date that exists — 31/02 is refused rather than rolled into March. */
export function realDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/*
 * A typed amount, however it was written: "€100,000.00", "12.000,50",
 * "CHF 13'900", "20,000".
 *
 * The rule InvoiceWEB learned the hard way: a comma or a dot followed by
 * EXACTLY three digits is a thousands separator, because money is not written
 * to three decimal places — "215.000 euro" is 215,000, not 215. Two or more of
 * the same mark are always thousands. One or two digits after the LAST mark
 * make it the decimal point.
 */
export function parseMoney(text) {
  let s = String(text ?? '')
    .replace(/[^\d.,'-]/g, '')
    .replace(/'/g, '');
  if (!s || !/\d/.test(s)) return NaN;
  const neg = s.startsWith('-');
  s = s.replace(/-/g, '');

  const last = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  if (last === -1) return (neg ? -1 : 1) * Number(s);

  const mark = s[last];
  const after = s.slice(last + 1);
  const count = s.split(mark).length - 1;
  const otherMark = mark === '.' ? ',' : '.';

  let intPart;
  let decPart = '';
  if (s.includes(otherMark)) {
    // Both marks: the last one is the decimal point.
    intPart = s.slice(0, last).replace(/[.,]/g, '');
    decPart = after;
  } else if (count > 1 || (after.length === 3 && !/^0[.,]/.test(s))) {
    intPart = s.replace(/[.,]/g, '');
  } else {
    intPart = s.slice(0, last);
    decPart = after;
  }
  const n = Number(`${intPart || '0'}.${decPart || '0'}`);
  return neg ? -n : n;
}

/** Brand + model + reference, the way a watch is named when no title is set. */
export function displayTitle(w) {
  if (w.title) return w.title;
  const brand = w.brand || '';
  let model = w.model || '';
  // "Rolex Rolex Cosmograph Daytona" — Chrono Key's model often repeats the brand.
  if (brand && model.toLowerCase().startsWith(`${brand.toLowerCase()} `)) model = model.slice(brand.length + 1);
  return [brand, model, w.reference].filter(Boolean).join(' ').trim() || (w.stock_no ? `Stock ${w.stock_no}` : 'Untitled watch');
}
