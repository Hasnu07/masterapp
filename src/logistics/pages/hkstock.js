/*
 * HK Stock: the logistics app's "HK Stock" tab — the same stock engine as
 * London and Dubai (`currentStockLoc = 'hk'`, the hkStock rows, corners "In
 * vault" / "With client", spares `hkSpares`) — AND the app's HK situation
 * board (section tab-hksituation, hkSituation rows: a section in hand /
 * incoming / outgoing / sold, a holder, a stock status, movements with their
 * sales), which the app reaches from Need Polish ("↗ Go to HK Situation")
 * and its own flows. Both are on this one tab here, as sub-tabs, so nothing
 * the app shows for Hong Kong is missing. The reader lives in londonstock.js.
 */
import { stockPage, stockFacts } from './londonstock.js';

/** The page's data (GET /api/logistics/page/hkstock): the stock rows, history, spares and the situation board. */
export async function page() {
  return stockPage('hk');
}

/** Where Hong Kong holds the watch now — its corner, consignment, polish, and the board's section and holder. */
export function forStock(stockNo, rows) {
  return stockFacts('hk', stockNo, rows);
}
