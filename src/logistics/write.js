/*
 * Writing logistics records here — the entries that used to be made in the
 * logistics app (asked 27 Oct 2026: "all the features in the logistic side in
 * the erp system to do entries"). Every workflow of the app (move, consign,
 * sold, checkout, a cost, a shipment, a plan …) is an ACTION
 * (src/logistics/actions) built out of these pieces, inside one transaction:
 *
 *   loadItem      a record, locked for the transaction
 *   insertItem    a new record — origin 'manual', its stock numbers read as
 *                 the sync reads them, an event, never seen by the app
 *   patchItem     a changed record: every top-level field that differs is
 *                 LOCKED against the sync (the app's copy no longer overwrites
 *                 it), an event with the change
 *   softDelete    deleted here, stays deleted however often the sync meets it
 *   logActivity   a line in the activity log, as the app writes one for
 *                 everything it does (`logActivity` in its index.html)
 *
 * The values a form sends are checked by clean() against the kind's typed
 * fields (kinds.js) before they reach a record; an action checks the rest.
 */
import { tx } from '../db/index.js';
import { parseMoney, realDate } from '../watches/fields.js';
import { KIND, isSecret } from './kinds.js';
import * as situation from './situation.js';
import { stockFor } from '../import/logistics/sync.js';
import { kindOf } from './shared.js';

export const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
export const notFound = () => Object.assign(new Error('No such logistics record'), { status: 404 });
export const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

/* The extra typed fields the action modules give a kind's form (actions/*.js FIELDS), registered by actions/index.js. */
const extraFields = Object.create(null);
export const addFields = (map) => {
  for (const [kind, fields] of Object.entries(map || {})) extraFields[kind] = [...(extraFields[kind] || []), ...fields];
};
/** A kind's typed fields: kinds.js's, then the modules' (a key kinds.js already types stays kinds.js's). */
export const fieldsOf = (k) => {
  const had = new Set((k.fields || []).map((f) => f.key));
  return [...(k.fields || []), ...(extraFields[k.key] || []).filter((f) => !had.has(f.key))];
};

/* The app's own ids: `Date.now().toString(36) + 4 random base-36 chars` (its uid()). */
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
/* Today as a day on the calendar of the business (Dubai), for a date left blank. */
export const localToday = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);

export const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);
/** A day (YYYY-MM-DD, as the app writes days), today when blank; refused when not a day. */
export function dayOf(v, label = 'Date', { blank = 'today' } = {}) {
  const s = text(v, 10);
  if (!s) return blank === 'today' ? localToday() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !realDate(s)) throw bad(`${label}: "${v}" is not a date`);
  return s;
}
/** An amount, rounded to cents; 0 when blank; refused when not a number. */
export function amountOf(v, label = 'Amount') {
  if (v === undefined || v === null || String(v).trim() === '') return 0;
  const n = typeof v === 'number' ? v : parseMoney(v);
  if (!Number.isFinite(n) || n < 0 || n > 1e9) throw bad(`${label}: "${v}" is not an amount`);
  return Math.round(n * 100) / 100;
}
/** A currency code; `fallback` when blank. */
export function currencyOf(v, fallback = 'USD', label = 'Currency') {
  const c = text(v, 4).toUpperCase() || fallback;
  if (!/^[A-Z]{3,4}$/.test(c)) throw bad(`${label}: "${v}" is not a currency code`);
  return c;
}

/**
 * A form's values, checked against the kind's typed fields: an amount is a
 * number, a date a day, an enum one of its options … A field the kind does
 * not type is kept as text (a list or a set of details is not edited this
 * way). Nothing that looks like a secret, nothing off the prototype.
 */
