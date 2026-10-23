import { query, tx } from '../db/index.js';
import { parseMoney, realDate } from '../watches/fields.js';
import { storage } from '../storage/index.js';
import { getRates } from '../rates/index.js';
import { lastLogisticsRead, stockFor } from '../import/logistics/sync.js';
import { GROUPS, KINDS, KIND, isSecret } from './kinds.js';
import * as situation from './situation.js';

/*
 * Logistics, as masterapp holds it: every record of the logistics app — and
 * every one added here — read, searched, edited and deleted (softly).
 *
 * The rule for watches, clients and expenses holds: until the switch-over the
 * logistics app's figures replace ours, except a field somebody edited here
 * (locked). A record added here is ours alone and never touched by the sync.
 */

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const notFound = () => Object.assign(new Error('No such logistics record'), { status: 404 });

/* What the page builds its tabs and forms from. */
export function catalog() {
  return {
    groups: GROUPS,
    kinds: KINDS.map((k) => ({ key: k.key, label: k.label, group: k.group, fields: k.fields || [], place: k.place || '', theirs: Boolean(k.theirs) })),
  };
}

/* A kind the app added that this catalog does not know yet still has a page. */
const kindOf = (key) =>
  KIND[key] || {
    key,
    label: String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()),
    group: 'log',
    summary: (d) => ({ title: String(d.title || d.name || d.description || d.text || d.id || key), date: d.ts || d.createdAt || d.date }),
  };

/*
 * A logistics client's id as records name it: the app's own, or — for one
 * added here, which has none — "ma-" and our row's id.
 */
const CLIENT_ID = "COALESCE(source_id, 'ma-' || id)";

/* The logistics clients by id, for every summary that names one. */
async function context() {
  const { rows } = await query(`SELECT ${CLIENT_ID} AS id, data->>'name' AS name FROM logistics_items WHERE kind = 'clients'`);
  const names = new Map(rows.map((r) => [r.id, r.name || '']));
  const client = (id) => (id ? names.get(String(id)) || '' : '');
  return { client, route: (d) => situation.route(d, client), stage: situation.stage };
}

function summarise(row, ctx) {
  let s = {};
  try {
    s = kindOf(row.kind).summary(row.data || {}, ctx) || {};
  } catch {
    s = {};
  }
  const t = situation.when(s.date);
  const d = row.data || {};
  return {
    // A record added through the plain Title / Notes form says what it is, not just its list's name.
    title: String(s.title || d.title || d.name || d.text || d.notes || '').trim().slice(0, 200) || kindOf(row.kind).label,
    sub: String(s.sub || '').trim(),
    status: String(s.status || '').trim(),
    date: t ? new Date(t).toISOString() : null,
    money: s.money || null,
  };
}

const view = (row, ctx) => ({
  id: row.id,
  kind: row.kind,
  kind_label: kindOf(row.kind).label,
  source_id: row.source_id,
  origin: row.origin,
  stock_nos: row.stock_nos,
  locked_fields: row.locked_fields,
  created_at: row.created_at,
  updated_at: row.updated_at,
  deleted_at: row.deleted_at,
  summary: summarise(row, ctx),
});

/* ── reading ─────────────────────────────────────────────────────── */

/**
 * A page of one tab's records (or one kind's), newest first, searched across
 * every field and the stock numbers, with how many each kind holds.
 */
