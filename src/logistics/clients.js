import { query } from '../db/index.js';
import { clientName } from '../clients/index.js';
import { context, view, withWatches } from './index.js';
import * as situation from './situation.js';

/*
 * A client's logistics situation (asked 24 Oct 2026): "in the client tab add
 * their logistic situation as well … make a separate tab of clients in
 * logistics, linked with the master client tab, but it shows only the
 * logistic situation". So:
 *   - the Logistics → Clients tab: each logistics client and its situation
 *     alone, as the logistics app's own client page builds it
 *   - our client's page: everything, and that situation beside it
 *
 * Which of OUR clients a logistics client is — the logistics app keeps typed
 * names and its own ids, never a Chrono Key one — is worked out from the
 * watches ("these clients will have a watch stock against them, so you can
 * also match that to find the original client"): the stock numbers the
 * logistics app says were bought from or sold to that client, against who OUR
 * watches with those numbers were bought from and sold to (Chrono Key's ids).
 * A name decides only when no watch does, and only a full name that is one
 * client of ours. A person's choice (logistics_client_links) always wins.
 *
 * The logistics app ties its records to a client in two ways, and so does this:
 * by its client id (accessory transactions, shipments) and by the typed name
 * (incomings' supplier, the "sold to" of sales, a stock row's "bought from", a
 * consignment's "with", the safe's owner).
 */

const CLIENT_ID = "COALESCE(source_id, 'ma-' || id)";
const RECORD_KINDS = ['transactions', 'shipments', 'incomings', 'soldStocks', 'readyForDelivery', 'londonStock', 'dubaiStock', 'hkStock', 'safeStock'];
const PLACE_KINDS = ['londonStock', 'dubaiStock', 'hkStock'];

/* A name as compared here: lower case, no accents, punctuation or double spaces — "Rooh Ul Amin" is "rooh ul amin". Any script: "محمد العلي" stays itself. */
export const normName = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/* The logistics app's own locations ("Company · Dubai"): that is us, never a client of ours. */
const isUs = (d) => d?.isCompany === true || normName(d?.name) === 'company';

/*
 * A "client" that is only a place or a placeholder — the logistics app makes one
 * from a stock row's "bought from" ("HK"), or someone types "Need to confirm":
 * never linked on its own, only by a person (seen live, 24 Oct 2026).
 */
const NOT_A_PERSON = new Set(['hk', 'hong kong', 'dubai', 'london', 'uk', 'united kingdom', 'spain', 'switzerland', 'italy', 'mayfair', 'ncl', 'safe', 'office', 'need to confirm', 'unknown', 'tbc', 'tbd', 'client']);

/* Edit distance, for names typed two ways ("Victor" / "viktor", "Shouaib" / "suhaib"). */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/* Two names that could be one person typed two ways: one inside the other, or a word (or the whole) at most about half different. */
export function namesAlike(a, b) {
  const A = normName(a);
  const B = normName(b);
  if (!A || !B) return false;
  const ca = A.replace(/ /g, '');
  const cb = B.replace(/ /g, '');
  const near = (x, y) => 1 - editDistance(x, y) / Math.max(x.length, y.length) >= 0.5;
  if (Math.min(ca.length, cb.length) >= 3 && (ca.includes(cb) || cb.includes(ca))) return true;
  const ta = A.split(' ').filter((w) => w.length >= 3);
  const tb = B.split(' ').filter((w) => w.length >= 3);
  return ta.some((x) => tb.some((y) => near(x, y))) || near(ca, cb);
}

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/*
 * Everything the matching and the situations read, in one go — the logistics
 * clients, every record that names a client, our watches by stock number, our
 * clients' names, and what people decided. Each record is filed under the
 * logistics clients it names, with what it says about them. Kept until any of
 * it changes (a record edited, synced, deleted; a watch's client changed; a
 * link chosen): a few-bytes stamp says so, so a page never shows figures from
 * before an edit made a moment ago.
 */