export function clean(kind, patch, current = {}) {
  const k = kindOf(kind);
  const typed = Object.assign(Object.create(null), Object.fromEntries(fieldsOf(k).map((f) => [f.key, f])));
  const out = {};
  for (const [key, v] of Object.entries(patch || {})) {
    // "constructor", "__proto__" and the like are no field of a record, whatever a request says.
    if (!FIELD_NAME.test(key) || key in Object.prototype || isSecret(key) || key === 'id') throw bad(`Not a field that can be edited: ${key}`);
    const f = typed[key];
    const blank = v === null || v === undefined || String(v).trim() === '';
    if (!f) {
      const had = Object.hasOwn(current, key) ? current[key] : undefined;
      if ((v !== null && typeof v === 'object') || (had !== null && typeof had === 'object')) {
        throw bad(`${key} is a list or a set of details — edit it in its own section`);
      }
      out[key] = typeof v === 'string' ? v.slice(0, 20000) : v;
      continue;
    }
    switch (f.type) {
      case 'money':
      case 'number': {
        if (blank) out[key] = null;
        else {
          const n = typeof v === 'number' ? v : f.type === 'money' ? parseMoney(v) : Number(String(v).replace(',', '.'));
          if (!Number.isFinite(n) || Math.abs(n) > 1e9) throw bad(`${f.label}: "${v}" is not a number`);
          out[key] = f.type === 'money' ? Math.round(n * 100) / 100 : n;
        }
        break;
      }
      case 'currency': {
        const c = blank ? '' : String(v).trim().toUpperCase();
        if (c && !/^[A-Z]{3,4}$/.test(c)) throw bad(`${f.label}: "${v}" is not a currency code`);
        out[key] = c;
        break;
      }
      case 'date':
      case 'when': {
        const s = blank ? '' : String(v).trim();
        if (s && (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !realDate(s))) throw bad(`${f.label}: "${v}" is not a date`);
        out[key] = s || (f.type === 'when' ? null : '');
        break;
      }
      case 'enum': {
        const s = blank ? '' : String(v);
        // A value the record already had stays allowed, though the list does not name it.
        if (s && !f.options.includes(s) && s !== (Object.hasOwn(current, key) ? current[key] : undefined)) {
          throw bad(`${f.label}: "${v}" is not one of ${f.options.join(', ')}`);
        }
        out[key] = s;
        break;
      }
      case 'bool':
        out[key] = v === true || /^(true|yes|1|on)$/i.test(String(v));
        break;
      default:
        out[key] = blank ? '' : String(v).trim().slice(0, f.type === 'longtext' ? 20000 : 500);
    }
  }
  return out;
}

/* ── inside a transaction (db) ───────────────────────────────────── */

export async function log(db, itemId, { userId = null, source = 'user', action, changes = {} }) {
  await db.query('INSERT INTO logistics_events(item_id, user_id, source, action, changes) VALUES ($1,$2,$3,$4,$5)', [itemId, userId, source, action, changes]);
}

/* A trip's watches are its rows' ids: looked up among our items. */
export async function rowStockFromDb(db) {
  const { rows } = await db.query(
    "SELECT kind, COALESCE(source_id, data->>'id') AS source_id, data->>'stockNumber' AS stock FROM logistics_items WHERE deleted_at IS NULL AND COALESCE(source_id, data->>'id') IS NOT NULL AND kind = ANY($1)",
    [['londonStock', 'dubaiStock', 'hkStock', 'safeStock', 'hkSituation', 'incomings', 'soldStocks', 'readyForDelivery', 'checkoutStock']]
  );
  const m = new Map(rows.map((r) => [`${r.kind}:${r.source_id}`, r.stock || '']));
  return (list, id) => (list === '*' ? rows.find((r) => r.source_id === String(id))?.stock || '' : m.get(`${list}:${id}`) || '');
}

/** The record, locked for this transaction; a deleted one only when asked. */
export async function loadItem(db, id, { deleted = false } = {}) {
  const { rows } = await db.query('SELECT * FROM logistics_items WHERE id = $1 FOR UPDATE', [Number(id) || 0]);
  const it = rows[0];
  if (!it || (it.deleted_at && !deleted)) throw notFound();
  return it;
}

/* A change in an event: a list or a set of details is named, not copied. */
const brief = (v) => (v === undefined ? null : v !== null && typeof v === 'object' ? (Array.isArray(v) ? `${v.length} entr${v.length === 1 ? 'y' : 'ies'}` : '(details)') : v);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * A new record of ours, as the app would write it (the app's `id`, `createdAt`
 * and `ts` where its lists carry them). Returns the row.
 */
