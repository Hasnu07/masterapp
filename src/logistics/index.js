import { query, tx } from '../db/index.js';
import { parseMoney, realDate, displayTitle } from '../watches/fields.js';
import { storage } from '../storage/index.js';
import { getRates } from '../rates/index.js';
import { listWatches } from '../watches/index.js';
import { listClients, clientName } from '../clients/index.js';
import { config } from '../config.js';
import { lastLogisticsRead, stockFor, copyWorkerFile } from '../import/logistics/sync.js';
import { GROUPS, KINDS, KIND, isSecret, stockList } from './kinds.js';
import * as situation from './situation.js';
import { linksByName, linksByClientId } from './clients.js';

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

/* Where the logistics app keeps its pictures: an address there is shown as the picture, through workerFile. */
const photoPrefix = () => {
  try {
    return `${new URL(config.vault.url).origin}/photos/`;
  } catch {
    return '';
  }
};

/* What the page builds its tabs and forms from. */
export function catalog() {
  return {
    photoPrefix: photoPrefix(),
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
export async function context() {
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

export const view = (row, ctx) => ({
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

/*
 * Our watches, for a page of logistics records: each record's stock numbers
 * point at OUR watch where we hold it — one watch, never a second copy.
 */
export async function withWatches(views) {
  const nos = [...new Set(views.flatMap((v) => v.stock_nos || []))];
  const ours = await watchesFor(nos);
  const by = new Map(ours.map((w) => [w.stock_no, { id: w.id, stock_no: w.stock_no }]));
  return views.map((v) => ({ ...v, watches: (v.stock_nos || []).map((s) => by.get(s)).filter(Boolean) }));
}

/* ── search everything ───────────────────────────────────────────── */

/*
 * The Overview's search, across masterapp's own watches and clients and the
 * logistics app's records — without a thing twice (asked 24 Oct 2026: "make
 * sure everything is aligned with our stock and clients, not making
 * duplicates"):
 *   - a watch is OUR watch. A logistics stock row (London, Dubai, sold …) of a
 *     watch we hold is that watch — found through it, shown once, as ours,
 *     with where it is right now
 *   - a client is OUR client. A logistics contact is not shown again when one
 *     of ours with its name is in the answer. (Names only decide what is shown
 *     twice; nothing is linked by name.)
 *   - the rest — shipments, transactions, costs, a stock row for a watch we do
 *     not hold (one per watch) — as the logistics records they are
 */
const STOCK_KINDS = ['londonStock', 'dubaiStock', 'hkStock', 'safeStock', 'hkSituation', 'checkoutStock', 'soldStocks', 'readyForDelivery', 'incomings', 'fobPicked'];
const CLIENT_KINDS = ['clients', 'companies'];
/*
 * The stock rows each chip takes. The HK list goes by its section (sold, on
 * its way, in hand); the safe holds clients' watches, never our stock, so only
 * All has it; an incoming that arrived is in its place now. Constant SQL — no
 * request value reaches it.
 */
const SECTION = "COALESCE(i.data->>'section','')";
export const SEARCH_SCOPES = Object.assign(Object.create(null), {
  all: { watchStatus: '', rows: `i.kind IN (${STOCK_KINDS.map((k) => `'${k}'`).join(',')})`, clients: true, otherKinds: null },
  stock: {
    watchStatus: 'in_stock',
    rows: `(i.kind IN ('londonStock','dubaiStock','hkStock','checkoutStock') OR (i.kind = 'hkSituation' AND ${SECTION} NOT IN ('sold','incoming')))`,
    clients: false,
    otherKinds: [],
  },
  sold: { watchStatus: 'sold', rows: `(i.kind IN ('soldStocks','readyForDelivery') OR (i.kind = 'hkSituation' AND ${SECTION} = 'sold'))`, clients: false, otherKinds: [] },
  incoming: {
    watchStatus: 'incoming',
    rows: `((i.kind = 'incomings' AND COALESCE(i.data->>'status','') NOT IN ('arrived','cancelled')) OR i.kind = 'fobPicked' OR (i.kind = 'hkSituation' AND ${SECTION} = 'incoming'))`,
    clients: false,
    otherKinds: [],
  },
  shipments: { watchStatus: null, rows: null, clients: false, otherKinds: ['shipments', 'thirdPartyShipments', 'driverDeliveries'] },
  clients: { watchStatus: null, rows: null, clients: true, otherKinds: [] },
  transactions: { watchStatus: null, rows: null, clients: false, otherKinds: ['transactions', 'settlements', 'swaps', 'accCollect', 'accGive'] },
});
/* The copy a move leaves behind in the old place: a row of history, not where the watch is. */
const NOT_MOVED = "COALESCE(i.data->>'status','') <> 'moved'";
/* Which of a watch's rows says where it is now, first to last — situation.now's order. */
const WHERE_FIRST = ['soldStocks', 'readyForDelivery', 'checkoutStock', 'londonStock', 'dubaiStock', 'hkStock', 'safeStock', 'hkSituation', 'incomings', 'fobPicked'];

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

export async function search({ q = '', scope = 'all' } = {}) {
  const S = SEARCH_SCOPES[scope] || SEARCH_SCOPES.all;
  const term = String(q).trim();
  if (!term) return { q: term, scope, watches: [], clients: [], records: [] };
  const words = term.split(/\s+/).slice(0, 6);
  /*
   * Every word, in a record's fields or its stock numbers. A bare number is a
   * stock number exactly, as on the Watches page ("1668" must not find 11668,
   * nor a timestamp or a price with those digits inside); in a record's other
   * fields it must stand on its own (a whole tracking number, an amount) —
   * except when the record leads to one of OUR watches, where only its stock
   * numbers count ("2024" would otherwise bring every watch with a 2024 date).
   */
  const match = (params, { stockOnly = false } = {}) =>
    words
      .map((w) => {
        params.push(w);
        const n = `$${params.length}`;
        if (!/^\d+$/.test(w)) return `(i.data::text ILIKE '%'||${n}||'%' OR array_to_string(i.stock_nos, ' ') ILIKE '%'||${n}||'%')`;
        return stockOnly ? `${n} = ANY(i.stock_nos)` : `(${n} = ANY(i.stock_nos) OR i.data::text ~ ('(^|[^0-9])'||${n}||'([^0-9]|$)'))`;
      })
      .join(' AND ');
  const ctx = await context();

  // Watches: ours that match, and ours that a matching logistics stock row names.
  let watches = [];
  if (S.watchStatus !== null) {
    const direct = (await listWatches({ q: term, status: S.watchStatus, limit: 40 })).watches;
    const p = [];
    const cond = match(p, { stockOnly: true });
    if (S.watchStatus) p.push(S.watchStatus);
    const { rows: via } = await query(
      `SELECT DISTINCT w.id FROM logistics_items i JOIN watches w ON w.stock_no = ANY(i.stock_nos) AND w.deleted_at IS NULL
        WHERE i.deleted_at IS NULL AND ${S.rows} AND ${NOT_MOVED} AND ${cond} ${S.watchStatus ? `AND w.status = $${p.length}` : ''}
        LIMIT 40`,
      p
    );
    const have = new Set(direct.map((w) => w.id));
    const more = via.map((r) => r.id).filter((id) => !have.has(id));
    const extra = more.length
      ? (
          await query(
            `SELECT w.*, (SELECT p.id FROM watch_photos p WHERE p.watch_id = w.id AND p.deleted_at IS NULL ORDER BY p.sort, p.id LIMIT 1) AS photo_id
               FROM watches w WHERE w.id = ANY($1)`,
            [more]
          )
        ).rows.map((w) => ({ id: w.id, stock_no: w.stock_no, title: displayTitle(w), status: w.status, location: w.location, photo_id: w.photo_id }))
      : [];
    watches = [...direct, ...extra].slice(0, 40);
    // Where each is right now, from the logistics app.
    const nos = watches.map((w) => w.stock_no).filter(Boolean);
    if (nos.length) {
      const { rows: its } = await query('SELECT id, kind, data, stock_nos, deleted_at FROM logistics_items WHERE stock_nos && $1::text[]', [nos]);
      for (const w of watches) {
        const mine = its.filter((i) => i.stock_nos.includes(w.stock_no));
        const n = mine.length ? situation.now(mine, { clientName: ctx.client }) : null;
        w.now = n && n.headline ? { headline: n.headline, tone: n.tone } : null;
      }
    }
  }

  // Clients: ours; and a logistics contact unless one of ours with its name is among them — else it is the only
  // way that person is found (the term may be in what only the logistics app holds: a country, an address, notes).
  let clients = [];
  let shownNames = new Set();
  if (S.clients) {
    clients = (await listClients({ q: term, limit: 25 })).clients;
    shownNames = new Set(clients.flatMap((c) => [c.name, c.company, c.nickname].map(norm).filter(Boolean)));
  }

  // Logistics records: stock rows of watches we do not hold, logistics-only contacts, and the rest of the scope's lists.
  const p = [];
  const parts = [];
  if (S.rows) {
    parts.push(`(${S.rows} AND ${NOT_MOVED} AND NOT EXISTS (SELECT 1 FROM watches w WHERE w.stock_no = ANY(i.stock_nos) AND w.deleted_at IS NULL))`);
  }
  if (S.clients) {
    p.push(CLIENT_KINDS);
    parts.push(`i.kind = ANY($${p.length})`);
  }
  if (S.otherKinds === null) {
    p.push([...STOCK_KINDS, ...CLIENT_KINDS]);
    parts.push(`NOT (i.kind = ANY($${p.length}))`);
  } else if (S.otherKinds.length) {
    p.push(S.otherKinds);
    parts.push(`i.kind = ANY($${p.length})`);
  }
  let records = [];
  if (parts.length) {
    const { rows } = await query(
      `SELECT i.* FROM logistics_items i WHERE i.deleted_at IS NULL AND (${parts.join(' OR ')}) AND ${match(p)}
        ORDER BY COALESCE(i.happened_at, i.created_at) DESC, i.id DESC LIMIT 60`,
      p
    );
    // A watch we do not hold is one record, however many lists still have a row of it: the row that says where it
    // is now, read in the order the watch page reads them (sold, then waiting for delivery, checked out, a place,
    // the HK list, coming in) — the newest among equals.
    const watchKey = (r) => (STOCK_KINDS.includes(r.kind) && r.stock_nos?.length ? [...r.stock_nos].sort().join(',') : null);
    const best = new Map();
    for (const r of rows) {
      const key = watchKey(r);
      if (key && (!best.has(key) || WHERE_FIRST.indexOf(r.kind) < WHERE_FIRST.indexOf(best.get(key).kind))) best.set(key, r);
    }
    records = rows
      .filter((r) => !(CLIENT_KINDS.includes(r.kind) && shownNames.has(norm(r.data?.name))))
      .filter((r) => !watchKey(r) || best.get(watchKey(r)) === r)
      .map((r) => view(r, ctx));
    records = await withWatches(records);
  }
  return { q: term, scope, watches, clients, records };
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

/*
 * Polish, as the logistics app does it (its Send / Done):
 *   send  the stock row gets `polish` (who has it, from when, expected back,
 *         the cost) and needPolish; a cost becomes a logistic cost line for
 *         the watch, marked with the polish's id
 *   done  the polish moves to the row's polishHistory with the day it came
 *         back and the notes; needPolish is cleared
 * Fields changed on a row copied from the logistics app are locked, as any
 * edit: the next copy does not undo the polish.
 */
const POLISH_KINDS = ['londonStock', 'dubaiStock', 'hkStock', 'safeStock', 'soldStocks', 'readyForDelivery'];
const PLACE_LABEL = { londonStock: 'London Stock', dubaiStock: 'Dubai Stock', hkStock: 'HK Stock', safeStock: 'Safe', soldStocks: 'Sold Stock', readyForDelivery: 'Ready for delivery' };

export async function polishAction(id, body, user) {
  const action = String(body?.action || '');
  if (action !== 'send' && action !== 'done') throw bad('Say send or done');
  const text = (v, max = 500) => String(v ?? '').trim().slice(0, max);
  const day = (v, label) => {
    const s = text(v, 10) || localToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !realDate(s)) throw bad(`${label}: "${v}" is not a date`);
    return s;
  };
  return tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM logistics_items WHERE id = $1 FOR UPDATE', [Number(id) || 0]);
    const it = rows[0];
    if (!it || it.deleted_at) throw notFound();
    if (!POLISH_KINDS.includes(it.kind)) throw bad('Only a watch in stock, sold or waiting for delivery goes to polish');
    const d = it.data;
    const next = { ...d };
    let cost = null;
    if (action === 'send') {
      if (d.polish && d.polish.status !== 'done') throw bad(`Already at polish with ${d.polish.sentTo || 'someone'}`);
      const sentTo = text(body.sentTo, 200);
      if (!sentTo) throw bad('Say who the watch is going to for polishing');
      const amount = body.costAmount === undefined || body.costAmount === '' ? 0 : parseMoney(body.costAmount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 1e9) throw bad(`Cost: "${body.costAmount}" is not an amount`);
      const currency = text(body.costCurrency, 4).toUpperCase() || 'AED';
      if (!/^[A-Z]{3,4}$/.test(currency)) throw bad(`"${body.costCurrency}" is not a currency code`);
      next.polish = {
        id: `ma${Date.now().toString(36)}`,
        status: 'at_polish',
        sentTo,
        takenBy: text(body.takenBy, 200),
        itemDescription: text(body.itemDescription, 200) || 'Full Watch',
        sentDate: day(body.sentDate, 'Sent'),
        expectedBack: body.expectedBack ? day(body.expectedBack, 'Expected back') : '',
        costCurrency: currency,
        costAmount: Math.round(amount * 100) / 100,
        notes: text(body.notes, 2000),
        sentPhotos: [],
        createdAt: Date.now(),
      };
      next.needPolish = true;
      if (amount > 0) {
        cost = {
          stockNumber: d.stockNumber || '',
          title: `Polish — ${sentTo}`,
          date: next.polish.sentDate,
          currency,
          amount: next.polish.costAmount,
          fromName: PLACE_LABEL[it.kind] || '',
          toName: sentTo,
          notes: next.polish.notes ? `Polish: ${next.polish.notes}` : 'Polish cost',
          polishId: next.polish.id,
          ts: Date.now(),
          createdAt: Date.now(),
        };
      }
    } else {
      if (!d.polish || d.polish.status === 'done') throw bad('This watch is not at polish');
      next.polishHistory = [...(Array.isArray(d.polishHistory) ? d.polishHistory : []), { ...d.polish, returnedDate: day(body.returnedDate, 'Back'), returnNotes: text(body.returnNotes, 2000), donePhotos: [] }];
      delete next.polish;
      next.needPolish = false;
    }
    const keys = [...new Set([...Object.keys(d), ...Object.keys(next)])].filter((k) => JSON.stringify(d[k] ?? null) !== JSON.stringify(next[k] ?? null));
    const locks = it.origin === 'manual' ? it.locked_fields : [...new Set([...it.locked_fields, ...keys])];
    await db.query('UPDATE logistics_items SET data = $2, locked_fields = $3, updated_at = now() WHERE id = $1', [it.id, next, locks]);
    await log(db, it.id, {
      userId: user?.id,
      action: 'update',
      changes: Object.fromEntries(keys.map((k) => [k, [k === 'polish' || k === 'polishHistory' ? (d[k] ? '(details)' : null) : d[k] ?? null, k === 'polish' || k === 'polishHistory' ? (next[k] ? '(details)' : null) : next[k] ?? null]])),
    });
    if (cost) {
      const { rows: ins } = await db.query(
        "INSERT INTO logistics_items(kind, data, stock_nos, happened_at, origin, created_by) VALUES ('logisticCosts',$1,$2,$3,'manual',$4) RETURNING id",
        [cost, it.stock_nos, situation.happenedAt('logisticCosts', cost), user?.id ?? null]
      );
      await log(db, ins[0].id, { userId: user?.id, action: 'create', changes: { title: cost.title, amount: cost.amount, currency: cost.currency } });
    }
    return { changed: keys, cost: Boolean(cost) };
  });
}

/* Today as a day on the calendar of the business (Dubai), for a date left blank. */
function localToday() {
  return new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
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
  const opts = { clientName: ctx.client, stockNo };
  const costs = situation.costs(stockNo, items);
  costs.total = await costTotal(costs.totals, w[0].purchase_currency);
  const transactions = await txViews(rows.filter((r) => r.kind === 'transactions' && !r.deleted_at));
  return {
    stock_no: stockNo,
    as_of: at,
    now: situation.now(items, opts),
    timeline: situation.timeline(items, opts).slice(0, 200).map((e) => ({ ...e, at: e.at ? new Date(e.at).toISOString() : null, kind_label: kindOf(e.kind).label })),
    costs,
    // Its accessory transactions, as the Transactions tab shows them: shown with the costs on the watch's page, not on its tile.
    transactions,
    // What it has and what is missing, from every source that says (its own panel on the watch's page).
    accessories: await accessoriesOf(w[0].id, rows, transactions),
    items: rows.filter((r) => !r.deleted_at).map((r) => view(r, ctx)),
  };
}

/* ── held for a while: in the safe, checked out ──────────────────── */

const text = (v) => (v === null || v === undefined || v === false ? '' : String(v).trim());
const TICK = /^(true|✓|✔|yes|y|x|1)$/i;
const UNTICKED = /^(false|no|n|0)$/i;
/* A tick field that may instead say where or why: '' when unticked, 'yes' for a bare tick, else its words. */
const ticked = (v) => (UNTICKED.test(text(v)) ? '' : TICK.test(text(v)) ? 'yes' : text(v));
const iso = (v) => {
  const t = situation.when(v);
  return t ? new Date(t).toISOString() : null;
};
/* A day as the app wrote it (YYYY-MM-DD stays itself — no time zone moves it); milliseconds become a moment. */
const dayOf = (v) => (/^\d{4}-\d{2}-\d{2}/.test(text(v)) ? text(v).slice(0, 10) : iso(v));
function picturesOf(d) {
  const prefix = photoPrefix();
  const all = (Array.isArray(d.photos) ? d.photos : []).filter((v) => typeof v === 'string' && (/^lgfile:\d+$/.test(v) || (prefix && v.startsWith(prefix))));
  return { picture: all[0] || null, photo_count: all.length };
}

/*
 * Our watch of a record's stock number, and the clients Chrono Key ties it to
 * — bought from, sold to — by id, never by a typed name: so a row on these
 * pages links to our stock and to our client in one go.
 */
async function oursByStock(rows) {
  const byNo = await oursByNumber(rows.flatMap((r) => r.stock_nos || []));
  return (r) => (r.stock_nos || []).map((s) => byNo.get(s)).find(Boolean) || null;
}
async function oursByNumber(list) {
  const nos = [...new Set(list)];
  if (!nos.length) return new Map();
  const person = (col) =>
    `(SELECT jsonb_build_object('id', c.id, 'forename', c.forename, 'surname', c.surname, 'nickname', c.nickname, 'company', c.company)
        FROM clients c WHERE c.id = w.${col} AND c.deleted_at IS NULL)`;
  const { rows: ours } = await query(
    `SELECT w.id, w.stock_no, w.brand, w.model, w.reference, w.status,
            (SELECT p.id FROM watch_photos p WHERE p.watch_id = w.id AND p.deleted_at IS NULL ORDER BY p.sort, p.id LIMIT 1) AS photo_id,
            ${person('purchased_from_client_id')} AS bought_from, ${person('sold_to_client_id')} AS sold_to
       FROM watches w WHERE w.stock_no = ANY($1) AND w.deleted_at IS NULL`,
    [nos]
  );
  const who = (c) => (c ? { id: c.id, name: clientName(c) } : null);
  return new Map(
    ours.map((w) => [
      w.stock_no,
      { id: w.id, stock_no: w.stock_no, title: displayTitle(w), status: w.status, photo_id: w.photo_id, bought_from: who(w.bought_from), sold_to: who(w.sold_to) },
    ])
  );
}

/*
 * The logistics app's In Safe page (asked 26 Oct 2026): clients' watches we
 * hold — never our stock, so never priced — each with who it is for (the
 * row's "from", the app's Owner), and the accessories we owe a client that
 * sit in the safe ("To give" ticked "in our safe"). A row a move left behind
 * is history, not the safe now. The owner is a typed name: linked to the
 * logistics client of that name, and to ours only as that client is
 * (linksByName — by its watches, as on the Clients tab).
 */
const NOW_IN_PLACE = "COALESCE(data->>'status','') IN ('', 'current', 'consignment')";

export async function inSafe() {
  const [watchRows, accRows] = await Promise.all([
    query(`SELECT * FROM logistics_items WHERE kind = 'safeStock' AND deleted_at IS NULL AND ${NOW_IN_PLACE}`),
    query("SELECT * FROM logistics_items WHERE kind = 'accGive' AND deleted_at IS NULL AND lower(COALESCE(data->>'inSafe','')) NOT IN ('', 'false', 'no', 'n', '0')"),
  ]);
  const ourWatch = await oursByStock([...watchRows.rows, ...accRows.rows]);
  const people = await linksByName([...watchRows.rows.map((r) => r.data?.from), ...accRows.rows.map((r) => r.data?.toClient)]);
  const linkOf = (name) => people.get(text(name)) || null;

  const watches = watchRows.rows
    .map((r) => {
      const d = r.data || {};
      return {
        id: r.id,
        stock_no: text(d.stockNumber),
        brand: text(d.brand),
        model: text(d.watchModel || d.model || d.description),
        reference: text(d.watchReference || d.reference),
        watch_date: text(d.watchDate),
        serial: text(d.watchSerial || d.serial),
        owner: text(d.from),
        owner_link: linkOf(d.from),
        received_at: iso(d.receivedAt) || iso(d.createdAt) || new Date(r.created_at).toISOString(),
        // Which safe or box, when it says more than a tick; whether it is out with its owner for now.
        where: ticked(d.inSafe) === 'yes' ? '' : ticked(d.inSafe),
        with_owner: ticked(d.withClient),
        accessories_present: text(d.accessoriesPresent),
        accessories_missing: text(d.accessoriesMissing),
        need_polish: d.needPolish === true || d.needPolish === 'true',
        polish: d.polish?.sentTo && d.polish.status !== 'done' ? text(d.polish.sentTo) : '',
        consignment: text(d.consignment?.with),
        notes: text(d.notes),
        held_for_buyer: Boolean(d.heldForBuyer || d.soldId),
        ...picturesOf(d),
        origin: r.origin,
        locked: (r.locked_fields || []).length > 0,
        watch: ourWatch(r),
      };
    })
    .sort((a, b) => String(b.received_at || '').localeCompare(String(a.received_at || '')) || b.id - a.id);

  const accessories = accRows.rows
    .map((r) => {
      const d = r.data || {};
      const w = ourWatch(r);
      const safeRow = watches.find((x) => x.stock_no && x.stock_no === text(d.stockNumber));
      return {
        id: r.id,
        stock_no: text(d.stockNumber),
        // What the watch is, as the app shows it under the number: ours, else the safe's own row.
        about: w ? w.title : [safeRow?.brand, safeRow?.reference].filter(Boolean).join(' · '),
        items: text(d.items),
        for_client: text(d.toClient),
        for_link: linkOf(d.toClient),
        notes: text(d.notes),
        in_safe_at: iso(d.inSafeAt),
        watch: w,
      };
    })
    .sort((a, b) => String(b.in_safe_at || '').localeCompare(String(a.in_safe_at || '')) || b.id - a.id);

  return { as_of: await asOf(), watches, accessories };
}

/*
 * The logistics app's Checkout page (asked 26 Oct 2026): watches held
 * somewhere for a while, not sold — a trade show, a client trying one, a
 * driver, one given back. Each linked to our watch of that number and so to
 * our client (who it was bought from, who it was sold to — Chrono Key's ids).
 * The app lists a watch again each time it is checked out without a return
 * (1439 three times): shown once here, the earlier rows under it. A number
 * that is no number ("-", "xxxxxx") is never put together with another.
 */
const OUT_NOW = "COALESCE(data->>'status','') NOT IN ('returned', 'moved', 'sold', 'done')";
const ORIGIN = { hk: 'Hong Kong', 'hong kong': 'Hong Kong', dubai: 'Dubai', london: 'London', uk: 'London', safe: 'Safe' };
const originOf = (v) => ORIGIN[text(v).toLowerCase()] || text(v);
/* The HK list's description repeats the number and the brand ("1508 · Patek Philippe · 5396R-016"): the model is what is left. */
function modelOf(d, stock, brand) {
  const parts = text(d.watchModel || d.model || d.description).split(' · ').map((s) => s.trim());
  while (parts.length > 1 && (!parts[0] || parts[0] === '-' || parts[0] === stock || parts[0].toLowerCase() === brand.toLowerCase())) parts.shift();
  return parts.join(' · ');
}

export async function checkedOut() {
  const { rows } = await query(`SELECT * FROM logistics_items WHERE kind = 'checkoutStock' AND deleted_at IS NULL AND ${OUT_NOW}`);
  const ourWatch = await oursByStock(rows);
  const all = rows
    .map((r) => {
      const d = r.data || {};
      const stock = text(d.stockNumber);
      const brand = text(d.brand);
      return {
        id: r.id,
        stock_no: stock,
        brand,
        model: modelOf(d, stock, brand),
        reference: text(d.watchReference || d.reference),
        serial: text(d.watchSerial || d.serial),
        watch_date: text(d.watchDate),
        origin: originOf(d.originLocation),
        checked_out: dayOf(d.checkedOutDate) || new Date(r.created_at).toISOString(),
        reason: text(d.checkedOutBy),
        notes: text(d.notes),
        ...picturesOf(d),
        locked: (r.locked_fields || []).length > 0,
        watch: ourWatch(r),
      };
    })
    .sort((a, b) => String(b.checked_out).localeCompare(String(a.checked_out)) || b.id - a.id);

  const watches = [];
  const byStock = new Map();
  for (const w of all) {
    const key = /\d/.test(w.stock_no) ? w.stock_no : null;
    const first = key && byStock.get(key);
    if (first) {
      first.earlier.push({ id: w.id, checked_out: w.checked_out, reason: w.reason, origin: w.origin });
      continue;
    }
    const g = { ...w, earlier: [] };
    if (key) byStock.set(key, g);
    watches.push(g);
  }
  const origins = new Map();
  for (const w of watches) origins.set(w.origin, (origins.get(w.origin) || 0) + 1);
  return {
    as_of: await asOf(),
    watches,
    rows: all.length,
    by_origin: [...origins].map(([origin, n]) => ({ origin, n })).sort((a, b) => b.n - a.n || a.origin.localeCompare(b.origin)),
  };
}

/*
 * The logistics app's accessory transactions (asked 26 Oct 2026, its All
 * Transactions page): a watch bought or sold, and the accessories that go
 * with it — each to give (we owe the client) or to collect (they owe us),
 * pending or done — and the settlements that handed them over. Linked as
 * everywhere: the watch to ours and its clients; the client (the app's own
 * id) to the logistics client and, as that one is, to ours.
 */
async function txViews(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.source_id).filter(Boolean);
  const [ourWatch, people, settled] = await Promise.all([
    oursByStock(rows),
    linksByClientId(rows.map((r) => r.data?.clientId)),
    ids.length
      ? query("SELECT * FROM logistics_items WHERE kind = 'settlements' AND deleted_at IS NULL AND data->>'txId' = ANY($1) ORDER BY id", [ids])
      : { rows: [] },
  ]);
  return rows
    .map((r) => {
      const d = r.data || {};
      const items = (Array.isArray(d.items) ? d.items : []).filter(Boolean).map((it) => ({
        id: text(it.id),
        accessory: text(it.accessory) || 'Item',
        qty: Math.max(Number(it.qty) || 1, 1),
        // The app's own rule, as its Accessories page counts: 'give' is ours to give, anything else theirs to give us.
        dir: it.direction === 'give' ? 'give' : 'get',
        done: it.status === 'done',
      }));
      const settlements = settled.rows
        .filter((s) => s.data?.txId === r.source_id)
        .map((s) => {
          const sd = s.data || {};
          const which = new Set((Array.isArray(sd.itemIds) ? sd.itemIds : []).map(String));
          return {
            id: s.id,
            at: iso(sd.ts) || iso(sd.date),
            dir: sd.direction === 'give' ? 'give' : 'get',
            items: items.filter((it) => which.has(it.id)).map((it) => (it.qty > 1 ? `${it.accessory} × ${it.qty}` : it.accessory)),
            notes: text(sd.notes),
            ...picturesOf(sd),
          };
        })
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      return {
        id: r.id,
        date: dayOf(d.date) || iso(d.createdAt),
        type: d.type === 'sold' || d.type === 'bought' ? d.type : text(d.type),
        stock_no: text(d.stockNumber),
        brand: text(d.brand),
        reference: text(d.reference),
        notes: text(d.notes),
        client: people.get(text(d.clientId)) || null,
        items,
        pending: items.filter((it) => !it.done).length,
        total: items.length,
        settlements,
        watch: ourWatch(r),
      };
    })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.id - a.id);
}

/** The Transactions tab: every accessory transaction, and what its filters offer (the clients and countries in it). */
export async function transactionsList() {
  const { rows } = await query("SELECT * FROM logistics_items WHERE kind = 'transactions' AND deleted_at IS NULL");
  const transactions = await txViews(rows);
  const clients = new Map();
  for (const t of transactions) if (t.client) clients.set(t.client.lg_client_id, { id: t.client.lg_client_id, name: t.client.name, country: t.client.country });
  return {
    as_of: await asOf(),
    transactions,
    clients: [...clients.values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })),
    countries: [...new Set(transactions.map((t) => t.client?.country).filter(Boolean))].sort(),
  };
}

