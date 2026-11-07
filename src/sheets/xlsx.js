/*
 * A sheet as an .xlsx workbook, for GridCraft (src/web/gridcraft.js), and
 * back: the workbook GridCraft saves → the sheet's document, with every cell
 * that differs from before marked as edited — the same `edited` the page's
 * own grid sets, so "put it in the system too?" (sheets/index.js applyRow)
 * works the same whichever grid the person used.
 *
 * What carries the sheet's identity through the round trip:
 *   - column A, hidden: the row's key (its record in the ERP). A row typed
 *     into GridCraft has none → a new row of the sheet (`manual`).
 *   - row 1: the column labels. A column is known by its label (the
 *     document's columns map label → key); a new label is a new, unbound
 *     column; a renamed label is read as a new column — the hidden `erp`
 *     sheet lists key · label · type · binding, so a label changed there
 *     is still found by its key when the hidden sheet's order matches.
 *   - the hidden sheet `erp`: "masterapp-sheet", the sheet id, then the
 *     columns. Never shown; GridCraft keeps hidden sheets as they are.
 */
import { writeXlsx, readXlsx, colLetters } from '../xlsx/index.js';
import { fillFormulas } from './build.js';

const MARK = 'masterapp-sheet';
const KEY_HEAD = '#';

const styleOf = (c) => ({ money: 'money', number: 'int', date: 'date' }[c.type] || 'text');
const widthOf = (c) => ({ money: 14, number: 10, date: 12, currency: 7, status: 11 }[c.type] || Math.min(Math.max((c.label || '').length + 4, 10), 40));

/** The sheet's document → workbook bytes. Formulas come with their last computed value as the cached one. */
export function sheetToWorkbook(sheet) {
  const doc = sheet.doc || { columns: [], rows: [] };
  const cols = doc.columns || [];
  const rows = doc.rows || [];
  // Formulas in the document name the page's columns (A = first column); in the workbook column A is the key, so every reference moves one column right.
  const shift = (f) => String(f).replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (m, d1, letters, d2, row) => {
    // Only a reference to one of the sheet's own columns (within its width) is moved; a function name followed by digits is not a reference.
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1 < cols.length ? `${d1}${colLetters(n)}${d2}${row}` : m;
  });
  const head = [{ v: KEY_HEAD, style: 'header' }, ...cols.map((c) => ({ v: c.label || c.key, style: 'header' }))];
  const body = rows.map((r) => [
    r.key,
    ...cols.map((c) => {
      const v = r.cells?.[c.key];
      if (v === null || v === undefined || v === '') return null;
      if (typeof v === 'string' && v.startsWith('=')) return { f: shift(v), v: r.calc?.[c.key] ?? null, style: styleOf(c) };
      if (c.type === 'date') return { v, style: 'date' };
      if ((c.type === 'money' || c.type === 'number') && typeof v === 'number') return { v, style: styleOf(c) };
      return { v, style: typeof v === 'number' ? 'int' : 'text' };
    }),
  ]);
  const erp = [
    [MARK, String(sheet.id ?? ''), String(sheet.version ?? '')],
    ['key', 'label', 'type', 'bind'],
    ...cols.map((c) => [c.key, c.label || '', c.type || 'text', c.bind ? `${c.bind.entity}.${c.bind.field}` : '']),
  ];
  const last = colLetters(cols.length);
  return writeXlsx({
    sheets: [
      {
        name: (sheet.title || 'Sheet').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31),
        freeze: 1,
        cols: [{ hidden: true, width: 4 }, ...cols.map((c) => ({ width: widthOf(c) }))],
        rows: [head, ...body],
        filter: cols.length ? `B1:${last}${Math.max(rows.length + 1, 2)}` : null,
      },
      // veryHidden: not in the Unhide list of GridCraft or Excel; a person who wants it can still reach it from a macro — it is only identity, never a secret.
      { name: 'erp', hidden: 'very', rows: erp },
    ],
  });
}

const norm = (s) => String(s ?? '').trim().toLowerCase();
const same = (a, b) => (a === null || a === undefined ? '' : String(a)) === (b === null || b === undefined ? '' : String(b));

/**
 * The workbook GridCraft saved → the document, edits marked. Returns
 * { doc, changed: [{ key, cells: [colKey…] }], added: n, removed: n, columnsAdded: [label…] }.
 * Throws (400) when the workbook is not this sheet's (no hidden erp sheet naming it).
 */
