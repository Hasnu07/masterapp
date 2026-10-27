/*
 * Dubai Stock: the logistics app's "Dubai Stock" page — the same engine as
 * London with the location switched (`currentStockLoc = 'dubai'`; its
 * corners are the office and the safe, its spares `dubaiSpares`). The
 * reader lives in londonstock.js, as it does in the app.
 */
import { stockPage, stockFacts } from './londonstock.js';

/** The page's data (GET /api/logistics/page/dubaistock). */
export async function page() {
  return stockPage('dubai');
}

/** Where Dubai holds the watch now — its corner, since when, consignment, polish, what is missing. */
export function forStock(stockNo, rows) {
  return stockFacts('dubai', stockNo, rows);
}
