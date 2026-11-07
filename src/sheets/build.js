/*
 * A sheet's rows, read from the system (asked 7 Nov 2026: "a system of
 * excel / google sheet … starts asking what do you want: logistics /
 * accounting / client situation / stock situation").
 *
 *   logistics   what moving a watch cost, by area (logistic costs, shipments,
 *               trips), line by line — from our copy of the logistics app
 *   accounting  money in and out, for a stock or for a client: purchases,
 *               sales, accessories, logistics, expenses that name the stock
 *   client      everything a client has bought from us and sold to us
 *   stock       every watch asked for, one row each, with its money
 *
 * A column may be BOUND to a field of the system ({entity, field}) and a row
 * may carry the record it came from (ref.watch / ref.expense / ref.client):
 * a cell that is both is the system's value, and the page offers to change
 * the system when it is edited. Logistics lines are the app's — never bound:
 * nothing is written to the logistics app (decided 30 Oct 2026).
 *
 * Amounts stay in their own currency. "≈ EUR" is Chrono Key's own euro figure
 * where it has one (purchase_price_eur, sale_price_eur, an expense's
 * cost_eur), else today's rate — the sheet's note says so.
 */
import { query } from '../db/index.js';
import { getRates } from '../rates/index.js';
import { costs as costsOf } from '../logistics/situation.js';
import { stockList } from '../logistics/kinds.js';
import { clientName } from '../clients/index.js';
import { displayTitle } from '../watches/fields.js';

export const KINDS = [
  { key: 'logistics', label: 'Logistics', about: 'What we paid to move a watch, area by area: logistic costs, shipments, trips.' },
  { key: 'accounting', label: 'Accounting', about: 'Money in and out — for a stock, or for a client.' },
  { key: 'client', label: 'Client situation', about: 'Every watch a client bought from us or sold to us, and where it is now.' },
  { key: 'stock', label: 'Stock situation', about: 'The full situation of the stock you choose: status, place, money, logistics.' },
];

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const round = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100);

/* Today's rates, or none: a sheet is still built when the rate sources are down — its ≈ EUR cells are left blank. */
async function eurConverter() {
  let r = null;
  try {
    r = (await getRates()).rates;
  } catch {
    r = null;
  }
  return (amount, cur) => {
    if (amount === null || amount === undefined || amount === '') return null;
    const c = String(cur || '').toUpperCase() === 'USDT' ? 'USD' : String(cur || '').toUpperCase();
    if (c === 'EUR') return round(amount);
    if (!r || !c || !r[c] || !r.EUR) return null;
    return round((Number(amount) / r[c]) * r.EUR);
  };
}

/* ── the subjects ─────────────────────────────────────────────────── */

