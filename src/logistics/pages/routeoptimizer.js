/*
 * Route Optimizer: the logistics app's "Route Optimizer" page (its tab
 * `routeoptimizer`: renderRouteOptimizer, renderRouteAvailable,
 * renderRouteStockList, buildRouteHistoricalData, routeUpdateHistory), read
 * from our copy of its records.
 *
 * The app's page: pick where the watches are (From) and where they go
 * (To); the watches available at From — London and Dubai rows in stock or
 * on consignment, the HK list's "in hand" rows — are ticked into the move;
 * each shows what it cost to buy, what moving it has cost so far, and (once
 * the AI has been asked) its market price and the profit; the cargo summary
 * adds them up; "Historical costs on this route" is every recorded move
 * between the two places — live shipments, movers' shipments, cost lines,
 * completed trips' legs — by method / carrier with the times used, the
 * average and the total, and the eight most recent; then the AI's route
 * recommendation.
 *
 * Here: everything the records give. The market prices and the
 * recommendation are asked of Claude with the app's own key, which
 * masterapp does not hold — those wait for the switch-over, and the page
 * says so in a line. Dollars are at the converter's rates (as the Overview
 * and Movement tabs), never the app's fixed FX_TO_USD table. Every watch is
 * ours, with its clients by Chrono Key's ids; the typed "bought from" on a
 * place's row links as far as the logistics client of that name does.
 */
import { query } from '../../db/index.js';
import { oursByNumber, text, dayOf, picturesOf } from '../shared.js';
import * as situation from '../situation.js';
import { linksByName } from '../clients.js';
import { getRates } from '../../rates/index.js';
import { lastLogisticsRead } from '../../import/logistics/sync.js';

/* Copied from src/logistics/index.js (ratesSoon). */
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

/* Copied from src/logistics/index.js (asOf). */
async function asOf() {
  const { rows } = await query("SELECT finished_at AS at FROM import_runs WHERE source = 'logistics' AND ok ORDER BY started_at DESC LIMIT 1");
  const a = rows[0]?.at ? new Date(rows[0].at) : null;
  const b = lastLogisticsRead();
  return a && b ? (a > b ? a : b) : a || b;
}

/* The app's six places, in its order. */
export const PLACES = ['Dubai', 'London', 'Hong Kong', 'Switzerland', 'Italy', 'Other'];

/*
 * The app's normalizeRouteLoc, as written: a typed place to one of its
 * names — "swiss", "Geneva" → Switzerland; "Mayfair", "uk" → London;
 * "dubai", "UAE" → Dubai; anything else with its first letter up.
 */