/*
 * The logistics app's Accessories Management page (asked 26 Oct 2026),
 * counted as it counts: every PENDING transaction item, by its quantity —
 * ours to give when its direction is 'give', the client's to give us
 * otherwise; by accessory exactly as typed ("Links" and "links" are two
 * lines there too); by brand (with how many transactions); and by client,
 * grouped by the client's country, one row per transaction and direction.
 * Same links as the Transactions tab. A transaction whose client the app
 * does not list is shown under "client not listed", not dropped.
 */
export async function accessoriesSummary() {
  const { rows } = await query("SELECT * FROM logistics_items WHERE kind = 'transactions' AND deleted_at IS NULL");
  const txs = await txViews(rows);
  const total = { give: 0, get: 0 };
  const byAcc = { give: new Map(), get: new Map() };
  const brands = new Map();
  const people = new Map();
  for (const t of txs) {
    const open = t.items.filter((it) => !it.done);
    if (!open.length) continue;
    const b = brands.get(t.brand) || brands.set(t.brand, { brand: t.brand, give: 0, get: 0, transactions: 0 }).get(t.brand);
    b.transactions += 1;
    const key = t.client ? `c${t.client.lg_client_id}` : 'none';
    const p = people.get(key) || people.set(key, { client: t.client, country: t.client?.country || '', give: 0, get: 0, items: 0, rows: [] }).get(key);
    for (const dir of ['give', 'get']) {
      const mine = open.filter((it) => it.dir === dir);
      if (!mine.length) continue;
      for (const it of mine) {
        total[dir] += it.qty;
        byAcc[dir].set(it.accessory, (byAcc[dir].get(it.accessory) || 0) + it.qty);
        b[dir] += it.qty;
        p[dir] += it.qty;
        p.items += 1;
      }
      p.rows.push({ id: t.id, dir, stock_no: t.stock_no, reference: t.reference, brand: t.brand, date: t.date, items: mine.map((it) => (it.qty > 1 ? `${it.accessory} × ${it.qty}` : it.accessory)), watch: t.watch });
    }
  }
  const ranked = (m) => [...m].map(([accessory, n]) => ({ accessory, n })).sort((a, b) => b.n - a.n || a.accessory.localeCompare(b.accessory));
  const countries = new Map();
  for (const p of people.values()) {
    const c = countries.get(p.country) || countries.set(p.country, { country: p.country, items: 0, clients: [] }).get(p.country);
    c.items += p.items;
    c.clients.push(p);
  }
  const nameOf = (p) => p.client?.name || '';
  return {
    as_of: await asOf(),
    give: { total: total.give, by_accessory: ranked(byAcc.give) },
    get: { total: total.get, by_accessory: ranked(byAcc.get) },
    by_brand: [...brands.values()].sort((a, b) => b.give + b.get - (a.give + a.get) || a.brand.localeCompare(b.brand)),
    by_country: [...countries.values()]
      .sort((a, b) => a.country.localeCompare(b.country))
      .map((c) => ({ ...c, clients: c.clients.sort((a, b) => Number(!a.client) - Number(!b.client) || nameOf(a).localeCompare(nameOf(b), 'en', { sensitivity: 'base' })) })),
  };
}

