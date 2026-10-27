/*
 * Missing Accessories: the logistics app's "Missing Accessories" page — what
 * to source or collect across every stock location — read from our copy of
 * its records, its rules ported from its own code (renderMissingAccessories,
 * allMissingRows, parseMissingTokens, aggregateMissing, lookupStockMeta).
 *
 *   - "What clients need to give us": every PENDING item a client is to
 *     give us (`direction: 'receive'`) on the accessory transactions, by
 *     client, by transaction (stock, reference, brand — the typed ones, else
 *     the stock row's, as the app's lookupStockMeta).
 *   - The stock rows' "accessories missing": London and Dubai rows that are
 *     current (the app: `(status || 'current') === 'current'` — a row on
 *     consignment or moved away is not counted), and the HK list's rows in
 *     hand. Each cell split on commas into tokens with a quantity ("3 Links"
 *     → Link × 3) and the app's canonical names ("links" / "Link" are one).
 *
 * The console sums, filters and drills exactly as the app (combined, per
 * location, per brand, per accessory), from these rows. Every stock number
 * is OUR watch, linked with its clients by Chrono Key's ids, and beside the
 * app's list stands what Chrono Key's own record says the watch lacks (box,
 * papers, service papers — a "no" on our watch row, as the watch page shows).
 */
import { query } from '../../db/index.js';
import { oursByNumber, text } from '../shared.js';
import { stockList } from '../kinds.js';
import { linksByClientId } from '../clients.js';

/* The app's three places, in its order, with its labels. */
export const PLACES = [
  { key: 'london', kind: 'londonStock', label: 'London' },
  { key: 'dubai', kind: 'dubaiStock', label: 'Dubai' },
  { key: 'hk', kind: 'hkSituation', label: 'HK' },
];
const PLACE_OF_KIND = Object.fromEntries(PLACES.map((p) => [p.kind, p]));