export async function listItems(opts = {}) {
  const { group = '', kind = '', q = '', status = '' } = opts;
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const where = [opts.deleted === '1' || opts.deleted === true ? 'i.deleted_at IS NOT NULL' : 'i.deleted_at IS NULL'];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replaceAll('$?', `$${params.length}`));
  };
  const groupKinds = KINDS.filter((k) => k.group === group).map((k) => k.key);
  if (group === 'log') {
    // The activity tab also shows lists the catalog does not know yet.
    params.push(groupKinds, KINDS.map((k) => k.key));
    where.push(`(i.kind = ANY($${params.length - 1}) OR NOT (i.kind = ANY($${params.length})))`);
  } else if (group) add('i.kind = ANY($?)', groupKinds);
  for (const word of String(q).trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
    add("(i.data::text ILIKE '%'||$?||'%' OR array_to_string(i.stock_nos, ' ') ILIKE '%'||$?||'%')", word);
  }
  const kindWhere = [...where];
  const kindParams = [...params];
  if (kind) add('i.kind = $?', kind);
  if (status) add("i.data->>'status' = $?", status);

  const [kinds, total, page] = await Promise.all([
    query(`SELECT i.kind, count(*)::int AS n FROM logistics_items i WHERE ${kindWhere.join(' AND ')} GROUP BY 1 ORDER BY 1`, kindParams),
    query(`SELECT count(*)::int AS n FROM logistics_items i WHERE ${where.join(' AND ')}`, params),
    query(
      `SELECT i.* FROM logistics_items i WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(i.happened_at, i.created_at) DESC, i.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    ),
  ]);
  const ctx = await context();
  return {
    total: total.rows[0].n,
    kinds: kinds.rows.map((r) => ({ kind: r.kind, label: kindOf(r.kind).label, n: r.n })),
    items: page.rows.map((r) => view(r, ctx)),
  };
}

/** The watches (ours) a record names, by stock number. */
async function watchesFor(stockNos) {
  if (!stockNos?.length) return [];
  const { rows } = await query(
    'SELECT id, stock_no, brand, model, reference, status FROM watches WHERE stock_no = ANY($1) AND deleted_at IS NULL ORDER BY stock_no',
    [stockNos]
  );
  return rows;
}

export async function getItem(id) {
  const { rows } = await query('SELECT * FROM logistics_items WHERE id = $1', [Number(id) || 0]);
  const it = rows[0];
  if (!it) throw notFound();
  const ctx = await context();
  const k = kindOf(it.kind);
  return {
    ...view(it, ctx),
    data: it.data,
    fields: k.fields || [],
    watches: await watchesFor(it.stock_nos),
    clients: Object.fromEntries(
      (k.fields || [])
        .filter((f) => f.type === 'client' && it.data[f.key])
        .map((f) => [f.key, ctx.client(it.data[f.key])])
    ),
  };
}

export async function itemEvents(id) {
  const { rows } = await query(
    `SELECT e.id, e.at, e.source, e.action, e.changes, u.name AS user_name
       FROM logistics_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.item_id = $1 ORDER BY e.at DESC, e.id DESC LIMIT 200`,
    [Number(id) || 0]
  );
  return rows;
}

/** The logistics clients, for the client fields' choices. */
export async function clientChoices() {
  const { rows } = await query(
    `SELECT ${CLIENT_ID} AS id, data->>'name' AS name, data->>'country' AS country FROM logistics_items
      WHERE kind = 'clients' AND deleted_at IS NULL ORDER BY lower(data->>'name')`
  );
  return rows;
}

/* ── changing ─────────────────────────────────────────────────────── */

const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

/**
 * A patch as stored: the kind's own fields by their type; any other field
 * the record carries only as plain text, a number or yes/no — a list or a
 * nested record is the logistics app's structure and is not edited loose.
 */
function clean(kind, patch, current = {}) {
  const k = kindOf(kind);
  const typed = Object.assign(Object.create(null), Object.fromEntries((k.fields || []).map((f) => [f.key, f])));
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

async function log(db, itemId, { userId = null, source = 'user', action, changes = {} }) {
  await db.query('INSERT INTO logistics_events(item_id, user_id, source, action, changes) VALUES ($1,$2,$3,$4,$5)', [itemId, userId, source, action, changes]);
}

/* A trip's watches are its rows' ids: looked up among our items. */
async function rowStockFromDb(db) {
  const { rows } = await db.query(
    "SELECT kind, source_id, data->>'stockNumber' AS stock FROM logistics_items WHERE source_id IS NOT NULL AND kind = ANY($1)",
    [['londonStock', 'dubaiStock', 'hkStock', 'safeStock', 'hkSituation', 'incomings', 'soldStocks', 'readyForDelivery', 'checkoutStock']]
  );
  const m = new Map(rows.map((r) => [`${r.kind}:${r.source_id}`, r.stock || '']));
  return (list, id) => (list === '*' ? rows.find((r) => r.source_id === String(id))?.stock || '' : m.get(`${list}:${id}`) || '');
}

export async function createItem(kind, data, user) {
  if (!kind || !FIELD_NAME.test(kind) || kind === 'settings') throw bad('Say which list the record belongs to');
  if (!KIND[kind]) throw bad(`There is no logistics list called ${kind}`);
  if (KIND[kind].map) throw bad('Vault holders are kept by the vault itself');
  const values = clean(kind, data);
  const stamp = Date.now();
  values.createdAt ??= stamp;
  if (['activity', 'vaultNotifications', 'ownerBriefs', 'settlements', 'thirdPartyMovers', 'thirdPartyShipments', 'logisticCosts', 'soldStocks', 'readyForDelivery'].includes(kind)) values.ts ??= stamp;
  return tx(async (db) => {
    const stockNos = stockFor(kind, values, null, await rowStockFromDb(db));
    const { rows } = await db.query(
      "INSERT INTO logistics_items(kind, data, stock_nos, happened_at, origin, created_by) VALUES ($1,$2,$3,$4,'manual',$5) RETURNING id",
      [kind, values, stockNos, situation.happenedAt(kind, values), user?.id ?? null]
    );
    await log(db, rows[0].id, { userId: user?.id, action: 'create', changes: values });
    return rows[0].id;
  });
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Edits a record; a field changed on one copied from the logistics app is LOCKED against the sync. */
export async function updateItem(id, patch, user) {
  return tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM logistics_items WHERE id = $1 FOR UPDATE', [Number(id) || 0]);
    const it = rows[0];
    if (!it) throw notFound();
    const values = clean(it.kind, patch, it.data);
    const changes = {};
    for (const [k, v] of Object.entries(values)) if (!same(it.data[k], v)) changes[k] = [it.data[k] ?? null, v];
    const keys = Object.keys(changes);
    if (!keys.length) return { changed: [] };
    const next = { ...it.data, ...values };
    const locks = it.origin === 'manual' ? it.locked_fields : [...new Set([...it.locked_fields, ...keys])];
    const stockNos = stockFor(it.kind, next, it.source_id, await rowStockFromDb(db), it.stock_nos);
    await db.query('UPDATE logistics_items SET data = $2, stock_nos = $3, locked_fields = $4, happened_at = $5, updated_at = now() WHERE id = $1', [
      it.id,
      next,
      stockNos,
      locks,
      situation.happenedAt(it.kind, next),
    ]);
    await log(db, it.id, { userId: user?.id, action: 'update', changes });
    return { changed: keys };
  });
}

/** Hands a field back to the sync: the logistics app's value comes back now, not in fifteen minutes. */
export async function unlockField(id, field, user) {
  return tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM logistics_items WHERE id = $1 FOR UPDATE', [Number(id) || 0]);
    const it = rows[0];
    if (!it) throw notFound();
    if (!it.locked_fields.includes(field)) throw bad(`${field} is not locked`);
    const { rows: raw } = await db.query('SELECT data FROM logistics_records WHERE kind = $1 AND source_id = $2', [it.kind, it.source_id]);
    const next = { ...it.data };
    const theirs = raw[0]?.data?.[field];
    if (theirs === undefined) delete next[field];
    else next[field] = theirs;
    const locks = it.locked_fields.filter((k) => k !== field);
    await db.query('UPDATE logistics_items SET data = $2, locked_fields = $3, stock_nos = $4, happened_at = $5, updated_at = now() WHERE id = $1', [
      it.id,
      next,
      locks,
      stockFor(it.kind, next, it.source_id, await rowStockFromDb(db), it.stock_nos),
      situation.happenedAt(it.kind, next),
    ]);
    await log(db, it.id, { userId: user?.id, action: 'unlock', changes: { [field]: [it.data[field] ?? null, theirs ?? null] } });
  });
}

/* Deleting is soft: one from the logistics app stays deleted however often the sync meets it. */
export async function deleteItem(id, user, { restore = false } = {}) {
  return tx(async (db) => {
    const { rows } = await db.query(
      `UPDATE logistics_items SET deleted_at = ${restore ? 'NULL' : 'now()'}, updated_at = now()
        WHERE id = $1 AND deleted_at IS ${restore ? 'NOT NULL' : 'NULL'} RETURNING id`,
      [Number(id) || 0]
    );
    if (!rows[0]) throw notFound();
    await log(db, rows[0].id, { userId: user?.id, action: restore ? 'restore' : 'delete' });
  });
}

/* ── one watch ───────────────────────────────────────────────────── */

/** When the logistics app was last read (a pass that found nothing new still counts). */
async function asOf() {
  // Newest first along import_runs' started_at index, not a scan of every run.
  const { rows } = await query("SELECT finished_at AS at FROM import_runs WHERE source = 'logistics' AND ok ORDER BY started_at DESC LIMIT 1");
  const a = rows[0]?.at ? new Date(rows[0].at) : null;
  const b = lastLogisticsRead();
  return a && b ? (a > b ? a : b) : a || b;
}

/**
 * Where a watch is and what is happening to it: the headline, what is moving
 * it, its logistics history and what moving it cost — from every record,
 * deleted ones included for the history (a sale takes a watch's row out of
 * its place's list, and that row's movements are its past).
 */
/*
 * What moving a watch cost, as ONE figure (asked 24 Oct 2026): every
 * currency's total converted into the currency the watch was bought in —
 * dollars when that is not known, as the logistics app counts — at the rates
 * the converter beside every price uses. Null when no rate can be had: the
 * page then shows each currency's own total, never a guess.
 */
async function costTotal(totals, purchaseCurrency) {
  const parts = Object.entries(totals || {});
  if (!parts.length) return null;
  const target = /^[A-Z]{3,4}$/.test(purchaseCurrency || '') ? purchaseCurrency : 'USD';
  let r;
  try {
    r = await getRates();
  } catch {
    return null;
  }
  if (!r.rates[target]) return null;
  let sum = 0;
  const missing = [];
  for (const [cur, amount] of parts) {
    if (r.rates[cur]) sum += (amount / r.rates[cur]) * r.rates[target];
    else missing.push(cur);
  }
  if (missing.length === parts.length) return null;
  return {
    amount: Math.round(sum * 100) / 100,
    currency: target,
    bought_in: target === purchaseCurrency,
    rates: r.kind, // "live" or "daily", as the converter prints it
    stale: Boolean(r.stale),
    missing, // currencies with no rate: left out of the figure, and said so
  };
}

export async function forWatch(watchId) {
  const { rows: w } = await query('SELECT id, stock_no, purchase_currency FROM watches WHERE id = $1', [Number(watchId) || 0]);
  if (!w[0]) throw Object.assign(new Error('No such watch'), { status: 404 });
  const stockNo = w[0].stock_no;
  const [{ rows }, ctx, at] = await Promise.all([
    query('SELECT * FROM logistics_items WHERE stock_nos @> ARRAY[$1]::text[] ORDER BY id', [stockNo]),
    context(),
    asOf(),
  ]);
  const items = rows.map((r) => ({ ...r, id: r.id }));
  const opts = { clientName: ctx.client };
  const costs = situation.costs(stockNo, items);
  costs.total = await costTotal(costs.totals, w[0].purchase_currency);
  return {
    stock_no: stockNo,
    as_of: at,
    now: situation.now(items, opts),
    timeline: situation.timeline(items, opts).slice(0, 200).map((e) => ({ ...e, at: e.at ? new Date(e.at).toISOString() : null, kind_label: kindOf(e.kind).label })),
    costs,
    items: rows.filter((r) => !r.deleted_at).map((r) => view(r, ctx)),
  };
}

/* ── the overview ────────────────────────────────────────────────── */

export async function overview() {
  const live = (kind, extra = '') => query(`SELECT * FROM logistics_items WHERE kind = $1 AND deleted_at IS NULL ${extra} ORDER BY updated_at DESC LIMIT 200`, [kind]);
  const [ctx, shipments, ready, incoming, counts, recent, at] = await Promise.all([
    context(),
    live('shipments', "AND COALESCE(data->>'status','') NOT IN ('delivered','cancelled')"),
    live('readyForDelivery'),
    live('incomings', "AND COALESCE(data->>'status','') NOT IN ('arrived','cancelled')"),
    query(`SELECT kind,
                  count(*)::int AS n,
                  count(*) FILTER (WHERE data->>'status' = 'consignment' OR data ? 'consignment')::int AS consignment,
                  count(*) FILTER (WHERE data->'polish' IS NOT NULL AND data->'polish'->>'status' IS DISTINCT FROM 'done')::int AS polish,
                  count(*) FILTER (WHERE (data->>'needPolish')::text = 'true')::int AS need_polish
             FROM logistics_items
            WHERE deleted_at IS NULL AND kind IN ('londonStock','dubaiStock','hkStock','safeStock','checkoutStock')
              AND COALESCE(data->>'status','current') IN ('current','consignment')
            GROUP BY kind`),
    query(
      `SELECT e.at, e.source, e.action, e.changes, u.name AS user_name, i.id, i.kind, i.data, i.stock_nos, i.origin, i.source_id,
              i.locked_fields, i.created_at, i.updated_at, i.deleted_at
         FROM logistics_events e JOIN logistics_items i ON i.id = e.item_id LEFT JOIN users u ON u.id = e.user_id
        WHERE e.action <> 'create' OR e.source = 'user'
        ORDER BY e.at DESC, e.id DESC LIMIT 40`
    ),
    asOf(),
  ]);
  const withStage = (r) => ({ ...view(r, ctx), stage: situation.stage(r.data).key });
  return {
    as_of: at,
    shipments: shipments.rows.filter((r) => situation.shipmentOpen(r.data)).map(withStage),
    ready: ready.rows.map((r) => view(r, ctx)),
    incoming: incoming.rows.map((r) => view(r, ctx)),
    places: counts.rows.map((r) => ({ ...r, label: kindOf(r.kind).label })),
    recent: recent.rows.map((r) => ({ at: r.at, source: r.source, action: r.action, changes: r.changes, user_name: r.user_name, item: view(r, ctx) })),
  };
}

/* ── files ───────────────────────────────────────────────────────── */

export async function file(fid, { thumb = false } = {}) {
  const { rows } = await query('SELECT * FROM logistics_files WHERE id = $1', [Number(fid) || 0]);
  const f = rows[0];
  if (!f) return null;
  const key = thumb && f.thumb_key ? f.thumb_key : f.storage_key;
  const buffer = await (await storage()).get(key);
  if (!buffer) return null;
  return { buffer, type: thumb && f.thumb_key ? 'image/jpeg' : f.content_type };
}
