/*
 * A watch's logistics from OUR copy of the app's records (logistics_items,
 * a minute behind the app) — the same shape the app's bridge hands the
 * Logistics window (lgapp-bridge.js, passportData), so the window can draw
 * at once while the app, 2 MB and its whole document away, is still loading
 * (asked 3 Nov 2026: "this is still too slow"). The live answer replaces it
 * when it comes. Pictures and papers are the copy's "lgfile:<id>" where the
 * pass has copied them, else the worker's address as the app wrote it.
 */
import { query } from '../db/index.js';
import { stockList } from './kinds.js';

/* The app's lists the window reads, as it names them, and the key the bridge hands each over under. */
const LISTS = {
  incomings: 'incomings',
  londonStock: 'london',
  dubaiStock: 'dubai',
  hkStock: 'hk',
  hkSituation: 'hkSituation',
  safeStock: 'safe',
  checkoutStock: 'checkout',
  soldStocks: 'sold',
  readyForDelivery: 'ready',
  shipments: 'shipments',
  thirdPartyShipments: 'movers',
  transactions: 'transactions',
  logisticCosts: 'costs',
  personTrips: 'trips',
  externalPolish: 'polish',
  accCollect: 'collect',
  accGive: 'give',
};
/* A row in a stock list is the watch's own: its stock number exactly, as the bridge takes it. */
const EXACT = new Set(['londonStock', 'dubaiStock', 'hkStock', 'hkSituation', 'safeStock', 'checkoutStock', 'soldStocks', 'readyForDelivery']);

export async function passport(no) {
  const want = stockList(no);
  const out = Object.fromEntries(Object.values(LISTS).map((k) => [k, []]));
  if (!want.length) return null;
  const { rows } = await query(
    `SELECT kind, source_id, data, updated_at FROM logistics_items
      WHERE deleted_at IS NULL AND kind = ANY($1) AND stock_nos && $2::text[]`,
    [Object.keys(LISTS), want]
  );
  let copiedAt = null;
  for (const r of rows) {
    if (EXACT.has(r.kind) && !want.includes(String(r.data?.stockNumber ?? '').trim())) continue;
    out[LISTS[r.kind]].push(r.data);
    if (!copiedAt || r.updated_at > copiedAt) copiedAt = r.updated_at;
  }
  // Accessory settlements belong to the watch's transactions; a trip to the costs it carried.
  const txIds = out.transactions.map((t) => String(t.id ?? '')).filter(Boolean);
  const tripIds = out.costs.map((c) => String(c.tripId ?? '')).filter(Boolean);
  const [settlements, trips, people, movers] = await Promise.all([
    txIds.length ? query("SELECT data FROM logistics_items WHERE deleted_at IS NULL AND kind = 'settlements' AND data->>'txId' = ANY($1)", [txIds]) : { rows: [] },
    tripIds.length ? query("SELECT data FROM logistics_items WHERE deleted_at IS NULL AND kind = 'personTrips' AND source_id = ANY($1)", [tripIds]) : { rows: [] },
    query("SELECT COALESCE(source_id, 'ma-' || id) AS id, data->>'name' AS name, data->>'country' AS country FROM logistics_items WHERE deleted_at IS NULL AND kind = 'clients'"),
    query("SELECT COALESCE(source_id, 'ma-' || id) AS id, data->>'name' AS name, data->>'country' AS country FROM logistics_items WHERE deleted_at IS NULL AND kind = 'thirdPartyMovers'"),
  ]);
  out.settlements = settlements.rows.map((r) => r.data);
  const seen = new Set(out.trips.map((t) => String(t.id ?? '')));
  for (const r of trips.rows) if (!seen.has(String(r.data?.id ?? ''))) out.trips.push(r.data);
  const names = (list) => Object.fromEntries(list.map((c) => [c.id, { name: c.name || '', country: c.country || '' }]));
  const empty = Object.values(out).every((l) => !l.length);
  return { stock: no, meta: null, ...out, clients: names(people.rows), moverNames: names(movers.rows), copied: true, copiedAt, empty };
}