export function placeOf(s) {
  s = text(s).toLowerCase();
  if (/dubai|uae|\bae\b/.test(s)) return 'Dubai';
  if (/london|england|\buk\b|\bgb\b|mayfair|newcastle/.test(s)) return 'London';
  if (/hong.?kong|\bhk\b/.test(s)) return 'Hong Kong';
  if (/switzerland|swiss|geneva|zurich|\bch\b/.test(s)) return 'Switzerland';
  if (/italy|italian|milan|rome|\bit\b/.test(s)) return 'Italy';
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* The app's detectCarrier — a carrier from the shape of its tracking number. */
function carrierOf(tracking) {
  const t = text(tracking).replace(/\s/g, '').toUpperCase();
  if (!t) return '';
  if (/^1Z[0-9A-Z]{16}$/.test(t)) return 'UPS';
  if (/^EE[0-9]{9}[A-Z]{2}$/.test(t)) return 'EMS';
  if (/^[A-Z]{2}[0-9]{9}[A-Z]{2}$/.test(t)) return 'Royal Mail';
  if (/^9[0-9]{15,21}$/.test(t)) return 'USPS';
  if (/^[0-9]{10}$/.test(t)) return 'DHL';
  if (/^[0-9]{12}$|^[0-9]{15}$|^[0-9]{20}$|^[0-9]{22}$/.test(t)) return 'FedEx';
  if (/^[0-9]{11}$/.test(t)) return 'Aramex';
  return '';
}

const CUR = (v) => text(v).toUpperCase() || 'USD';
const money = (amount, currency) => ({ amount: Math.round((Number(amount) || 0) * 100) / 100, currency: CUR(currency) });
/* Dollars at the converter's rates (USD → code); null when the currency has no rate. */
const usdAt = (rates) => (amount, currency) => {
  const per = rates?.rates?.[CUR(currency)];
  return per ? Math.round(((Number(amount) || 0) / per) * 100) / 100 : null;
};

/** The page's data (GET /api/logistics/page/routeoptimizer). */
export async function page() {
  const [stockQ, moveQ, rates] = await Promise.all([
    query(
      `SELECT * FROM logistics_items WHERE deleted_at IS NULL AND (
           (kind IN ('londonStock', 'dubaiStock') AND COALESCE(data->>'status', 'current') IN ('current', 'consignment'))
        OR (kind = 'hkSituation' AND data->>'section' = 'in_hand'))
        ORDER BY kind, id`
    ),
    query("SELECT * FROM logistics_items WHERE deleted_at IS NULL AND kind IN ('shipments', 'thirdPartyShipments', 'logisticCosts', 'personTrips') ORDER BY id"),
    ratesSoon(),
  ]);
  const usd = usdAt(rates);
  const nos = [...new Set(stockQ.rows.flatMap((r) => r.stock_nos || []))];
  const [ours, people, costQ] = await Promise.all([
    oursByNumber(nos),
    linksByName(stockQ.rows.map((r) => r.data?.from)),
    // What moving each available watch has cost so far: the app's costsForStock, over every record naming it.
    nos.length
      ? query("SELECT * FROM logistics_items WHERE deleted_at IS NULL AND kind IN ('logisticCosts', 'shipments', 'personTrips', 'incomings') AND stock_nos && $1::text[]", [nos])
      : { rows: [] },
  ]);
  const PLACE = { londonStock: 'London', dubaiStock: 'Dubai', hkSituation: 'Hong Kong' };
  const available = { London: [], Dubai: [], 'Hong Kong': [] };
  for (const r of stockQ.rows) {
    const d = r.data || {};
    const stock = text(d.stockNumber);
    const mine = costQ.rows.filter((c) => (c.stock_nos || []).includes(stock));
    const { lines } = stock ? situation.costs(stock, mine) : { lines: [] };
    // Logistic cost in dollars: every line but the purchase (the app's figure adds the purchase in; that is the price of the watch, not of moving it).
    const log = lines.filter((l) => l.source !== 'Purchase');
    let log_usd = 0;
    const missing = new Set();
    for (const l of log) {
      const v = usd(l.amount, l.currency);
      if (v == null) missing.add(l.currency);
      else log_usd += v;
    }
    const buy = d.buyPrice ? money(d.buyPrice, d.buyCurrency) : null;
    available[PLACE[r.kind]].push({
      id: r.id,
      place: PLACE[r.kind],
      stock_no: stock,
      brand: text(d.brand),
      model: text(d.watchModel || d.description || d.watchReference),
      reference: text(d.watchReference || d.reference),
      from: text(d.from) ? { name: text(d.from), link: people.get(text(d.from)) || null } : null,
      status: text(d.status) || 'current',
      buy,
      buy_usd: buy ? usd(buy.amount, buy.currency) : null,
      log_lines: log.length,
      log_usd: Math.round(log_usd * 100) / 100,
      log_missing: [...missing],
      ...picturesOf(d),
      watch: (r.stock_nos || []).map((s) => ours.get(s)).find(Boolean) || null,
    });
  }

  // Every recorded move, for the route history: the app's buildRouteHistoricalData, each with its from / to as the app normalises them.
  const moves = [];
  for (const r of moveQ.rows) {
    const d = r.data || {};
    if (r.kind === 'shipments') {
      const m = money(d.costAmount, d.costCurrency);
      moves.push({ id: r.id, kind: 'shipment', from: placeOf(d.fromText), to: placeOf(d.toText), date: dayOf(d.date) || '', method: carrierOf(d.tracking) || 'Courier', detail: `Stock #${text(d.stockNumber) || '–'}`, ...m, usd: usd(m.amount, m.currency), stock_nos: r.stock_nos || [] });
    } else if (r.kind === 'thirdPartyShipments') {
      const m = money(d.amount, d.currency);
      moves.push({ id: r.id, kind: 'mover', from: placeOf(d.fromCountry), to: placeOf(d.toCountry), date: dayOf(d.shipmentDate) || '', method: text(d.moverName) || '3rd Party', detail: `Stock #${text(d.stockNumber) || '–'}`, ...m, usd: usd(m.amount, m.currency), stock_nos: r.stock_nos || [] });
    } else if (r.kind === 'logisticCosts') {
      const m = money(d.amount, d.currency);
      // What the line stands for (the app writes the record's id on it): the browser leaves out a line whose shipment, mover shipment or trip is already a move — the app counts both.
      const stands_for = d.tripId ? 'trip' : d.thirdPartyShipmentId ? 'mover' : d.shipmentId ? 'shipment' : d.polishId ? 'polish' : '';
      moves.push({ id: r.id, kind: 'cost', stands_for, from: placeOf(d.fromName), to: placeOf(d.toName), date: dayOf(d.date) || '', method: text(d.title) || 'Other', detail: `Stock #${text(d.stockNumber) || '–'}`, ...m, usd: usd(m.amount, m.currency), stock_nos: r.stock_nos || [] });
    } else if (r.kind === 'personTrips' && d.status === 'completed') {
      const costs = Array.isArray(d.costs) ? d.costs : [];
      const n = Array.isArray(d.stockIds) ? d.stockIds.length : 0;
      for (const leg of Array.isArray(d.legs) ? d.legs : []) {
        if (!leg) continue;
        const legCosts = costs.filter((c) => c && (!c.legId || c.legId === leg.id));
        // A leg's cost is its own lines and the trip's unassigned ones — in dollars, as the app sums them; a currency with no rate is named.
        let total = 0;
        const missing = new Set();
        const byCur = {};
        for (const c of legCosts) {
          const v = usd(c.amount, c.currency);
          byCur[CUR(c.currency)] = Math.round(((byCur[CUR(c.currency)] || 0) + (Number(c.amount) || 0)) * 100) / 100;
          if (v == null) missing.add(CUR(c.currency));
          else total += v;
        }
        moves.push({ id: r.id, kind: 'trip', from: placeOf(leg.from), to: placeOf(leg.to), date: dayOf(leg.date) || dayOf(d.startDate) || '', method: `Personal (${text(d.personName) || 'person'})`, person: text(d.personName), detail: `${n} watch${n === 1 ? '' : 'es'}`, amounts: byCur, usd: legCosts.length ? Math.round(total * 100) / 100 : 0, missing: [...missing], stock_nos: r.stock_nos || [] });
      }
    }
  }
  return {
    as_of: await asOf(),
    places: PLACES,
    available,
    moves,
    rates: rates ? { usd: rates.rates, kind: rates.kind, stale: Boolean(rates.stale) } : null,
    waits: 'Market prices and the AI route recommendation are asked of Claude with the logistics app’s own key, which masterapp does not hold — they wait for the switch-over.',
  };
}

/**
 * What this page knows about one watch: nothing lasting — the route
 * optimizer plans a move from what the other lists say, and keeps no record
 * of its own (the app holds the picked watches in the page only).
 */
export function forStock() {
  return [];
}
