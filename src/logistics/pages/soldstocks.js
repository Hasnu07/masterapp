/*
 * Sold Stocks: the logistics app's "Sold Stocks" page (its renderSoldStocks
 * and openSoldDetail), read from our copy of its records.
 *
 * A `soldStocks` row is a delivered sale (the app's finalizeReadyAsSold): the
 * watch's spec, `originKey` / `originLocation` (london · dubai · hk ·
 * incomings — where it was sold from), `soldPrice` + `soldCurrency`,
 * `soldDate`, `soldToBuyer` (a typed name), `soldFromLocation`, `soldNotes`,
 * `deliveredVia` (in_person · shipment · held_in_safe), `shipmentId`,
 * `deliveredAt` (milliseconds), `deliveryNotes`, `photos` (the sale's),
 * `deliveryPhotos`, and `originRow` — the stock row as it was at the sale
 * (its accessories, corner, watch date, needPolish: the app's "condition at
 * sale"). `soldPriceUsd` is the app's own dollar figure from its fixed
 * table; the page converts at the converter's rates instead and keeps the
 * app's figure beside it.
 *
 * The P&L is the app's: revenue less every cost its costsForStock finds for
 * the stock number — situation.costs here, line for line (logistic costs,
 * shipments, a trip's share, the purchase from the incoming). Amounts stay
 * in their own currency; the dollars are worked out in the console at the
 * rates given here, over the rows shown, as the app sums the rows filtered.
 *
 * Every row is OUR watch — sold on Chrono Key too: our sale price and the
 * client it was sold to (by id) sit beside the app's typed buyer, who links
 * through linksByName; never merged by name. Ready for delivery (sold, not
 * yet handed over) is the Shipments tab's — linked, not rebuilt. Set the
 * delivery date, send to polish, hold in the safe, cancel the sale, delete,
 * fetch a picture: the app's buttons that change records; a row opens its
 * record here.
 */
import { query } from '../../db/index.js';
import { oursByNumber, text, iso, dayOf, picturesOf, photoPrefix } from '../shared.js';
import * as situation from '../situation.js';
import { linksByName } from '../clients.js';
import { getRates } from '../../rates/index.js';

const ORIGIN = { london: 'London', dubai: 'Dubai', hk: 'Hong Kong', incomings: 'Incomings' };
/* The app's originLocation carries a flag; the key says the place. */
export const originOf = (d) => ORIGIN[text(d.originKey)] || text(d.originLocation).replace(/[^\p{L}\p{N} ]/gu, '').trim();

/* The pictures a list holds that this app can serve (copied, or still on the worker). */
function pics(list) {
  const prefix = photoPrefix();
  return (Array.isArray(list) ? list : []).filter((v) => typeof v === 'string' && (/^lgfile:\d+$/.test(v) || (prefix && v.startsWith(prefix))));
}
/* A typed accessories list, or the app's array form, as words. */
const listOf = (v) =>
  (Array.isArray(v) ? v : String(v ?? '').split(/[,\n]+/)).map((x) => text(typeof x === 'object' && x ? x.name || x.accessory : x)).filter(Boolean);

/*
 * The converter's rates, with a cap on the wait (copied from ratesSoon in
 * src/logistics/index.js, which is not exported): the fresh table when it
 * comes within 1.5 s, else the last one, marked stale; none the first time.
 */
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