/*
 * The logistics app's Incomings page (asked 26 Oct 2026: "the same tab with
 * the same features"), its rules read from its own code: where a watch is
 * (`location`), who has it (`supplier`), where it is going (`inventoryDest`
 * — the firm answer — else the typed `destination`), its status, and what the
 * owner decided (the `ownerDecisions` record it names; none = still to
 * decide, or "not asked yet" for one picked from FOB). A row is history once
 * arrived, cancelled, shipped or taken into stock; its day received is the
 * stock row's `receivedAt` (the one people correct) else `arrivedAt`. Each
 * row linked to our watch and its clients, the typed client as far as it goes.
 * The grouping, counters and filters are the browser's, as in the app. The
 * app's buttons that change its records wait for the switch-over (asked).
 */
const OD_ACTIONS = {
  COLLECT: 'Collect', SHIP: 'Ship', HAND_CARRY: 'Hand carry', HOLD: 'Hold', SELL_LOCAL: 'Sell locally', COMBINE: 'Combine with others',
  RETURN: 'Return', WAIT_FOR_BOX: 'Wait for box', WAIT_FOR_DOCUMENTS: 'Wait for documents', CHANGE_DESTINATION: 'Change destination',
  REVIEW_LATER: 'Review later', OTHER: 'Other',
};
const INC_DEST = { london: 'London', dubai: 'Dubai', hk: 'Hong Kong' };
/* The app's odDescribe: what was decided, in a line. */
const decisionWords = (d) =>
  [d.action && (OD_ACTIONS[d.action] || d.action), d.collector && `with ${d.collector}`, d.destination && `→ ${d.destination}`, d.reviewAt && `review ${d.reviewAt}`, d.holdUntil && `until ${d.holdUntil}`]
    .filter(Boolean)
    .join(' · ') || text(d.rawInstruction).slice(0, 60);

