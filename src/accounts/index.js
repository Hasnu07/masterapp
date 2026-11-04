import { query } from '../db/index.js';
import { config } from '../config.js';
import { lastAccountsRead } from '../import/accounts/sync.js';
import { linksByClientId, accountsClientsOf } from './clients.js';

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
 * Everything our copy of the accounts app holds on one stock number: the
 * ledger's purchase and sale legs with their payments, quick sales, invoices,
 * expenses and commission lines naming it — and who its clients are, in the
 * app and in the ERP.
 */
export async function forStock(no) {
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
