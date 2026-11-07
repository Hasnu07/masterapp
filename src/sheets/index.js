/*
 * Sheets: a spreadsheet of the system, kept and edited here.
 *
 * The document (`sheets.doc`) is { columns, rows, note, groupBy }: each
 * column { key, label, type, bind?, formula? }, each row { key, ref?, bind?,
 * cells: {key: value}, edited?: {key: true} }. Edits change the SHEET only.
 * Putting one into the system is a separate, deliberate step (`apply`,
 * asked 7 Nov 2026: "when we enter new data … it asks us do you want this to
 * add in the system too") — done through the same functions as the pages'
 * forms, so a change is locked against the copy and logged like any edit.
 */
import crypto from 'node:crypto';
import { query, tx } from '../db/index.js';
import * as watches from '../watches/index.js';
import * as expenses from '../expenses/index.js';
import * as clients from '../clients/index.js';
import { FIELD } from '../watches/fields.js';
import { buildSheet, fillFormulas, KINDS, letters } from './build.js';
import { renderPdf } from '../pdf/index.js';

export { KINDS, buildSheet };

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const notFound = () => Object.assign(new Error('No such sheet'), { status: 404 });
const MAX_ROWS = 5000;
const MAX_COLS = 60;

/* ── reading and keeping ──────────────────────────────────────────── */