/* The app's own table of canonical names (normalizeAccessoryName), as written there. */
const CANON = {
  links: 'Link', link: 'Link',
  boxes: 'Box', box: 'Box', 'outer box': 'Outer Box', outerbox: 'Outer Box',
  booklets: 'Booklet', booklet: 'Booklet', manual: 'Booklet', manuals: 'Booklet',
  pouches: 'Pouch', pouch: 'Pouch',
  pushers: 'Pusher', pusher: 'Pusher', 'white pusher': 'White Pusher',
  tag: 'Tag', tags: 'Tag', gtag: 'G-Tag', wtag: 'W-Tag', 'g tag': 'G-Tag', 'w tag': 'W-Tag',
  card: 'Card', cards: 'Card', 'warranty card': 'Warranty Card', warranty: 'Warranty Card', warrenty: 'Warranty Card',
  strap: 'Strap', straps: 'Strap', bracelet: 'Bracelet',
  buckle: 'Buckle', buckles: 'Buckle',
  'cord cover': 'Cord Cover', cord: 'Cord Cover',
  'service card': 'Service Card', holder: 'Holder', holders: 'Holder',
};
export function normalizeAccessoryName(name) {
  const n = text(name);
  if (!n) return '';
  const hit = Object.prototype.hasOwnProperty.call(CANON, n.toLowerCase()) ? CANON[n.toLowerCase()] : '';
  if (hit) return hit;
  return n
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/*
 * "3 Links, Box, Missing 2 link" → [{ accessory: 'Link', qty: 3 }, { Box, 1 }, { Link, 2 }]
 * — the app's parseMissingTokens: split on commas and semicolons, a leading
 * "missing" / "no" / "need" dropped, a leading number is the quantity.
 */
export function parseMissingTokens(v) {
  const out = [];
  for (const raw of String(v ?? '').split(/[,;]+/)) {
    const tok = raw.trim();
    if (!tok) continue;
    const clean = tok.replace(/^(missing|no|need)\s+/i, '').trim();
    const m = clean.match(/^(\d+)\s*(.+)$/);
    if (m) out.push({ accessory: normalizeAccessoryName(m[2]), qty: parseInt(m[1], 10) || 1 });
    else out.push({ accessory: normalizeAccessoryName(clean), qty: 1 });
  }
  return out.filter((t) => t.accessory);
}

/* The app counts a London / Dubai row only while it is current, and an HK row only in hand. */
export const countsHere = (kind, d) => (kind === 'hkSituation' ? d.section === 'in_hand' : (text(d.status) || 'current') === 'current');

/*
 * What Chrono Key's own record says the watch lacks: a "no" on box or papers
 * (the watch page's rule). Not service papers: Chrono Key says "no" to those
 * on 1,321 of 1,671 watches, which would mark nearly every row here.
 */
const CK_LACKS = [['box', 'Box'], ['papers', 'Papers']];
const ckLacks = (w) => (w ? CK_LACKS.filter(([k]) => w[k] === false).map(([, l]) => l) : []);

/*
 * The app's lookupStockMeta: a transaction's reference and brand, when not
 * typed on it, from the first stock row of that number — London, Dubai, HK
 * stock, the HK list, incomings, sold, ready for delivery, in that order.
 */
const META_ORDER = ['londonStock', 'dubaiStock', 'hkStock', 'hkSituation', 'incomings', 'soldStocks', 'readyForDelivery'];
function metaLookup(rows) {
  const by = new Map();
  for (const r of rows) {
    const d = r.data || {};
    const sn = text(d.stockNumber);
    if (!sn || !META_ORDER.includes(r.kind)) continue;
    const list = by.get(sn) || [];
    list.push(r);
    by.set(sn, list);
  }
  return (stockNumber) => {
    const sn = String(stockNumber ?? '').split(',')[0].trim();
    const list = sn && by.get(sn);
    if (!list) return null;
    const r = list.slice().sort((a, b) => META_ORDER.indexOf(a.kind) - META_ORDER.indexOf(b.kind))[0];
    const d = r.data || {};
    if (r.kind === 'hkSituation') return { ref: '', brand: text(d.brand), model: text(d.description) };
    if (r.kind === 'incomings') return { ref: text(d.reference), brand: text(d.brand), model: text(d.reference) };
    return { ref: text(d.watchReference), brand: text(d.brand), model: text(d.watchModel) };
  };
}

const KINDS = [...PLACES.map((p) => p.kind), 'transactions', 'hkStock', 'incomings', 'soldStocks', 'readyForDelivery'];

/** The page's data (GET /api/logistics/page/missingacc). */
export async function page() {
  const { rows: all } = await query('SELECT id, kind, source_id, data, stock_nos, created_at FROM logistics_items WHERE kind = ANY($1) AND deleted_at IS NULL ORDER BY id', [KINDS]);
  const meta = metaLookup(all);

  // The stock rows with something missing — one row each, as the app aggregates by row id.
  const stockRows = all
    .filter((r) => PLACE_OF_KIND[r.kind] && countsHere(r.kind, r.data || {}))
    .map((r) => {
      const d = r.data || {};
      const tokens = parseMissingTokens(d.accessoriesMissing ?? d.missing);
      if (!tokens.length) return null;
      const place = PLACE_OF_KIND[r.kind];
      return {
        id: r.id,
        place: place.key,
        place_label: place.label,
        stock_no: text(d.stockNumber),
        brand: text(d.brand) || '(no brand)',
        model: text(d.watchModel || d.description || d.reference),
        reference: text(d.watchReference || d.reference),
        missing: text(d.accessoriesMissing ?? d.missing),
        tokens,
      };
    })
    .filter(Boolean);

  // What clients still have to give us: pending items to receive, by client, by transaction.
  const txRows = all.filter((r) => r.kind === 'transactions');
  const owed = txRows
    .map((r) => {
      const d = r.data || {};
      const pending = (Array.isArray(d.items) ? d.items : []).filter((it) => it && it.status === 'pending' && it.direction === 'receive');
      if (!pending.length) return null;
      const m = meta(d.stockNumber);
      return {
        id: r.id,
        client_id: text(d.clientId),
        from_client: text(d.fromClient),
        stock_no: text(d.stockNumber),
        reference: text(d.reference) || m?.ref || '',
        brand: text(d.brand) || m?.brand || '',
        items: pending.map((it) => ({ accessory: text(it.accessory) || 'Item', qty: Math.max(Number(it.qty) || 1, 1) })),
      };
    })
    .filter(Boolean);

  const numbers = [...stockRows.map((r) => r.stock_no), ...owed.flatMap((t) => stockList(t.stock_no))].filter(Boolean);
  const [ours, people, ck] = await Promise.all([
    oursByNumber(numbers),
    linksByClientId(owed.map((t) => t.client_id)),
    numbers.length ? query('SELECT stock_no, box, papers, service_papers FROM watches WHERE stock_no = ANY($1) AND deleted_at IS NULL', [[...new Set(numbers)]]) : { rows: [] },
  ]);
  const ckByNo = new Map(ck.rows.map((w) => [w.stock_no, w]));
  const link = (no) => {
    const first = stockList(no)[0] || '';
    return { watch: ours.get(first) || null, ck_missing: ckLacks(ckByNo.get(first)) };
  };

  for (const r of stockRows) Object.assign(r, link(r.stock_no));
  const byClient = new Map();
  for (const t of owed) {
    const c = people.get(t.client_id) || null;
    const key = c ? `c:${t.client_id}` : `?:${t.client_id || 'unknown'}`;
    const g = byClient.get(key) || {
      key,
      // The app: the client's name, else the typed fromClient, else its id, else "(Unknown client)".
      name: c ? c.name : t.from_client || t.client_id || '(Unknown client)',
      country: c ? c.country : '',
      link: c,
      items: 0,
      transactions: [],
    };
    const qty = t.items.reduce((s, it) => s + it.qty, 0);
    g.items += qty;
    g.transactions.push({ id: t.id, stock_no: t.stock_no, reference: t.reference, brand: t.brand, items: t.items, qty, ...link(t.stock_no) });
    byClient.set(key, g);
  }
  const clients = [...byClient.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  return {
    rows: stockRows,
    client_owes: { items: clients.reduce((s, c) => s + c.items, 0), clients },
    brands: [...new Set(stockRows.map((r) => r.brand))].sort(),
    accessories: [...new Set(stockRows.flatMap((r) => r.tokens.map((t) => t.accessory)))].sort(),
  };
}

/**
 * What this page knows about one watch, for its Inventory card and its page:
 * what its stock row says is missing where it is now, and what a client has
 * still to give us for it.
 */
export function forStock(stockNo, rows) {
  const out = [];
  const missing = [];
  for (const r of rows || []) {
    const d = r.data || {};
    if (!PLACE_OF_KIND[r.kind] || !countsHere(r.kind, d)) continue;
    if (!stockList(d.stockNumber).includes(stockNo)) continue;
    for (const t of parseMissingTokens(d.accessoriesMissing ?? d.missing)) {
      const label = t.qty > 1 ? `${t.accessory} × ${t.qty}` : t.accessory;
      if (!missing.includes(label)) missing.push(label);
    }
  }
  if (missing.length) out.push({ text: `Missing: ${missing.join(', ')}`, link: '#/logistics/missingacc', tone: 'warn' });
  for (const r of rows || []) {
    if (r.kind !== 'transactions') continue;
    const d = r.data || {};
    if (!stockList(d.stockNumber).includes(stockNo)) continue;
    const pending = (Array.isArray(d.items) ? d.items : []).filter((it) => it && it.status === 'pending' && it.direction === 'receive');
    if (!pending.length) continue;
    const words = pending.map((it) => (Number(it.qty) > 1 ? `${text(it.accessory) || 'Item'} × ${Number(it.qty)}` : text(it.accessory) || 'Item'));
    out.push({ text: `Client still to give us: ${words.join(', ')}`, link: `#/lg/${r.id}`, tone: 'warn' });
  }
  return out;
}