export async function incomingPage() {
  const [incQ, odQ, fobQ] = await Promise.all([
    query("SELECT * FROM logistics_items WHERE kind = 'incomings' AND deleted_at IS NULL"),
    query("SELECT source_id, data FROM logistics_items WHERE kind = 'ownerDecisions' AND deleted_at IS NULL AND source_id IS NOT NULL"),
    query("SELECT * FROM logistics_items WHERE kind = 'fobPicked' AND deleted_at IS NULL ORDER BY id"),
  ]);
  const decisions = new Map(odQ.rows.map((r) => [r.source_id, r.data || {}]));
  const nos = [...new Set([...incQ.rows, ...fobQ.rows].flatMap((r) => r.stock_nos || []))];
  const [ours, places, people] = await Promise.all([
    oursByNumber(nos),
    nos.length
      ? query("SELECT stock_nos, data->'receivedAt' AS received FROM logistics_items WHERE kind IN ('londonStock','dubaiStock','hkStock') AND deleted_at IS NULL AND stock_nos && $1::text[]", [nos])
      : { rows: [] },
    linksByName(incQ.rows.map((r) => r.data?.supplier)),
  ]);
  const receivedOf = new Map();
  for (const p of places.rows) {
    const t = Number(p.received);
    if (t) for (const s of p.stock_nos || []) if (!receivedOf.has(s)) receivedOf.set(s, t);
  }
  const watchOf = (r) => (r.stock_nos || []).map((s) => ours.get(s)).find(Boolean) || null;

  const rows = incQ.rows.map((r) => {
    const d = r.data || {};
    const od = d.ownerDecisionId ? decisions.get(String(d.ownerDecisionId)) : null;
    const received = (r.stock_nos || []).map((s) => receivedOf.get(s)).find(Boolean) || Number(d.arrivedAt) || null;
    return {
      id: r.id,
      stock_no: text(d.stockNumber),
      brand: text(d.brand),
      reference: text(d.reference),
      serial: text(d.serial),
      supplier: text(d.supplier),
      supplier_link: people.get(text(d.supplier)) || null,
      location: text(d.location),
      destination: INC_DEST[d.inventoryDest] || text(d.destination),
      status: text(d.status) || 'pending',
      eta: text(d.eta),
      notes: text(d.notes),
      shipped: Boolean(d.shipmentId),
      shipped_at: iso(d.shippedAt),
      in_stock: Boolean(d.inventoryId),
      received_at: received ? new Date(received).toISOString() : null,
      history: d.status === 'arrived' || d.status === 'cancelled' || Boolean(d.shipmentId) || Boolean(d.inventoryId),
      decision: od?.status ? { status: od.status, what: decisionWords(od) } : { status: d.fromFob ? 'NOT_ASKED' : 'DECISION_NEEDED', what: '' },
      created: Number(d.createdAt) || 0,
      ...picturesOf(d),
      watch: watchOf(r),
    };
  });
  const fob_picked = fobQ.rows.map((r) => {
    const d = r.data || {};
    return {
      id: r.id,
      stock_no: text(d.stockNumber),
      brand: text(d.brand),
      model: text(d.watchModel || d.model),
      reference: text(d.reference),
      serial: text(d.serial),
      supplier: text(d.supplier),
      buy_price: Number(d.buyPrice) || null,
      buy_currency: text(d.buyCurrency),
      destination: text(d.destination),
      eta: text(d.eta),
      watch: watchOf(r),
    };
  });
  return { as_of: await asOf(), rows, fob_picked };
}