export async function listSheets({ limit = 100 } = {}) {
  const { rows } = await query(
    `SELECT s.id, s.kind, s.title, s.subject, s.built_at, s.updated_at, s.created_at, jsonb_array_length(COALESCE(s.doc->'rows', '[]'::jsonb)) AS row_count,
            u.name AS updated_by_name
       FROM sheets s LEFT JOIN users u ON u.id = s.updated_by
      WHERE s.deleted_at IS NULL ORDER BY s.updated_at DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), 500)]
  );
  return { sheets: rows };
}

export async function getSheet(id, { workbook = false } = {}) {
  const { rows } = await query(
    `SELECT s.id, s.kind, s.title, s.subject, s.doc, s.version, s.built_at, s.created_by, s.updated_by, s.created_at, s.updated_at, s.workbook_at,
            ${workbook ? 's.workbook,' : ''} u.name AS updated_by_name
       FROM sheets s LEFT JOIN users u ON u.id = s.updated_by WHERE s.id = $1 AND s.deleted_at IS NULL`,
    [Number(id) || 0]
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}

/** Builds a sheet from the system and keeps it. */
export async function createSheet(kind, subject, user) {
  if (!KINDS.some((k) => k.key === kind) && kind !== 'blank') throw bad(`Which kind of sheet? One of ${KINDS.map((k) => k.key).join(', ')}`);
  const built = await buildSheet(kind, subject || {});
  const doc = { columns: built.columns, rows: built.rows, note: built.note, groupBy: built.groupBy || null };
  const { rows } = await query(
    `INSERT INTO sheets(kind, title, subject, doc, built_at, created_by, updated_by) VALUES ($1, $2, $3, $4, now(), $5, $5) RETURNING id`,
    [kind, built.title, JSON.stringify(subject || {}), JSON.stringify(doc), user?.id ?? null]
  );
  return rows[0].id;
}

/** Reads a kept sheet's rows from the system again; cells edited by hand and columns added by hand are kept. */
export async function rebuildSheet(id, user) {
  const s = await getSheet(id);
  if (s.kind === 'blank') throw bad('A blank sheet has nothing to read again');
  const built = await buildSheet(s.kind, s.subject || {});
  const old = s.doc || { columns: [], rows: [] };
  const known = new Set(built.columns.map((c) => c.key));
  const extraCols = (old.columns || []).filter((c) => !known.has(c.key));
  const columns = [...built.columns, ...extraCols];
  const oldRows = new Map((old.rows || []).map((r) => [r.key, r]));
  const rows = built.rows.map((r) => {
    const o = oldRows.get(r.key);
    if (!o) return r;
    const cells = { ...r.cells };
    for (const k of Object.keys(o.edited || {})) if (o.cells[k] !== undefined) cells[k] = o.cells[k];
    for (const c of extraCols) if (o.cells[c.key] !== undefined) cells[c.key] = o.cells[c.key];
    return { ...r, cells, edited: o.edited || {} };
  });
  // Rows typed by hand (no record behind them) stay, after the system's.
  const builtKeys = new Set(built.rows.map((r) => r.key));
  for (const o of old.rows || []) if (o.manual && !builtKeys.has(o.key)) rows.push(o);
  const doc = { ...old, columns, rows, note: built.note, groupBy: old.groupBy ?? built.groupBy ?? null };
  fillFormulas(doc);
  // The workbook kept from GridCraft is of the old rows: dropped, so the next open is made from the document.
  await query(`UPDATE sheets SET doc = $1, title = COALESCE(NULLIF(title, ''), $2), built_at = now(), workbook = NULL, workbook_at = NULL, updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $4`, [
    JSON.stringify(doc),
    built.title,
    user?.id ?? null,
    s.id,
  ]);
  return getSheet(id);
}

function cleanDoc(doc) {
  if (!doc || typeof doc !== 'object') throw bad('A sheet needs its columns and rows');
  const columns = (Array.isArray(doc.columns) ? doc.columns : []).slice(0, MAX_COLS).map((c, i) => {
    const key = String(c?.key || letters(i)).slice(0, 60);
    const out = { key, label: String(c?.label ?? key).slice(0, 120), type: ['text', 'money', 'number', 'date', 'currency', 'status'].includes(c?.type) ? c.type : 'text' };
    if (c?.bind && typeof c.bind === 'object' && c.bind.entity && c.bind.field) out.bind = { entity: String(c.bind.entity), field: String(c.bind.field) };
    if (typeof c?.formula === 'string' && c.formula.startsWith('=')) out.formula = c.formula.slice(0, 500);
    if (c?.width) out.width = Math.min(Math.max(Number(c.width) || 0, 40), 600);
    return out;
  });
  if (!columns.length) throw bad('A sheet needs at least one column');
  const keys = new Set(columns.map((c) => c.key));
  if (keys.size !== columns.length) throw bad('Two columns have the same key');
  const rows = (Array.isArray(doc.rows) ? doc.rows : []).slice(0, MAX_ROWS).map((r) => {
    const cells = {};
    for (const k of keys) {
      const v = r?.cells?.[k];
      if (v === undefined) continue;
      cells[k] = v === null ? null : typeof v === 'number' ? v : typeof v === 'boolean' ? v : String(v).slice(0, 5000);
    }
    const out = { key: String(r?.key || crypto.randomBytes(6).toString('hex')).slice(0, 80), cells };
    if (r?.ref && typeof r.ref === 'object') out.ref = Object.fromEntries(Object.entries(r.ref).filter(([k, v]) => ['watch', 'expense', 'client', 'lg'].includes(k) && v).map(([k, v]) => [k, Number(v)]));
    if (r?.bind && typeof r.bind === 'object') out.bind = Object.fromEntries(Object.entries(r.bind).filter(([k, v]) => keys.has(k) && typeof v === 'string').map(([k, v]) => [k, v.slice(0, 60)]));
    if (r?.edited && typeof r.edited === 'object') out.edited = Object.fromEntries(Object.keys(r.edited).filter((k) => keys.has(k)).map((k) => [k, true]));
    if (r?.manual) out.manual = true;
    // The page's computed value of each formula cell, so the CSV and PDF print figures.
    if (r?.calc && typeof r.calc === 'object') {
      const calc = {};
      for (const [k, v] of Object.entries(r.calc)) if (keys.has(k) && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')) calc[k] = typeof v === 'string' ? v.slice(0, 500) : v;
      if (Object.keys(calc).length) out.calc = calc;
    }
    return out;
  });
  return { columns, rows, note: String(doc.note ?? '').slice(0, 2000), groupBy: doc.groupBy && keys.has(doc.groupBy) ? doc.groupBy : null };
}

/**
 * Saves the sheet as edited. `version` is the one the page loaded: another
 * person's save in between is refused (409) rather than overwritten unseen.
 */
export async function saveSheet(id, { doc, title, version }, user) {
  const clean = doc !== undefined ? cleanDoc(doc) : null;
  return tx(async (db) => {
    const { rows } = await db.query('SELECT id, version FROM sheets WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [Number(id) || 0]);
    if (!rows[0]) throw notFound();
    if (version !== undefined && Number(version) !== rows[0].version) {
      throw Object.assign(new Error('Somebody else saved this sheet while you had it open — reload it, then make your change again'), { status: 409 });
    }
    const sets = ['updated_at = now()', 'updated_by = $1', 'version = version + 1'];
    const vals = [user?.id ?? null];
    if (clean) {
      vals.push(JSON.stringify(clean));
      sets.push(`doc = $${vals.length}`);
    }
    if (title !== undefined) {
      vals.push(String(title).trim().slice(0, 200));
      sets.push(`title = $${vals.length}`);
    }
    vals.push(rows[0].id);
    await db.query(`UPDATE sheets SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    return { version: rows[0].version + 1 };
  });
}

