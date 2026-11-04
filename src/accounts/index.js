import { query } from '../db/index.js';
import { config } from '../config.js';
import { lastAccountsRead, stockNosOf, clientIdsOf, happenedAt } from '../import/accounts/sync.js';
import { fetchStateAs, erpSessionCookie } from '../import/accounts/client.js';
import { linksByClientId, accountsClientsOf, oursByExactName } from './clients.js';
import { accountsCookies } from '../web/accapp.js';

/*
 * Accounts in the ERP is the accounts app itself (web/accapp.js), served at
 * /acc-app/ — and, beside it, what our copy of its records says about one
 * watch or one client (the watch page's Accounts window, the client page's
 * panel). Nothing here writes to the app.
 */

/* The app's pages a link of ours can open: our key → the app's own route. */
export const PAGES = [
  { key: 'dashboard', label: 'Dashboard', path: '/' },
  { key: 'clients', label: 'Clients', path: '/clients' },
  { key: 'payable', label: 'Payable', path: '/clients/payable' },
  { key: 'receivable', label: 'Receivable', path: '/clients/receivable' },
  { key: 'wallets', label: 'Wallets', path: '/clients/wallets' },
  { key: 'currencies', label: 'Currencies', path: '/clients/currencies' },
  { key: 'rates', label: 'Exchange rates', path: '/clients/rates' },
  { key: 'pnl', label: 'P&L', path: '/clients/pnl' },
  { key: 'invoices', label: 'Documents', path: '/invoices' },
  { key: 'expenses', label: 'Expenses', path: '/expenses' },
  { key: 'quicksale', label: 'Quick sale', path: '/quick-sale' },
  { key: 'exchange', label: 'Exchange desk', path: '/exchange' },
  { key: 'schedule', label: 'Schedule', path: '/schedule' },
  { key: 'employees', label: 'Employees', path: '/employees' },
  { key: 'partners', label: 'Partner desk', path: '/partner-desk' },
  { key: 'reconcile', label: 'Reconcile', path: '/reconcile' },
  { key: 'reports', label: 'Reports', path: '/reports' },
  { key: 'stock', label: 'Stock report', path: '/reports/stock' },
  { key: 'companies', label: 'Own companies', path: '/companies' },
  { key: 'team', label: 'Team', path: '/admin/team' },
];

export function catalog() {
  return {
    app_embedded: Boolean(config.accounts.appUrl),
    sync: config.accounts.enabled && config.accounts.configured,
    pages: PAGES,
  };
}

/* ── the ledger's arithmetic, as the app does it ───────────────────── */

const num = (v) => (v === '' || v == null ? 0 : parseFloat(v) || 0);
const r2 = (n) => Math.round((+n || 0) * 100) / 100;
export const paidOf = (e) => r2((e.payments || []).reduce((t, p) => t + num(p.applied != null ? p.applied : p.amount), 0));
export const targetOf = (e) => (e && e._cancelled ? 0 : r2(num(e.amount) + (e.costs || []).reduce((t, c) => t + num(c.amount), 0)));
export const outstandingOf = (e) => r2(Math.max(0, targetOf(e) - paidOf(e)));
export const statusOf = (e) => {
  if (e && e._cancelled) return 'cancelled';
  const p = paidOf(e);
  if (p <= 0) return 'open';
  return outstandingOf(e) <= 0.005 ? 'settled' : 'partial';
};

const KINDS_FOR_STOCK = ['entries', 'quickSales', 'invoices', 'expenses', 'commissionSettlements'];

/**
 * Everything the accounts app holds on one stock number: the ledger's
 * purchase and sale legs with their payments, quick sales, invoices, expenses
 * and commission lines naming it — and who its clients are, in the app and in
 * the ERP. From OUR COPY when the copy is running (`source: 'copy'`); when it
 * is not there yet (no account for the ERP in the app, or the first pass still
 * to come — seen live 4 Nov 2026: "accountancy info not showing up"), from
 * the app itself, read with the person's own accounts sign-in out of the
 * frame, else the ERP's (`source: 'live'`); and when neither can read it,
 * empty, saying why (`source: 'none'`).
 */
export async function forStock(no, { cookie = '' } = {}) {
  const copy = await copyForStock(no);
  const { rows } = await query("SELECT EXISTS(SELECT 1 FROM accounts_items WHERE deleted_at IS NULL AND kind = 'entries') AS any");
  if (rows[0].any) return { ...copy, source: 'copy' };
  try {
    const live = await liveForStock(no, cookie);
    if (live) return live;
    return { ...copy, source: 'none', why: 'Not signed in to the accounts app' };
  } catch (err) {
    return { ...copy, source: 'none', why: err.message };
  }
}