/* A list as the app writes it: an array, or words split on commas and new lines. */
const listOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\n]+/)).map((x) => text(typeof x === 'object' && x ? x.name || x.accessory : x)).filter(Boolean);
const PLACE_OF = { londonStock: 'London', dubaiStock: 'Dubai', hkStock: 'Hong Kong', safeStock: 'our safe', hkSituation: 'the HK list' };

/*
 * A watch's accessories (asked 26 Oct 2026: "what is missing against that
 * watch and what we have"), from everything that says: Chrono Key's box,
 * papers, service papers and accessories (our record); what each place's
 * stock row says came with it and is missing; the transactions — what a
 * client still owes us, what we still owe a buyer, what was settled; and the
 * logistics app's To collect / To give lists. Each line says where it comes
 * from and opens that record.
 */
async function accessoriesOf(watchId, rows, transactions) {
  const { rows: w } = await query('SELECT box, papers, service_papers, accessories FROM watches WHERE id = $1', [watchId]);
  const live = rows.filter((r) => !r.deleted_at);
  const places = live
    .filter((r) => PLACE_OF[r.kind] && !['moved', 'sold'].includes(r.data?.status))
    .map((r) => ({ id: r.id, place: PLACE_OF[r.kind], present: listOf(r.data?.accessoriesPresent), missing: listOf(r.data?.accessoriesMissing) }))
    .filter((p) => p.present.length || p.missing.length);
  const label = (it) => (it.qty > 1 ? `${it.accessory} × ${it.qty}` : it.accessory);
  const fromTx = (dir, done) =>
    transactions.flatMap((t) => {
      const items = t.items.filter((it) => it.dir === dir && it.done === done).map(label);
      return items.length ? [{ id: t.id, items, client: t.client, type: t.type, date: t.date }] : [];
    });
  const list = (kind, who) =>
    live
      .filter((r) => r.kind === kind)
      .map((r) => ({ id: r.id, items: listOf(r.data?.items), who: text(r.data?.[who]), in_safe: kind === 'accGive' && ticked(r.data?.inSafe) !== '', notes: text(r.data?.notes) }));
  return {
    chrono_key: w[0] ? { box: w[0].box, papers: w[0].papers, service_papers: w[0].service_papers, accessories: text(w[0].accessories) } : null,
    places,
    owed_to_us: fromTx('get', false),
    we_owe: fromTx('give', false),
    received: fromTx('get', true),
    given: fromTx('give', true),
    to_collect: list('accCollect', 'fromClient'),
    to_give: list('accGive', 'toClient'),
  };
}

