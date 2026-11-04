import { query, tx } from '../db/index.js';
import { CURRENCIES, PAYMENT_KINDS } from './fields.js';
import { logEvent } from './index.js';
import { stockList } from '../logistics/kinds.js';
import * as accounts from '../accounts/index.js';
import { stockNosOf as accountsStockNos } from '../import/accounts/sync.js';

/*
 * A watch's additional expenditures (asked 4 Nov 2026): what it cost beyond
 * its purchase price — shipping, customs, a service, a commission, insurance,
 * travel. Two kinds, kept apart on the page:
 *
 * - KNOWN: the cost lines the logistics app and the accounts app already hold
 *   on the stock number, read from our copies (the logistics cost lines,
 *   shipments and couriers, movements and polish on its stock rows; the
 *   accounts app's expenses, commission settlements and the costs on a
 *   ledger leg). Read-only here. A line the app ties to SEVERAL watches at
 *   once — a courier that carried three, a trip — is shown as shared and
 *   left out of the total, because how it splits is nobody's guess.
 * - ADDED HERE: typed by a person, one per watch (watch_costs), in the cost's
 *   own currency, never converted — the ERP's own overview of what the watch
 *   cost, not a correction of the apps' lines and never written to them.
 *   Every add, change and removal is in the watch's history.
 *
 * Totals are per currency, as everywhere on the watch page.
 */

export const KINDS = ['shipping', 'customs', 'service', 'commission', 'insurance', 'travel', 'other'];
export const KIND_LABELS = { shipping: 'Shipping', customs: 'Customs / duty', service: 'Service / polish', commission: 'Commission', insurance: 'Insurance', travel: 'Travel', other: 'Other' };
export const MAX_COSTS = 100;
const PAID_BY = new Set(PAYMENT_KINDS.map((p) => p.key));
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const r2 = (n) => Math.round(n * 100) / 100;

/** The fields a person may set, checked: amount and currency are required, the rest optional. */
export function cleanCost(body, { partial = false } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  if (has('amount') || !partial) {
    const n = Number(String(b.amount ?? '').replace(/,/g, '').trim());
    if (!Number.isFinite(n) || n <= 0 || n > 1e9) throw bad('The amount must be a figure above zero');
    out.amount = r2(n);
  }
  if (has('currency') || !partial) {
    const c = String(b.currency ?? '').trim().toUpperCase();
    if (!CURRENCIES.includes(c)) throw bad(`The currency must be one of ${CURRENCIES.join(', ')}`);
    out.currency = c;
  }
  if (has('kind') || !partial) out.kind = KINDS.includes(String(b.kind)) ? String(b.kind) : 'other';
  if (has('title') || !partial) out.title = String(b.title ?? '').trim().slice(0, 200);
  if (has('note') || !partial) out.note = String(b.note ?? '').trim().slice(0, 2000);
  if (has('paid_by') || !partial) out.paid_by = PAID_BY.has(String(b.paid_by)) ? String(b.paid_by) : '';
  if (has('paid_on') || !partial) {
    const v = String(b.paid_on ?? '').trim();
    if (!v) out.paid_on = null;
    else {
      const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/) || v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (!m) throw bad('The date must be YYYY-MM-DD or DD/MM/YYYY');
      const [y, mo, d] = /^\d{4}/.test(v) ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
      const dt = new Date(Date.UTC(+y, +mo - 1, +d));
      if (dt.getUTCFullYear() !== +y || dt.getUTCMonth() !== +mo - 1 || dt.getUTCDate() !== +d) throw bad('That date does not exist');
      out.paid_on = `${y}-${mo}-${d}`;
    }
  }
  return out;
}

const SELECT = `SELECT c.id, c.kind, c.title, c.amount::float8 AS amount, c.currency, to_char(c.paid_on, 'YYYY-MM-DD') AS paid_on, c.paid_by, c.note,
                       c.created_at, c.updated_at, COALESCE(NULLIF(u.name, ''), u.email) AS user_name
                  FROM watch_costs c LEFT JOIN users u ON u.id = c.created_by`;

