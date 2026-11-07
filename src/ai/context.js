import { query } from '../db/index.js';
import * as watches from '../watches/index.js';
import * as clients from '../clients/index.js';
import { passport } from '../logistics/passport.js';
import * as lgClients from '../logistics/clients.js';
import * as accounts from '../accounts/index.js';
import * as accClients from '../accounts/clients.js';
import { listCosts } from '../watches/costs.js';

/*
 * What the model reads (asked 4 Nov 2026: "add api to the tool so it can read
 * through everything easily and be smart about what and how to show the data
 * combined"): one watch's whole picture — the ERP's own record and history,
 * who it was bought from and sold to, what the reference has sold for, the
 * logistics app's story on it (from our copy) and the accounts app's ledger
 * on it (our copy, or the app live with the person's sign-in) — and the
 * pictures of a client and of the open ledger, for the questions asked
 * across everything. Trimmed before it goes: no pictures, papers or inline
 * files, no provenance histories, long lists capped. Nothing here writes.
 */

const DROP = /photo|image|pic\b|pics|docs?\b|documents?|proofs?|attachments?|files?\b|_history|dataUrl|thumb|base64|password|secret|token|apikey|pin$/i;
const MAX_LIST = 60;
const MAX_TEXT = 400;

/** The value as the model gets it: files, pictures and secrets out, lists capped, long texts cut. */
export function trim(v, depth = 0) {
  if (depth > 8) return undefined;
  if (typeof v === 'string') {
    if (/^(data:|acfile:|lgfile:)/.test(v) || /^https?:\/\/\S+\.(jpe?g|png|webp|gif|pdf)(\?|$)/i.test(v)) return undefined;
    return v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}…` : v;
  }
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_LIST).map((x) => trim(x, depth + 1)).filter((x) => x !== undefined);
    if (v.length > MAX_LIST) out.push(`… ${v.length - MAX_LIST} more`);
    return out;
  }
  if (v && typeof v === 'object') {
    if (v instanceof Date) return v.toISOString();
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (DROP.test(k)) continue;
      const t = trim(x, depth + 1);
      if (t !== undefined && t !== null && t !== '' && !(Array.isArray(t) && !t.length) && !(typeof t === 'object' && !Array.isArray(t) && !Object.keys(t).length)) out[k] = t;
    }
    return out;
  }
  return v;
}

const WATCH_KEYS = [
  'id', 'stock_no', 'category', 'display_title', 'brand', 'model', 'reference', 'serial', 'watch_date', 'status', 'location', 'origin', 'condition', 'dial', 'size', 'case_material', 'bezel', 'bracelet',
  // jewellery and bags (5 Nov 2026) — blank on a watch
  'jewel_type', 'material', 'carats', 'gemstones', 'gem_colour', 'gem_clarity', 'chain_length', 'ring_size', 'weight', 'certificate',
  'bag_type', 'bag_material', 'bag_colour', 'bag_size', 'hardware', 'date_code',
  'papers', 'service_papers', 'box', 'description', 'notes', 'purchase_date', 'purchased_from', 'purchase_price', 'purchase_currency', 'purchase_price_eur', 'purchase_payments',
  'sale_date', 'sold_to', 'sale_price', 'sale_currency', 'sale_price_eur', 'sale_payments', 'retail_price', 'retail_currency', 'website_price', 'website_currency',
  'b2b_price', 'b2c_price', 'chrono24_price', 'order_type', 'ck_product_id', 'locked_fields', 'deleted_at', 'created_at', 'updated_at',
];

/** One watch's whole picture, for the brief and for the model's `watch_picture` tool. */
export async function watchPicture(idOrNo, { cookie = '' } = {}) {
  let id = Number(idOrNo) || 0;
  if (!id || !/^\d+$/.test(String(idOrNo))) id = 0;
  // A stock number (as typed, "1668" or "1668A") when no watch has that id or it reads like one.
  let w = null;
  if (id) w = await watches.getWatch(id).catch(() => null);
  if (!w) {
    const { rows } = await query('SELECT id FROM watches WHERE stock_no = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1', [String(idOrNo).trim()]);
    if (rows[0]) w = await watches.getWatch(rows[0].id);
  }
  if (!w) return null;
  const [links, events, sold, related, lg, acc, costs] = await Promise.all([
    clients.linksOf(w),
    watches.watchEvents(w.id, 80),
    watches.soldFor(w.id, 10).catch(() => null),
    w.ck_product_id
      ? query('SELECT id, stock_no, status, purchase_date, sale_date, sale_price, sale_currency FROM watches WHERE ck_product_id = $1 AND id <> $2 AND deleted_at IS NULL ORDER BY purchase_date', [w.ck_product_id, w.id]).then((r) => r.rows)
      : [],
    w.stock_no ? passport(w.stock_no).catch(() => null) : null,
    w.stock_no ? accounts.forStock(w.stock_no, { cookie }).catch((err) => ({ error: err.message })) : null,
    listCosts(w.id).catch(() => []),
  ]);
  const watch = Object.fromEntries(WATCH_KEYS.filter((k) => w[k] !== undefined && w[k] !== null && w[k] !== '').map((k) => [k, w[k]]));
  watch.photo_count = (w.photos || []).length;
  watch.status_why = w.status_why;
  // The history as changes only: what moved, when, by whom.
  const history = events
    .filter((e) => e.action !== 'photo_remove' && e.action !== 'photo_add')
    .map((e) => ({ at: e.at, by: e.user_name || e.source, action: e.action, changes: e.changes }))
    .slice(0, 40);
  return trim({
    watch,
    clients: { bought_from: links.purchase, sold_to: links.sale },
    history,
    reference_sold_for: sold,
    same_watch_other_purchases: related,
    logistics: lg && !lg.empty ? { ...lg, copied: undefined, copiedAt: lg.copiedAt } : null,
    costs_added_here: costs.map((c) => ({ kind: c.kind, title: c.title, amount: c.amount, ccy: c.currency, paid_on: c.paid_on, paid_by: c.paid_by, note: c.note, by: c.user_name })),
    accounts: acc,
  });
}

/** Our client's picture: who they are, the watches each way, and what the logistics and accounts apps tie to them. */
export async function clientPicture(idOrName) {
  let c = null;
  if (/^\d+$/.test(String(idOrName))) c = await clients.getClient(Number(idOrName)).catch(() => null);
  if (!c) {
    const r = await clients.listClients({ q: String(idOrName), limit: 5 });
    const list = r.clients || r.rows || [];
    if (list.length === 1) c = await clients.getClient(list[0].id);
    else return { matches: list.map((x) => ({ id: x.id, name: x.name, company: x.company, type: x.type })) };
  }
  const acc = await accounts.forOurClient(c.id).catch(() => null);
  const line = (w) => ({ id: w.id, stock_no: w.stock_no, title: w.title, status: w.status, purchase_date: w.purchase_date, purchase_price: w.purchase_price, purchase_currency: w.purchase_currency, sale_date: w.sale_date, sale_price: w.sale_price, sale_currency: w.sale_currency });
  return trim({
    client: { id: c.id, name: c.name, company: c.company, type: c.type, email: c.email, phone: c.phone, notes: c.notes, origin: c.origin },
    bought_from_them: (c.bought || []).map(line),
    sold_to_them: (c.sold || []).map(line),
    accounts: acc,
  });
}

/** Watches found by words (stock number, reference, serial, brand, model, a client), with the facets. */
export async function searchWatches({ q = '', status = '', location = '', brand = '', limit = 20 } = {}) {
  const r = await watches.listWatches({ q, status, location, brand, limit, sort: 'newest' });
  return trim({
    total: r.total,
    watches: (r.watches || []).map((w) => ({
      id: w.id, stock_no: w.stock_no, title: w.title, reference: w.reference, serial: w.serial, status: w.status, location: w.location,
      purchase_date: w.purchase_date, purchase_price: w.purchase_price, purchase_currency: w.purchase_currency, bought_from: w.bought_from,
      sale_date: w.sale_date, sale_price: w.sale_price, sale_currency: w.sale_currency, sold_to: w.sold_to,
    })),
    facets: r.facets,
  });
}

/** Our clients found by words. */
export async function searchClients(q, limit = 20) {
  const r = await clients.listClients({ q, limit });
  const list = r.clients || r.rows || [];
  return trim({ total: r.total ?? list.length, clients: list.map((c) => ({ id: c.id, name: c.name, company: c.company, type: c.type, phone: c.phone, email: c.email, bought: c.bought, sold: c.sold })) });
}

/**
 * The open ledger, from our copy of the accounts app: every entry with
 * something outstanding, owed to us (receivables) or owed by us (payables),
 * with its client, stock number and what is left — newest first.
 */
export async function accountsOpen({ direction = 'both', limit = 60 } = {}) {
  const { rows } = await query(
    `SELECT source_id, data, happened_at, client_ids FROM accounts_items WHERE kind = 'entries' AND deleted_at IS NULL ORDER BY happened_at DESC NULLS LAST LIMIT 3000`
  );
  const want = direction === 'owed_to_us' ? 'RECEIVABLE' : direction === 'we_owe' ? 'PAYABLE' : null;
  const open = [];
  for (const r of rows) {
    const e = r.data || {};
    if (want && e.type !== want) continue;
    if (e._cancelled) continue;
    const left = accounts.outstandingOf(e);
    if (left <= 0.005) continue;
    open.push({ id: r.source_id, type: e.type, client_id: e.clientId, stock: e.stock, model: e.model, date: e.date, due: e.dueDate, amount: e.amount, ccy: e.ccy, paid: accounts.paidOf(e), outstanding: left, invoice: e.invoiceNo });
    if (open.length >= limit) break;
  }
  const who = await accClients.linksByClientId([...new Set(open.map((o) => o.client_id).filter(Boolean))]);
  for (const o of open) {
    const c = who.get(String(o.client_id));
    if (c) {
      o.client = c.name;
      if (c.client_id) o.our_client = { id: c.client_id, name: c.client_name };
    }
  }
  const totals = {};
  for (const o of open) {
    const t = (totals[o.ccy || '—'] ||= { owed_to_us: 0, we_owe: 0 });
    if (o.type === 'RECEIVABLE') t.owed_to_us += o.outstanding;
    else t.we_owe += o.outstanding;
  }
  return trim({ copy_present: rows.length > 0, open, totals });
}

/** Where the logistics app has a watch, from our copy. */
export async function logisticsWhere(stockNo) {
  const p = await passport(String(stockNo).trim());
  if (!p) return null;
  const links = await lgClients.linksByName([]).catch(() => new Map());
  void links;
  return trim({ ...p, copied: undefined });
}