/*
 * The logistics app's Hand Carry plans (asked 26 Oct 2026; its kashanPlans):
 * a person's plan of stops, each with the watches delivered there (from Ready
 * for delivery, to the buyer typed on it), collected (incomings, from the
 * supplier) or moved (a place's stock). Same links as everywhere: each watch
 * to our watch of that number and through it to our clients (Chrono Key's
 * ids); the typed buyer or supplier to the logistics client of that name, and
 * to ours only as that one is (linksByName). Open plans first, then the
 * app's Plans History (completed). And what is waiting for one: Ready for
 * delivery not shipped, incomings pending or in transit (the app's own two
 * lists), each saying which open plan has it, if any.
 */
export async function handCarry() {
  const [plansQ, readyQ, incQ] = await Promise.all([
    query("SELECT * FROM logistics_items WHERE kind = 'kashanPlans' AND deleted_at IS NULL ORDER BY id"),
    query("SELECT * FROM logistics_items WHERE kind = 'readyForDelivery' AND deleted_at IS NULL AND COALESCE(data->>'status','') <> 'shipped' ORDER BY happened_at DESC NULLS LAST, id DESC"),
    query("SELECT * FROM logistics_items WHERE kind = 'incomings' AND deleted_at IS NULL AND data->>'status' IN ('pending', 'in_transit') ORDER BY happened_at DESC NULLS LAST, id DESC"),
  ]);
  const all = [...plansQ.rows, ...readyQ.rows, ...incQ.rows];
  const ours = await oursByNumber(all.flatMap((r) => r.stock_nos || []));
  const watchOf = (stock) => stockList(stock).map((s) => ours.get(s)).find(Boolean) || null;
  const typed = [];
  for (const p of plansQ.rows) {
    for (const leg of Array.isArray(p.data?.legs) ? p.data.legs : []) {
      for (const x of [...(leg?.deliveries || []), ...(leg?.collections || [])]) typed.push(x?.clientName, x?.supplier);
    }
  }
  const people = await linksByName([...typed, ...readyQ.rows.map((r) => r.data?.soldToBuyer), ...incQ.rows.map((r) => r.data?.supplier)]);
  const person = (name) => (text(name) ? { name: text(name), link: people.get(text(name)) || null } : null);

  const ITEM = {
    deliver: (x) => ({ who: person(x.clientName), place: text(x.clientCountry), source_id: text(x.readyId) }),
    collect: (x) => ({ who: person(x.supplier), place: text(x.country), source_id: text(x.incId) }),
    move: (x) => ({ who: null, place: text(x.fromLocation), source_id: text(x.stockId) }),
  };
  const plans = plansQ.rows.map((r) => {
    const d = r.data || {};
    const flights = new Map();
    const stops = (Array.isArray(d.legs) ? d.legs : []).map((leg, i) => {
      const l = leg || {};
      const items = Object.fromEntries(
        situation.PLAN_PARTS.map(([part, role]) => [
          role,
          (Array.isArray(l[part]) ? l[part] : []).map((x) => ({
            stock_no: text(x?.stockNumber),
            brand: text(x?.brand),
            model: text(x?.model),
            ...ITEM[role](x || {}),
            watch: watchOf(x?.stockNumber),
          })),
        ])
      );
      const cost = Number(l.flightCost) || 0;
      const currency = text(l.flightCostCurrency).toUpperCase();
      if (cost > 0) flights.set(currency, (flights.get(currency) || 0) + cost);
      return { n: i + 1, from: text(l.fromCity), to: text(l.toCity), date: dayOf(l.date), time: text(l.time), flight: text(l.flightInfo), cost: cost || null, currency, notes: text(l.notes), ...items };
    });
    const count = (role) => stops.reduce((a, s) => a + s[role].length, 0);
    return {
      id: r.id,
      name: text(d.name) || 'Plan',
      start: text(d.currentCity),
      notes: text(d.notes),
      completed: d.status === 'completed',
      completed_at: d.status === 'completed' ? iso(d.completedAt) : null,
      stops,
      counts: { stops: stops.length, deliver: count('deliver'), collect: count('collect'), move: count('move') },
      flights: [...flights].map(([currency, amount]) => ({ currency, amount: Math.round(amount * 100) / 100 })),
      locked: (r.locked_fields || []).length > 0,
    };
  });

  // Which open plan carries a waiting row: by the row's own id, as the app assigns it.
  const onPlan = new Map();
  for (const p of plans.filter((x) => !x.completed)) {
    for (const s of p.stops) for (const x of [...s.deliver, ...s.collect]) if (x.source_id && !onPlan.has(x.source_id)) onPlan.set(x.source_id, { id: p.id, name: p.name, stop: s.n, to: s.to });
  }
  const waiting = (r, who, model, place) => {
    const d = r.data || {};
    return { id: r.id, stock_no: text(d.stockNumber), brand: text(d.brand), model, who: person(who), place, on_plan: onPlan.get(text(r.source_id)) || null, watch: watchOf(d.stockNumber) };
  };
  return {
    as_of: await asOf(),
    plans: plans.filter((p) => !p.completed),
    history: plans.filter((p) => p.completed).sort((a, b) => String(b.completed_at || '').localeCompare(String(a.completed_at || '')) || b.id - a.id),
    waiting: {
      deliver: readyQ.rows.map((r) => waiting(r, r.data?.soldToBuyer, text(r.data?.watchModel || r.data?.watchReference), text(r.data?.soldFromLocation))),
      collect: incQ.rows.map((r) => waiting(r, r.data?.supplier, text(r.data?.reference || r.data?.model), text(r.data?.location || r.data?.inventoryDest))),
    },
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
    // Only changes a person can read — the carrier's answers and timestamps are left out here, in the query, so a
    // busy stretch of tracking cannot push every real change out of the window — and without the records' data.
    query(
      `SELECT e.at, e.source, e.action, (e.changes - $1::text[]) AS changes, u.name AS user_name, e.item_id
         FROM logistics_events e LEFT JOIN users u ON u.id = e.user_id
        WHERE (e.action <> 'create' OR e.source = 'user')
          AND (e.action NOT IN ('sync', 'update', 'unlock')
               OR EXISTS (SELECT 1 FROM jsonb_object_keys(e.changes) k WHERE k NOT IN ('back', 'gone') AND k !~ $2 AND k !~ $3))
        ORDER BY e.at DESC, e.id DESC LIMIT 400`,
      [QUIET_LIST, QUIET_NAMES.source, QUIET_TIMES.source]
    ),
    asOf(),
  ]);
  const withStage = (r) => ({ ...view(r, ctx), stage: situation.stage(r.data).key, late: lateSince(r.data) });
  const [dash, polish] = await Promise.all([dashboard(), needPolish(ctx)]);
  // Fresh: read, or found unchanged, within three of the minute checks (with them off: within one and a half 15-minute passes).
  const freshMs = (config.logistics.pollSec > 0 ? Math.max(3 * config.logistics.pollSec, 180) : 1.5 * Math.max(5, config.sync.intervalMin) * 60) * 1000;
  return {
    as_of: at,
    fresh: Boolean(at && Date.now() - new Date(at).getTime() < freshMs),
    ...dash,
    need_polish: await withWatches(polish),
    // The late ones first.
    shipments: await withWatches(
      shipments.rows
        .filter((r) => situation.shipmentOpen(r.data))
        .map(withStage)
        .sort((a, b) => (b.late ? 1 : 0) - (a.late ? 1 : 0))
    ),
    ready: await withWatches(ready.rows.map((r) => view(r, ctx))),
    incoming: await withWatches(incoming.rows.map((r) => view(r, ctx))),
    places: counts.rows.map((r) => ({ ...r, label: kindOf(r.kind).label })),
    recent: await latestChanges(recent.rows, ctx),
  };
}