let held = null;
export const forgetClientSnapshot = () => {
  held = null;
};
async function stamp() {
  const { rows } = await query(
    `SELECT concat_ws('|', (SELECT max(updated_at) FROM logistics_items), (SELECT count(*) FROM logistics_items),
                           (SELECT max(updated_at) FROM watches), (SELECT max(updated_at) FROM clients),
                           (SELECT max(at) FROM logistics_client_links), (SELECT count(*) FROM logistics_client_links)) AS s`
  );
  return rows[0].s;
}
async function snapshot() {
  const now = await stamp();
  if (held && held.stamp === now && Date.now() - held.at < 10 * 60_000) return held.snap;
  const [lc, recs, ws, cs, links] = await Promise.all([
    query(`SELECT id, source_id, ${CLIENT_ID} AS cid, data FROM logistics_items WHERE kind = 'clients' AND deleted_at IS NULL ORDER BY id`),
    // Newest first, so every list built from them comes out in the logistics app's order.
    query('SELECT * FROM logistics_items WHERE deleted_at IS NULL AND kind = ANY($1) ORDER BY happened_at DESC NULLS LAST, id DESC', [RECORD_KINDS]),
    query('SELECT id, stock_no, purchased_from_client_id AS bought_from, sold_to_client_id AS sold_to FROM watches WHERE deleted_at IS NULL'),
    query('SELECT id, forename, surname, nickname, company FROM clients WHERE deleted_at IS NULL'),
    // A person's link to a client of ours deleted since counts for nothing: the worked-out match shows instead.
    query('SELECT l.item_id, l.client_id FROM logistics_client_links l LEFT JOIN clients c ON c.id = l.client_id WHERE l.client_id IS NULL OR c.deleted_at IS NULL'),
  ]);
  const clients = lc.rows.map((r) => ({ id: r.id, cid: r.cid, data: r.data || {}, name: String(r.data?.name || '').trim(), us: isUs(r.data) }));
  const byCid = new Map(clients.map((c) => [c.cid, c]));
  const byName = new Map();
  for (const c of clients) {
    const n = normName(c.name);
    if (!n || c.us) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(c);
  }
  // Records per logistics client: [{ row, role }] — role says what the record is to them.
  const filed = new Map(clients.map((c) => [c.id, []]));
  const file = (c, row, role) => c && filed.get(c.id)?.push({ row, role });
  const fileByName = (name, row, role) => (byName.get(normName(name)) || []).forEach((c) => file(c, row, role));
  for (const row of recs.rows) {
    const d = row.data || {};
    switch (row.kind) {
      case 'transactions':
        file(byCid.get(String(d.clientId ?? '')), row, d.type === 'sold' ? 'sold' : 'bought');
        break;
      case 'shipments': {
        const from = byCid.get(String(d.fromClientId ?? ''));
        const to = byCid.get(String(d.toClientId ?? ''));
        file(from, row, 'ship_from');
        if (to !== from) file(to, row, 'ship_to');
        break;
      }
      case 'incomings':
        fileByName(d.supplier, row, d.status === 'consignment' ? 'consigned_in' : 'incoming');
        break;
      case 'soldStocks':
        fileByName(d.soldToBuyer, row, 'sold');
        break;
      case 'readyForDelivery':
        fileByName(d.soldToBuyer, row, 'awaiting');
        break;
      case 'safeStock':
        if ((d.status || 'current') === 'current') fileByName(d.from, row, 'in_safe');
        break;
      default:
        // A place's row: bought from whoever it names — and maybe on consignment: ours with a client, or a client's with us.
        if (d.status !== 'moved') fileByName(d.from, row, 'bought');
        if (d.status === 'consignment' && d.consignment?.with) fileByName(d.consignment.with, row, d.consignment.direction === 'from_client' ? 'consigned_in' : 'consigned_out');
    }
  }
  // What a watch arrived without, by stock number — its London row, else its Dubai row (as the app looks).
  const missingOf = new Map();
  for (const row of recs.rows) {
    if (row.kind !== 'londonStock' && row.kind !== 'dubaiStock') continue;
    const m = row.data?.accessoriesMissing;
    const list = (Array.isArray(m) ? m : String(m || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
    for (const s of row.stock_nos || []) {
      const had = missingOf.get(s);
      if (!had || (had.kind !== 'londonStock' && row.kind === 'londonStock')) missingOf.set(s, { kind: row.kind, list });
    }
  }
  const watchByStock = new Map(ws.rows.map((w) => [w.stock_no, w]));
  const ourNames = new Map(); // full name or company → our client ids
  const ourName = new Map();
  for (const c of cs.rows) {
    ourName.set(c.id, clientName(c));
    for (const n of new Set([`${c.forename || ''} ${c.surname || ''}`, c.company].map(normName).filter(Boolean))) {
      if (!ourNames.has(n)) ourNames.set(n, new Set());
      ourNames.get(n).add(c.id);
    }
  }
  const decided = new Map(links.rows.map((r) => [r.item_id, r.client_id]));
  const snap = { clients, byId: new Map(clients.map((c) => [c.id, c])), byName, filed, watchByStock, ourNames, ourName, decided, missingOf };
  for (const c of clients) c.match = matchOf(c, snap);
  held = { at: Date.now(), stamp: now, snap };
  return snap;
}

/*
 * Which of our clients this logistics client is, from the watches: each stock
 * number the logistics app ties to them is a vote for whoever OUR watch with
 * that number was bought from (a purchase, an incoming) or sold to (a sale). A
 * shipment only adds half a vote to a client the purchases and sales already
 * point at — never one on its own: whoever sends or receives a parcel is not
 * always the client (a forwarder in Belfast sent three watches bought from a
 * dealer in Spain). The winner needs twice the runner-up's votes. A full name
 * that is exactly one client of ours decides when no watch does — and stops a
 * winner with little evidence that another of ours carries the name.
 */
function matchOf(c, snap) {
  const words = normName(c.name).split(' ').filter(Boolean);
  const named = snap.ourNames.get(normName(c.name));
  const nameOne = named?.size === 1 ? [...named][0] : null;
  if (c.us) return { client_id: null, how: null, stocks: [], candidates: [] };
  const votes = new Map();
  const vote = (cid, stock, weight) => {
    if (!cid) return;
    if (!votes.has(cid)) votes.set(cid, { client_id: cid, score: 0, stocks: new Set() });
    const v = votes.get(cid);
    if (!v.stocks.has(stock)) {
      v.stocks.add(stock);
      v.score += weight;
    }
  };
  const shipped = [];
  for (const { row, role } of snap.filed.get(c.id) || []) {
    for (const s of row.stock_nos || []) {
      const w = snap.watchByStock.get(s);
      if (!w) continue;
      if (['bought', 'incoming', 'consigned_in'].includes(role)) vote(w.bought_from, s, 1);
      else if (['sold', 'awaiting'].includes(role)) vote(w.sold_to, s, 1);
      else if (role === 'ship_from' || role === 'ship_to') shipped.push([w, s]);
    }
  }
  for (const [w, s] of shipped) {
    for (const cid of [w.bought_from, w.sold_to]) if (votes.has(cid)) vote(cid, s, 0.5);
  }
  const ranked = [...votes.values()].sort((a, b) => b.score - a.score || b.stocks.size - a.stocks.size).map((v) => ({ ...v, stocks: [...v.stocks].sort() }));
  const candidates = ranked.slice(0, 3).map((v) => ({ client_id: v.client_id, name: snap.ourName.get(v.client_id) || '', stocks: v.stocks }));
  if (nameOne && !candidates.some((x) => x.client_id === nameOne)) candidates.push({ client_id: nameOne, name: snap.ourName.get(nameOne) || '', stocks: [], by_name: true });
  const [best, second] = ranked;
  // A place or a placeholder is not a person: suggested, never linked on its own.
  if (NOT_A_PERSON.has(normName(c.name))) return { client_id: null, how: null, stocks: [], candidates };
  if (best && (!second || best.score >= 2 * second.score)) {
    // A name that is another client of ours outweighs one or two watches.
    if (nameOne && nameOne !== best.client_id && best.score < 3) return { client_id: null, how: null, stocks: [], candidates };
    // One watch alone links only names that look alike (a polisher or a forwarder entered as a client shares one watch too).
    if (best.stocks.length === 1 && !namesAlike(c.name, snap.ourName.get(best.client_id) || '')) return { client_id: null, how: null, stocks: [], candidates };
    return { client_id: best.client_id, how: 'watches', stocks: best.stocks, candidates };
  }
  if (!best && nameOne && words.length >= 2) return { client_id: nameOne, how: 'name', stocks: [], candidates };
  return { client_id: null, how: null, stocks: [], candidates };
}

/* The link as shown: a person's choice, else the worked-out match. */
function linkOf(c, snap) {
  if (snap.decided.has(c.id)) {
    const id = snap.decided.get(c.id);
    return { client_id: id, client_name: id ? snap.ourName.get(id) || '' : '', how: 'person', stocks: [] };
  }
  const m = c.match;
  return { client_id: m.client_id, client_name: m.client_id ? snap.ourName.get(m.client_id) || '' : '', how: m.how, stocks: m.stocks };
}

/* ── the situation ─────────────────────────────────────────────── */

const qty = (it) => Math.max(Number(it?.qty) || 1, 1);
const pending = (it) => it && it.status === 'pending';

/*
 * What is still owed on a client's accessory transactions — their pending
 * items, grouped by watch as the app groups them — and, as the app adds, what
 * a watch bought from them arrived without (its London row, else its Dubai
 * row), unless that watch already has items owed. One rule for the Clients
 * list and the client's page, so the two never give different numbers.
 */
function owedOf(txRows, snap) {
  const weGive = [];
  const theyGive = [];
  const receiving = new Set();
  const bought = new Set();
  for (const row of txRows) {
    const d = row.data || {};
    const items = Array.isArray(d.items) ? d.items : [];
    const line = (list) => ({ tx: row.id, stock: String(d.stockNumber || ''), title: [d.brand, d.reference].filter(Boolean).join(' '), items: list.map((it) => ({ accessory: String(it.accessory || 'Item'), qty: qty(it) })) });
    const give = items.filter((it) => pending(it) && it.direction === 'give');
    const get = items.filter((it) => pending(it) && it.direction !== 'give');
    if (give.length) weGive.push(line(give));
    if (get.length) {
      theyGive.push(line(get));
      receiving.add(String(d.stockNumber || ''));
    }
    if (d.type !== 'sold') for (const s of row.stock_nos || []) bought.add(s);
  }
  const missing = [];
  for (const s of bought) {
    if (receiving.has(s)) continue;
    const m = snap.missingOf.get(s);
    if (m?.list.length) missing.push({ stock: s, items: m.list });
  }
  const sum = (lines) => lines.reduce((a, l) => a + l.items.reduce((b, it) => b + (typeof it === 'string' ? 1 : it.qty), 0), 0);
  return { we_give: weGive, they_give: theyGive, missing, give_n: sum(weGive), owed_n: sum(theyGive) + sum(missing) };
}

/*
 * The logistics situation of one or more logistics clients (more when two of
 * theirs are one client of ours: "Rooh Ul Amin" and "Rooh ul Amin"), the way the
 * logistics app's client page adds it up: the watches traded, what is with
 * them now, the accessories still owed either way, the shipments, what was
 * already given and collected.
 */
async function situationOf(cs, snap) {
  const ctx = await context();
  const seen = new Map(); // record id → { row, roles }
  for (const c of cs) {
    for (const { row, role } of snap.filed.get(c.id) || []) {
      if (!seen.has(row.id)) seen.set(row.id, { row, roles: new Set() });
      seen.get(row.id).roles.add(role);
    }
  }
  const all = [...seen.values()];
  const has = (r, ...roles) => roles.some((x) => r.roles.has(x));
  const txs = all.filter((r) => r.row.kind === 'transactions');
  const ships = all.filter((r) => r.row.kind === 'shipments');

  // Accessories still owed either way (the transactions' pending items, and what their watches arrived without);
  // and what was already given and collected, newest first.
  const owed = owedOf(txs.map((r) => r.row), snap);
  const history = [];
  for (const { row } of txs) {
    const d = row.data || {};
    for (const it of (Array.isArray(d.items) ? d.items : []).filter((x) => x && x.status === 'done')) {
      history.push({ tx: row.id, stock: String(d.stockNumber || ''), dir: it.direction === 'give' ? 'given' : 'collected', accessory: String(it.accessory || 'Item'), qty: qty(it), at: d.date || null });
    }
  }
  history.sort((a, b) => (situation.when(b.at) || 0) - (situation.when(a.at) || 0));

  // What is with them now: their consignment with us, a sale not delivered yet, our watch on consignment with them, theirs in our safe.
  const WITH = [
    ['consigned_in', 'On consignment from them'],
    ['awaiting', 'Sold to them, not delivered yet'],
    ['consigned_out', 'Ours, on consignment with them'],
    ['in_safe', 'Theirs, kept in our safe'],
  ];
  const withThem = [];
  for (const [role, text] of WITH) {
    for (const r of all.filter((x) => x.roles.has(role))) {
      // Shipped but not delivered is still theirs-to-receive: the app keeps it on the list until it is delivered.
      withThem.push({ label: role === 'awaiting' && r.row.data?.status === 'shipped' ? 'Sold to them, on its way' : text, row: r.row });
    }
  }

  // Their watches: bought from them, sold to them, coming in from them — one line per stock and direction.
  const stocks = new Map();
  const addStock = (dir, row) => {
    for (const s of row.stock_nos || []) {
      const key = `${dir}:${s}`;
      if (!stocks.has(key)) stocks.set(key, { dir, stock: s, row });
    }
  };
  for (const r of all) {
    if (r.row.kind === 'shipments') continue;
    if (has(r, 'bought', 'consigned_in')) addStock('bought', r.row);
    if (has(r, 'incoming')) addStock('incoming', r.row);
    if (has(r, 'sold', 'awaiting')) addStock('sold', r.row);
  }
  // A watch coming in that has a purchase line too is one watch: the purchase line says it.
  for (const [key, s] of stocks) if (s.dir === 'incoming' && stocks.has(`bought:${s.stock}`)) stocks.delete(key);
  const nos = [...new Set([...stocks.values()].map((s) => s.stock))];
  const nowOf = new Map();
  if (nos.length) {
    const { rows } = await query('SELECT id, kind, data, stock_nos, deleted_at FROM logistics_items WHERE stock_nos && $1::text[]', [nos]);
    for (const s of nos) {
      const mine = rows.filter((i) => i.stock_nos.includes(s));
      const n = mine.length ? situation.now(mine, { clientName: ctx.client }) : null;
      if (n?.headline) nowOf.set(s, { headline: n.headline, tone: n.tone });
    }
  }

  const views = await withWatches([...new Map([...all.map((r) => r.row), ...withThem.map((w) => w.row)].map((r) => [r.id, r])).values()].map((r) => view(r, ctx)));
  const viewOf = new Map(views.map((v) => [v.id, v]));
  const shipments = ships
    .map((r) => ({ dir: r.roles.has('ship_to') ? 'to_them' : 'from_them', item: { ...viewOf.get(r.row.id), stage: situation.stage(r.row.data).key }, open: situation.shipmentOpen(r.row.data) }))
    .sort((a, b) => (b.open ? 1 : 0) - (a.open ? 1 : 0) || String(b.item.summary.date || '').localeCompare(String(a.item.summary.date || '')));
  const stockList = [...stocks.values()]
    .map((s) => {
      const v = viewOf.get(s.row.id);
      return { dir: s.dir, stock: s.stock, title: v.summary.title, date: v.summary.date, now: nowOf.get(s.stock) || null, watch: (v.watches || []).find((w) => w.stock_no === s.stock) || null, item: v.id };
    })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  return {
    counts: {
      transactions: txs.length,
      shipments: ships.length,
      shipments_open: shipments.filter((s) => s.open).length,
      stocks: stockList.length,
      with_them: withThem.length,
      we_give: owed.give_n,
      they_give: owed.owed_n,
    },
    with_them: withThem.map((w) => ({ label: w.label, item: viewOf.get(w.row.id) })),
    accessories: { we_give: owed.we_give, they_give: owed.they_give, missing: owed.missing },
    stocks: stockList,
    shipments,
    history: history.slice(0, 40),
    history_total: history.length,
  };
}

/* ── what the API serves ───────────────────────────────────────── */

/** The Logistics → Clients tab: every logistics client, who of ours it is, and what is open with them. */
export async function listLogisticsClients({ q = '' } = {}) {
  const snap = await snapshot();
  const words = normName(q).split(' ').filter(Boolean);
  const rows = snap.clients.map((c) => {
    const link = linkOf(c, snap);
    const recs = snap.filed.get(c.id) || [];
    const txs = recs.filter((r) => r.row.kind === 'transactions').map((r) => r.row);
    const owed = owedOf(txs, snap);
    const shipOpen = recs.filter((r) => r.row.kind === 'shipments' && situation.shipmentOpen(r.row.data)).length;
    const stocks = new Set(recs.filter((r) => r.row.kind !== 'shipments').flatMap((r) => r.row.stock_nos || []));
    return {
      id: c.id,
      name: c.name || 'Unnamed client',
      country: String(c.data.country || '').trim(),
      us: c.us,
      link,
      transactions: txs.length,
      we_give: owed.give_n,
      they_give: owed.owed_n,
      shipments_open: shipOpen,
      watches: stocks.size,
    };
  });
  const found = words.length ? rows.filter((r) => words.every((w) => normName(`${r.name} ${r.country} ${r.link.client_name}`).includes(w))) : rows;
  found.sort((a, b) => Number(a.us) - Number(b.us) || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
  return {
    clients: found,
    linked: rows.filter((r) => !r.us && r.link.client_id).length,
    unlinked: rows.filter((r) => !r.us && !r.link.client_id).length,
  };
}

/** One logistics client: who of ours it is, why, and its logistics situation alone. */
export async function logisticsClient(itemId) {
  const snap = await snapshot();
  const c = snap.byId.get(Number(itemId) || 0);
  if (!c) throw bad('No such logistics client', 404);
  return {
    id: c.id,
    name: c.name || 'Unnamed client',
    country: String(c.data.country || '').trim(),
    phone: String(c.data.phone || '').trim(),
    notes: String(c.data.notes || '').trim(),
    us: c.us,
    link: linkOf(c, snap),
    candidates: c.match.candidates,
    // Others in the logistics app with the same name — often the same person typed twice.
    same_name: (snap.byName.get(normName(c.name)) || []).filter((x) => x.id !== c.id).map((x) => ({ id: x.id, name: x.name, country: String(x.data.country || '') })),
    situation: await situationOf([c], snap),
  };
}

/**
 * Our client's logistics: every logistics client that is them (a person's choice
 * or the worked-out match), its situation added up, where each of their watches
 * is now — and, when none is linked yet, the logistics clients that may be them.
 */
export async function forOurClient(clientId) {
  const id = Number(clientId) || 0;
  const snap = await snapshot();
  const linked = snap.clients.filter((c) => !c.us && linkOf(c, snap).client_id === id);
  const { rows: watches } = await query(
    'SELECT stock_no FROM watches WHERE deleted_at IS NULL AND (purchased_from_client_id = $1 OR sold_to_client_id = $1) AND stock_no IS NOT NULL',
    [id]
  );
  const nos = watches.map((w) => w.stock_no);
  const watchNow = {};
  if (nos.length) {
    const ctx = await context();
    const { rows } = await query('SELECT id, kind, data, stock_nos, deleted_at FROM logistics_items WHERE stock_nos && $1::text[]', [nos]);
    for (const s of nos) {
      const mine = rows.filter((i) => i.stock_nos.includes(s));
      const n = mine.length ? situation.now(mine, { clientName: ctx.client }) : null;
      if (n?.headline) watchNow[s] = { headline: n.headline, tone: n.tone };
    }
  }
  const suggestions = linked.length
    ? []
    : snap.clients
        .filter((c) => !c.us && !snap.decided.has(c.id) && c.match.candidates.some((x) => x.client_id === id))
        .map((c) => ({ id: c.id, name: c.name, country: String(c.data.country || ''), stocks: c.match.candidates.find((x) => x.client_id === id)?.stocks || [] }));
  return {
    linked: linked.map((c) => ({ id: c.id, name: c.name, country: String(c.data.country || ''), link: linkOf(c, snap) })),
    suggestions,
    watch_now: watchNow,
    situation: linked.length ? await situationOf(linked, snap) : null,
  };
}

/* A link in the record's history: who, with their number, and how it was decided — so the line says what changed. */
const linkWords = (l) =>
  l.client_id
    ? `${l.client_name || 'a client of ours'} (#${l.client_id}), ${l.how === 'person' ? 'chosen by a person' : l.how === 'name' ? 'by the name' : 'by the watches'}`
    : l.how === 'person'
      ? 'none of ours (chosen by a person)'
      : 'not linked';

/**
 * A person says who a logistics client is: one of our clients (a number), none
 * of ours (null), or "work it out again" ('auto'). Kept apart from the record's
 * data, so no sync changes it; written to the record's history.
 */
export async function setClientLink(itemId, clientId, user) {
  const id = Number(itemId) || 0;
  if (id > 2147483647) throw bad('No such logistics client', 404);
  const { rows } = await query("SELECT id FROM logistics_items WHERE id = $1 AND kind = 'clients'", [id]);
  if (!rows.length) throw bad('No such logistics client', 404);
  const none = { id, match: { client_id: null, how: null, stocks: [], candidates: [] } };
  const snap = await snapshot();
  const before = linkOf(snap.byId.get(id) || none, snap);
  if (clientId === 'auto') {
    await query('DELETE FROM logistics_client_links WHERE item_id = $1', [id]);
  } else {
    const cid = clientId === null ? null : Number(clientId);
    if (cid !== null) {
      if (!Number.isInteger(cid) || cid <= 0 || cid > 2147483647) throw bad('Choose one of our clients');
      const { rows: ok } = await query('SELECT 1 FROM clients WHERE id = $1 AND deleted_at IS NULL', [cid]);
      if (!ok.length) throw bad('No such client of ours');
    }
    await query(
      `INSERT INTO logistics_client_links(item_id, client_id, user_id, at) VALUES ($1, $2, $3, now())
       ON CONFLICT (item_id) DO UPDATE SET client_id = EXCLUDED.client_id, user_id = EXCLUDED.user_id, at = now()`,
      [id, cid, user?.id || null]
    );
  }
  forgetClientSnapshot();
  const now = await snapshot();
  const after = linkOf(now.byId.get(id) || none, now);
  if (linkWords(before) !== linkWords(after)) {
    await query("INSERT INTO logistics_events(item_id, user_id, source, action, changes) VALUES ($1, $2, 'user', 'update', $3)", [
      id,
      user?.id || null,
      { our_client: [linkWords(before), linkWords(after)] },
    ]);
  }
  return after;
}
