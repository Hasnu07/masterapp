/*
 * Swaps: the logistics app's "Swaps" page — a swap settles one "I owe" item
 * against one "they owe" item, when an accessory taken from one watch is
 * given with another. Read from our copy of its records; its shape from the
 * app's own saveSwap / renderSwaps:
 *
 *   { id, giveTxId, giveItemId, receiveTxId, receiveItemId, notes, ts }
 *
 * The give side is the pending item we owed (a transaction's item with
 * direction 'give'), the receive side the one owed to us; saving marks both
 * items done with `settledBy` = the swap's id. The page shows, per swap, the
 * give transaction's reference and accessory ↔ the receive transaction's,
 * the notes and the time. The app has none yet (0 live, 0 in June), so this
 * is built from its code.
 *
 * Links as everywhere: each side's stock number to OUR watch and its clients
 * by Chrono Key's ids; its client (the app's id) to the logistics client
 * and, as that one is linked, to ours. New swap and delete change the app's
 * records: they wait for the switch-over.
 */
import { query } from '../../db/index.js';
import { oursByNumber, text, iso } from '../shared.js';
import { stockList } from '../kinds.js';
import { linksByClientId } from '../clients.js';

/** The page's data (GET /api/logistics/page/swaps). */
export async function page() {
  const [{ rows: swaps }, { rows: txs }] = await Promise.all([
    query("SELECT id, source_id, data, created_at FROM logistics_items WHERE kind = 'swaps' AND deleted_at IS NULL ORDER BY id"),
    query("SELECT id, source_id, data, stock_nos FROM logistics_items WHERE kind = 'transactions' AND deleted_at IS NULL"),
  ]);
  const txById = new Map(txs.map((r) => [text(r.data?.id) || r.source_id, r]));
  const named = swaps.flatMap((s) => [txById.get(text(s.data?.giveTxId)), txById.get(text(s.data?.receiveTxId))]).filter(Boolean);
  const [ours, people] = await Promise.all([oursByNumber(named.flatMap((r) => r.stock_nos || [])), linksByClientId(named.map((r) => r.data?.clientId))]);

  // One side of a swap: the transaction and the item the swap names on it — '?' in the app when either is gone.
  const side = (txId, itemId) => {
    const r = txById.get(text(txId));
    if (!r) return null;
    const d = r.data || {};
    const it = (Array.isArray(d.items) ? d.items : []).find((x) => x && text(x.id) === text(itemId)) || null;
    const first = stockList(d.stockNumber)[0] || '';
    return {
      id: r.id,
      type: d.type === 'sold' || d.type === 'bought' ? d.type : text(d.type),
      stock_no: text(d.stockNumber),
      reference: text(d.reference),
      brand: text(d.brand),
      accessory: it ? text(it.accessory) || 'Item' : '',
      qty: it ? Math.max(Number(it.qty) || 1, 1) : 0,
      client: people.get(text(d.clientId)) || null,
      watch: ours.get(first) || null,
    };
  };
  return {
    swaps: swaps
      .map((s) => {
        const d = s.data || {};
        return {
          id: s.id,
          at: iso(d.ts) || new Date(s.created_at).toISOString(),
          notes: text(d.notes),
          give: side(d.giveTxId, d.giveItemId),
          receive: side(d.receiveTxId, d.receiveItemId),
        };
      })
      .sort((a, b) => String(b.at).localeCompare(String(a.at)) || b.id - a.id),
  };
}

/**
 * What this page knows about one watch: an accessory of its transaction
 * settled by a swap (the item's `settledBy` — a swap row itself names no
 * stock number, so it never reaches here).
 */
export function forStock(stockNo, rows) {
  const out = [];
  for (const r of rows || []) {
    if (r.kind !== 'transactions') continue;
    const d = r.data || {};
    if (!stockList(d.stockNumber).includes(stockNo)) continue;
    const swapped = (Array.isArray(d.items) ? d.items : []).filter((it) => it && it.status === 'done' && text(it.settledBy));
    if (!swapped.length) continue;
    const words = swapped.map((it) => (Number(it.qty) > 1 ? `${text(it.accessory) || 'Item'} × ${Number(it.qty)}` : text(it.accessory) || 'Item'));
    out.push({ text: `Settled by a swap: ${words.join(', ')}`, link: '#/logistics/swaps', tone: 'good' });
  }
  return out;
}
