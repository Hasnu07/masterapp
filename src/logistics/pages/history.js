/*
 * Accessory History: the logistics app's "Accessory Transaction History" page
 * — every accessory transaction with its full settlement timeline: what was
 * given, what was collected, when, and the proof photos — read from our copy
 * of its records, its rules from its own renderHistory:
 *
 *   - every transaction (its filter: one client, else all), newest first by
 *     its date, then by when it was created;
 *   - a line = kind (bought / sold), stock number, reference, brand, the
 *     client "name (country)" by the app's own client id; "n pending ·
 *     m settled" count ITEMS by status;
 *   - the pending items under the app's label by the transaction's kind
 *     (sold → "I owe client", bought → "Client owes me");
 *   - the settlements of the transaction (`txId`), newest first, each
 *     "Delivered" (give) or "Received", the items it names (`itemIds`),
 *     its notes, time and photos.
 *
 * The Transactions tab lists the same records; this is the history view.
 * Links as everywhere: the stock number to OUR watch and its clients by
 * Chrono Key's ids; the app's client id to the logistics client and, as that
 * one is linked, to ours (linksByClientId). Edit, settle, undo and delete
 * change the app's records: they wait for the switch-over.
 */
import { query } from '../../db/index.js';
import { oursByNumber, text, iso, dayOf, photoPrefix } from '../shared.js';
import { stockList } from '../kinds.js';
import { linksByClientId } from '../clients.js';

/* Every picture a record holds (shared.js's picturesOf keeps only the first and a count). */
function allPictures(d) {
  const prefix = photoPrefix();
  return (Array.isArray(d.photos) ? d.photos : []).filter((v) => typeof v === 'string' && (/^lgfile:\d+$/.test(v) || (prefix && v.startsWith(prefix))));
}

const label = (it) => (it.qty > 1 ? `${it.accessory} × ${it.qty}` : it.accessory);
const itemOf = (it) => ({
  id: text(it.id),
  accessory: text(it.accessory) || 'Item',
  qty: Math.max(Number(it.qty) || 1, 1),
  // The app's own field: 'give' is ours to give, 'receive' theirs to give us.
  direction: it.direction === 'give' ? 'give' : 'receive',
  status: it.status === 'done' ? 'done' : 'pending',
  // 'settledBy' is the swap that settled it, 'settlementId' the handover.
  settled_by_swap: Boolean(text(it.settledBy)),
});

/** The page's data (GET /api/logistics/page/history). */
export async function page() {
  const [{ rows: txs }, { rows: sets }, { rows: lgClients }] = await Promise.all([
    query("SELECT id, source_id, data, stock_nos, created_at FROM logistics_items WHERE kind = 'transactions' AND deleted_at IS NULL ORDER BY id"),
    query("SELECT id, source_id, data FROM logistics_items WHERE kind = 'settlements' AND deleted_at IS NULL ORDER BY id"),
    query("SELECT COALESCE(source_id, 'ma-' || id) AS id, data->>'name' AS name, data->>'country' AS country FROM logistics_items WHERE kind = 'clients' AND deleted_at IS NULL"),
  ]);
  const [ours, people] = await Promise.all([oursByNumber(txs.flatMap((r) => r.stock_nos || [])), linksByClientId(txs.map((r) => r.data?.clientId))]);
  const settlementsOf = new Map();
  for (const s of sets) {
    const k = text(s.data?.txId);
    if (!k) continue;
    (settlementsOf.get(k) || settlementsOf.set(k, []).get(k)).push(s);
  }
  const transactions = txs
    .map((r) => {
      const d = r.data || {};
      const items = (Array.isArray(d.items) ? d.items : []).filter(Boolean).map(itemOf);
      const byId = new Map(items.map((it) => [it.id, it]));
      const settlements = (settlementsOf.get(text(d.id) || r.source_id) || [])
        .map((s) => {
          const sd = s.data || {};
          const ids = (Array.isArray(sd.itemIds) ? sd.itemIds : []).map(String);
          return {
            id: s.id,
            at: iso(sd.ts) || iso(sd.date),
            direction: sd.direction === 'give' ? 'give' : 'receive',
            items: ids.map((i) => byId.get(i)).filter(Boolean).map(label),
            notes: text(sd.notes),
            pictures: allPictures(sd),
          };
        })
        .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
      const first = stockList(d.stockNumber)[0] || '';
      return {
        id: r.id,
        date: dayOf(d.date) || iso(d.createdAt),
        created_at: Number(d.createdAt) || new Date(r.created_at).getTime(),
        type: d.type === 'sold' || d.type === 'bought' ? d.type : text(d.type),
        stock_no: text(d.stockNumber),
        brand: text(d.brand),
        reference: text(d.reference),
        notes: text(d.notes),
        client_id: text(d.clientId),
        client: people.get(text(d.clientId)) || null,
        items,
        pending: items.filter((it) => it.status === 'pending').length,
        done: items.filter((it) => it.status === 'done').length,
        settlements,
        watch: ours.get(first) || null,
      };
    })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.created_at - a.created_at || b.id - a.id);
  return {
    transactions,
    // The app's filter lists every client, "name (country)", by name.
    clients: lgClients.map((c) => ({ id: c.id, name: text(c.name), country: text(c.country) })).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })),
    settlements: sets.length,
  };
}

/**
 * What this page knows about one watch: its accessories still pending on a
 * transaction (either way), and what was settled.
 */
export function forStock(stockNo, rows) {
  const out = [];
  for (const r of rows || []) {
    if (r.kind !== 'transactions') continue;
    const d = r.data || {};
    if (!stockList(d.stockNumber).includes(stockNo)) continue;
    const items = (Array.isArray(d.items) ? d.items : []).filter(Boolean).map(itemOf);
    const we = items.filter((it) => it.status === 'pending' && it.direction === 'give');
    const they = items.filter((it) => it.status === 'pending' && it.direction === 'receive');
    const done = items.filter((it) => it.status === 'done');
    if (we.length) out.push({ text: `We still owe: ${we.map(label).join(', ')}`, link: `#/lg/${r.id}`, tone: 'warn' });
    if (they.length) out.push({ text: `Still to collect: ${they.map(label).join(', ')}`, link: `#/lg/${r.id}`, tone: 'warn' });
    if (done.length) out.push({ text: `Settled: ${done.map(label).join(', ')}`, link: '#/logistics/history', tone: 'good' });
  }
  return out;
}