/** "1617, 1618 1620" → ['1617', '1618', '1620']. */
export function stockNumbers(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/);
  return [...new Set(list.map((s) => String(s).trim().replace(/^#/, '')).filter(Boolean))].slice(0, 2000);
}

const WATCH_COLS = `w.id, w.stock_no, w.brand, w.model, w.reference, w.serial, w.title, w.status, w.location, w.purchase_date, w.purchase_price,
  w.purchase_currency, w.purchase_price_eur, w.sale_date, w.sale_price, w.sale_currency, w.sale_price_eur, w.accessories_cost,
  w.b2b_price, w.b2b_currency, w.b2c_price, w.b2c_currency, w.purchased_from, w.sold_to, w.notes,
  w.purchased_from_client_id, w.sold_to_client_id,
  (SELECT jsonb_build_object('id', c.id, 'forename', c.forename, 'surname', c.surname, 'nickname', c.nickname, 'company', c.company)
     FROM clients c WHERE c.id = w.purchased_from_client_id) AS bought_from,
  (SELECT jsonb_build_object('id', c.id, 'forename', c.forename, 'surname', c.surname, 'nickname', c.nickname, 'company', c.company)
     FROM clients c WHERE c.id = w.sold_to_client_id) AS sold_to_client`;

/** Our watches for a subject: stock numbers, or a status ('all' for every one), in stock-number order. */
async function watchesFor(subject) {
  const nos = stockNumbers(subject.stock);
  if (nos.length) {
    const { rows } = await query(`SELECT ${WATCH_COLS} FROM watches w WHERE w.deleted_at IS NULL AND w.stock_no = ANY($1)`, [nos]);
    return rows.sort((a, b) => nos.indexOf(a.stock_no) - nos.indexOf(b.stock_no));
  }
  const status = String(subject.status || 'in_stock');
  const { rows } = await query(
    `SELECT ${WATCH_COLS} FROM watches w WHERE w.deleted_at IS NULL AND ($1 = 'all' OR w.status = $1)
      ORDER BY NULLIF(regexp_replace(w.stock_no, '\\D', '', 'g'), '')::bigint NULLS LAST, w.stock_no LIMIT 3000`,
    [status]
  );
  return rows;
}

async function clientOf(subject) {
  const id = Number(subject.client) || 0;
  if (!id) throw bad('Which client? Pick one first.');
  const { rows } = await query('SELECT * FROM clients WHERE id = $1 AND deleted_at IS NULL', [id]);
  if (!rows[0]) throw bad('No such client');
  return rows[0];
}

/* ── logistics costs, for many stock numbers at once ──────────────── */

const COST_KINDS = ['logisticCosts', 'shipments', 'personTrips', 'incomings'];
const AREA = { 'Logistic cost': 'Logistic cost', Shipment: 'Shipment', 'Trip (shared)': 'Trip' };

/**
 * Every logistics cost line of the stock numbers given (null: every stock
 * number any cost names), the app's own costing per watch (situation.costs).
 * The purchase line it also gives is left out: that is the watch's purchase,
 * not logistics.
 */
export async function logisticsLines(nos) {
  const { rows } = await query(
    `SELECT id, kind, data, stock_nos, deleted_at FROM logistics_items
      WHERE deleted_at IS NULL AND kind = ANY($1) ${nos ? 'AND stock_nos && $2::text[]' : ''}`,
    nos ? [COST_KINDS, nos] : [COST_KINDS]
  );
  const want = nos || [...new Set(rows.filter((r) => r.kind !== 'incomings').flatMap((r) => r.stock_nos || []))];
  const byNo = new Map();
  for (const no of want) {
    const mine = rows.filter((r) => (r.stock_nos || []).includes(no));
    if (!mine.length) continue;
    const lines = costsOf(no, mine, { tripStocks: (i) => Math.max(1, (i.stock_nos || []).length || (i.data.stockIds || []).length) }).lines.filter(
      (l) => l.source !== 'Purchase'
    );
    if (lines.length) byNo.set(no, lines);
  }
  return byNo;
}

/* ── the four kinds ───────────────────────────────────────────────── */

const col = (key, label, type = 'text', more = {}) => ({ key, label, type, ...more });
const bind = (entity, field) => ({ bind: { entity, field } });

async function logisticsSheet(subject) {
  const nos = stockNumbers(subject.stock);
  const toEur = await eurConverter();
  const byNo = await logisticsLines(nos.length ? nos : null);
  const ours = new Map(
    (await query('SELECT id, stock_no FROM watches WHERE deleted_at IS NULL AND stock_no = ANY($1)', [[...byNo.keys()]])).rows.map((r) => [r.stock_no, r.id])
  );
  const rows = [];
  const order = [...byNo.keys()].sort((a, b) => (Number(a) || 0) - (Number(b) || 0) || a.localeCompare(b));
  for (const no of order) {
    byNo.get(no).forEach((l, i) =>
      rows.push({
        key: `lg:${no}:${l.itemId}:${i}`,
        ref: { ...(ours.get(no) ? { watch: ours.get(no) } : {}), lg: l.itemId },
        cells: {
          stock: no,
          area: AREA[l.source] || l.source,
          what: l.title || '',
          detail: l.detail || '',
          date: l.date ? String(l.date).slice(0, 10) : '',
          amount: round(l.amount),
          currency: l.currency || 'USD',
          eur: toEur(l.amount, l.currency || 'USD'),
        },
      })
    );
  }
  return {
    title: nos.length ? `Logistics · ${nos.length === 1 ? `stock ${nos[0]}` : `${nos.length} stocks`}` : 'Logistics · every stock',
    note: 'From our copy of the logistics app (a minute behind it). Shared costs are split over the watches they carried, as the app does. ≈ EUR at today’s rate. These lines are the logistics app’s: a change here stays in the sheet; a new line can be added to the system as an expense.',
    columns: [
      col('stock', 'Stock'),
      col('area', 'Area'),
      col('what', 'What'),
      col('detail', 'Detail'),
      col('date', 'Date', 'date'),
      col('amount', 'Amount', 'money'),
      col('currency', 'Currency', 'currency'),
      col('eur', '≈ EUR', 'money'),
    ],
    rows,
    groupBy: nos.length === 1 ? 'area' : 'stock',
  };
}

async function accountingSheet(subject) {
  const toEur = await eurConverter();
  const rows = [];
  let title;
  const watchRows = (w, roleIn = null) => {
    const out = [];
    const ref = { watch: w.id };
    const t = displayTitle(w);
    if ((roleIn === null || roleIn === 'purchase') && w.purchase_price !== null) {
      out.push({
        key: `buy:${w.id}`,
        ref,
        bind: { date: 'purchase_date', out: 'purchase_price', currency: 'purchase_currency', eur: 'purchase_price_eur' },
        cells: {
          date: w.purchase_date || '',
          stock: w.stock_no || '',
          what: `Purchase · ${t}`,
          client: w.bought_from ? clientName(w.bought_from) : w.purchased_from || '',
          in: null,
          out: w.purchase_price,
          currency: w.purchase_currency || '',
          eur: w.purchase_price_eur ?? (w.purchase_currency ? toEur(w.purchase_price, w.purchase_currency) : null),
        },
      });
    }
    if ((roleIn === null || roleIn === 'sale') && w.sale_price !== null) {
      out.push({
        key: `sale:${w.id}`,
        ref,
        bind: { date: 'sale_date', in: 'sale_price', currency: 'sale_currency', eur: 'sale_price_eur' },
        cells: {
          date: w.sale_date || '',
          stock: w.stock_no || '',
          what: `Sale · ${t}`,
          client: w.sold_to_client ? clientName(w.sold_to_client) : w.sold_to || '',
          in: w.sale_price,
          out: null,
          currency: w.sale_currency || '',
          eur: w.sale_price_eur ?? (w.sale_currency ? toEur(w.sale_price, w.sale_currency) : null),
        },
      });
    }
    if (roleIn === null && Number(w.accessories_cost) > 0) {
      out.push({
        key: `acc:${w.id}`,
        ref,
        bind: { out: 'accessories_cost' },
        cells: { date: w.purchase_date || '', stock: w.stock_no || '', what: 'Accessories', client: '', in: null, out: w.accessories_cost, currency: '', eur: null },
      });
    }
    return out;
  };
  if (subject.client) {
    const c = await clientOf(subject);
    title = `Accounting · ${clientName(c)}`;
    const { rows: ws } = await query(
      `SELECT ${WATCH_COLS} FROM watches w WHERE w.deleted_at IS NULL AND (w.purchased_from_client_id = $1 OR w.sold_to_client_id = $1)`,
      [c.id]
    );
    for (const w of ws) {
      if (w.purchased_from_client_id === c.id) rows.push(...watchRows(w, 'purchase'));
      if (w.sold_to_client_id === c.id) rows.push(...watchRows(w, 'sale'));
    }
  } else {
    const nos = stockNumbers(subject.stock);
    if (!nos.length) throw bad('Which stock numbers, or which client?');
    const ws = await watchesFor({ stock: nos });
    title = `Accounting · ${nos.length === 1 ? `stock ${nos[0]}` : `${nos.length} stocks`}`;
    for (const w of ws) rows.push(...watchRows(w));
    const lg = await logisticsLines(nos);
    for (const [no, lines] of lg) {
      const w = ws.find((x) => x.stock_no === no);
      lines.forEach((l, i) =>
        rows.push({
          key: `lg:${no}:${l.itemId}:${i}`,
          ref: { ...(w ? { watch: w.id } : {}), lg: l.itemId },
          cells: {
            date: l.date ? String(l.date).slice(0, 10) : '',
            stock: no,
            what: `Logistics · ${AREA[l.source] || l.source}${l.title ? ` · ${l.title}` : ''}`,
            client: '',
            in: null,
            out: round(l.amount),
            currency: l.currency || 'USD',
            eur: toEur(l.amount, l.currency || 'USD'),
          },
        })
      );
    }
    // Expenses that name the stock ("stock 1617", "#1617") — an expense added from a sheet says so in its description.
    const pattern = nos.map((n) => n.replace(/[^\w]/g, '')).filter(Boolean);
    if (pattern.length) {
      const { rows: xs } = await query(
        `SELECT id, expense_date, title, type, amount, currency, cost_eur, description FROM expenses
          WHERE deleted_at IS NULL AND (title || ' ' || description) ~* $1`,
        [`(stock\\s*#?\\s*|#)(${pattern.join('|')})\\M`]
      );
      for (const x of xs) {
        const no = nos.find((n) => new RegExp(`(stock\\s*#?\\s*|#)${n.replace(/[^\w]/g, '')}\\b`, 'i').test(`${x.title} ${x.description}`)) || '';
        rows.push({
          key: `exp:${x.id}`,
          ref: { expense: x.id },
          bind: { date: 'expense_date', what: 'title', out: 'amount', currency: 'currency', eur: 'cost_eur' },
          cells: {
            date: x.expense_date || '',
            stock: no,
            what: x.title || x.type || 'Expense',
            client: '',
            in: null,
            out: x.amount,
            currency: x.currency || '',
            eur: x.cost_eur ?? (x.currency ? toEur(x.amount, x.currency) : null),
          },
        });
      }
    }
  }
  rows.sort((a, b) => String(a.cells.date || '9999').localeCompare(String(b.cells.date || '9999')));
  return {
    title,
    note: 'In and out in each deal’s own currency. ≈ EUR: Chrono Key’s own euro figure where it has one, else today’s rate. A purchase or sale is the watch’s own: editing it can change the watch. A new line with money out can be added to the system as an expense.',
    columns: [
      col('date', 'Date', 'date'),
      col('stock', 'Stock'),
      col('what', 'What'),
      col('client', 'Client'),
      col('in', 'In', 'money'),
      col('out', 'Out', 'money'),
      col('currency', 'Currency', 'currency'),
      col('eur', '≈ EUR', 'money'),
      col('net', 'Net ≈ EUR', 'money', { formula: '=IF({in}<>"",{eur},-{eur})' }),
    ],
    rows,
    groupBy: 'currency',
  };
}

/* The watch columns shared by the client and stock sheets: every one a field of the watch, so an edit can go back to it. */
const WATCH_FIELDS = [
  col('stock', 'Stock', 'text', bind('watch', 'stock_no')),
  col('brand', 'Brand', 'text', bind('watch', 'brand')),
  col('model', 'Model', 'text', bind('watch', 'model')),
  col('reference', 'Reference', 'text', bind('watch', 'reference')),
  col('serial', 'Serial', 'text', bind('watch', 'serial')),
  col('status', 'Status', 'status', bind('watch', 'status')),
  col('location', 'Location', 'text', bind('watch', 'location')),
];
const watchCells = (w) => ({
  stock: w.stock_no || '',
  brand: w.brand || '',
  model: w.model || '',
  reference: w.reference || '',
  serial: w.serial || '',
  status: w.status || '',
  location: w.location || '',
});

async function clientSheet(subject) {
  const c = await clientOf(subject);
  const toEur = await eurConverter();
  const { rows: ws } = await query(
    `SELECT ${WATCH_COLS} FROM watches w WHERE w.deleted_at IS NULL AND (w.purchased_from_client_id = $1 OR w.sold_to_client_id = $1)
      ORDER BY COALESCE(w.sale_date, w.purchase_date) NULLS LAST`,
    [c.id]
  );
  const lg = await logisticsLines(ws.map((w) => w.stock_no).filter(Boolean));
  const rows = ws.map((w) => {
    const lines = lg.get(w.stock_no) || [];
    const moving = lines.reduce((s, l) => s + (toEur(l.amount, l.currency || 'USD') || 0), 0);
    return {
      key: `w:${w.id}`,
      ref: { watch: w.id },
      cells: {
        ...watchCells(w),
        role: [w.purchased_from_client_id === c.id && 'Bought from them', w.sold_to_client_id === c.id && 'Sold to them'].filter(Boolean).join(' · '),
        purchase_date: w.purchase_date || '',
        purchase_price: w.purchase_price,
        purchase_currency: w.purchase_currency || '',
        sale_date: w.sale_date || '',
        sale_price: w.sale_price,
        sale_currency: w.sale_currency || '',
        logistics_eur: lines.length ? round(moving) : null,
      },
    };
  });
  return {
    title: `Client situation · ${clientName(c)}`,
    note: `${clientName(c)}${c.company && c.company !== clientName(c) ? ` (${c.company})` : ''}${c.country ? ` · ${c.country}` : ''}${c.phone ? ` · ${c.phone}` : ''}. Every watch Chrono Key ties to them by id. A cell of the watch can be changed in the system too; a new row with a stock number links that watch to them.`,
    columns: [
      ...WATCH_FIELDS,
      col('role', 'With them'),
      col('purchase_date', 'Bought', 'date', bind('watch', 'purchase_date')),
      col('purchase_price', 'Paid', 'money', bind('watch', 'purchase_price')),
      col('purchase_currency', 'Paid cur.', 'currency', bind('watch', 'purchase_currency')),
      col('sale_date', 'Sold', 'date', bind('watch', 'sale_date')),
      col('sale_price', 'Sold for', 'money', bind('watch', 'sale_price')),
      col('sale_currency', 'Sold cur.', 'currency', bind('watch', 'sale_currency')),
      col('logistics_eur', 'Logistics ≈ EUR', 'money'),
    ],
    rows,
    groupBy: 'role',
    client: { id: c.id, name: clientName(c) },
  };
}

async function stockSheet(subject) {
  const ws = await watchesFor(subject);
  const toEur = await eurConverter();
  const lg = await logisticsLines(ws.map((w) => w.stock_no).filter(Boolean));
  const today = Date.now();
  const rows = ws.map((w) => {
    const lines = lg.get(w.stock_no) || [];
    const moving = lines.length ? round(lines.reduce((s, l) => s + (toEur(l.amount, l.currency || 'USD') || 0), 0)) : null;
    const days = w.purchase_date && !w.sale_date ? Math.max(0, Math.floor((today - Date.parse(w.purchase_date)) / 86400_000)) : null;
    return {
      key: `w:${w.id}`,
      ref: { watch: w.id },
      cells: {
        ...watchCells(w),
        days,
        purchase_date: w.purchase_date || '',
        bought_from: w.bought_from ? clientName(w.bought_from) : w.purchased_from || '',
        purchase_price: w.purchase_price,
        purchase_currency: w.purchase_currency || '',
        purchase_eur: w.purchase_price_eur ?? (w.purchase_currency ? toEur(w.purchase_price, w.purchase_currency) : null),
        b2b_price: w.b2b_price,
        b2b_currency: w.b2b_currency || '',
        sale_date: w.sale_date || '',
        sold_to: w.sold_to_client ? clientName(w.sold_to_client) : w.sold_to || '',
        sale_price: w.sale_price,
        sale_currency: w.sale_currency || '',
        sale_eur: w.sale_price_eur ?? (w.sale_currency ? toEur(w.sale_price, w.sale_currency) : null),
        logistics_eur: moving,
      },
    };
  });
  const nos = stockNumbers(subject.stock);
  const status = String(subject.status || 'in_stock');
  const STATUS = { in_stock: 'in stock', incoming: 'incoming', sold: 'sold', reserved: 'reserved', returned: 'returned', other: 'other', all: 'every watch' };
  return {
    title: nos.length ? `Stock situation · ${nos.length === 1 ? `stock ${nos[0]}` : `${nos.length} stocks`}` : `Stock situation · ${STATUS[status] || status}`,
    note: 'One row per watch. Its cells are the watch’s own fields and can be changed in the system too. ≈ EUR: Chrono Key’s euro figure where it has one, else today’s rate. Margin = sold − bought − logistics, in ≈ EUR. A new row can be added to the system as a new watch.',
    columns: [
      ...WATCH_FIELDS,
      col('days', 'Days in stock', 'number'),
      col('purchase_date', 'Bought', 'date', bind('watch', 'purchase_date')),
      col('bought_from', 'From'),
      col('purchase_price', 'Paid', 'money', bind('watch', 'purchase_price')),
      col('purchase_currency', 'Paid cur.', 'currency', bind('watch', 'purchase_currency')),
      col('purchase_eur', 'Paid ≈ EUR', 'money', bind('watch', 'purchase_price_eur')),
      col('b2b_price', 'B2B', 'money', bind('watch', 'b2b_price')),
      col('b2b_currency', 'B2B cur.', 'currency', bind('watch', 'b2b_currency')),
      col('sale_date', 'Sold', 'date', bind('watch', 'sale_date')),
      col('sold_to', 'To'),
      col('sale_price', 'Sold for', 'money', bind('watch', 'sale_price')),
      col('sale_currency', 'Sold cur.', 'currency', bind('watch', 'sale_currency')),
      col('sale_eur', 'Sold ≈ EUR', 'money', bind('watch', 'sale_price_eur')),
      col('logistics_eur', 'Logistics ≈ EUR', 'money'),
      col('margin', 'Margin ≈ EUR', 'money', { formula: '=IF({sale_eur}="","",{sale_eur}-{purchase_eur}-{logistics_eur})' }),
    ],
    rows,
    groupBy: 'status',
  };
}

/**
 * Builds a sheet of a kind for a subject. A column with a `formula` is filled
 * row by row — {key} becomes that column's cell on the row (E7), so the
 * margin stays live when a cell is edited, as in any spreadsheet.
 */
export async function buildSheet(kind, subject = {}) {
  const fn = { logistics: logisticsSheet, accounting: accountingSheet, client: clientSheet, stock: stockSheet }[kind];
  if (kind === 'blank') return { title: 'New sheet', note: '', columns: ['A', 'B', 'C', 'D', 'E', 'F'].map((k) => col(k, k)), rows: [] };
  if (!fn) throw bad(`No such kind of sheet: ${kind}`);
  const out = await fn(subject);
  fillFormulas(out);
  return out;
}

/* A column's letters as a spreadsheet names it: 0 → A, 25 → Z, 26 → AA. */
export function letters(i) {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

export function fillFormulas(sheet) {
  const at = new Map(sheet.columns.map((c, i) => [c.key, letters(i)]));
  const withF = sheet.columns.filter((c) => c.formula);
  sheet.rows.forEach((row, i) => {
    for (const c of withF) {
      if (row.edited?.[c.key]) continue;
      row.cells[c.key] = c.formula.replace(/\{([a-z_]+)\}/g, (m, k) => (at.has(k) ? `${at.get(k)}${i + 2}` : m));
    }
  });
}

/* For the client picker: a stock number's existence. */
export async function stockExists(nos) {
  const { rows } = await query('SELECT stock_no FROM watches WHERE deleted_at IS NULL AND stock_no = ANY($1)', [stockNumbers(nos)]);
  return rows.map((r) => r.stock_no);
}

export { stockList };
