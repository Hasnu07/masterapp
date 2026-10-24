import { query, tx } from '../db/index.js';
import { parseMoney, realDate, displayTitle } from '../watches/fields.js';
import { storage } from '../storage/index.js';
import { getRates } from '../rates/index.js';
import { listWatches } from '../watches/index.js';
import { listClients } from '../clients/index.js';
import { config } from '../config.js';
import { lastLogisticsRead, stockFor, copyWorkerFile } from '../import/logistics/sync.js';
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
  return {
    as_of: at,
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