/** The page's data (GET /api/logistics/page/soldstocks). */
export async function page() {
  const { rows } = await query("SELECT * FROM logistics_items WHERE kind = 'soldStocks' AND deleted_at IS NULL ORDER BY id");
  const nos = [...new Set(rows.flatMap((r) => r.stock_nos || []))];
  const shipmentIds = [...new Set(rows.map((r) => text(r.data?.shipmentId)).filter(Boolean))];
  const [ours, people, sales, related, ships, ready, r] = await Promise.all([
    oursByNumber(nos),
    linksByName(rows.map((x) => text(x.data?.soldToBuyer)).filter(Boolean)),
    nos.length ? query('SELECT stock_no, sale_price, sale_currency, sale_date FROM watches WHERE stock_no = ANY($1) AND deleted_at IS NULL', [nos]) : { rows: [] },
    // What the P&L adds up: every record that names one of these watches (situation.costs reads costs, shipments, trips, incomings).
    nos.length
      ? query("SELECT * FROM logistics_items WHERE deleted_at IS NULL AND kind IN ('logisticCosts','shipments','personTrips','incomings') AND stock_nos && $1::text[]", [nos])
      : { rows: [] },
    shipmentIds.length ? query("SELECT id, source_id FROM logistics_items WHERE kind = 'shipments' AND source_id = ANY($1)", [shipmentIds]) : { rows: [] },
    query("SELECT count(*)::int AS n FROM logistics_items WHERE kind = 'readyForDelivery' AND deleted_at IS NULL"),
    ratesSoon(),
  ]);
  const saleOf = new Map(sales.rows.map((w) => [w.stock_no, w]));
  const shipOf = new Map(ships.rows.map((s) => [s.source_id, s.id]));
  const currencies = new Set(['USD']);

  const list = rows.map((x) => {
    const d = x.data || {};
    const stock = text(d.stockNumber);
    const orig = d.originRow && typeof d.originRow === 'object' ? d.originRow : {};
    const buyer = text(d.soldToBuyer);
    const mine = stock ? related.rows.filter((i) => (i.stock_nos || []).includes(stock)) : [];
    const costs = stock ? situation.costs(stock, mine).lines : [];
    for (const c of costs) currencies.add(c.currency);
    const currency = text(d.soldCurrency).toUpperCase();
    if (currency) currencies.add(currency);
    const our = ours.get(stock) || null;
    const sale = saleOf.get(stock);
    const salePics = pics(d.photos);
    const beforePics = pics(orig.photos);
    const deliveryPics = pics(d.deliveryPhotos);
    const corner = [orig.inMayfair && 'Mayfair', orig.inNcl && 'Newcastle', orig.inOffice && 'Office', orig.inSafe && 'Safe'].filter(Boolean).join(', ');
    return {
      id: x.id,
      stock_no: stock,
      brand: text(d.brand),
      model: text(d.watchModel),
      reference: text(d.watchReference),
      serial: text(d.watchSerial),
      watch_date: text(d.watchDate),
      origin_key: text(d.originKey),
      origin: originOf(d),
      sold_date: dayOf(d.soldDate) || '',
      delivered_at: iso(d.deliveredAt),
      delivered_via: text(d.deliveredVia),
      shipment_item_id: shipOf.get(text(d.shipmentId)) || null,
      buyer,
      buyer_link: (buyer && people.get(buyer)) || null,
      sold_from: text(d.soldFromLocation),
      price: Number(d.soldPrice) || 0,
      currency,
      // The app's own dollar figure, from its fixed table — kept to compare, never summed here.
      price_usd_app: Number(d.soldPriceUsd) || 0,
      notes: text(d.soldNotes),
      delivery_notes: text(d.deliveryNotes),
      picture: salePics[0] || beforePics[0] || deliveryPics[0] || null,
      photos: { sale: salePics.length, before: beforePics.length, delivery: deliveryPics.length },
      condition: {
        watch_date: text(orig.watchDate),
        place: corner,
        need_polish: orig.needPolish === true || text(orig.needPolish) === 'true',
        present: listOf(orig.accessoriesPresent),
        missing: listOf(orig.accessoriesMissing),
      },
      costs,
      locked: (x.locked_fields || []).length > 0,
      watch: our && {
        ...our,
        sale_price: sale?.sale_price === null || sale?.sale_price === undefined ? null : Number(sale.sale_price),
        sale_currency: sale?.sale_currency || null,
        sale_date: sale?.sale_date ? String(sale.sale_date).slice(0, 10) : null,
      },
    };
  });

  return {
    rows: list,
    ready_for_delivery: ready.rows[0]?.n || 0,
    rates: r ? { kind: r.kind, stale: Boolean(r.stale), table: Object.fromEntries([...currencies].filter((c) => r.rates[c]).map((c) => [c, r.rates[c]])) } : null,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayWords = (v) => {
  const t = situation.when(v);
  if (!t) return '';
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const VIA = { in_person: 'by hand', shipment: 'by shipment', held_in_safe: 'held in our safe' };

/**
 * What this page knows about one watch: "Sold to B on …, delivered by hand
 * on …"; a sale with no delivery date yet; and "awaiting delivery" from the
 * app's Ready for delivery list (the Shipments tab's).
 */
export function forStock(stockNo, rows, ctx) {
  const out = [];
  for (const r of rows || []) {
    const d = r.data || {};
    if (r.kind !== 'soldStocks' && r.kind !== 'readyForDelivery') continue;
    const buyer = text(d.soldToBuyer);
    const sold = `Sold${buyer ? ` to ${buyer}` : ''}${d.soldDate ? ` on ${dayWords(d.soldDate)}` : ''}`;
    if (r.kind === 'readyForDelivery') {
      out.push({ text: `${sold} · awaiting delivery${d.status === 'shipped' ? ' (shipped)' : ''}`, link: '#/logistics/shipments', tone: 'move' });
      continue;
    }
    const via = VIA[text(d.deliveredVia)] || '';
    const when = dayWords(d.deliveredAt);
    out.push({
      text: when ? `${sold} · delivered${via ? ` ${via}` : ''} on ${when}` : `${sold} · delivery date not set`,
      link: '#/logistics/soldstocks',
      tone: when ? 'good' : 'warn',
    });
  }
  return out;
}
