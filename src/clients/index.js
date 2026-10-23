import { query, tx } from '../db/index.js';
import { displayTitle } from '../watches/fields.js';
import { logEvent } from '../watches/index.js';
import { markGone, settleClients } from '../import/gone.js';

/*
 * Clients: who a watch was bought from and who it was sold to.
 *
 * Copied from Chrono Key's client list (`/User/ClientList`), editable here,
 * with the same rule as a watch: until the switch-over Chrono Key's list
 * replaces what we hold, except a field somebody edited here, which is locked
 * (clients.locked_fields) and never overwritten.
 *
 * A watch is tied to its clients by Chrono Key's own ids — the product grid
 * names both sides of every deal (clientId = bought from, soldToId = sold to)
 * — never by matching names: 8 names are on more than one client, and the
 * typed "Purchased from" often differs from the client's name ("EVALUMASA
 * (DieGO GIMINEZ)" is the client "DieGO GIMINEZ").
 */

export const CLIENT_TYPES = [
  { key: 'dealer', label: 'Dealer' },
  { key: 'retail', label: 'Retail' },
  { key: 'retail_company', label: 'Retail company' },
];

export const CLIENT_FIELDS = [
  { key: 'forename', label: 'Forename', type: 'text' },
  { key: 'surname', label: 'Surname', type: 'text' },
  { key: 'nickname', label: 'Nickname', type: 'text' },
  { key: 'type', label: 'Type', type: 'enum', options: ['', ...CLIENT_TYPES.map((t) => t.key)] },
  { key: 'company', label: 'Company', type: 'text' },
  { key: 'company_number', label: 'Company number', type: 'text' },
  { key: 'email', label: 'Email', type: 'text' },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'address', label: 'Address', type: 'longtext' },
  { key: 'country', label: 'Country', type: 'text' },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];
const CLIENT_FIELD = Object.fromEntries(CLIENT_FIELDS.map((f) => [f.key, f]));

/* A watch's two client links, as they are named in watches.locked_fields. */
export const LINKS = {
  purchase: { column: 'purchased_from_client_id', lock: 'purchased_from_client', gridKey: 'clientId' },
  sale: { column: 'sold_to_client_id', lock: 'sold_to_client', gridKey: 'soldToId' },
};

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const notFound = () => Object.assign(new Error('No such client'), { status: 404 });

function cleanClient(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const f = CLIENT_FIELD[k];
    if (!f) throw bad(`Unknown field: ${k}`);
    const s = v === null || v === undefined ? '' : String(v).trim();
    if (f.type === 'enum' && !f.options.includes(s)) throw bad(`${f.label}: "${s}" is not one of ${f.options.filter(Boolean).join(', ')}`);
    out[k] = s.slice(0, f.type === 'longtext' ? 5000 : 300);
  }
  return out;
}

/** "Rashid Mohammed Zain", else the nickname or the company. */
export function clientName(c) {
  if (!c) return '';
  return [c.forename, c.surname].filter(Boolean).join(' ').trim() || c.nickname || c.company || 'Unnamed client';
}

/* ── reading ─────────────────────────────────────────────────────── */

/**
 * A page of clients, searched by name, nickname, company, email or phone
 * (a phone is compared by its digits, so "+971 50" finds "0097150…"), with how
 * many watches each has sold us and bought.
 */
