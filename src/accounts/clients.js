import { query } from '../db/index.js';
import { clientName } from '../clients/index.js';
import { normName, namesAlike } from '../logistics/clients.js';

export { normName, namesAlike, oursByExactName, ourClientNames } from '../logistics/clients.js';

/*
 * Which of OUR clients an accounts client is (asked 4 Nov 2026: "stock and
 * clients is the main thing that should be linked through all the apps").
 *
 * The accounts app keeps its own clients (CL-001 …) with typed names and no
 * Chrono Key id. So the link is worked out from the ledger itself, the same
 * way as for the logistics app: every entry the app posts against a client
 * carries a stock number — a PAYABLE is a purchase (we bought that watch from
 * them), a RECEIVABLE a sale (we sold it to them) — and OUR watch with that
 * number says, by Chrono Key's own ids, who it was bought from and sold to.
 * Each stock number is a vote; the winner needs twice the runner-up's. A full
 * name that is exactly one client of ours decides only when no watch does. A
 * person's choice (accounts_client_links) always wins.
 */

/* Everything the matching reads, in one go, kept until any of it changes (a few-bytes stamp says so). */
let held = null;
export const forgetAccountsClientSnapshot = () => {
  held = null;
};
async function stamp() {
  const { rows } = await query(
    `SELECT concat_ws('|', (SELECT max(updated_at) FROM accounts_items), (SELECT count(*) FROM accounts_items),
                           (SELECT max(updated_at) FROM watches), (SELECT max(updated_at) FROM clients),
                           (SELECT max(at) FROM accounts_client_links), (SELECT count(*) FROM accounts_client_links)) AS s`
  );
  return rows[0].s;
}

export async function snapshot() {
  const now = await stamp();
  if (held && held.stamp === now && Date.now() - held.at < 10 * 60_000) return held.snap;
  const [ac, en, ws, cs, links] = await Promise.all([
    query("SELECT id, source_id, data FROM accounts_items WHERE kind = 'clients' AND deleted_at IS NULL ORDER BY id"),
    query("SELECT id, data->>'type' AS type, stock_nos, client_ids FROM accounts_items WHERE kind = 'entries' AND deleted_at IS NULL AND cardinality(stock_nos) > 0 AND cardinality(client_ids) > 0"),
    query('SELECT id, stock_no, purchased_from_client_id AS bought_from, sold_to_client_id AS sold_to FROM watches WHERE deleted_at IS NULL'),
    query('SELECT id, forename, surname, nickname, company FROM clients WHERE deleted_at IS NULL'),
    // A person's link to a client of ours deleted since counts for nothing: the worked-out match shows instead.
    query('SELECT l.item_id, l.client_id FROM accounts_client_links l LEFT JOIN clients c ON c.id = l.client_id WHERE l.client_id IS NULL OR c.deleted_at IS NULL'),
  ]);
  const clients = ac.rows
    .filter((r) => r.source_id && r.source_id !== '*')
    .map((r) => ({ id: r.id, cid: r.source_id, data: r.data || {}, name: String(r.data?.name || '').trim(), company: String(r.data?.company || '').trim() }));
  const byCid = new Map(clients.map((c) => [c.cid, c]));
  const byName = new Map();
  for (const c of clients) {
    for (const n of new Set([normName(c.name), normName(c.company)].filter(Boolean))) {
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(c);
    }
  }
  // The ledger per accounts client: [{ role, stocks }] — bought (a PAYABLE) or sold (a RECEIVABLE).
  const ledger = new Map(clients.map((c) => [c.id, []]));
  for (const e of en.rows) {
    const role = e.type === 'PAYABLE' ? 'bought' : e.type === 'RECEIVABLE' ? 'sold' : null;
    if (!role) continue;
    for (const cid of e.client_ids) {
      const c = byCid.get(cid);
      if (c) ledger.get(c.id).push({ role, stocks: e.stock_nos });
    }
  }
  const watchByStock = new Map(ws.rows.map((w) => [w.stock_no, w]));
  const ourNames = new Map();
  const ourName = new Map();
  for (const c of cs.rows) {
    ourName.set(c.id, clientName(c));
    for (const n of new Set([`${c.forename || ''} ${c.surname || ''}`, c.company, c.nickname].map(normName).filter(Boolean))) {
      if (!ourNames.has(n)) ourNames.set(n, new Set());
      ourNames.get(n).add(c.id);
    }
  }
  const decided = new Map(links.rows.map((r) => [r.item_id, r.client_id]));
  const snap = { clients, byId: new Map(clients.map((c) => [c.id, c])), byCid, byName, ledger, watchByStock, ourNames, ourName, decided };
  for (const c of clients) c.match = matchOf(c, snap);
  held = { at: Date.now(), stamp: now, snap };
  return snap;
}

