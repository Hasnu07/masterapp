import { query, tx } from '../db/index.js';
import { parseMoney, realDate, CURRENCIES, PAYMENT_KINDS } from '../watches/fields.js';
import { saveDocument, storage } from '../storage/index.js';
import { currencyFromNote } from '../import/productlist.js';

/*
 * Expenses: copied from Chrono Key's expense list (and each expense's own
 * page), editable here, with payment copies attached here — Chrono Key has no
 * place for those.
 *
 * The rule for watches and clients holds: until the switch-over Chrono Key's
 * figures replace ours, except a field somebody edited here (locked).
 */

export const EXPENSE_FIELDS = [
  { key: 'expense_date', label: 'Date', type: 'date' },
  { key: 'title', label: 'Title', type: 'text' },
  { key: 'type', label: 'Type', type: 'text' },
  { key: 'amount', label: 'Cost', type: 'money', currency: 'currency' },
  { key: 'currency', label: 'Currency', type: 'currency' },
  { key: 'payment_method', label: 'Payment method', type: 'enum', options: ['', ...PAYMENT_KINDS.map((k) => k.key)] },
  { key: 'description', label: 'Description', type: 'longtext' },
  { key: 'exchange_rate', label: 'Exchange rate to EUR', type: 'rate' },
  { key: 'cost_eur', label: 'Cost in EUR', type: 'money', fixedCurrency: 'EUR' },
  { key: 'exclude_from_profit', label: 'Left out of profit (Loan Book)', type: 'bool' },
];
// No prototype, as watches' FIELD: "constructor" from a request is not a column.
const FIELD = Object.assign(Object.create(null), Object.fromEntries(EXPENSE_FIELDS.map((f) => [f.key, f])));
export const MAX_FILES = 10;

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const notFound = () => Object.assign(new Error('No such expense'), { status: 404 });

function clean(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const f = FIELD[k];
    if (!f) throw bad(`Unknown field: ${k}`);
    const blank = v === null || v === undefined || String(v).trim() === '';
    switch (f.type) {
      case 'money': {
        if (blank) out[k] = null;
        else {
          const n = typeof v === 'number' ? v : parseMoney(v);
          if (!Number.isFinite(n) || n < 0 || n > 50_000_000) throw bad(`${f.label}: "${v}" is not an amount`);
          out[k] = Math.round(n * 100) / 100;
        }
        break;
      }
      case 'rate': {
        const n = blank ? null : Number(String(v).replace(',', '.'));
        if (n !== null && (!Number.isFinite(n) || n <= 0 || n > 100_000)) throw bad(`${f.label}: "${v}" is not a rate`);
        out[k] = n;
        break;
      }
      case 'date': {
        const iso = blank ? null : String(v).trim();
        if (iso && (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !realDate(iso))) throw bad(`${f.label}: "${v}" is not a date`);
        out[k] = iso;
        break;
      }
      case 'currency': {
        const c = blank ? '' : String(v).trim().toUpperCase();
        if (c && !/^[A-Z]{3,4}$/.test(c)) throw bad(`${f.label}: "${v}" is not a currency code`);
        out[k] = c;
        break;
      }
      case 'enum':
        if (!f.options.includes(blank ? '' : String(v))) throw bad(`${f.label}: "${v}" is not one of ${f.options.filter(Boolean).join(', ')}`);
        out[k] = blank ? '' : String(v);
        break;
      case 'bool':
        out[k] = v === true || /^(true|yes|1|on)$/i.test(String(v));
        break;
      default:
        out[k] = blank ? '' : String(v).trim().slice(0, f.type === 'longtext' ? 20000 : 500);
    }
  }
  // An amount in euros is its own euro figure.
  if (out.amount !== undefined && out.currency === 'EUR' && out.cost_eur === undefined) out.cost_eur = out.amount;
  return out;
}

/* ── reading ─────────────────────────────────────────────────────── */

/**
 * A page of expenses, newest first, searched by title, type and description
 * (and the amount: "4300" finds AED 4,300), with the euro total of every
 * match — and how many matches have no euro figure, so a total is never
 * quietly short.
 */