export async function listClients(opts = {}) {
  const { q = '', type = '' } = opts;
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const offset = Math.max(Number(opts.offset) || 0, 0);
  const where = ['c.deleted_at IS NULL'];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replaceAll('$?', `$${params.length}`));
  };
  for (const word of String(q).trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
    const digits = word.replace(/\D/g, '');
    params.push(word);
    const w = `$${params.length}`;
    let phone = '';
    if (digits.length >= 4) {
      params.push(digits);
      phone = ` OR regexp_replace(c.phone, '\\D', '', 'g') LIKE '%'||$${params.length}||'%'`;
    }
    where.push(
      `(c.forename ILIKE '%'||${w}||'%' OR c.surname ILIKE '%'||${w}||'%' OR c.nickname ILIKE '%'||${w}||'%'
        OR c.company ILIKE '%'||${w}||'%' OR c.email ILIKE '%'||${w}||'%' OR c.notes ILIKE '%'||${w}||'%'${phone})`
    );
  }
  const counts = await query(
    `SELECT c.type AS k, count(*)::int AS n FROM clients c WHERE ${where.join(' AND ')} GROUP BY 1 ORDER BY 2 DESC`,
    params
  );
  if (type) add('c.type = $?', type);
  params.push(limit, offset);
  const { rows } = await query(
    `SELECT c.*, count(*) OVER()::int AS total,
            (SELECT count(*)::int FROM watches w WHERE w.purchased_from_client_id = c.id AND w.deleted_at IS NULL) AS bought,
            (SELECT count(*)::int FROM watches w WHERE w.sold_to_client_id = c.id AND w.deleted_at IS NULL) AS sold,
            (SELECT max(d) FROM (
               SELECT w.purchase_date AS d FROM watches w WHERE w.purchased_from_client_id = c.id AND w.deleted_at IS NULL
               UNION ALL
               SELECT w.sale_date FROM watches w WHERE w.sold_to_client_id = c.id AND w.deleted_at IS NULL) x) AS last_deal
       FROM clients c WHERE ${where.join(' AND ')}
      ORDER BY last_deal DESC NULLS LAST, lower(c.forename), lower(c.surname), c.id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return {
    total: rows[0]?.total ?? 0,
    clients: rows.map((c) => ({
      id: c.id,
      name: clientName(c),
      nickname: c.nickname,
      type: c.type,
      company: c.company,
      email: c.email,
      phone: c.phone,
      country: c.country,
      bought: c.bought,
      sold: c.sold,
      last_deal: c.last_deal,
      origin: c.origin,
    })),
    types: counts.rows,
  };
}

const watchLine = (w) => ({
  id: w.id,
  stock_no: w.stock_no,
  title: displayTitle(w),
  reference: w.reference,
  serial: w.serial,
  status: w.status,
  location: w.location,
  purchase_date: w.purchase_date,
  purchase_price: w.purchase_price,
  purchase_currency: w.purchase_currency,
  sale_date: w.sale_date,
  sale_price: w.sale_price,
  sale_currency: w.sale_currency,
  sale_price_eur: w.sale_price_eur,
  photo_id: w.photo_id,
});

/** One client, and every watch bought from them or sold to them, newest first. */
export async function getClient(id) {
  const { rows } = await query('SELECT * FROM clients WHERE id = $1', [Number(id) || 0]);
  const c = rows[0];
  if (!c) throw notFound();
  const watchesBy = (column, date) =>
    query(
      `SELECT w.*, (SELECT p.id FROM watch_photos p WHERE p.watch_id = w.id AND p.deleted_at IS NULL
                     ORDER BY p.sort, p.id LIMIT 1) AS photo_id
         FROM watches w WHERE w.${column} = $1 AND w.deleted_at IS NULL
        ORDER BY w.${date} DESC NULLS LAST, w.id DESC`,
      [c.id]
    );
  const [bought, sold] = await Promise.all([
    watchesBy('purchased_from_client_id', 'purchase_date'),
    watchesBy('sold_to_client_id', 'sale_date'),
  ]);
  return { ...c, name: clientName(c), bought: bought.rows.map(watchLine), sold: sold.rows.map(watchLine) };
}

/** A watch's two clients, for its page: { purchase: {id, name, locked}, sale: … }. */
export async function linksOf(w) {
  const names = await namesOf({ query }, [w.purchased_from_client_id, w.sold_to_client_id]);
  const one = (link) => ({
    id: w[link.column] ?? null,
    name: w[link.column] ? names[w[link.column]] ?? '' : '',
    locked: w.locked_fields.includes(link.lock),
  });
  return { purchase: one(LINKS.purchase), sale: one(LINKS.sale) };
}

/* ── changing ─────────────────────────────────────────────────────── */

async function logClient(db, clientId, { userId = null, source = 'user', action, changes = {} }) {
  await db.query('INSERT INTO client_events(client_id, user_id, source, action, changes) VALUES ($1, $2, $3, $4, $5)', [
    clientId,
    userId,
    source,
    action,
    changes,
  ]);
}

export async function createClient(data, user) {
  const values = cleanClient(data);
  if (!(values.forename || values.surname || values.nickname || values.company)) {
    throw bad('A client needs a name, a nickname or a company');
  }
  const keys = Object.keys(values);
  return tx(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO clients(${keys.join(', ')}, origin) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, 'manual') RETURNING id`,
      keys.map((k) => values[k])
    );
    await logClient(db, rows[0].id, { userId: user?.id, action: 'create', changes: values });
    return rows[0].id;
  });
}

