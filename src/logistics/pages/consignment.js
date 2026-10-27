/*
 * In Consignment: the logistics app's "In Consignment" page (its
 * renderConsignment), read from our copy of its records.
 *
 * Where consignment lives in the app's data (read from its code, not
 * guessed — confirmStockConsignment, renderConsignment, printConsignment):
 *   - a London or Dubai stock row with `status: 'consignment'` and a
 *     `consignment` object: `direction` ('to_client' = our watch, the client
 *     holds it; 'from_client' = the client's watch, we hold it — the app's
 *     default when unset is to_client), `with` (a typed name), `date` (sent /
 *     received, YYYY-MM-DD), `accessories` (typed), `returnDate`, `notes`,
 *     `photosBefore` (pictures taken when it went). A row that moved on keeps
 *     the object but its status is no longer 'consignment' — history, not
 *     here. The app leaves out a row whose id a sale (Ready for delivery or
 *     Sold) carries as its `originRow.id` — the sold row not yet taken out
 *     of the stock list — and so do we.
 *   - an incoming with `status: 'consignment'`: the supplier holds the
 *     watch; `supplier`, `location`, `accessoriesPresent`, `eta`, `notes`.
 * HK stock has the same status option but the app's page never reads it —
 * neither does this one.
 *
 * Every stock number is OUR watch, with its clients by Chrono Key's ids; the
 * typed "with" / supplier is linked through linksByName (our client only as
 * that logistics client is — by its watches). "Our Watch → Client", "Client
 * Watch → Us", Move back, Sold, Cost, edit and delete change records in the
 * app: here a row opens its record. Print / PDF is built in the console.
 */
import { query } from '../../db/index.js';
import { context, oursByNumber, text, dayOf, picturesOf, photoPrefix } from '../shared.js';
import { linksByName } from '../clients.js';

const PLACE = { londonStock: 'London', dubaiStock: 'Dubai' };

/* The pictures a list holds that this app can serve (copied, or still on the worker). */
function pics(list) {
  const prefix = photoPrefix();
  return (Array.isArray(list) ? list : []).filter((v) => typeof v === 'string' && (/^lgfile:\d+$/.test(v) || (prefix && v.startsWith(prefix))));
}

const direction = (c) => (c?.direction === 'from_client' ? 'from_client' : 'to_client');

/** The page's data (GET /api/logistics/page/consignment). */
export async function page() {
  const [{ rows }, { rows: sales }] = await Promise.all([
    query(
      `SELECT * FROM logistics_items
        WHERE deleted_at IS NULL AND data->>'status' = 'consignment'
          AND kind IN ('londonStock', 'dubaiStock', 'incomings')
        ORDER BY id`
    ),
    // The app's safety net: a stock row a sale still names as its origin is sold, not on consignment.
    query(
      `SELECT data->'originRow'->>'id' AS oid FROM logistics_items
        WHERE deleted_at IS NULL AND kind IN ('readyForDelivery', 'soldStocks') AND data->'originRow' ? 'id'`
    ),
  ]);
  const soldOrigins = new Set(sales.map((s) => s.oid).filter(Boolean));
  const stock = rows.filter((r) => r.kind !== 'incomings' && !(r.source_id && soldOrigins.has(r.source_id)));
  const incomings = rows.filter((r) => r.kind === 'incomings');
  const [ours, people] = await Promise.all([
    oursByNumber(rows.flatMap((r) => r.stock_nos || [])),
    linksByName([...stock.map((r) => text(r.data?.consignment?.with)), ...incomings.map((r) => text(r.data?.supplier))].filter((n) => n && n !== '-')),
  ]);
  const watchOf = (r) => (r.stock_nos || []).map((s) => ours.get(s)).find(Boolean) || null;
  const byNumber = (a, b) => text(a.stock_no).localeCompare(text(b.stock_no));

  const owned = stock
    .map((r) => {
      const d = r.data || {};
      const c = d.consignment || {};
      const before = pics(c.photosBefore);
      const own = picturesOf(d);
      const name = text(c.with);
      return {
        id: r.id,
        kind: r.kind,
        place: PLACE[r.kind] || r.kind,
        stock_no: text(d.stockNumber),
        brand: text(d.brand),
        model: text(d.watchModel),
        reference: text(d.watchReference),
        serial: text(d.watchSerial),
        watch_date: text(d.watchDate),
        direction: direction(c),
        with: name === '-' ? '' : name,
        with_link: (name && people.get(name)) || null,
        date: dayOf(c.date) || '',
        accessories: text(c.accessories),
        return_by: dayOf(c.returnDate) || '',
        notes: text(c.notes),
        // The app shows the "before" pictures first, else the row's own.
        picture: before[0] || own.picture,
        photo_count: before.length || own.photo_count,
        before: before.length > 0,
        locked: (r.locked_fields || []).length > 0,
        watch: watchOf(r),
      };
    })
    .sort(byNumber);

  const incoming = incomings
    .map((r) => {
      const d = r.data || {};
      const supplier = text(d.supplier);
      return {
        id: r.id,
        kind: r.kind,
        stock_no: text(d.stockNumber),
        brand: text(d.brand),
        reference: text(d.reference),
        serial: text(d.serial),
        supplier,
        supplier_link: (supplier && people.get(supplier)) || null,
        location: text(d.location),
        accessories: text(d.accessoriesPresent),
        eta: dayOf(d.eta) || text(d.eta),
        notes: text(d.notes),
        ...picturesOf(d),
        locked: (r.locked_fields || []).length > 0,
        watch: watchOf(r),
      };
    })
    .sort((a, b) => a.location.localeCompare(b.location) || byNumber(a, b));

  return {
    incoming,
    to_client: owned.filter((r) => r.direction === 'to_client'),
    from_client: owned.filter((r) => r.direction === 'from_client'),
  };
}

/* Today on the business's calendar (Dubai), as the app compares a return date with the day. */
const today = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayWords = (s) => {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}` : String(s || '');
};

/**
 * What this page knows about one watch, for its Inventory card and its page:
 * "On consignment with X since …" / "X's watch, held on consignment since …"
 * / "Consignment coming in from …" — overdue when its return date has passed.
 */
export function forStock(stockNo, rows, ctx) {
  const out = [];
  const link = '#/logistics/consignment';
  for (const r of rows || []) {
    const d = r.data || {};
    if (text(d.status) !== 'consignment') continue;
    if (r.kind === 'londonStock' || r.kind === 'dubaiStock') {
      const c = d.consignment || {};
      const name = text(c.with);
      const who = name && name !== '-' ? name : 'a client';
      const since = dayOf(c.date);
      const back = dayOf(c.returnDate);
      const overdue = Boolean(back && back.slice(0, 10) < today());
      const words = direction(c) === 'from_client' ? `${who}'s watch, held on consignment` : `On consignment with ${who}`;
      out.push({
        text: [`${words}${since ? ` since ${dayWords(since)}` : ''}`, back && `${overdue ? 'was due back' : 'due back'} ${dayWords(back)}`].filter(Boolean).join(' · '),
        link,
        tone: overdue ? 'bad' : 'warn',
      });
    } else if (r.kind === 'incomings') {
      const supplier = text(d.supplier);
      out.push({ text: `Consignment coming in${supplier ? ` from ${supplier}` : ''}${d.location ? ` · now in ${text(d.location)}` : ''}`, link, tone: 'move' });
    }
  }
  return out;
}