const LIVE_LISTS = ['entries', 'clients', 'accounts', 'invoices', 'quickSales', 'expenses', 'commissionSettlements'];
/* The app's answer held a minute per session: a watch page opens the Accounts window and the Timeline close together. */
const liveHeld = new Map();
async function liveState(cookieHeader) {
  let cookie = accountsCookies(cookieHeader);
  if (!/connect\.sid=/.test(cookie)) cookie = await erpSessionCookie();
  if (!cookie) return null;
  const had = liveHeld.get(cookie);
  if (had && Date.now() - had.at < 60_000) return had.state;
  const state = await fetchStateAs(cookie, LIVE_LISTS);
  if (liveHeld.size > 50) liveHeld.clear();
  liveHeld.set(cookie, { at: Date.now(), state });
  return state;
}
export const forgetLive = () => liveHeld.clear();

async function liveForStock(no, cookieHeader) {
  const state = await liveState(cookieHeader);
  if (!state || typeof state !== 'object') return null;
  const items = [];
  for (const kind of KINDS_FOR_STOCK) {
    for (const r of Array.isArray(state[kind]) ? state[kind] : []) {
      if (!r || typeof r !== 'object' || !stockNosOf(kind, r).includes(String(no))) continue;
      items.push({ id: null, kind, source_id: r.id == null ? null : String(r.id), happened_at: happenedAt(r), data: r, client_ids: clientIdsOf(r) });
    }
  }
  const invoiceNos = new Set(items.filter((r) => r.kind === 'entries').map((r) => String(r.data.invoiceNo || '').trim().toLowerCase()).filter(Boolean));
  for (const r of Array.isArray(state.invoices) ? state.invoices : []) {
    if (r && invoiceNos.has(String(r.invoiceNo || '').trim().toLowerCase()) && !items.some((x) => x.kind === 'invoices' && x.data === r)) {
      items.push({ id: null, kind: 'invoices', source_id: r.id == null ? null : String(r.id), happened_at: happenedAt(r), data: r, client_ids: clientIdsOf(r) });
    }
  }
  items.sort((a, b) => String(b.happened_at || '').localeCompare(String(a.happened_at || '')));
  // Its clients, by the app's ids — ours when exactly one of ours carries the name (the copy's ledger match needs the copy).
  const cids = [...new Set(items.flatMap((r) => r.client_ids))];
  const appClients = new Map((Array.isArray(state.clients) ? state.clients : []).filter((c) => c && c.id != null).map((c) => [String(c.id), c]));
  const named = await oursByExactName(cids.map((id) => appClients.get(id)?.name).filter(Boolean));
  const clients = {};
  for (const id of cids) {
    const c = appClients.get(id);
    if (!c) continue;
    const ours = named.get(String(c.name || '').trim());
    clients[id] = { acc_client_id: id, name: c.name || '', company: c.company || '', client_id: ours?.client_id || null, client_name: ours?.client_name || '', how: ours ? 'name' : null };
  }
  const walletIds = new Set(items.flatMap((r) => [...(r.data.payments || []).map((p) => p._walletAccId || p.walletAccId || p.accountId), r.data.walletAccId]).filter(Boolean).map(String));
  const wallets = {};
  for (const w of Array.isArray(state.accounts) ? state.accounts : []) {
    if (w && walletIds.has(String(w.id))) wallets[String(w.id)] = { name: w.name || '', company: w.company || '', bank: w.bankName || '', ccy: w.ccy || '', kind: w.kind || '' };
  }
  const entries = items.filter((r) => r.kind === 'entries').map((r) => ({ ...r, status: statusOf(r.data), paid: paidOf(r.data), target: targetOf(r.data), outstanding: outstandingOf(r.data) }));
  return {
    stock: String(no),
    entries,
    quick_sales: items.filter((r) => r.kind === 'quickSales'),
    invoices: items.filter((r) => r.kind === 'invoices'),
    expenses: items.filter((r) => r.kind === 'expenses'),
    settlements: items.filter((r) => r.kind === 'commissionSettlements'),
    clients,
    wallets,
    read_at: new Date().toISOString(),
    sync: catalog().sync,
    source: 'live',
  };
}