export async function listExpenses(opts = {}) {
  const { q = '', type = '', from = '', to = '' } = opts;
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const where = ['e.deleted_at IS NULL'];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replaceAll('$?', `$${params.length}`));
  };
  for (const word of String(q).trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
    const n = /^[\d.,']+$/.test(word) ? parseMoney(word) : NaN;
    params.push(word);
    const w = `$${params.length}`;
    let byAmount = '';
    if (Number.isFinite(n)) {
      params.push(n);
      byAmount = ` OR e.amount = $${params.length} OR e.cost_eur = $${params.length}`;
    }
    where.push(`(e.title ILIKE '%'||${w}||'%' OR e.type ILIKE '%'||${w}||'%' OR e.description ILIKE '%'||${w}||'%'${byAmount})`);
  }
  for (const [col, v, op] of [
    ['e.expense_date', from, '>='],
    ['e.expense_date', to, '<='],
  ]) {
    if (v && /^\d{4}-\d{2}-\d{2}$/.test(v) && realDate(v)) add(`${col} ${op} $?`, v);
  }
  const typeWhere = [...where];
  const typeParams = [...params];
  if (type) add('e.type = $?', type);

  const [types, totals, page] = await Promise.all([
    query(`SELECT e.type AS k, count(*)::int AS n FROM expenses e WHERE ${typeWhere.join(' AND ')} GROUP BY 1 ORDER BY 2 DESC, 1`, typeParams),
    query(
      `SELECT count(*)::int AS n, COALESCE(sum(e.cost_eur), 0)::float AS eur, count(*) FILTER (WHERE e.cost_eur IS NULL)::int AS no_eur
         FROM expenses e WHERE ${where.join(' AND ')}`,
      params
    ),
    query(
      `SELECT e.*, (SELECT count(*)::int FROM expense_files f WHERE f.expense_id = e.id AND f.deleted_at IS NULL) AS files
         FROM expenses e WHERE ${where.join(' AND ')}
        ORDER BY e.expense_date DESC NULLS LAST, e.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
  ]);
  return {
    total: totals.rows[0].n,
    sum_eur: Math.round(totals.rows[0].eur * 100) / 100,
    without_eur: totals.rows[0].no_eur,
    expenses: page.rows,
    types: types.rows,
  };
}

export async function getExpense(id) {
  const { rows } = await query('SELECT * FROM expenses WHERE id = $1', [Number(id) || 0]);
  const e = rows[0];
  if (!e) throw notFound();
  const files = await query(
    `SELECT id, name, content_type, bytes, thumb_key IS NOT NULL AS has_thumb, created_at
       FROM expense_files WHERE expense_id = $1 AND deleted_at IS NULL ORDER BY id`,
    [e.id]
  );
  return { ...e, files: files.rows };
}

/** The type names in use, most used first — the form's suggestions. */
export async function expenseTypes() {
  const { rows } = await query(
    "SELECT type, count(*)::int AS n FROM expenses WHERE type <> '' AND deleted_at IS NULL GROUP BY 1 ORDER BY 2 DESC, 1"
  );
  return rows.map((r) => r.type);
}

/* ── changing ─────────────────────────────────────────────────────── */

async function log(db, expenseId, { userId = null, source = 'user', action, changes = {} }) {
  await db.query('INSERT INTO expense_events(expense_id, user_id, source, action, changes) VALUES ($1, $2, $3, $4, $5)', [
    expenseId,
    userId,
    source,
    action,
    changes,
  ]);
}

const same = (a, b) => (a === null || a === undefined ? '' : String(a)) === (b === null || b === undefined ? '' : String(b));

export async function createExpense(data, user) {
  const values = clean(data);
  if (!values.title) throw bad('An expense needs a title');
  if (values.amount === undefined || values.amount === null) throw bad('An expense needs its cost');
  if (!values.currency) throw bad('Say which currency the cost is in');
  values.expense_date ||= new Date().toISOString().slice(0, 10);
  const keys = Object.keys(values);
  return tx(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO expenses(${keys.join(', ')}, origin) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, 'manual') RETURNING id`,
      keys.map((k) => values[k])
    );
    await log(db, rows[0].id, { userId: user?.id, action: 'create', changes: values });
    return rows[0].id;
  });
}