/**
 * The workbook GridCraft saved (sheets/xlsx.js reads it): kept whole, its
 * cells into the document with the edits marked. `version` is the one the
 * page opened the workbook from; another save in between is a 409.
 */
export async function saveWorkbook(id, bytes, version, user, toDoc) {
  if (bytes.length > 60 * 1024 * 1024) throw bad('That workbook is over 60 MB');
  return tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM sheets WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [Number(id) || 0]);
    const s = rows[0];
    if (!s) throw notFound();
    if (version !== undefined && Number(version) !== s.version) {
      throw Object.assign(new Error('Somebody else saved this sheet while you had it open — reload it, then make your change again'), { status: 409 });
    }
    const read = toDoc(s, bytes);
    const doc = cleanDoc(read.doc);
    await db.query(
      `UPDATE sheets SET doc = $1, workbook = $2, workbook_at = now(), updated_at = now(), updated_by = $3, version = version + 1 WHERE id = $4`,
      [JSON.stringify(doc), bytes, user?.id ?? null, s.id]
    );
    return { version: s.version + 1, doc, changed: read.changed, added: read.added, removed: read.removed, columnsAdded: read.columnsAdded };
  });
}

export async function deleteSheet(id, user, { restore = false } = {}) {
  const { rowCount } = await query(`UPDATE sheets SET deleted_at = ${restore ? 'NULL' : 'now()'}, updated_by = $2 WHERE id = $1`, [Number(id) || 0, user?.id ?? null]);
  if (!rowCount) throw notFound();
}

/* ── into the system ──────────────────────────────────────────────── */

/* A cell's value for a watch field: the sheet's text, as a form would send it. */
const asField = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v));

/**
 * Puts a sheet's row into the system. What the row is decides how:
 *   - a row of a watch (ref.watch): every edited cell bound to a watch field
 *     → PATCH the watch (updateWatch: locked and logged); a changed client
 *     name is not a link — links are made by id on the watch page
 *   - a row of an expense (ref.expense) → updateExpense the same way
 *   - a new row on a stock sheet → a new watch (createWatch)
 *   - a new row on a client sheet with a stock number → that watch linked to
 *     the client (linkWatch)
 *   - a new row with money out on an accounting or logistics sheet → an
 *     expense naming the stock ("stock 1617 · …")
 * Returns what was done, for the page to say; the sheet's row then points at
 * the record it made (ref) and its edits are no longer "pending".
 */
