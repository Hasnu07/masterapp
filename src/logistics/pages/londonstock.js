/*
 * London Stock: the logistics app's "London Stock" page — the stock in one
 * place right now — read from our copy of its records. The app draws London,
 * Dubai and Hong Kong with ONE engine and a location switch
 * (STOCK_LOC_CONFIG, renderLondonStock / renderLondonCards /
 * renderLondonHistoryContent / renderLondonSpares / printLondonStock), so the
 * three pages share this module: dubaistock.js and hkstock.js import
 * `stockPage` and `stockFacts` with their own place.
 *
 * What the app's page holds, row for row (read from its code):
 *   - the rows with status current or consignment are "in stock" there; a row
 *     with status moved is its History ("London Stock History": moved on,
 *     destination, carrier, accessories taken, spares left — the row's first
 *     movement);
 *   - the stock card: photo, stock number, received date, from, brand, model
 *     with its specs strip (size, case, dial, bezel, movement), reference,
 *     watch date, serial, cost price / B2B / B2C (buyPrice, b2bPrice,
 *     b2cPrice with their currencies), accessories present (+ the pending
 *     collect / give badge from accCollect / accGive of that stock number),
 *     accessories missing, the place's two corners (London: Mayfair / NCL;
 *     Dubai: office / safe; HK: vault / with client), notes, need polish or
 *     at polish with whom, consignment to / from a client, "not in Vault";
 *   - search over stock #, reference, serial, brand, model, from, accessories,
 *     corners and notes; sort newest first (createdAt) or by stock number;
 *   - "Spare Accessories": the place's spares (londonSpares …), grouped by
 *     brand — accessory, qty, from stock, from watch, added, notes.
 *
 * The one rule every tab keeps: a stock number is OUR watch, linked with the
 * clients Chrono Key ties to it by id; a typed name (from, consignment with,
 * a holder) links through linksByName only as far as it goes.
 */
import { query } from '../../db/index.js';
import { oursByNumber, text, ticked, iso, dayOf, picturesOf, NOW_IN_PLACE } from '../shared.js';
import { stockList } from '../kinds.js';
import { linksByName } from '../clients.js';
import { lastLogisticsRead } from '../../import/logistics/sync.js';

/* The app's STOCK_LOC_CONFIG, with the words its page uses for each place. */
export const PLACES = {
  london: { key: 'london', place: 'London', note: 'stock currently in London (Mayfair / NCL)', kind: 'londonStock', spares: 'londonSpares', corners: [['inMayfair', 'In Mayfair'], ['inNcl', 'In NCL']], page: 'londonstock' },
  dubai: { key: 'dubai', place: 'Dubai', note: 'stock currently in Dubai', kind: 'dubaiStock', spares: 'dubaiSpares', corners: [['inOffice', 'In office'], ['inSafe', 'In safe']], page: 'dubaistock' },
  hk: { key: 'hk', place: 'Hong Kong', note: 'stock currently in Hong Kong', kind: 'hkStock', spares: 'hkSpares', corners: [['inVault', 'In vault'], ['withClient', 'With client']], page: 'hkstock' },
};

/* The HK situation board's sections, in the app's order (HK_SECTIONS). */
export const HK_SECTIONS = [
  { key: 'in_hand', title: 'HK Stock (In Hand)', short: 'In hand' },
  { key: 'incoming', title: 'Incomings to HK', short: 'Incoming' },
  { key: 'outgoing', title: 'Going out from HK', short: 'Outgoing' },
  { key: 'sold', title: 'Sold Stock', short: 'Sold' },
];
const hkSectionTitle = (key) => HK_SECTIONS.find((s) => s.key === key)?.title || text(key);