/** Edits a client. A field changed on a client copied from Chrono Key is LOCKED against the sync. */
export async function updateClient(id, patch, user) {
  const values = cleanClient(patch);
  return tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM clients WHERE id = $1 FOR UPDATE', [Number(id) || 0]);
    const c = rows[0];
    if (!c) throw notFound();
    const changes = {};
    for (const [k, v] of Object.entries(values)) if ((c[k] ?? '') !== v) changes[k] = [c[k], v];
    const keys = Object.keys(changes);
    if (!keys.length) return { changed: [] };
    const locks = c.origin === 'manual' ? c.locked_fields : [...new Set([...c.locked_fields, ...keys])];
    await db.query(
      `UPDATE clients SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, locked_fields = $${keys.length + 1},
              updated_at = now() WHERE id = $${keys.length + 2}`,
      [...keys.map((k) => values[k]), locks, c.id]
    );
    await logClient(db, c.id, { userId: user?.id, action: 'update', changes });
    return { changed: keys };
  });
}

/**
 * Who a watch was bought from (`role` 'purchase') or sold to ('sale').
 *
 * `clientId` a client, or null for none: the link is then LOCKED, so the sync
 * does not put Chrono Key's back. `'chronokey'` hands it back — unlocked and
 * set at once to what Chrono Key's grid says.
 */
export async function linkWatch(watchId, role, clientId, user) {
  const link = LINKS[role];
  if (!link) throw bad('Say purchase or sale');
  return tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM watches WHERE id = $1 FOR UPDATE', [Number(watchId) || 0]);
    const w = rows[0];
    if (!w) throw Object.assign(new Error('No such watch'), { status: 404 });

    let next;
    let locks;
    if (clientId === 'chronokey') {
      next = await gridClient(db, w.stock_no, link.gridKey);
      locks = w.locked_fields.filter((f) => f !== link.lock);
    } else {
      next = clientId === null ? null : Number(clientId) || 0;
      if (next !== null) {
        const { rows: c } = await db.query('SELECT id FROM clients WHERE id = $1 AND deleted_at IS NULL', [next]);
        if (!c[0]) throw notFound();
      }
      locks = w.origin === 'manual' ? w.locked_fields : [...new Set([...w.locked_fields, link.lock])];
    }
    await db.query(`UPDATE watches SET ${link.column} = $1, locked_fields = $2, updated_at = now() WHERE id = $3`, [
      next,
      locks,
      w.id,
    ]);
    if (w[link.column] !== next || clientId === 'chronokey') {
      const names = await namesOf(db, [w[link.column], next]);
      await logEvent(db, w.id, {
        userId: user?.id,
        action: clientId === 'chronokey' ? 'unlock' : 'update',
        changes: clientId === 'chronokey' ? { field: link.lock } : { [link.lock]: [names[w[link.column]] ?? null, names[next] ?? null] },
      });
    }
    return { client_id: next };
  });
}

/* What Chrono Key's grid, as last read, names for one side of a watch. */
async function gridClient(db, stockNo, gridKey) {
  const { rows } = await db.query(
    `SELECT c.id FROM ck_records r JOIN clients c ON c.ck_id = r.list_row->>$2 WHERE r.stock_no = $1`,
    [stockNo, gridKey]
  );
  return rows[0]?.id ?? null;
}

async function namesOf(db, ids) {
  const want = ids.filter((x) => x !== null && x !== undefined);
  if (!want.length) return {};
  const { rows } = await db.query('SELECT * FROM clients WHERE id = ANY($1)', [want]);
  return Object.fromEntries(rows.map((c) => [c.id, clientName(c)]));
}

/* ── from Chrono Key ──────────────────────────────────────────────── */

const t = (v) => (v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim());
const TYPE_OF = { D: 'dealer', I: 'retail' };

/** One row of Chrono Key's client list → our fields. Its page shows any type but D and I as "Retail-Company". */
export function fromChronoKey(r) {
  const address = [r.billAddress1, r.billAddress2, [r.billZipCode, r.billCity].map(t).filter(Boolean).join(' '), r.billStateProvince]
    .map(t)
    .filter(Boolean)
    .join('\n');
  return {
    forename: t(r.firstName),
    surname: t(r.lastName),
    nickname: t(r.nickName),
    type: TYPE_OF[r.clientType] || (t(r.clientType) ? 'retail_company' : ''),
    company: t(r.companyName),
    company_number: t(r.companyNumber),
    email: t(r.email),
    phone: t(r.phoneNumber) || t(r.billPhoneNumber),
    address,
    country: t(r.billCountryName) || t(r.billCountry),
  };
}