export async function insertItem(db, kind, data, user, { source = 'user', action = 'create' } = {}) {
  if (!kind || !FIELD_NAME.test(kind) || kind === 'settings') throw bad('Say which list the record belongs to');
  if (!KIND[kind]) throw bad(`There is no logistics list called ${kind}`);
  if (KIND[kind].map) throw bad('Vault holders are kept by the vault itself');
  const stamp = Date.now();
  const values = { id: uid(), ...data };
  values.createdAt ??= stamp;
  if (['activity', 'vaultNotifications', 'ownerBriefs', 'settlements', 'thirdPartyMovers', 'thirdPartyShipments', 'logisticCosts', 'soldStocks', 'readyForDelivery', 'accCollect', 'accGive', 'driverDeliveries', 'swaps'].includes(kind)) values.ts ??= stamp;
  const stockNos = stockFor(kind, values, null, await rowStockFromDb(db));
  const { rows } = await db.query(
    "INSERT INTO logistics_items(kind, data, stock_nos, happened_at, origin, created_by) VALUES ($1,$2,$3,$4,'manual',$5) RETURNING *",
    [kind, values, stockNos, situation.happenedAt(kind, values), user?.id ?? null]
  );
  await log(db, rows[0].id, { userId: user?.id, source, action, changes: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, brief(v)])) });
  return rows[0];
}

/**
 * The record with `next` as its data. Every top-level field that differs is
 * locked when the record is the app's copy (the sync leaves it alone); a
 * field set to undefined is dropped. Returns the changed keys.
 */
export async function patchItem(db, it, next, user, { source = 'user', action = 'update' } = {}) {
  const data = {};
  for (const [k, v] of Object.entries(next)) if (v !== undefined) data[k] = v;
  const keys = [...new Set([...Object.keys(it.data), ...Object.keys(data)])].filter((k) => !same(it.data[k], data[k]));
  if (!keys.length) return [];
  const locks = it.origin === 'manual' ? it.locked_fields : [...new Set([...it.locked_fields, ...keys])];
  const stockNos = stockFor(it.kind, data, it.source_id, await rowStockFromDb(db), it.stock_nos);
  await db.query('UPDATE logistics_items SET data = $2, stock_nos = $3, locked_fields = $4, happened_at = $5, updated_at = now() WHERE id = $1', [
    it.id,
    data,
    stockNos,
    locks,
    situation.happenedAt(it.kind, data),
  ]);
  await log(db, it.id, { userId: user?.id, source, action, changes: Object.fromEntries(keys.map((k) => [k, [brief(it.data[k]), brief(data[k])]])) });
  it.data = data;
  it.locked_fields = locks;
  it.stock_nos = stockNos;
  return keys;
}

/** Deleted softly; the app's copy stays deleted however often the sync meets it. */
export async function softDelete(db, id, user, { restore = false } = {}) {
  const { rows } = await db.query(
    `UPDATE logistics_items SET deleted_at = ${restore ? 'NULL' : 'now()'}, updated_at = now()
      WHERE id = $1 AND deleted_at IS ${restore ? 'NOT NULL' : 'NULL'} RETURNING id`,
    [Number(id) || 0]
  );
  if (!rows[0]) throw notFound();
  await log(db, rows[0].id, { userId: user?.id, action: restore ? 'restore' : 'delete' });
}

/** A line in the activity log, worded as the app words its own. */
export async function logActivity(db, line, user, type = 'info') {
  return insertItem(db, 'activity', { text: text(line, 500), type }, user, { action: 'create' });
}

/** The records of a kind, not deleted, as a list of rows. */
export async function listKind(db, kind, where = '', params = []) {
  const { rows } = await db.query(`SELECT * FROM logistics_items WHERE kind = $1 AND deleted_at IS NULL ${where ? `AND (${where})` : ''} ORDER BY id`, [kind, ...params]);
  return rows;
}

/** One transaction around an action. */
export const inTx = (fn) => tx(fn);