/** Edits an expense; a field changed on one copied from Chrono Key is LOCKED against the sync. */
export async function updateExpense(id, patch, user) {
  const values = clean(patch);
  return tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM expenses WHERE id = $1 FOR UPDATE', [Number(id) || 0]);
    const e = rows[0];
    if (!e) throw notFound();
    const changes = {};
    for (const [k, v] of Object.entries(values)) if (!same(e[k], v)) changes[k] = [e[k], v];
    const keys = Object.keys(changes);
    if (!keys.length) return { changed: [] };
    const locks = e.origin === 'manual' ? e.locked_fields : [...new Set([...e.locked_fields, ...keys])];
    await db.query(
      `UPDATE expenses SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, locked_fields = $${keys.length + 1},
              updated_at = now() WHERE id = $${keys.length + 2}`,
      [...keys.map((k) => values[k]), locks, e.id]
    );
    await log(db, e.id, { userId: user?.id, action: 'update', changes });
    return { changed: keys };
  });
}

/* Deleting is soft, as for watches: one from Chrono Key stays deleted however often the sync meets it. */
export async function deleteExpense(id, user, { restore = false } = {}) {
  return tx(async (db) => {
    const { rows } = await db.query(
      `UPDATE expenses SET deleted_at = ${restore ? 'NULL' : 'now()'}, updated_at = now()
        WHERE id = $1 AND deleted_at IS ${restore ? 'NOT NULL' : 'NULL'} RETURNING id`,
      [Number(id) || 0]
    );
    if (!rows[0]) throw notFound();
    await log(db, rows[0].id, { userId: user?.id, action: restore ? 'restore' : 'delete' });
  });
}

/* ── payment copies ──────────────────────────────────────────────── */