const NOT_A_PERSON = new Set(['hk', 'hong kong', 'dubai', 'london', 'uk', 'spain', 'switzerland', 'italy', 'safe', 'office', 'need to confirm', 'unknown', 'tbc', 'tbd', 'client', 'cash', 'walk in', 'walk-in']);

function matchOf(c, snap) {
  const words = normName(c.name).split(' ').filter(Boolean);
  const named = snap.ourNames.get(normName(c.name)) || (c.company && snap.ourNames.get(normName(c.company)));
  const nameOne = named?.size === 1 ? [...named][0] : null;
  const votes = new Map();
  const vote = (cid, stock) => {
    if (!cid) return;
    if (!votes.has(cid)) votes.set(cid, { client_id: cid, score: 0, stocks: new Set() });
    const v = votes.get(cid);
    if (!v.stocks.has(stock)) {
      v.stocks.add(stock);
      v.score += 1;
    }
  };
  for (const { role, stocks } of snap.ledger.get(c.id) || []) {
    for (const s of stocks) {
      const w = snap.watchByStock.get(s);
      if (!w) continue;
      vote(role === 'bought' ? w.bought_from : w.sold_to, s);
    }
  }
  const ranked = [...votes.values()].sort((a, b) => b.score - a.score).map((v) => ({ ...v, stocks: [...v.stocks].sort() }));
  const candidates = ranked.slice(0, 3).map((v) => ({ client_id: v.client_id, name: snap.ourName.get(v.client_id) || '', stocks: v.stocks }));
  if (nameOne && !candidates.some((x) => x.client_id === nameOne)) candidates.push({ client_id: nameOne, name: snap.ourName.get(nameOne) || '', stocks: [], by_name: true });
  const none = { client_id: null, how: null, stocks: [], candidates };
  if (NOT_A_PERSON.has(normName(c.name))) return none;
  const [best, second] = ranked;
  if (best && (!second || best.score >= 2 * second.score)) {
    // A name that is another client of ours outweighs one or two watches.
    if (nameOne && nameOne !== best.client_id && best.score < 3) return none;
    // One watch alone links only names that look alike.
    if (best.stocks.length === 1 && !namesAlike(c.name, snap.ourName.get(best.client_id) || '')) return none;
    return { client_id: best.client_id, how: 'watches', stocks: best.stocks, candidates };
  }
  if (!best && nameOne && (words.length >= 2 || normName(c.company))) return { client_id: nameOne, how: 'name', stocks: [], candidates };
  return none;
}

/* The link as shown: a person's choice, else the worked-out match. */
export function linkOf(c, snap) {
  if (snap.decided.has(c.id)) {
    const id = snap.decided.get(c.id);
    return { client_id: id, client_name: id ? snap.ourName.get(id) || '' : '', how: 'person', stocks: [] };
  }
  const m = c.match;
  return { client_id: m.client_id, client_name: m.client_id ? snap.ourName.get(m.client_id) || '' : '', how: m.how, stocks: m.stocks };
}