async function copyForStock(no) {
  const { rows } = await query(
    `SELECT id, kind, source_id, data, happened_at, client_ids FROM accounts_items
      WHERE deleted_at IS NULL AND kind = ANY($1) AND stock_nos @> ARRAY[$2]::text[]
      ORDER BY happened_at DESC NULLS LAST, id DESC`,
    [KINDS_FOR_STOCK, String(no)]
  );
  const items = rows.map((r) => ({ id: r.id, kind: r.kind, source_id: r.source_id, happened_at: r.happened_at, data: r.data, client_ids: r.client_ids }));
  // An invoice names no stock number itself: it is the entry's, by its invoice number (as the app ties the two).
  const invoiceNos = [...new Set(items.filter((r) => r.kind === 'entries').map((r) => String(r.data.invoiceNo || '').trim().toLowerCase()).filter(Boolean))];
  if (invoiceNos.length) {
    const { rows: docs } = await query(
      `SELECT id, kind, source_id, data, happened_at, client_ids FROM accounts_items
        WHERE deleted_at IS NULL AND kind = 'invoices' AND lower(trim(data->>'invoiceNo')) = ANY($1) ORDER BY happened_at DESC NULLS LAST, id DESC`,
      [invoiceNos]
    );
    for (const d of docs) if (!items.some((r) => r.id === d.id)) items.push({ id: d.id, kind: d.kind, source_id: d.source_id, happened_at: d.happened_at, data: d.data, client_ids: d.client_ids });
  }
  const cids = [...new Set(items.flatMap((r) => r.client_ids || []))];
  const who = await linksByClientId(cids);
  // The wallets its payments went to or came from (the app's `accounts` collection), by id.
  const walletIds = [
    ...new Set(
      items.flatMap((r) => [...(r.data.payments || []).map((p) => p._walletAccId || p.walletAccId || p.accountId), r.data.walletAccId]).filter(Boolean).map(String)
    ),
  ];
  const wallets = {};
  if (walletIds.length) {
    const { rows: ws } = await query("SELECT source_id, data FROM accounts_items WHERE kind = 'accounts' AND deleted_at IS NULL AND source_id = ANY($1)", [walletIds]);
    for (const r of ws) wallets[r.source_id] = { name: r.data.name || '', company: r.data.company || '', bank: r.data.bankName || '', ccy: r.data.ccy || '', kind: r.data.kind || '' };
  }
  const entries = items
    .filter((r) => r.kind === 'entries')
    .map((r) => ({ ...r, status: statusOf(r.data), paid: paidOf(r.data), target: targetOf(r.data), outstanding: outstandingOf(r.data) }));
  return {
    stock: String(no),
    entries,
    quick_sales: items.filter((r) => r.kind === 'quickSales'),
    invoices: items.filter((r) => r.kind === 'invoices'),
    expenses: items.filter((r) => r.kind === 'expenses'),
    settlements: items.filter((r) => r.kind === 'commissionSettlements'),
    clients: Object.fromEntries([...who]),
    wallets,
    read_at: lastAccountsRead(),
    sync: catalog().sync,
  };
}

/**
 * What the accounts app says about OUR client: which of its clients that is,
 * and what stands open with them — owed to us (receivables) and owed by us
 * (payables), per currency — and how many entries there are.
 */
export async function forOurClient(ourClientId) {
  const linked = await accountsClientsOf(ourClientId);
  if (!linked.length) return { links: [], balances: {}, entries: 0, last_at: null, read_at: lastAccountsRead() };
  const { rows } = await query(
    `SELECT data, happened_at FROM accounts_items WHERE kind = 'entries' AND deleted_at IS NULL AND client_ids && $1::text[]`,
    [linked.map((l) => l.acc_client_id)]
  );
  const balances = {};
  let last = null;
  for (const r of rows) {
    const e = r.data || {};
    const ccy = String(e.ccy || '').toUpperCase() || '—';
    const b = (balances[ccy] ||= { owed_to_us: 0, we_owe: 0 });
    const open = outstandingOf(e);
    if (e.type === 'RECEIVABLE') b.owed_to_us = r2(b.owed_to_us + open);
    else if (e.type === 'PAYABLE') b.we_owe = r2(b.we_owe + open);
    if (r.happened_at && (!last || r.happened_at > last)) last = r.happened_at;
  }
  for (const k of Object.keys(balances)) if (!balances[k].owed_to_us && !balances[k].we_owe) delete balances[k];
  return { links: linked, balances, entries: rows.length, last_at: last, read_at: lastAccountsRead() };
}