/**
 * Chrono Key's client list → ck_clients and clients, then every watch's two
 * links from the grid. Fields edited here are left alone; a client no longer
 * on the list is kept (a deal still names them).
 */
export async function applyClientList(db, rows, { mirror = false } = {}) {
  const stats = { clients: rows.length, created: 0, updated: 0, unchanged: 0 };
  const { rows: held } = await db.query('SELECT * FROM clients WHERE ck_id IS NOT NULL');
  const byCk = new Map(held.map((c) => [c.ck_id, c]));
  for (const r of rows) {
    const ckId = t(r.id);
    if (!ckId) continue;
    const fields = { ...fromChronoKey(r), active: r.isActive !== false };
    const c = byCk.get(ckId);
    let clientId;
    if (!c) {
      const keys = Object.keys(fields);
      const { rows: ins } = await db.query(
        `INSERT INTO clients(ck_id, ${keys.join(', ')}, origin) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}, 'chronokey')
         RETURNING id`,
        [ckId, ...keys.map((k) => fields[k])]
      );
      clientId = ins[0].id;
      await logClient(db, clientId, { source: 'chronokey', action: 'create', changes: fields });
      stats.created += 1;
    } else {
      clientId = c.id;
      const changes = {};
      for (const [k, v] of Object.entries(fields)) if (!c.locked_fields.includes(k) && c[k] !== v) changes[k] = [c[k], v];
      const keys = Object.keys(changes);
      if (keys.length) {
        await db.query(
          `UPDATE clients SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}, updated_at = now() WHERE id = $${keys.length + 1}`,
          [...keys.map((k) => fields[k]), clientId]
        );
        await logClient(db, clientId, { source: 'chronokey', action: 'sync', changes });
        stats.updated += 1;
      } else stats.unchanged += 1;
    }
    await db.query(
      `INSERT INTO ck_clients(ck_id, data, fetched_at, client_id) VALUES ($1, $2, now(), $3)
       ON CONFLICT (ck_id) DO UPDATE SET data = EXCLUDED.data, fetched_at = now(), client_id = EXCLUDED.client_id`,
      [ckId, r, clientId]
    );
  }
  Object.assign(stats, await linkWatchesToClients(db));
  // A client gone from the list (deleted, or merged into another) — kept while a watch still names it.
  if (mirror) {
    stats.goneFromList = await markGone(db, 'ck_clients', 'ck_id', rows.map((r) => t(r.id)).filter(Boolean));
    stats.clientsGone = await settleClients(db);
  }
  return stats;
}

/**
 * Every watch's "bought from" and "sold to" set to the clients Chrono Key's
 * grid names — except a link changed here (locked). A grid row naming no
 * buyer clears the sale's link: a sale taken back on Chrono Key is taken back
 * here, as the list does with the deal itself.
 */
export async function linkWatchesToClients(db) {
  const { rows } = await db.query(
    `SELECT w.id, w.locked_fields, w.purchased_from_client_id, w.sold_to_client_id,
            r.list_row ? 'clientId' AS has_ids,
            (SELECT c.id FROM clients c WHERE c.ck_id = r.list_row->>'clientId') AS bought_from,
            (SELECT c.id FROM clients c WHERE c.ck_id = r.list_row->>'soldToId') AS sold_to
       FROM watches w JOIN ck_records r ON r.watch_id = w.id
      WHERE r.list_row IS NOT NULL`
  );
  let linked = 0;
  const names = {};
  const { rows: all } = await db.query('SELECT * FROM clients');
  for (const c of all) names[c.id] = clientName(c);
  for (const w of rows) {
    // A row from the CSV export carries no ids: nothing to say, nothing changed.
    if (!w.has_ids) continue;
    const changes = {};
    const sets = {};
    for (const [link, next] of [
      [LINKS.purchase, w.bought_from],
      [LINKS.sale, w.sold_to],
    ]) {
      if (w.locked_fields.includes(link.lock) || w[link.column] === next) continue;
      sets[link.column] = next;
      changes[link.lock] = [names[w[link.column]] ?? null, names[next] ?? null];
    }
    const keys = Object.keys(sets);
    if (!keys.length) continue;
    await db.query(`UPDATE watches SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1}`, [
      ...keys.map((k) => sets[k]),
      w.id,
    ]);
    await logEvent(db, w.id, { source: 'chronokey', action: 'sync', changes });
    linked += 1;
  }
  return { watchesLinked: linked };
}