/** Who a typed name is: the accounts client of that name, and which of ours that one is. Two of one name give one of ours only when both say the same. */
export async function linksByName(names) {
  const snap = await snapshot();
  const out = new Map();
  for (const name of new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))) {
    const cs = snap.byName.get(normName(name)) || [];
    if (!cs.length) continue;
    const ids = [...new Set(cs.map((c) => linkOf(c, snap).client_id))];
    const ours = ids.length === 1 ? ids[0] : null;
    out.set(name, { acc_client_id: cs[0].cid, client_id: ours, client_name: ours ? snap.ourName.get(ours) || '' : '' });
  }
  return out;
}

/** Who an accounts client id (CL-001) is: its name, and which of ours it is. */
export async function linksByClientId(cids) {
  const snap = await snapshot();
  const out = new Map();
  for (const cid of new Set(cids.map((x) => String(x ?? '').trim()).filter(Boolean))) {
    const c = snap.byCid.get(cid);
    if (!c) continue;
    const link = linkOf(c, snap);
    out.set(cid, { acc_client_id: cid, name: c.name, company: c.company, client_id: link.client_id, client_name: link.client_name, how: link.how });
  }
  return out;
}

/** The accounts clients that are OUR client (by id): for the client's page. */
export async function accountsClientsOf(ourClientId) {
  const snap = await snapshot();
  return snap.clients.filter((c) => linkOf(c, snap).client_id === ourClientId).map((c) => ({ acc_client_id: c.cid, name: c.name, company: c.company, how: linkOf(c, snap).how }));
}

/** The accounts clients found by words (name, company, code), each with who of ours it is now — for the client page's picker. */
export async function appClients(q, limit = 12) {
  const snap = await snapshot();
  const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  const hit = (c) => !words.length || words.every((w) => `${c.name} ${c.company} ${c.cid}`.toLowerCase().includes(w));
  return snap.clients
    .filter(hit)
    .slice(0, Math.min(Math.max(Number(limit) || 12, 1), 50))
    .map((c) => {
      const l = linkOf(c, snap);
      return { acc_client_id: c.cid, name: c.name, company: c.company, client_id: l.client_id, client_name: l.client_name, how: l.how };
    });
}

/**
 * A person's decision: this accounts client is OUR client N (or, client_id
 * null, none of ours). It wins over the worked-out match from then on, and
 * the sync never changes it. Kept in accounts_client_links by the copied
 * record's row.
 */
export async function setClientLink(accClientId, clientId, user) {
  const { rows } = await query("SELECT id FROM accounts_items WHERE kind = 'clients' AND deleted_at IS NULL AND source_id = $1", [String(accClientId || '').trim()]);
  if (!rows[0]) throw Object.assign(new Error('No such client in the accounts app'), { status: 404 });
  if (clientId !== null) {
    const { rows: ours } = await query('SELECT id FROM clients WHERE id = $1 AND deleted_at IS NULL', [Number(clientId) || 0]);
    if (!ours[0]) throw Object.assign(new Error('No such client of ours'), { status: 404 });
  }
  await query(
    `INSERT INTO accounts_client_links(item_id, client_id, user_id, at) VALUES ($1, $2, $3, now())
     ON CONFLICT (item_id) DO UPDATE SET client_id = EXCLUDED.client_id, user_id = EXCLUDED.user_id, at = now()`,
    [rows[0].id, clientId === null ? null : Number(clientId), user?.id ?? null]
  );
  forgetAccountsClientSnapshot();
}

/** The decision forgotten: the worked-out match shows again. */
export async function forgetClientLink(accClientId) {
  await query("DELETE FROM accounts_client_links WHERE item_id IN (SELECT id FROM accounts_items WHERE kind = 'clients' AND source_id = $1)", [String(accClientId || '').trim()]);
  forgetAccountsClientSnapshot();
}

/** The accounts app's own client id for a typed name, when exactly one carries it — for opening its profile there. */
export async function accountsClientIdFor(name) {
  const snap = await snapshot();
  const cs = snap.byName.get(normName(name)) || [];
  return cs.length === 1 ? cs[0].cid : null;
}
