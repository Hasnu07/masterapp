import { query } from '../db/index.js';
import { clientName } from '../clients/index.js';

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

/*
 * Who a typed name is, for a page that shows it (the safe's owner): the
 * logistics client of that name, and which of ours that one is — by the same
 * rule as everywhere (a person's choice, else its watches; a name alone only
 * as matchOf allows). Two logistics clients of one name give one of ours only
 * when both say the same.
 */
export async function linksByName(names) {
  const snap = await snapshot();
  const out = new Map();
  for (const name of new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))) {
    const cs = (snap.byName.get(normName(name)) || []).filter((c) => !c.us);
    if (!cs.length) continue;
    const ids = [...new Set(cs.map((c) => linkOf(c, snap).client_id))];
    const ours = ids.length === 1 ? ids[0] : null;
    out.set(name, { lg_client_id: cs[0].id, client_id: ours, client_name: ours ? snap.ourName.get(ours) || '' : '' });
  }
  return out;
}

/*
 * Our client of exactly this name — the full name or the company, compared
 * as normName compares — when exactly one of ours carries it. For the
 * logistics app inside the ERP (30 Oct 2026, "the same client, one connected
 * whole"): a name typed there that is one of ours links to ours, with no copy
 * of the app's records needed. Two of ours with one name link nowhere.
 */
export async function oursByExactName(names) {
  const want = new Map(); // as compared → every spelling asked for
  for (const n of names) {
    const k = normName(n);
    if (!k) continue;
    if (!want.has(k)) want.set(k, []);
    want.get(k).push(String(n).trim());
  }
  if (!want.size) return new Map();
  const { rows } = await query('SELECT id, forename, surname, nickname, company FROM clients WHERE deleted_at IS NULL');
  const byNorm = new Map();
  for (const c of rows) {
    for (const k of new Set([`${c.forename || ''} ${c.surname || ''}`, c.company, c.nickname].map(normName).filter(Boolean))) {
      if (!byNorm.has(k)) byNorm.set(k, new Set());
      byNorm.get(k).add(c.id);
    }
  }
  const byId = new Map(rows.map((c) => [c.id, c]));
  const out = new Map();
  for (const [k, spellings] of want) {
    const ids = byNorm.get(k);
    if (ids?.size !== 1) continue;
    const c = byId.get([...ids][0]);
    for (const typed of spellings) out.set(typed, { client_id: c.id, client_name: clientName(c) });
  }
  return out;
}

/* Every client of ours by name, for the app's own name lists: what somebody types there can be one of ours exactly. */
export async function ourClientNames() {
  const { rows } = await query('SELECT id, forename, surname, nickname, company FROM clients WHERE deleted_at IS NULL ORDER BY surname, forename');
  return rows.map((c) => ({ id: c.id, name: clientName(c) })).filter((c) => c.name);
}

/*
 * Who a logistics client id is (a transaction's clientId, the app's own id):
 * its name and country, and which of ours it is — the same link as on the
 * Clients tab.
 */
export async function linksByClientId(cids) {
  const snap = await snapshot();
  const byCid = new Map(snap.clients.map((c) => [String(c.cid), c]));
  const out = new Map();
  for (const cid of new Set(cids.map((x) => String(x ?? '').trim()).filter(Boolean))) {
    const c = byCid.get(cid);
    if (!c) continue;
    const link = c.us ? { client_id: null, client_name: '' } : linkOf(c, snap);
    out.set(cid, { lg_client_id: c.id, name: c.name, country: String(c.data.country || '').trim(), client_id: link.client_id, client_name: link.client_name });
  }
  return out;
}

/* ── what the API serves ───────────────────────────────────────── */

/** The Logistics → Clients tab: every logistics client, who of ours it is, and what is open with them. */