export async function addFiles(id, files, user) {
  const { rows } = await query(
    `SELECT e.id, (SELECT count(*)::int FROM expense_files f WHERE f.expense_id = e.id AND f.deleted_at IS NULL) AS n
       FROM expenses e WHERE e.id = $1`,
    [Number(id) || 0]
  );
  if (!rows[0]) throw notFound();
  if (rows[0].n + files.length > MAX_FILES) throw bad(`An expense can hold ${MAX_FILES} payment copies; this one has ${rows[0].n}`);
  // Every file is checked and stored before any row is written: a bad one fails the lot.
  const stored = [];
  for (const f of files) stored.push({ ...(await saveDocument(f.buffer)), name: String(f.name || '').slice(0, 200) });
  return tx(async (db) => {
    const ids = [];
    for (const s of stored) {
      const { rows: ins } = await db.query(
        `INSERT INTO expense_files(expense_id, storage_key, thumb_key, content_type, bytes, name, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [rows[0].id, s.storage_key, s.thumb_key, s.content_type, s.bytes, s.name, user?.id ?? null]
      );
      ids.push(ins[0].id);
    }
    await log(db, rows[0].id, { userId: user?.id, action: 'file_add', changes: { names: stored.map((s) => s.name) } });
    return ids;
  });
}

export async function removeFile(expenseId, fileId, user) {
  return tx(async (db) => {
    const { rows } = await db.query(
      'UPDATE expense_files SET deleted_at = now() WHERE id = $1 AND expense_id = $2 AND deleted_at IS NULL RETURNING id, name',
      [Number(fileId) || 0, Number(expenseId) || 0]
    );
    if (!rows[0]) throw Object.assign(new Error('No such payment copy'), { status: 404 });
    await log(db, Number(expenseId), { userId: user?.id, action: 'file_remove', changes: { name: rows[0].name } });
  });
}

export async function expenseFile(fileId, { thumb = false } = {}) {
  const { rows } = await query('SELECT * FROM expense_files WHERE id = $1 AND deleted_at IS NULL', [Number(fileId) || 0]);
  const f = rows[0];
  if (!f) return null;
  const key = thumb && f.thumb_key ? f.thumb_key : f.storage_key;
  const buffer = await (await storage()).get(key);
  if (!buffer) return null;
  return { buffer, type: thumb && f.thumb_key ? 'image/jpeg' : f.content_type, name: f.name };
}

/* ── from Chrono Key ──────────────────────────────────────────────── */

const PAYMENT_OF = { 0: 'cash', 1: 'card', 2: 'bank', 3: 'crypto', 4: 'paypal' };

/*
 * The currency an expense's cost is in.
 *
 * Chrono Key's two European options do not say what they mean (first read,
 * 23 Oct 2026). Its "GBP (£)" is its BASE, rate fixed at 1 — and the base is
 * euros, as its "£" prices are: "salva | COMMISION | eur 5,000" is GBP 5,000 at
 * 1. Its "EUR (€)" is used for POUNDS at a pound-to-euro rate: "kashan | salary
 * | gbp 3,000" is EUR 3,000 at 1.18. So, in order:
 *   1. what the title or description says, when it names this same amount
 *      ("gbp 3,000" against 3,000) — the rule the product list uses
 *   2. the "GBP" option → EUR
 *   3. the "EUR" option at a rate of 1 → EUR; at any other rate it is most
 *      likely pounds, but that is a guess: left as not stated
 *   4. AED, USD, CHF, HKD as chosen — their rates fit (AED 0.24, USD 0.89)
 * The euro figure (cost × rate) is right whichever it is.
 */
function currencyOf(list, detail, rate) {
  const noted = currencyFromNote([detail.title, detail.description, list.title].filter(Boolean).join(' \n '), detail.cost);
  if (noted) return noted === 'USDT' ? 'USDT' : noted;
  if (detail.currency === 'GBP') return 'EUR';
  if (detail.currency === 'EUR') return rate === 1 ? 'EUR' : '';
  return detail.currency || '';
}

/**
 * One expense as Chrono Key holds it — its list row and, once read, its own
 * page — as our fields. The page is the better source (the cost in its own
 * currency, the rate, the payment type); the list alone gives the booked
 * figure, the title, type, description and date.
 */
export function fromChronoKey(list, detail) {
  const f = {
    title: list.title || '',
    type: list.type || '',
    description: list.description || '',
    expense_date: list.date || null,
    cost_eur: Number.isFinite(list.cost) ? list.cost : null,
  };
  if (detail) {
    if (detail.title) f.title = detail.title;
    if (detail.description) f.description = detail.description;
    if (detail.type) f.type = detail.type;
    if (detail.date) f.expense_date = detail.date;
    f.amount = Number.isFinite(detail.cost) ? detail.cost : null;
    f.exchange_rate = Number.isFinite(detail.rate) && detail.rate > 0 ? detail.rate : null;
    f.currency = currencyOf(list, detail, f.exchange_rate);
    f.payment_method = PAYMENT_OF[detail.paymentType] || '';
    f.exclude_from_profit = Boolean(detail.excludeFromProfit);
  }
  return f;
}

/** Writes one Chrono Key expense into ours: new, or its unlocked fields replaced. */
export async function applyExpense(db, ckId, fields) {
  const { rows } = await db.query('SELECT * FROM expenses WHERE ck_id = $1 FOR UPDATE', [ckId]);
  const e = rows[0];
  if (!e) {
    const keys = Object.keys(fields);
    const { rows: ins } = await db.query(
      `INSERT INTO expenses(ck_id, ${keys.join(', ')}, origin) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}, 'chronokey') RETURNING id`,
      [ckId, ...keys.map((k) => fields[k])]
    );
    await log(db, ins[0].id, { source: 'chronokey', action: 'create', changes: fields });
    return { id: ins[0].id, created: true, changed: keys };
  }
  const changes = {};
  for (const [k, v] of Object.entries(fields)) {
    if (e.locked_fields.includes(k) || same(e[k], v)) continue;
    // A currency is never cleared by a read that simply does not state one.
    if (k === 'currency' && !v && e[k]) continue;
    changes[k] = [e[k], v];
  }
  const keys = Object.keys(changes);
  if (keys.length) {
    await db.query(
      `UPDATE expenses SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${keys.length + 1}`,
      [...keys.map((k) => fields[k]), e.id]
    );
    await log(db, e.id, { source: 'chronokey', action: 'sync', changes });
  }
  return { id: e.id, created: false, changed: keys };
}

export { CURRENCIES };