export async function listCosts(watchId) {
  const { rows } = await query(`${SELECT} WHERE c.watch_id = $1 AND c.deleted_at IS NULL ORDER BY c.paid_on NULLS LAST, c.id`, [Number(watchId) || 0]);
  return rows;
}

async function watchRow(db, watchId) {
  const { rows } = await db.query(
    'SELECT w.id, w.stock_no, (SELECT count(*)::int FROM watch_costs c WHERE c.watch_id = w.id AND c.deleted_at IS NULL) AS n FROM watches w WHERE w.id = $1',
    [Number(watchId) || 0]
  );
  if (!rows[0]) throw Object.assign(new Error('No such watch'), { status: 404 });
  return rows[0];
}

const said = (c) => ({ kind: c.kind, title: c.title, amount: c.amount, currency: c.currency, paid_on: c.paid_on, paid_by: c.paid_by, note: c.note });

export async function addCost(watchId, body, user) {
  const v = cleanCost(body);
  return tx(async (db) => {
    const w = await watchRow(db, watchId);
    if (w.n >= MAX_COSTS) throw bad(`A watch can hold ${MAX_COSTS} cost lines`);
    const { rows } = await db.query(
      `INSERT INTO watch_costs(watch_id, kind, title, amount, currency, paid_on, paid_by, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [w.id, v.kind, v.title, v.amount, v.currency, v.paid_on, v.paid_by, v.note, user?.id ?? null]
    );
    await logEvent(db, w.id, { userId: user?.id, action: 'cost_add', changes: { id: rows[0].id, ...said(v) } });
    return rows[0].id;
  });
}

export async function editCost(watchId, costId, body, user) {
  const v = cleanCost(body, { partial: true });
  if (!Object.keys(v).length) throw bad('Nothing to change');
  return tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM watch_costs WHERE id = $1 AND watch_id = $2 AND deleted_at IS NULL FOR UPDATE', [Number(costId) || 0, Number(watchId) || 0]);
    const was = rows[0];
    if (!was) throw Object.assign(new Error('No such cost'), { status: 404 });
    const changes = {};
    for (const [k, nv] of Object.entries(v)) {
      const old = k === 'amount' ? Number(was.amount) : k === 'paid_on' ? (was.paid_on ? new Date(was.paid_on).toISOString().slice(0, 10) : null) : was[k];
      if (old !== nv) changes[k] = [old, nv];
    }
    if (!Object.keys(changes).length) return;
    const sets = Object.keys(v).map((k, i) => `${k} = $${i + 3}`);
    await db.query(`UPDATE watch_costs SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND watch_id = $2`, [was.id, was.watch_id, ...Object.values(v)]);
    await logEvent(db, was.watch_id, { userId: user?.id, action: 'cost_edit', changes: { id: was.id, title: v.title ?? was.title, ...changes } });
  });
}

export async function removeCost(watchId, costId, user) {
  return tx(async (db) => {
    const { rows } = await db.query(
      'UPDATE watch_costs SET deleted_at = now() WHERE id = $1 AND watch_id = $2 AND deleted_at IS NULL RETURNING id, kind, title, amount::float8 AS amount, currency',
      [Number(costId) || 0, Number(watchId) || 0]
    );
    if (!rows[0]) throw Object.assign(new Error('No such cost'), { status: 404 });
    await logEvent(db, Number(watchId), { userId: user?.id, action: 'cost_remove', changes: { id: rows[0].id, kind: rows[0].kind, title: rows[0].title, amount: rows[0].amount, currency: rows[0].currency } });
  });
}

/* ── what the two apps already know ─────────────────────────────── */

const num = (v) => Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0;
const cur = (v) => String(v ?? '').trim().toUpperCase();
const day = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : /^\d{11,}$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  return Number.isFinite(t) && t > 0 && t < 4e12 ? new Date(t).toISOString().slice(0, 10) : null;
};
const PLACE = { londonStock: 'London', dubaiStock: 'Dubai', hkStock: 'Hong Kong', hkSituation: 'Hong Kong', safeStock: 'the safe' };
const LG_KINDS = ['logisticCosts', 'shipments', 'thirdPartyShipments', ...Object.keys(PLACE)];

/**
 * The logistics app's cost lines on a stock number, from our copy: each with
 * the watches it is shared with (its row's stock_nos), so a line for several
 * watches at once is said to be — and not counted.
 */
export async function logisticsCosts(no) {
  const want = stockList(no);
  if (!want.length) return { lines: [], copied_at: null };
  const { rows } = await query(
    `SELECT id, kind, data, stock_nos, updated_at FROM logistics_items
      WHERE deleted_at IS NULL AND kind = ANY($1) AND stock_nos && $2::text[] ORDER BY happened_at NULLS LAST, id`,
    [LG_KINDS, want]
  );
  const lines = [];
  let copied = null;
  const line = (r, what, title, amount, currency, when, extra = {}) => {
    if (!num(amount)) return;
    const shared = (r.stock_nos || []).filter((s) => !want.includes(s));
    lines.push({ source: 'logistics', what, title, amount: r2(num(amount)), currency: cur(currency) || '', date: day(when), shared_with: shared, ref: `${r.kind}:${r.id}`, ...extra });
  };
  for (const r of rows) {
    const d = r.data || {};
    if (!copied || r.updated_at > copied) copied = r.updated_at;
    if (r.kind === 'logisticCosts') line(r, d.tripId ? 'Trip cost' : d.shipmentId ? 'Shipment cost' : 'Cost', d.title || d.notes || d.category || 'Cost', d.amount, d.currency, d.date || d.createdAt);
    else if (r.kind === 'shipments') line(r, 'Shipment', `Shipped${d.toText || d.to ? ` to ${d.toText || d.to}` : ''}${d.tracking ? ` · ${d.tracking}` : ''}`, d.costAmount ?? d.cost, d.costCurrency || d.currency, d.date || d.createdAt);
    else if (r.kind === 'thirdPartyShipments') line(r, 'Courier', `${d.moverName || 'Courier'}${d.fromCountry || d.toCountry ? `, ${d.fromCountry || '…'} → ${d.toCountry || '…'}` : ''}`, d.amount, d.currency, d.shipmentDate || d.createdAt);
    else {
      // A stock row is the watch's own: its movements and polish are never shared.
      if (!want.includes(String(d.stockNumber ?? '').trim())) continue;
      const own = { ...r, stock_nos: want };
      for (const m of Array.isArray(d.movements) ? d.movements : []) {
        const to = m.to || m.destination || m.toLocation || '';
        line(own, 'Movement', `${m.type ? String(m.type).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'Moved'}${to ? ` to ${to}` : ''}${m.carrier ? ` by ${m.carrier}` : ''}`, m.cost ?? m.costAmount, m.costCurrency || m.currency, m.date || m.ts || m.at || m.movedAt);
      }
      for (const p of [...(d.polish ? [d.polish] : []), ...(Array.isArray(d.polishHistory) ? d.polishHistory : [])]) {
        line(own, 'Polish', `Polish${p.sentTo ? ` at ${p.sentTo}` : ''}${p.itemDescription ? ` · ${p.itemDescription}` : ''}`, p.costAmount ?? p.cost, p.costCurrency || p.currency, p.sentDate || p.sentAt || p.returnedDate);
      }
      if (num(d.cost ?? d.costAmount)) line(own, 'Cost', `In ${PLACE[r.kind]} stock`, d.cost ?? d.costAmount, d.costCurrency || d.currency, d.receivedAt || d.createdAt);
    }
  }
  return { lines, copied_at: copied };
}

/**
 * The accounts app's cost lines on a stock number — its expenses, the
 * commission settled on it, the costs on a ledger leg — from our copy, or
 * live with the person's own sign-in when the copy is not there (as the
 * Accounts window reads it).
 */
export async function accountsCosts(no, { cookie = '' } = {}) {
  const acc = await accounts.forStock(no, { cookie }).catch((err) => ({ error: err.message, source: 'none' }));
  const lines = [];
  if (!acc || acc.error) return { lines, source: acc?.source || 'none', read_at: null, error: acc?.error || '' };
  const push = (what, title, amount, currency, when, shared, ref) => {
    if (!num(amount)) return;
    lines.push({ source: 'accounts', what, title, amount: r2(num(amount)), currency: cur(currency) || '', date: day(when), shared_with: shared, ref });
  };
  const others = (kind, d) => accountsStockNos(kind, d).filter((s) => s !== String(no));
  for (const r of acc.expenses || []) push('Expense', [r.data.title, r.data.category, r.data.vendor].filter(Boolean).join(' · ') || r.data.description || 'Expense', r.data.amount, r.data.ccy, r.data.date, others('expenses', r.data), `expenses:${r.source_id ?? r.id ?? ''}`);
  for (const r of acc.settlements || []) {
    for (const x of Array.isArray(r.data.lines) ? r.data.lines : []) {
      if (String(x.stock ?? '').trim() !== String(no)) continue;
      push('Commission', `Commission${r.data.employee || r.data.empName ? ` to ${r.data.employee || r.data.empName}` : ''}${x.role ? ` · ${x.role}` : ''}`, x.commission ?? x.amount, x.ccy || r.data.ccy || 'USD', r.data.date, [], `commissionSettlements:${r.source_id ?? r.id ?? ''}:${x.stock}`);
    }
  }
  for (const r of acc.entries || []) {
    const e = r.data || {};
    if (e._cancelled) continue;
    for (const c of Array.isArray(e.costs) ? e.costs : []) {
      push(e.type === 'PAYABLE' ? 'On the purchase' : 'On the sale', c.label || c.title || c.note || (e.type === 'PAYABLE' ? 'Cost on the purchase leg' : 'Cost on the sale leg'), c.amount, c.ccy || e.ccy, c.date || e.date, others('entries', e), `entries:${r.source_id ?? r.id ?? ''}:${c.id ?? c.label ?? ''}`);
    }
  }
  return { lines, source: acc.source || 'copy', read_at: acc.read_at || null, error: '' };
}

/** Per-currency sums; a shared line is left out. */
export function totalsOf(lines) {
  const t = {};
  for (const l of lines) {
    if (l.shared_with?.length) continue;
    const c = l.currency || '—';
    t[c] = r2((t[c] || 0) + num(l.amount));
  }
  return t;
}

/** Everything the page shows: the lines added here, the lines the apps know, and the totals per currency. */
export async function costsOf(watch, { cookie = '', accountsOn = true } = {}) {
  const [manual, lg, acc] = await Promise.all([
    listCosts(watch.id),
    watch.stock_no ? logisticsCosts(watch.stock_no).catch((err) => ({ lines: [], copied_at: null, error: err.message })) : { lines: [], copied_at: null },
    accountsOn && watch.stock_no ? accountsCosts(watch.stock_no, { cookie }) : { lines: [], source: 'none', read_at: null, error: '' },
  ]);
  const known = [...lg.lines, ...acc.lines].sort((a, b) => String(a.date || '9').localeCompare(String(b.date || '9')));
  const manualLines = manual.map((c) => ({ source: 'erp', what: KIND_LABELS[c.kind] || c.kind, title: c.title, amount: c.amount, currency: c.currency, date: c.paid_on, shared_with: [] }));
  const totals = { known: totalsOf(known), added: totalsOf(manualLines), all: totalsOf([...known, ...manualLines]) };
  return {
    added: manual,
    known,
    totals,
    shared: known.filter((l) => l.shared_with.length).length,
    logistics: { copied_at: lg.copied_at, error: lg.error || '' },
    accounts: { source: acc.source, read_at: acc.read_at, error: acc.error || '' },
    kinds: KINDS,
    currencies: CURRENCIES,
    paid_by: PAYMENT_KINDS,
  };
}