/*
 * The Overview's latest changes, as a person reads them: one line per record
 * (its newest change, and how many before it), only what changed in words —
 * not the carrier's raw answers, timestamps, pictures or lists inside the
 * record, and not a blank turning into another blank. A copy that changed
 * nothing readable is left out. (Asked 24 Oct 2026: "easy to understand".)
 */
const QUIET_LIST = ['fedex', 'dhl', 'ups', 'aramex', 'photos', 'receivingPhotos', 'vaultPhotos', 'files', 'movements', 'history', 'polishHistory', '_key'];
const QUIET_NAMES = new RegExp(`^(${QUIET_LIST.join('|')})$`);
const QUIET_TIMES = /(^createdAt|^updatedAt|UpdatedAt|^ts)$/;
const blankValue = (v) => v === null || v === undefined || v === '';
// A block of details inside the record (a polish, a consignment) is named, not shown: "(details)".
const scalar = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? '(details)' : v);
export function readableChanges(changes) {
  const out = {};
  for (const [k, pair] of Object.entries(changes || {})) {
    if (k === 'back' || k === 'gone' || QUIET_NAMES.test(k) || QUIET_TIMES.test(k) || !Array.isArray(pair)) continue;
    const [a, b] = pair.map(scalar);
    if (Array.isArray(a) || Array.isArray(b)) continue;
    if (blankValue(a) && blankValue(b)) continue;
    if (a === b) continue;
    out[k] = [a ?? null, b ?? null];
  }
  return out;
}

async function latestChanges(rows, ctx, limit = 12) {
  const byItem = new Map();
  for (const r of rows) {
    const changes = readableChanges(r.changes);
    if (['sync', 'update', 'unlock'].includes(r.action) && !Object.keys(changes).length) continue;
    const seen = byItem.get(r.item_id);
    if (seen) {
      seen.earlier += 1;
      continue;
    }
    if (byItem.size >= limit) continue;
    byItem.set(r.item_id, { at: r.at, source: r.source, action: r.action, changes, user_name: r.user_name, earlier: 0 });
  }
  if (!byItem.size) return [];
  const { rows: items } = await query('SELECT * FROM logistics_items WHERE id = ANY($1)', [[...byItem.keys()]]);
  const views = await withWatches(items.map((r) => view(r, ctx)));
  const byId = new Map(views.map((v) => [v.id, v]));
  return [...byItem.entries()].filter(([id]) => byId.has(id)).map(([id, c]) => ({ ...c, item: byId.get(id) }));
}

const RATE_TARGETS = ['USD', 'EUR', 'GBP', 'AED', 'HKD', 'CHF'];

const todayUtc = () => {
  const t = new Date();
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
};

/*
 * A shipment past its delivery day — the Overview's Late count and the rows it
 * marks, by one rule: pending or in transit, and the day it was due (as the
 * app writes it, YYYY-MM-DD, or day first, DD/MM/YYYY) is before today.
 * Anything else ("Oct 30", typed here) is no date to be late against: guessed,
 * it lands in 2001. Returns the due day, or null.
 */
