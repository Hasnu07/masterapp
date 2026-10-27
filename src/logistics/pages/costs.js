/*
 * Logistic Cost: the logistics app's "Logistic Cost" page (its tab
 * `logistics`, renderLogisticCosts), read from our copy of its records —
 * the ledger of every cost line: date, what for, the stock numbers it was
 * for, from → to, the amount in its own currency, notes, and where the line
 * came from (a live shipment delivered, a mover's shipment, a trip's
 * expense line, a polish, or typed by hand — the app writes the line's
 * `shipmentId`, `thirdPartyShipmentId`, `tripId` or `polishId`).
 *
 * The page's filters (search, currency, title, from / to date), the totals
 * by currency — all-time and for what the filters leave — and the sort
 * (date, newest first, then the moment it was written) are the browser's,
 * as in the app. On top of the app's page: the total in ONE currency at the
 * converter's rates, as the Overview and Movement tabs do (never the app's
 * fixed table). Print is the browser's; the app's + Add Cost / edit / delete
 * are the record's own page here (masterapp never writes back).
 *
 * The one rule every tab keeps: a stock number on a line is OUR watch,
 * linked with its clients by Chrono Key's ids; a typed From / To links as
 * far as the logistics client of that name does (linksByName); the app's
 * own client ids on a line (`fromClientId` / `toClientId`) through
 * linksByClientId.
 */
import { query } from '../../db/index.js';
import { oursByNumber, text, dayOf, iso } from '../shared.js';
import * as situation from '../situation.js';
import { linksByName, linksByClientId } from '../clients.js';
import { getRates } from '../../rates/index.js';
import { lastLogisticsRead } from '../../import/logistics/sync.js';

/* Copied from src/logistics/index.js (ratesSoon): the converter's rates without holding the page up — a slow source gets 1.5 s, then the last table, marked not fresh. */
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

/* Copied from src/logistics/index.js (asOf): when our copy was last read. */
async function asOf() {
  const { rows } = await query("SELECT finished_at AS at FROM import_runs WHERE source = 'logistics' AND ok ORDER BY started_at DESC LIMIT 1");
  const a = rows[0]?.at ? new Date(rows[0].at) : null;
  const b = lastLogisticsRead();
  return a && b ? (a > b ? a : b) : a || b;
}

/* Where a cost line came from — the ids the app writes on it when it makes one. */
export const sourceOf = (d) =>
  d.tripId ? 'trip' : d.thirdPartyShipmentId ? 'mover' : d.shipmentId ? 'shipment' : d.polishId ? 'polish' : 'manual';

const CUR = (v) => {
  const c = text(v).toUpperCase();
  return /^[A-Z]{3,4}$/.test(c) ? c : '';
};

/** The page's data (GET /api/logistics/page/costs). */
export async function page() {
  const [{ rows }, rates] = await Promise.all([
    query("SELECT * FROM logistics_items WHERE kind = 'logisticCosts' AND deleted_at IS NULL ORDER BY id"),
    ratesSoon(),
  ]);
  const data = rows.map((r) => r.data || {});
  // The records a line stands for, by the app's own ids: our row of that shipment, mover shipment, trip or polish.
  const want = (key, kind) => {
    const ids = [...new Set(data.map((d) => text(d[key])).filter(Boolean))];
    return ids.length ? query('SELECT id, source_id FROM logistics_items WHERE kind = $1 AND source_id = ANY($2)', [kind, ids]).then((q) => new Map(q.rows.map((x) => [x.source_id, x.id]))) : new Map();
  };
  const [ours, people, clients, ships, movers, trips] = await Promise.all([
    oursByNumber(rows.flatMap((r) => r.stock_nos || [])),
    linksByName(data.flatMap((d) => [d.fromName, d.toName])),
    linksByClientId(data.flatMap((d) => [d.fromClientId, d.toClientId])),
    want('shipmentId', 'shipments'),
    want('thirdPartyShipmentId', 'thirdPartyShipments'),
    want('tripId', 'personTrips'),
  ]);
  const side = (name, cid) => {
    const n = text(name).replace(/^🏢\s*/, '');
    const c = cid ? clients.get(text(cid)) : null;
    return { name: n, link: (c && (c.client_id || c.lg_client_id) ? { lg_client_id: c.lg_client_id, client_id: c.client_id, client_name: c.client_name } : null) || people.get(text(name)) || null };
  };
  const lines = rows
    .map((r) => {
      const d = r.data || {};
      const source = sourceOf(d);
      return {
        id: r.id,
        date: dayOf(d.date) || '',
        at: iso(d.ts) || new Date(r.created_at).toISOString(),
        title: text(d.title),
        stock: text(d.stockNumber),
        watches: (r.stock_nos || []).map((s) => ({ stock_no: s, watch: ours.get(s) || null })),
        from: side(d.fromName, d.fromClientId),
        to: side(d.toName, d.toClientId),
        // As written: a total is rounded once, at the end, as the app's are.
        amount: Number(d.amount) || 0,
        currency: CUR(d.currency),
        notes: text(d.notes),
        source,
        // The record the line stands for, opened from the row.
        for_id: source === 'shipment' ? ships.get(text(d.shipmentId)) || null : source === 'mover' ? movers.get(text(d.thirdPartyShipmentId)) || null : source === 'trip' ? trips.get(text(d.tripId)) || null : null,
        locked: (r.locked_fields || []).length > 0,
      };
    })
    // The app's order: the day, newest first, then the moment the line was written.
    .sort((a, b) => b.date.localeCompare(a.date) || b.at.localeCompare(a.at) || b.id - a.id);

  // All-time totals by currency, as the app's top cards (a line with no currency is the app's OTHER).
  const by_currency = {};
  for (const l of lines) {
    const cur = l.currency || 'OTHER';
    by_currency[cur] ||= { amount: 0, count: 0 };
    by_currency[cur].amount += l.amount;
    by_currency[cur].count += 1;
  }
  for (const v of Object.values(by_currency)) v.amount = Math.round(v.amount * 100) / 100;
  return {
    as_of: await asOf(),
    lines,
    by_currency,
    rates: rates ? { usd: rates.rates, kind: rates.kind, stale: Boolean(rates.stale) } : null,
  };
}

const amountWords = (n) => Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 });

/**
 * What this page knows about one watch, for its Inventory card and its page:
 * what moving it has cost so far — the app's own costsForStock, line for line
 * (situation.costs: cost lines split over the watches they name, a
 * shipment's own cost, a trip's lines split over its watches), each currency
 * kept as it is. The purchase itself is not a logistic cost and is left out
 * of the sum (the app's route optimizer adds it in; that reads as the price
 * of the watch, not of moving it).
 */
export function forStock(stockNo, rows) {
  const { lines, totals } = situation.costs(stockNo, rows);
  const n = lines.filter((l) => l.source !== 'Purchase').length;
  const parts = Object.entries(totals)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([cur, v]) => `${cur} ${amountWords(v)}`);
  if (!n || !parts.length) return [];
  return [{ text: `Logistic cost so far: ${parts.join(' + ')} (${n} line${n === 1 ? '' : 's'})`, link: '#/logistics/costs', tone: '' }];
}