export async function applyRow(id, rowKey, user, { as } = {}) {
  const s = await getSheet(id);
  const doc = s.doc;
  const row = (doc.rows || []).find((r) => r.key === rowKey);
  if (!row) throw bad('No such row on this sheet');
  const colOf = Object.fromEntries(doc.columns.map((c) => [c.key, c]));
  const done = [];
  const ref = { ...(row.ref || {}) };

  const watchPatch = () => {
    const patch = {};
    for (const k of Object.keys(row.edited || {})) {
      const field = row.bind?.[k] || (colOf[k]?.bind?.entity === 'watch' ? colOf[k].bind.field : null);
      if (field && FIELD[field]) patch[field] = asField(row.cells[k]);
    }
    return patch;
  };

  if (ref.watch) {
    const patch = watchPatch();
    if (!Object.keys(patch).length) throw bad('Nothing on this row is a field of the watch');
    const r = await watches.updateWatch(ref.watch, patch, user);
    done.push({ what: 'watch', id: ref.watch, changed: r.changed });
  } else if (ref.expense) {
    const patch = {};
    for (const k of Object.keys(row.edited || {})) {
      const field = row.bind?.[k];
      if (field) patch[field] = asField(row.cells[k]);
    }
    if (!Object.keys(patch).length) throw bad('Nothing on this row is a field of the expense');
    const r = await expenses.updateExpense(ref.expense, patch, user);
    done.push({ what: 'expense', id: ref.expense, changed: r.changed });
  } else if ((as || s.kind) === 'stock' && s.kind === 'stock') {
    const data = {};
    for (const c of doc.columns) if (c.bind?.entity === 'watch' && row.cells[c.key] !== undefined && row.cells[c.key] !== null && row.cells[c.key] !== '') data[c.bind.field] = asField(row.cells[c.key]);
    if (!data.stock_no) throw bad('A new watch needs a stock number');
    const wid = await watches.createWatch(data, user);
    ref.watch = wid;
    done.push({ what: 'watch', id: wid, created: true });
  } else if (s.kind === 'client') {
    const no = asField(row.cells.stock).trim();
    if (!no) throw bad('Which stock number? Type it in the Stock cell');
    const { rows: ws } = await query('SELECT id FROM watches WHERE deleted_at IS NULL AND stock_no = $1', [no]);
    if (!ws[0]) throw bad(`No watch of ours has stock number ${no} — add it on the Inventory first`);
    const role = /sold/i.test(asField(row.cells.role)) && !/bought/i.test(asField(row.cells.role)) ? 'sale' : 'purchase';
    await clients.linkWatch(ws[0].id, role, s.subject?.client, user);
    ref.watch = ws[0].id;
    done.push({ what: 'link', id: ws[0].id, role });
  } else {
    // Accounting / logistics / blank: a line of money out becomes an expense that names the stock.
    const c = row.cells;
    const amount = c.out ?? c.amount;
    if (amount === undefined || amount === null || amount === '') throw bad('An expense needs an amount in Out (or Amount)');
    const stock = asField(c.stock).trim();
    const what = asField(c.what || c.area || 'Expense').trim();
    const xid = await expenses.createExpense(
      {
        expense_date: asField(c.date) || undefined,
        title: [stock && `Stock ${stock}`, what].filter(Boolean).join(' · ').slice(0, 500),
        type: s.kind === 'logistics' || /logistic|shipment|trip/i.test(what) ? 'Logistics Expense' : '',
        amount,
        currency: asField(c.currency),
        description: [asField(c.detail), asField(c.client) && `client ${asField(c.client)}`, `from the sheet “${s.title}”`].filter(Boolean).join(' · '),
      },
      user
    );
    ref.expense = xid;
    done.push({ what: 'expense', id: xid, created: true });
  }

  // The row now stands for the record: its edits are in the system.
  row.ref = ref;
  row.edited = {};
  delete row.manual;
  await query('UPDATE sheets SET doc = $1, updated_at = now(), updated_by = $2, version = version + 1 WHERE id = $3', [JSON.stringify(doc), user?.id ?? null, s.id]);
  return { done, row };
}

/* ── out: CSV and PDF ─────────────────────────────────────────────── */

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/* A formula cell is computed by the page, which saves the value beside it (row.calc): the CSV and PDF take that — blank until the page has. */
const valueOf = (r, c) => {
  const v = r.cells[c.key];
  return typeof v === 'string' && v.startsWith('=') ? r.calc?.[c.key] ?? '' : v;
};
export function toCsv(doc) {
  const lines = [doc.columns.map((c) => csvCell(c.label)).join(',')];
  for (const r of doc.rows) lines.push(doc.columns.map((c) => csvCell(valueOf(r, c))).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

const shown = (c, v) => {
  if (v === null || v === undefined) return '';
  if (c.type === 'money' || c.type === 'number') return typeof v === 'number' ? v.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : String(v);
  return String(v);
};
export function toPdf(s) {
  const doc = s.doc;
  const cols = doc.columns.map((c) => ({ label: c.label, align: c.type === 'money' || c.type === 'number' ? 'right' : 'left' }));
  const totals = doc.columns.map((c) => {
    if (c.type !== 'money' && c.type !== 'number') return '';
    let sum = 0;
    let any = false;
    for (const r of doc.rows) {
      const v = valueOf(r, c);
      if (typeof v === 'number') (sum += v), (any = true);
    }
    return any ? sum.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : '';
  });
  if (totals.some(Boolean)) totals[0] = totals[0] || 'Total';
  // Money in several currencies does not add up: a total is shown only where every row has the same currency, or the column is ≈ EUR.
  const curCol = doc.columns.findIndex((c) => c.type === 'currency');
  const currencies = curCol >= 0 ? new Set(doc.rows.map((r) => r.cells[doc.columns[curCol].key] || '')) : new Set();
  const mixed = currencies.size > 1;
  const foot = totals.map((t, i) => (i > 0 && t && mixed && !/EUR/.test(doc.columns[i].label) && doc.columns[i].type === 'money' ? 'mixed currencies' : t));
  return renderPdf({
    title: s.title || 'Sheet',
    subtitle: [doc.note, s.updated_at ? `As kept on ${new Date(s.updated_at).toISOString().slice(0, 10)}` : ''].filter(Boolean).join(' '),
    blocks: [{ type: 'table', columns: cols, rows: doc.rows.map((r) => doc.columns.map((c) => shown(c, valueOf(r, c)))), foot: totals.some(Boolean) ? [foot] : [] }],
  });
}