/* When the logistics app was last read — index.js's asOf(), not exported there. */
async function asOf() {
  const { rows } = await query("SELECT finished_at AS at FROM import_runs WHERE source = 'logistics' AND ok ORDER BY started_at DESC LIMIT 1");
  const a = rows[0]?.at ? new Date(rows[0].at) : null;
  const b = lastLogisticsRead();
  return a && b ? (a > b ? a : b) : a || b;
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
/* A price with the currency the app shows for it ("USD" when the row has none, as the app prints `buyCurrency||'USD'`). */
const price = (amount, currency) => (num(amount) ? { amount: num(amount), currency: text(currency) || 'USD' } : null);
const isPolishing = (d) => Boolean(d.polish && d.polish.sentTo && d.polish.status !== 'done');
const needPolish = (d) => d.needPolish === true || d.needPolish === 'true';
/* A moment the app wrote: milliseconds, a day, or "DD/MM/YYYY" — as an ISO day/moment. */
const moment = (v) => dayOf(v) || null;
/* The app's own words for a consignment: "to_client" (or none) is ours out with a client; "from_client" is a client's with us. */
const consignmentOf = (d) => {
  if (!(d.status === 'consignment' || d.consignment?.with)) return null;
  const c = d.consignment || {};
  return {
    with: text(c.with) === '-' ? '' : text(c.with),
    direction: c.direction === 'from_client' ? 'from_client' : 'to_client',
    date: moment(c.date),
    return_date: moment(c.returnDate),
    notes: text(c.notes),
    accessories: text(c.accessories),
  };
};
/* The app writes a move's words in its movements; the first one is the move that took the row out. */
const movementOf = (m) => ({
  id: text(m.id),
  at: moment(m.ts) || moment(m.date),
  day: text(m.date),
  type: text(m.moveType),
  destination: text(m.destination),
  carrier: text(m.carrier),
  taken: Array.isArray(m.takenAccessories) ? m.takenAccessories.map(text).filter(Boolean) : [],
  left: Array.isArray(m.leftSpareAccessories) ? m.leftSpareAccessories.map(text).filter(Boolean) : [],
  notes: text(m.notes),
  returned: Boolean(m.returned),
  photos: ['photos', 'sendingPhotos', 'receivingPhotos', 'deliveryPhotos'].reduce((n, k) => n + (Array.isArray(m[k]) ? m[k].length : 0), 0),
});
const count = (v) => (Array.isArray(v) ? v.length : 0);

/* The app's `_pendingAccBadge`: accCollect / accGive rows of exactly this stock number (trimmed). */
function pendingOf(rows, kind) {
  const by = new Map();
  for (const r of rows.filter((x) => x.kind === kind)) {
    const sn = text(r.data?.stockNumber);
    if (!sn) continue;
    if (!by.has(sn)) by.set(sn, []);
    by.get(sn).push(text(r.data?.items) || 'accessories');
  }
  return (sn) => by.get(sn) || [];
}

/* One stock row as the page shows it. */
function rowView(r, cfg, { ours, link, collect, give }) {
  const d = r.data || {};
  const stock = text(d.stockNumber);
  const cons = consignmentOf(d);
  const status = (d.status || 'current') === 'moved' ? 'moved' : cons ? 'consignment' : 'current';
  const corners = cfg.corners.map(([key, label]) => ({ key, label, value: ticked(d[key]) })).filter((c) => c.value);
  const movements = (Array.isArray(d.movements) ? d.movements : []).map(movementOf);
  const our = ours.get(stock) || null;
  return {
    id: r.id,
    stock_no: stock,
    brand: text(d.brand),
    model: text(d.watchModel),
    reference: text(d.watchReference),
    serial: text(d.watchSerial),
    watch_date: text(d.watchDate),
    from: text(d.from),
    from_link: link(d.from),
    status,
    consignment: cons && { ...cons, with_link: link(cons.with) },
    received_at: moment(d.receivedAt),
    added_at: moment(d.createdAt) || new Date(r.created_at).toISOString(),
    moved_at: status === 'moved' ? moment(d.movedAt) || movements[0]?.at || null : null,
    corners,
    corner: corners.map((c) => (c.value === 'yes' ? c.label.replace(/^In /, '') : `${c.label.replace(/^In /, '')}: ${c.value}`)).join(', '),
    accessories_present: text(d.accessoriesPresent),
    accessories_missing: text(d.accessoriesMissing),
    pending_collect: collect(stock),
    pending_give: give(stock),
    need_polish: needPolish(d),
    polish: isPolishing(d) ? { sent_to: text(d.polish.sentTo), sent_date: moment(d.polish.sentDate), expected_back: moment(d.polish.expectedBack), status: text(d.polish.status) } : null,
    cost: price(d.buyPrice, d.buyCurrency),
    b2b: price(d.b2bPrice, d.b2bCurrency),
    b2c: price(d.b2cPrice, d.b2cCurrency),
    dial: text(d.dial),
    case_material: text(d.caseMaterial),
    case_diameter: text(d.caseDiameter),
    bezel: text(d.bezel),
    movement: text(d.movement),
    complications: text(d.complications),
    notes: text(d.notes),
    hidden_from_vault: d.hideFromVault === true,
    ...picturesOf(d),
    receiving_photos: count(d.receivingPhotos),
    bracelet_photos: count(d.braceletPhotos),
    movements,
    locked: (r.locked_fields || []).length > 0,
    watch: our,
  };
}

/* A spare accessory left behind when a watch moved out (the place's spares list). */
const spareView = (r, ours) => {
  const d = r.data || {};
  const from = text(d.fromStock);
  return {
    id: r.id,
    brand: text(d.brand),
    accessory: text(d.accessory),
    qty: Number(d.qty) || 1,
    from_stock: from,
    from_watch: text(d.fromWatch),
    added_at: moment(d.addedAt) || new Date(r.created_at).toISOString(),
    notes: text(d.notes),
    watch: ours.get(from) || null,
  };
};

/* An HK situation row: the board's own shape (section, holder, stock status), its movements and their sales. */
function hkView(r, { ours, link }) {
  const d = r.data || {};
  const stocks = stockList(d.stockNumber);
  const movements = (Array.isArray(d.movements) ? d.movements : []).map((m) => ({
    id: text(m.id),
    at: moment(m.ts) || moment(m.date),
    day: text(m.date),
    from_section: hkSectionTitle(m.fromSection),
    from_holder: text(m.fromHolder),
    to_section: hkSectionTitle(m.toSection),
    to_holder: text(m.toHolder),
    carrier: text(m.carrier),
    destination: text(m.destination),
    cost: text(m.cost),
    notes: text(m.notes),
    sale: m.sale
      ? {
          client: text(m.sale.clientName),
          client_link: link(m.sale.clientName),
          price: text(m.sale.price),
          brand: text(m.sale.brand),
          given: Array.isArray(m.sale.givenAccessories) ? m.sale.givenAccessories.map(text).filter(Boolean) : [],
          still_owed: Array.isArray(m.sale.remainingAccessories) ? m.sale.remainingAccessories.map(text).filter(Boolean) : [],
        }
      : null,
    photos: ['deliveryPhotos', 'receivingPhotos'].reduce((n, k) => n + (Array.isArray(m[k]) ? m[k].length : 0), 0),
  }));
  const section = HK_SECTIONS.some((s) => s.key === d.section) ? d.section : '';
  return {
    id: r.id,
    stock_no: text(d.stockNumber),
    stock_nos: stocks,
    brand: text(d.brand),
    description: text(d.description),
    holder: text(d.holder),
    holder_link: link(d.holder),
    section,
    section_title: section ? hkSectionTitle(section) : '',
    stock_status: text(d.stockStatus),
    notes: text(d.notes),
    added_at: moment(d.createdAt) || new Date(r.created_at).toISOString(),
    linked_shipment: text(d.linkedShipmentId),
    accessories_present: text(d.accessoriesPresent),
    accessories_missing: text(d.accessoriesMissing),
    ...picturesOf(d),
    movements,
    locked: (r.locked_fields || []).length > 0,
    // Every watch the row names (an incoming group names several), ours where we hold it.
    watches: stocks.map((s) => ours.get(s) || null),
    watch: stocks.map((s) => ours.get(s)).find(Boolean) || null,
  };
}

/**
 * The page for one place (GET /api/logistics/page/<key>): what is in stock
 * there now, its history (rows moved out), its spare accessories, and for
 * Hong Kong the HK situation board too.
 */
export async function stockPage(loc) {
  const cfg = PLACES[loc];
  const kinds = [cfg.kind, cfg.spares, 'accCollect', 'accGive', ...(loc === 'hk' ? ['hkSituation'] : [])];
  const { rows } = await query('SELECT * FROM logistics_items WHERE kind = ANY($1) AND deleted_at IS NULL ORDER BY id', [kinds]);
  const of = (kind) => rows.filter((r) => r.kind === kind);
  const stockRows = of(cfg.kind);
  const hkRows = of('hkSituation');
  const spareRows = of(cfg.spares);

  const ours = await oursByNumber([
    ...stockRows.flatMap((r) => r.stock_nos || []),
    ...hkRows.flatMap((r) => r.stock_nos || []),
    ...spareRows.map((r) => text(r.data?.fromStock)).filter(Boolean),
  ]);
  const names = await linksByName([
    ...stockRows.flatMap((r) => [r.data?.from, r.data?.consignment?.with]),
    ...hkRows.flatMap((r) => [r.data?.holder, ...(Array.isArray(r.data?.movements) ? r.data.movements.map((m) => m?.sale?.clientName) : [])]),
  ]);
  const link = (name) => (text(name) ? names.get(text(name)) || null : null);
  const ctx = { ours, link, collect: pendingOf(rows, 'accCollect'), give: pendingOf(rows, 'accGive') };

  const all = stockRows.map((r) => rowView(r, cfg, ctx));
  // Newest first, as the app's default sort (createdAt, else the order they came in).
  const byAdded = (a, b) => String(b.added_at || '').localeCompare(String(a.added_at || '')) || b.id - a.id;
  const watches = all.filter((w) => w.status !== 'moved').sort(byAdded);
  const history = all.filter((w) => w.status === 'moved').sort((a, b) => String(b.moved_at || '').localeCompare(String(a.moved_at || '')) || b.id - a.id);
  const spares = spareRows.map((r) => spareView(r, ours)).sort((a, b) => a.brand.localeCompare(b.brand) || String(b.added_at).localeCompare(String(a.added_at)));

  const counts = {
    in_stock: watches.length,
    plain: watches.filter((w) => w.status === 'current').length,
    consignment_to: watches.filter((w) => w.consignment?.direction === 'to_client').length,
    consignment_from: watches.filter((w) => w.consignment?.direction === 'from_client').length,
    need_polish: watches.filter((w) => w.need_polish && !w.polish).length,
    at_polish: watches.filter((w) => w.polish).length,
    ours: watches.filter((w) => w.watch).length,
    corners: cfg.corners.map(([key, label]) => ({ key, label, n: watches.filter((w) => w.corners.some((c) => c.key === key)).length })),
    moved: history.length,
    spares: spares.length,
    spare_items: spares.reduce((n, s) => n + s.qty, 0),
  };

  const out = {
    as_of: await asOf(),
    place: cfg.place,
    key: cfg.key,
    note: cfg.note,
    corners: cfg.corners.map(([key, label]) => ({ key, label })),
    watches,
    history,
    spares,
    counts,
  };
  if (loc === 'hk') {
    const board = hkRows.map((r) => hkView(r, ctx));
    // The app's default order: by section (in hand, incoming, outgoing, sold); a row with no section last.
    const order = (s) => {
      const i = HK_SECTIONS.findIndex((x) => x.key === s);
      return i < 0 ? HK_SECTIONS.length : i;
    };
    board.sort((a, b) => order(a.section) - order(b.section) || String(b.added_at).localeCompare(String(a.added_at)));
    out.situation = {
      rows: board,
      sections: [...HK_SECTIONS.map((s) => ({ ...s, n: board.filter((r) => r.section === s.key).length })), ...(board.some((r) => !r.section) ? [{ key: '', title: 'No section', short: 'No section', n: board.filter((r) => !r.section).length }] : [])],
      holders: [...new Set(board.map((r) => r.holder).filter(Boolean))].sort(),
    };
  }
  return out;
}

export async function page() {
  return stockPage('london');
}

/* ── what the page knows about one watch ─────────────────────────── */

const DAY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayWords = (v) => {
  const s = dayOf(v) || '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${DAY_MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
};
const cornerWords = (cfg, d) =>
  cfg.corners
    .map(([key, label]) => {
      const v = ticked(d[key]);
      return v && (v === 'yes' ? label.replace(/^In /, '') : `${label.replace(/^In /, '')}: ${v}`);
    })
    .filter(Boolean)
    .join(', ');

/**
 * Where this place holds the watch now, for its Inventory card and its page:
 * in the place (its corner, since when), on consignment to / from a client,
 * at polish or needing one, what is missing — and for Hong Kong the board's
 * section and holder. A row moved out is history: nothing to say here.
 */
export function stockFacts(loc, stockNo, rows) {
  const cfg = PLACES[loc];
  const sn = text(stockNo);
  const facts = [];
  const mine = (rows || []).filter((r) => r.kind === cfg.kind && !r.deleted_at && stockList(r.data?.stockNumber).includes(sn) && (r.data?.status || 'current') !== 'moved');
  // The newest row there, should the app list the watch twice.
  mine.sort((a, b) => String(moment(b.data?.receivedAt) || moment(b.data?.createdAt) || '').localeCompare(String(moment(a.data?.receivedAt) || moment(a.data?.createdAt) || '')));
  const row = mine[0];
  if (row) {
    const d = row.data || {};
    const link = `#/lg/${row.id}`;
    const cons = consignmentOf(d);
    const since = dayWords(d.receivedAt);
    const corner = cornerWords(cfg, d);
    if (cons && cons.direction === 'from_client') {
      facts.push({ text: `In ${cfg.place} on consignment from ${cons.with || 'a client'}${cons.date ? ` since ${dayWords(cons.date)}` : ''}`, link, tone: 'warn' });
    } else if (cons) {
      facts.push({ text: `On consignment with ${cons.with || 'a client'} from ${cfg.place}${cons.date ? ` since ${dayWords(cons.date)}` : ''}${cons.return_date ? `, due back ${dayWords(cons.return_date)}` : ''}`, link, tone: 'warn' });
    } else {
      facts.push({ text: `In ${cfg.place}${corner ? ` (${corner})` : ''}${since ? ` since ${since}` : ''}`, link, tone: 'good' });
    }
    if (isPolishing(d)) facts.push({ text: `At polish with ${text(d.polish.sentTo)}${d.polish.sentDate ? ` since ${dayWords(d.polish.sentDate)}` : ''}${d.polish.expectedBack ? `, back ${dayWords(d.polish.expectedBack)}` : ''}`, link, tone: 'warn' });
    else if (needPolish(d)) facts.push({ text: 'Needs polish', link, tone: 'warn' });
    if (text(d.accessoriesMissing)) facts.push({ text: `Missing: ${text(d.accessoriesMissing)}`, link, tone: 'bad' });
  }
  if (loc === 'hk') {
    const board = (rows || []).filter((r) => r.kind === 'hkSituation' && !r.deleted_at && stockList(r.data?.stockNumber).includes(sn));
    board.sort((a, b) => String(moment(b.data?.createdAt) || '').localeCompare(String(moment(a.data?.createdAt) || '')));
    const h = board[0];
    if (h) {
      const d = h.data || {};
      const link = `#/lg/${h.id}`;
      const who = text(d.holder) && `held by ${text(d.holder)}`;
      const status = text(d.stockStatus);
      const bits = [who, status].filter(Boolean).join(', ');
      const words = { in_hand: 'In Hong Kong, in hand', incoming: 'On its way to Hong Kong', outgoing: 'Going out from Hong Kong', sold: 'Sold in Hong Kong' }[d.section] || 'On the HK board';
      const sale = d.section === 'sold' ? [...(Array.isArray(d.movements) ? d.movements : [])].reverse().find((m) => m?.sale)?.sale : null;
      facts.push({
        text: `${words}${sale?.clientName ? ` to ${text(sale.clientName)}` : ''}${bits ? ` — ${bits}` : ''}`,
        link,
        tone: d.section === 'in_hand' ? 'good' : d.section === 'sold' ? '' : 'move',
      });
    }
  }
  return facts;
}

export function forStock(stockNo, rows) {
  return stockFacts('london', stockNo, rows);
}
