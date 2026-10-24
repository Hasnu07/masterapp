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

/* A name as compared here: lower case, no accents, punctuation or double spaces — "Rooh Ul Amin" is "rooh ul amin". */
export const normName = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/* The logistics app's own locations ("Company · Dubai"): that is us, never a client of ours. */
const isUs = (d) => d?.isCompany === true || normName(d?.name) === 'company';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/*
 * Everything the matching and the situations read, in one go — the logistics
 * clients, every record that names a client, our watches by stock number, our
 * clients' names, and what people decided — held 30 seconds, since the Clients
 * tab and a client page read it together. Each record is filed under the
 * logistics clients it names, with what it says about them.
 */
let held = null;
export const forgetClientSnapshot = () => {
  held = null;
};
async function snapshot() {
  if (held && Date.now() - held.at < 30_000) return held.snap;
  const [lc, recs, ws, cs, links] = await Promise.all([
    query(`SELECT id, source_id, ${CLIENT_ID} AS cid, data FROM logistics_items WHERE kind = 'clients' AND deleted_at IS NULL ORDER BY id`),
    query('SELECT * FROM logistics_items WHERE deleted_at IS NULL AND kind = ANY($1)', [RECORD_KINDS]),
    query('SELECT id, stock_no, purchased_from_client_id AS bought_from, sold_to_client_id AS sold_to FROM watches WHERE deleted_at IS NULL'),
    query('SELECT id, forename, surname, nickname, company FROM clients WHERE deleted_at IS NULL'),
    query('SELECT item_id, client_id FROM logistics_client_links'),
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
        // A place's row: bought from whoever it names, and maybe on consignment with a client now.
        if (d.status !== 'moved') fileByName(d.from, row, 'bought');
        if (d.status === 'consignment' && d.consignment?.with) fileByName(d.consignment.with, row, 'consigned_out');
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
  const snap = { clients, byId: new Map(clients.map((c) => [c.id, c])), byName, filed, watchByStock, ourNames, ourName, decided };
  for (const c of clients) c.match = matchOf(c, snap);
  held = { at: Date.now(), snap };
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
  if (best && (!second || best.score >= 2 * second.score)) {
    // A name that is another client of ours outweighs one or two watches.
    if (nameOne && nameOne !== best.client_id && best.score < 3) return { client_id: null, how: null, stocks: [], candidates };
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

  // Accessories: the transactions' items, pending, either way — by stock, as the app groups them.
  const label = (d) => [d.brand, d.reference].filter(Boolean).join(' ');
  const weGive = [];
  const theyGive = [];
  const receiving = new Set();
  const history = [];
  for (const { row } of txs) {
    const d = row.data || {};
    const items = Array.isArray(d.items) ? d.items : [];
    const give = items.filter((it) => pending(it) && it.direction === 'give');
    const get = items.filter((it) => pending(it) && it.direction !== 'give');
    const line = (list) => ({ tx: row.id, stock: String(d.stockNumber || ''), title: label(d), items: list.map((it) => ({ accessory: String(it.accessory || 'Item'), qty: qty(it) })) });
    if (give.length) weGive.push(line(give));
    if (get.length) {
      theyGive.push(line(get));
      receiving.add(String(d.stockNumber || ''));
    }
    for (const it of items.filter((x) => x && x.status === 'done')) {
      history.push({ tx: row.id, stock: String(d.stockNumber || ''), dir: it.direction === 'give' ? 'given' : 'collected', accessory: String(it.accessory || 'Item'), qty: qty(it), at: row.data?.date || null });
    }
  }
  // …and, as the app adds, what a watch bought from them arrived without (its London or Dubai row) — unless already owed.
  const missing = [];
  const boughtStocks = new Set(all.filter((r) => has(r, 'bought') && r.row.kind === 'transactions').flatMap((r) => r.row.stock_nos || []));
  if (boughtStocks.size) {
    const { rows } = await query("SELECT kind, data, stock_nos FROM logistics_items WHERE deleted_at IS NULL AND kind IN ('londonStock','dubaiStock') AND stock_nos && $1::text[]", [[...boughtStocks]]);
    for (const s of boughtStocks) {
      if (receiving.has(s)) continue;
      const row = rows.find((r) => r.kind === 'londonStock' && r.stock_nos.includes(s)) || rows.find((r) => r.stock_nos.includes(s));
      const m = row?.data?.accessoriesMissing;
      const list = (Array.isArray(m) ? m : String(m || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
      if (list.length) missing.push({ stock: s, items: list });
    }
  }

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
      if (role === 'awaiting' && r.row.data?.status === 'shipped') continue;
      withThem.push({ label: text, row: r.row });
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
  const sum = (lines) => lines.reduce((a, l) => a + l.items.reduce((b, it) => b + (typeof it === 'string' ? 1 : it.qty), 0), 0);

  return {
    counts: {
      transactions: txs.length,
      shipments: ships.length,
      shipments_open: shipments.filter((s) => s.open).length,
      stocks: stockList.length,
      with_them: withThem.length,
      we_give: sum(weGive),
      they_give: sum(theyGive) + sum(missing),
    },
    with_them: withThem.map((w) => ({ label: w.label, item: viewOf.get(w.row.id) })),
    accessories: { we_give: weGive, they_give: theyGive, missing },
    stocks: stockList,
    shipments,
    history: history.slice(-40).reverse(),
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
    let weGive = 0;
    let theyGive = 0;
    let txCount = 0;
    let shipOpen = 0;
    for (const { row, role } of recs) {
      if (row.kind === 'transactions') {
        txCount += 1;
        for (const it of Array.isArray(row.data?.items) ? row.data.items : []) {
          if (!pending(it)) continue;
          if (it.direction === 'give') weGive += qty(it);
          else theyGive += qty(it);
        }
      } else if (row.kind === 'shipments' && (role === 'ship_to' || role === 'ship_from') && situation.shipmentOpen(row.data)) shipOpen += 1;
    }
    const stocks = new Set(recs.filter((r) => r.row.kind !== 'shipments').flatMap((r) => r.row.stock_nos || []));
    return {
      id: c.id,
      name: c.name || 'Unnamed client',
      country: String(c.data.country || '').trim(),
      us: c.us,
      link,
      transactions: txCount,
      we_give: weGive,
      they_give: theyGive,
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

/**
 * A person says who a logistics client is: one of our clients (a number), none
 * of ours (null), or "work it out again" ('auto'). Kept apart from the record's
 * data, so no sync changes it; written to the record's history.
 */
export async function setClientLink(itemId, clientId, user) {
  const id = Number(itemId) || 0;
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
      if (!Number.isInteger(cid) || cid <= 0) throw bad('Choose one of our clients');
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
  if (before.client_id !== after.client_id || before.how !== after.how) {
    await query("INSERT INTO logistics_events(item_id, user_id, source, action, changes) VALUES ($1, $2, 'user', 'update', $3)", [
      id,
      user?.id || null,
      { our_client: [before.client_name || null, after.client_name || null] },
    ]);
  }
  return after;
}