export function lateSince(d, todayAt = todayUtc()) {
  if (d?.status !== 'pending' && d?.status !== 'in_transit') return null;
  const due = String(d.deliveryDate ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(due) && !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(due)) return null;
  const t = situation.when(due);
  return t !== null && t < todayAt ? new Date(t).toISOString().slice(0, 10) : null;
}

/*
 * The converter's rates, without holding the Overview up: a rate source that
 * is slow or failing (8 s each, two of them) gets a second and a half, then the
 * last table the Overview had is used, marked not fresh — or none, the first
 * time. The fetch carries on, and the next minute's refresh has it.
 */
let lastRates = null;
async function ratesSoon(waitMs = 1500) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(lastRates && { ...lastRates, stale: true }), waitMs);
    timer.unref?.();
  });
  const fresh = getRates().then(
    (r) => (lastRates = r),
    () => lastRates && { ...lastRates, stale: true }
  );
  try {
    return await Promise.race([fresh, late]);
  } finally {
    clearTimeout(timer);
  }
}

/*
 * The logistics app's dashboard, figure for figure (its renderDashboard):
 *   shipments  in motion = pending or in transit; delivered = delivered (all
 *              time); delayed = in motion past its delivery date; ready for
 *              delivery = sold, awaiting handover. The donut: delivered, in
 *              progress, delayed.
 *   accessories  pending items on accessory transactions: to give, and owed
 *              to us (the app's other direction), counted by quantity
 *   costs      every logistic cost, by currency (a cost with none is the
 *              app's OTHER), how many lines; and in one currency at the
 *              converter's rates — not the app's fixed table. A currency
 *              with no rate is left out and named.
 */
async function dashboard() {
  const [ships, txs, costRows] = await Promise.all([
    query("SELECT data->>'status' AS status, data->>'deliveryDate' AS due FROM logistics_items WHERE kind = 'shipments' AND deleted_at IS NULL"),
    query("SELECT data->'items' AS items FROM logistics_items WHERE kind = 'transactions' AND deleted_at IS NULL"),
    query("SELECT data->>'currency' AS currency, data->>'amount' AS amount FROM logistics_items WHERE kind = 'logisticCosts' AND deleted_at IS NULL"),
  ]);
  const todayAt = todayUtc();
  const active = ships.rows.filter((s) => s.status === 'pending' || s.status === 'in_transit');
  const delivered = ships.rows.filter((s) => s.status === 'delivered').length;
  const delayed = active.filter((s) => lateSince({ status: s.status, deliveryDate: s.due }, todayAt)).length;
  const { rows: readyRows } = await query("SELECT count(*)::int AS n FROM logistics_items WHERE kind = 'readyForDelivery' AND deleted_at IS NULL");

  let give = 0;
  let owed = 0;
  for (const { items } of txs.rows) {
    for (const it of Array.isArray(items) ? items : []) {
      if (it?.status !== 'pending') continue;
      const qty = Number(it.qty) || 1;
      if (it.direction === 'give') give += qty;
      else owed += qty;
    }
  }

  const byCurrency = {};
  for (const c of costRows.rows) {
    const cur = /^[A-Za-z]{3,4}$/.test(c.currency || '') ? c.currency.toUpperCase() : 'OTHER';
    byCurrency[cur] ||= { amount: 0, count: 0 };
    byCurrency[cur].amount += Number(c.amount) || 0;
    byCurrency[cur].count += 1;
  }
  for (const v of Object.values(byCurrency)) v.amount = Math.round(v.amount * 100) / 100;
  let rates = null;
  const r = await ratesSoon();
  if (r) {
    const want = new Set([...Object.keys(byCurrency), ...RATE_TARGETS]);
    rates = { kind: r.kind, stale: Boolean(r.stale), table: Object.fromEntries([...want].filter((c) => r.rates[c]).map((c) => [c, r.rates[c]])) };
  }
  return {
    deliveries: { in_motion: active.length, delivered, delayed, in_progress: active.length - delayed, ready: readyRows[0].n },
    accessories: { give, owed },
    costs: { by_currency: byCurrency, rates, targets: RATE_TARGETS },
  };
}

/*
 * Watches flagged for polish (the app's Need Polish list): a London, Dubai or
 * HK stock row marked "needs polish" — the moved copies a move leaves behind
 * left out — and HK situation rows whose description or notes say so. A row
 * at polish carries who has it and since when.
 */
async function needPolish(ctx) {
  const { rows } = await query(
    `SELECT * FROM logistics_items
      WHERE deleted_at IS NULL AND (
            (kind IN ('londonStock','dubaiStock','hkStock') AND data->>'needPolish' = 'true'
              AND COALESCE(data->>'status','current') <> 'moved')
         OR (kind = 'hkSituation' AND (COALESCE(data->>'description','') || ' ' || COALESCE(data->>'notes','')) ~* 'needs?\\s*polish'))
      ORDER BY kind, id`
  );
  const where = (d, kind) =>
    kind === 'londonStock'
      ? d.inMayfair ? 'Mayfair' : d.inNcl ? 'NCL' : 'London'
      : kind === 'dubaiStock'
        ? d.inOffice ? 'Dubai office' : d.inSafe ? 'Dubai safe' : 'Dubai'
        : kind === 'hkStock'
          ? 'Hong Kong'
          : `HK — ${String(d.section || '').replace(/_/g, ' ')}`;
  return rows.map((r) => {
    const d = r.data || {};
    return {
      ...view(r, ctx),
      source: kindOf(r.kind).label,
      reference: d.watchReference || d.reference || '',
      model: d.watchModel || d.description || '',
      from: d.from || d.holder || '',
      place: where(d, r.kind),
      polish: d.polish && d.polish.status !== 'done' ? { sentTo: d.polish.sentTo || '', sentDate: d.polish.sentDate || '' } : null,
      can_polish: r.kind !== 'hkSituation',
    };
  });
}

/* ── files ───────────────────────────────────────────────────────── */

/**
 * A picture or PDF a record names on the worker's /photos/, shown before the
 * pass has copied it: copied now, kept, and served like the rest. Only an
 * address on the worker that some record names — not any address a request
 * brings.
 */
export async function workerFile(url, { thumb = false } = {}) {
  const prefix = photoPrefix();
  if (!prefix || typeof url !== 'string' || !url.startsWith(prefix) || url.length > 1000) return null;
  const { rows } = await query("SELECT 1 FROM logistics_items WHERE data::text LIKE '%' || $1 || '%' LIMIT 1", [JSON.stringify(url).slice(1, -1)]);
  if (!rows.length) return null;
  const id = await copyWorkerFile(url);
  return id ? file(id, { thumb }) : null;
}

/* A document's tile among the pictures: a PDF has no thumbnail of its own. */
const PDF_TILE = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240"><rect width="240" height="240" fill="#f0ece4"/>' +
    '<text x="120" y="135" font-family="Arial, sans-serif" font-size="44" font-weight="700" fill="#a3332b" text-anchor="middle">PDF</text></svg>'
);

export async function file(fid, { thumb = false } = {}) {
  const { rows } = await query('SELECT * FROM logistics_files WHERE id = $1', [Number(fid) || 0]);
  const f = rows[0];
  if (!f) return null;
  if (thumb && !f.thumb_key && f.content_type === 'application/pdf') return { buffer: PDF_TILE, type: 'image/svg+xml' };
  const key = thumb && f.thumb_key ? f.thumb_key : f.storage_key;
  const buffer = await (await storage()).get(key);
  if (!buffer) return null;
  return { buffer, type: thumb && f.thumb_key ? 'image/jpeg' : f.content_type };
}
