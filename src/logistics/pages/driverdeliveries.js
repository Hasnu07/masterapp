/*
 * Driver Deliveries: the logistics app's "Driver Deliveries" page (its
 * renderDriverDeliveries) — watches handed to a driver to deliver and to
 * collect money. The app shows three figures (out with drivers, delivered,
 * money collected in dollars), then two tables: Out with driver (stock,
 * driver, given, destination, notes, the photos taken at the handover) and
 * Delivered history (delivered to, where, when, money collected, the proof
 * photos). A record is 'out' until marked delivered — the app's own rule
 * (`status !== 'delivered'`), so one typed 'returned' still counts as out.
 *
 * Money collected is added up in dollars at the converter's rates, not the
 * app's fixed table (as the Overview does). The rule every tab keeps: a stock
 * number is OUR watch, with the clients Chrono Key ties to it — the buyer
 * the driver delivers to is the sold-to client by id; the typed driver,
 * destination and "delivered to" link through linksByName.
 *
 * Marking delivered, the WhatsApp message and deleting change records or
 * send messages: they wait for the switch-over — a row opens its record.
 */
import { query } from '../../db/index.js';
import { oursByNumber, text, dayOf } from '../shared.js';
import { stockList } from '../kinds.js';
import { linksByName } from '../clients.js';
import { getRates } from '../../rates/index.js';
import { photoRefs } from './goldsouk.js';

/*
 * The converter's rates without holding the page up — copied from
 * ratesSoon() in src/logistics/index.js (not exported): a slow or failing
 * rate source gets a second and a half, then the last table seen is used,
 * marked not fresh, or none the first time.
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

const CURRENCY = /^[A-Za-z]{3,4}$/;
const amountOf = (v) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function rowOf(r, ours, links) {
  const d = r.data || {};
  const link = (name) => links.get(name) || null;
  const stockText = text(d.stockNumbers ?? d.stockNumber);
  const nos = stockList(stockText);
  const driver = text(d.driverName);
  const destination = text(d.destination);
  const to = text(d.deliveredTo);
  const money = amountOf(d.moneyCollected);
  const cur = text(d.moneyCurrency).toUpperCase();
  return {
    id: r.id,
    status: d.status === 'delivered' ? 'delivered' : 'out',
    status_word: text(d.status) || 'out',
    driver,
    driver_link: link(driver),
    date_given: dayOf(d.dateGiven) || dayOf(d.ts),
    stock_text: stockText,
    // Each number as typed, with our watch when it is one ("DAV Links" or "xanco" is no watch and stays words).
    stocks: nos.map((no) => ({ no, watch: ours.get(no) || null })),
    destination,
    destination_link: link(destination),
    notes: text(d.notes),
    given_photos: photoRefs(d.givenPhotos),
    delivered_to: to,
    delivered_to_link: link(to),
    delivery_location: text(d.deliveryLocation),
    delivered_date: dayOf(d.deliveredDate),
    money: money ? { amount: money, currency: CURRENCY.test(cur) ? cur : '' } : null,
    delivery_notes: text(d.deliveryNotes),
    delivery_photos: photoRefs(d.deliveryPhotos),
    locked: (r.locked_fields || []).length > 0,
    ts: Number(d.ts) || 0,
  };
}

/** The page's data (GET /api/logistics/page/driverdeliveries). */
export async function page() {
  const { rows } = await query("SELECT * FROM logistics_items WHERE kind = 'driverDeliveries' AND deleted_at IS NULL ORDER BY id");
  const names = rows.flatMap((r) => [text(r.data?.driverName), text(r.data?.destination), text(r.data?.deliveredTo)]);
  const [ours, links, rates] = await Promise.all([oursByNumber(rows.flatMap((r) => r.stock_nos || [])), linksByName(names), ratesSoon()]);
  const all = rows.map((r) => rowOf(r, ours, links));
  // The app keeps the newest first.
  const byNew = (a, b) => String(b.date_given || '').localeCompare(String(a.date_given || '')) || b.ts - a.ts || b.id - a.id;
  const out = all.filter((x) => x.status === 'out').sort(byNew);
  const delivered = all.filter((x) => x.status === 'delivered').sort((a, b) => String(b.delivered_date || '').localeCompare(String(a.delivered_date || '')) || byNew(a, b));

  // Money collected: each currency's own total, and all of it in dollars at the converter's rates.
  const byCurrency = {};
  for (const x of delivered) {
    if (!x.money) continue;
    const c = x.money.currency || 'OTHER';
    byCurrency[c] = Math.round(((byCurrency[c] || 0) + x.money.amount) * 100) / 100;
  }
  let usd = null;
  const missing = [];
  if (rates?.rates?.USD) {
    usd = 0;
    for (const [c, amount] of Object.entries(byCurrency)) {
      if (rates.rates[c]) usd += (amount / rates.rates[c]) * rates.rates.USD;
      else missing.push(c);
    }
    usd = Math.round(usd);
  }
  return {
    counts: { out: out.length, delivered: delivered.length },
    money: { by_currency: byCurrency, usd, missing, rates: rates ? { kind: rates.kind, stale: Boolean(rates.stale) } : null },
    out,
    delivered,
  };
}

/**
 * What this page knows about one watch: out — "With driver Fiaz to Parsa
 * since 23 Jun 2026 — <notes>"; delivered — "Delivered by driver Fiaz to
 * Parsa, 23 Jun 2026, collected AED 400,000".
 */
export function forStock(stockNo, rows) {
  const out = [];
  for (const r of rows) {
    if (r.kind !== 'driverDeliveries' || !(r.stock_nos || []).includes(stockNo)) continue;
    const d = r.data || {};
    const driver = text(d.driverName);
    if (d.status === 'delivered') {
      const money = amountOf(d.moneyCollected);
      const cur = text(d.moneyCurrency).toUpperCase();
      const to = text(d.deliveredTo) || text(d.destination);
      out.push({
        text: `Delivered by driver ${driver || '?'}${to ? ` to ${to}` : ''}${d.deliveredDate ? `, ${day(d.deliveredDate)}` : ''}${money ? `, collected ${cur ? `${cur} ` : ''}${money.toLocaleString('en-GB')}` : ''}`,
        link: `#/lg/${r.id}`,
        tone: 'good',
      });
    } else {
      const dest = text(d.destination);
      const notes = text(d.notes);
      out.push({
        text: `With driver ${driver || '?'}${dest ? ` to ${dest}` : ''}${d.dateGiven ? ` since ${day(d.dateGiven)}` : ''}${notes ? ` — ${notes}` : ''}`,
        link: `#/lg/${r.id}`,
        tone: 'move',
      });
    }
  }
  return out;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* A day in words, "23 Jun 2026", from YYYY-MM-DD or DD/MM/YYYY; anything else as typed. */
export function day(v) {
  const s = text(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${Number(m[1])} ${MONTHS[Number(m[2]) - 1] || m[2]} ${m[3]}`;
  return s;
}