export function workbookToDoc(sheet, bytes) {
  const wb = readXlsx(bytes);
  const old = sheet.doc || { columns: [], rows: [] };
  const erp = wb.sheets.find((s) => s.name === 'erp' && s.cells.A1?.v === MARK);
  if (!erp) throw Object.assign(new Error('That workbook was not made from this sheet (its hidden "erp" sheet is missing)'), { status: 400 });
  if (String(erp.cells.B1?.v ?? '') !== String(sheet.id)) throw Object.assign(new Error(`That workbook belongs to sheet ${erp.cells.B1?.v}, not this one`), { status: 400 });
  const main = wb.sheets.find((s) => !s.hidden && s !== erp) || wb.sheets.find((s) => s !== erp);
  if (!main) throw Object.assign(new Error('The workbook has no sheet to read'), { status: 400 });

  // The columns as the hidden sheet remembers them, in order: key and label per position.
  const known = new Map(old.columns.map((c) => [c.key, c]));
  const remembered = []; // position → { key, label }
  for (let r = 3; r <= erp.maxRow; r++) {
    const key = String(erp.cells[`A${r}`]?.v ?? '').trim();
    if (key) remembered.push({ key, label: String(erp.cells[`B${r}`]?.v ?? '') });
  }
  // Row 1: the labels, column by column. A is the key column, whatever its heading says. A column is the one the
  // hidden sheet remembers at that position when the label still agrees (so two columns both called "Cur." stay
  // apart); else the first unused column of the document with that label (a column was inserted or moved); else new.
  const columns = [];
  const colOf = []; // workbook column index → document column
  const used = new Set();
  const columnsAdded = [];
  for (let ci = 1; ci < Math.max(main.maxCol, 1); ci++) {
    const label = String(main.cells[`${colLetters(ci)}1`]?.v ?? '').trim();
    if (!label) {
      colOf[ci] = null;
      continue;
    }
    let col = null;
    const at = remembered[ci - 1];
    if (at && norm(at.label) === norm(label) && known.has(at.key) && !used.has(at.key)) col = known.get(at.key);
    if (!col) col = old.columns.find((c) => norm(c.label) === norm(label) && !used.has(c.key)) || null;
    if (!col) {
      const r = remembered.find((x) => norm(x.label) === norm(label) && known.has(x.key) && !used.has(x.key));
      if (r) col = known.get(r.key);
    }
    if (!col) {
      let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `col${ci}`;
      while (used.has(key) || known.has(key)) key += '_';
      col = { key, label: label.slice(0, 120), type: 'text' };
      columnsAdded.push(label);
    }
    used.add(col.key);
    columns.push(col);
    colOf[ci] = col;
  }
  if (!columns.length) throw Object.assign(new Error('The workbook’s first row has no column headings'), { status: 400 });

  const oldRows = new Map(old.rows.map((r) => [r.key, r]));
  const rows = [];
  const changed = [];
  let added = 0;
  const seen = new Set();
  for (let r = 2; r <= main.maxRow; r++) {
    const keyCell = main.cells[`A${r}`];
    let key = keyCell && keyCell.v !== null && keyCell.v !== undefined ? String(keyCell.v).trim() : '';
    const cells = {};
    const calc = {};
    let any = false;
    for (let ci = 1; ci < colOf.length; ci++) {
      const col = colOf[ci];
      if (!col) continue;
      const cell = main.cells[`${colLetters(ci)}${r}`];
      if (!cell) continue;
      any = true;
      if (cell.f) {
        // The formula as the page's grid writes it: references back one column (A is hidden here).
        cells[col.key] = unshift(cell.f, columns.length + 1);
        if (cell.v !== null && cell.v !== undefined) calc[col.key] = cell.v;
      } else if (cell.t === 'd') cells[col.key] = cell.v;
      else if (cell.t === 'n') cells[col.key] = col.type === 'text' && !['money', 'number'].includes(col.type) && typeof cell.v === 'number' && !Number.isInteger(cell.v) ? cell.v : cell.v;
      else if (cell.t === 'b') cells[col.key] = cell.v;
      else if (cell.t === 'e') cells[col.key] = String(cell.v);
      else cells[col.key] = typeof cell.v === 'string' ? cell.v : String(cell.v ?? '');
    }
    if (!any && !key) continue; // an empty line
    let prev = key ? oldRows.get(key) : null;
    if (prev && seen.has(key)) prev = null; // a copied row: its key is taken, so it is a new one
    if (!prev) {
      key = `m${r.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      added += 1;
    }
    seen.add(key);
    const row = { key, cells, ...(prev?.ref ? { ref: prev.ref } : {}), ...(prev?.bind ? { bind: prev.bind } : {}), edited: { ...(prev?.edited || {}) } };
    if (!prev) row.manual = true;
    if (Object.keys(calc).length) row.calc = calc;
    if (prev) {
      const diff = [];
      for (const col of columns) {
        const a = prev.cells?.[col.key];
        const b = cells[col.key];
        if (same(a, b)) continue;
        if (typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9) continue;
        if ((a === null || a === undefined || a === '') && (b === null || b === undefined || b === '')) continue;
        // A formula whose text GridCraft rewrote ($ signs, case) but whose value is the same is not an edit.
        if (typeof a === 'string' && a.startsWith('=') && typeof b === 'string' && b.startsWith('=') && norm(a.replace(/\$/g, '')) === norm(b.replace(/\$/g, ''))) continue;
        row.edited[col.key] = true;
        diff.push(col.key);
      }
      if (diff.length) changed.push({ key, cells: diff });
    }
    rows.push(row);
  }
  const removed = old.rows.filter((r) => !seen.has(r.key)).length;
  const doc = { ...old, columns, rows, note: old.note, groupBy: old.groupBy && columns.some((c) => c.key === old.groupBy) ? old.groupBy : null };
  fillFormulas(doc);
  return { doc, changed, added, removed, columnsAdded };
}

/* A workbook formula → the page's: references to the sheet's columns move one column left (A, the key, has no column on the page). */
function unshift(f, width) {
  return String(f).replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (m, d1, letters, d2, row) => {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    if (n < 2 || n > width) return m;
    return `${d1}${colLetters(n - 2)}${d2}${row}`;
  });
}
