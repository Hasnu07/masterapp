import { KIND, stockList } from './kinds.js';

/*
 * Where a watch is and what is happening to it, worked out from every
 * logistics record that names its stock number.
 *
 * The logistics app has no "where is it now" of its own — its Stock Passport
 * lists the records and leaves the reading to whoever looks. The order below
 * is the one its own flows imply:
 *
 *   sold (and maybe delivered)  →  sold, waiting for delivery  →  checked out
 *   →  in a place (London, Dubai, Hong Kong, the safe), maybe on consignment
 *      or at polish  →  the HK situation list  →  on its way in (incoming)
 *
 * and on top of whichever it is, what is moving it: a shipment not yet
 * delivered, a mover, a trip, a driver, accessories still to give or collect.
 *
 * Everything here is a pure function of the records, so it is tested without
 * a database and gives the same answer on the watch page and in a list.
 */

/** A moment as milliseconds: the app keeps both epoch ms and "YYYY-MM-DD" (and sometimes "DD/MM/YYYY"). */
export function when(v) {
  const t = rawWhen(v);
  // A number no calendar holds (typed by hand, or a stray id) is no moment: new Date() of it would throw.
  return t !== null && Number.isFinite(new Date(t).getTime()) ? t : null;
}

function rawWhen(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  const s = String(v).trim();
  if (/^\d{10,13}$/.test(s)) return Number(s);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const day = (v) => {
  const t = when(v);
  return t ? new Date(t).toISOString().slice(0, 10) : '';
};

const NO_CONTEXT = { client: () => '', route: () => '', stage: () => ({ label: '' }) };

/** A record's own date — shipped, sold, received, given — as a Date, or null: what "newest first" sorts by. */
export function happenedAt(kind, d) {
  let v;
  try {
    v = KIND[kind]?.summary(d || {}, NO_CONTEXT)?.date;
  } catch {
    v = null;
  }
  const t = when(v ?? d?.ts ?? d?.date ?? d?.createdAt);
  return t ? new Date(t) : null;
}

/* ── shipments: the carrier knows more than a status somebody set by hand ── */

const STAGES = {
  booked: 'Booked',
  picked_up: 'Picked up',
  in_transit: 'In transit',
  customs: 'At customs',
  delivered: 'Delivered',
};

/* FedEx's derived codes first — unambiguous — then the words (DHL, and anything else). The logistics app's own rules. */
export function stageFrom(code, text) {
  const c = String(code || '').toUpperCase();
  if (c === 'DL') return 'delivered';
  if (c === 'DE' || c === 'SE' || c === 'CA') return 'exception';
  if (c === 'PU') return 'picked_up';
  if (c === 'OC') return 'booked';
  if (['CC', 'CD', 'CH', 'CP'].includes(c)) return 'customs';
  if (['IT', 'AR', 'DP', 'AF', 'OD', 'TR', 'RR'].includes(c)) return 'in_transit';
  const t = String(text || '').toLowerCase();
  if (/delivered/.test(t)) return 'delivered';
  if (/exception|undeliverable|return to|held|refused|damaged|missed/.test(t)) return 'exception';
  if (/customs|clearance|duty|import/.test(t)) return 'customs';
  if (/picked up|pickup/.test(t)) return 'picked_up';
  if (/transit|departed|arrived|out for delivery|on vehicle|on the way|at destination|facility/.test(t)) return 'in_transit';
  if (/label|information sent|shipment information|order (created|processed)|booked/.test(t)) return 'booked';
  return '';
}

/** What the carrier last said about a shipment, whichever carrier it was. */
export function tracking(s) {
  const fx = s?.fedex?.lastStatus;
  if (fx && !fx.error) {
    const stage = stageFrom(fx.derivedCode || fx.statusCode, fx.status);
    return {
      carrier: 'FedEx',
      label: fx.status || '',
      stage: fx.delivered ? 'delivered' : stage || 'in_transit',
      location: fx.location || '',
      eta: fx.estimatedDelivery || '',
      delivered: Boolean(fx.delivered),
      asOf: when(s.fedexUpdatedAt),
    };
  }
  const dl = s?.dhl;
  if (dl && typeof dl === 'object') {
    const label = dl.description || dl.status || '';
    const delivered = Boolean(dl.delivered) || dl.status === 'delivered';
    return {
      carrier: 'DHL',
      label,
      stage: delivered ? 'delivered' : stageFrom('', label) || 'in_transit',
      location: dl.location || '',
      eta: dl.eta || '',
      delivered,
      asOf: when(s.dhlUpdatedAt),
    };
  }
  return null;
}

/** A shipment's stage: { key, label, track }. */
export function stage(s) {
  const t = tracking(s);
  if (s?.status === 'cancelled') return { key: 'cancelled', label: 'Cancelled', track: t };
  if (s?.status === 'delivered' || t?.delivered) return { key: 'delivered', label: 'Delivered', track: t };
  if (t?.stage === 'exception') return { key: 'exception', label: 'Delivery problem', track: t };
  if (t?.stage) return { key: t.stage, label: STAGES[t.stage] || 'In transit', track: t };
  if (!s?.tracking) return { key: 'no_tracking', label: s?.status === 'in_transit' ? 'In transit' : 'Pending (no tracking)', track: null };
  if (s.status === 'in_transit') return { key: 'in_transit', label: 'In transit', track: t };
  return { key: 'pending', label: 'Pending', track: t };
}

export const shipmentOpen = (s) => s && s.status !== 'delivered' && s.status !== 'cancelled' && !tracking(s)?.delivered;

/** "London → Dubai", names from the logistics clients where the end is a client. */
export const route = (s, clientName = () => '') =>
  [clientName(s?.fromClientId) || s?.fromText || '', clientName(s?.toClientId) || s?.toText || ''].filter(Boolean).join(' → ');

/* ── where the watch is now ───────────────────────────────────────── */

const PLACES = [
  ['londonStock', 'London'],
  ['dubaiStock', 'Dubai'],
  ['hkStock', 'Hong Kong'],
  ['safeStock', 'our safe'],
];

const newest = (rows, ...keys) =>
  [...rows].sort((a, b) => {
    const ta = Math.max(...keys.map((k) => when(a[k]) || 0));
    const tb = Math.max(...keys.map((k) => when(b[k]) || 0));
    return tb - ta;
  })[0];

const corner = (d) => [d.inMayfair && 'Mayfair', d.inNcl && 'NCL', d.inOffice && 'office', d.inSafe && 'safe'].filter(Boolean).join(', ');

/**
 * @param items  logistics items { id, kind, data, deleted_at } naming the watch
 * @param ctx    { clientName(id) }
 * @returns {{ headline, detail, tone, since, itemId, overlays: [{ text, tone, itemId }] }}
 */
export function now(items, ctx = {}) {
  const clientName = ctx.clientName || (() => '');
  const live = items.filter((i) => !i.deleted_at);
  const of = (kind) => live.filter((i) => i.kind === kind);
  let head = null;

  const sold = newest(of('soldStocks'), 'ts', 'soldDate', 'deliveredAt');
  if (sold) {
    const d = sold.data;
    head = {
      headline: d.deliveredAt ? 'Sold and delivered' : 'Sold',
      detail: [d.soldToBuyer && `to ${d.soldToBuyer}`, d.soldDate && `on ${day(d.soldDate)}`, d.deliveredAt && `delivered ${day(d.deliveredAt)}${d.deliveredVia === 'in_person' ? ' in person' : d.deliveredVia === 'shipment' ? ' by shipment' : ''}`]
        .filter(Boolean)
        .join(', '),
      tone: 'sold',
      since: when(d.deliveredAt) || when(d.soldDate) || when(d.ts),
      itemId: sold.id,
    };
    const held = of('safeStock').find((i) => i.data.soldId === d.id && (i.data.status || 'current') === 'current');
    if (held) head.detail = [head.detail, `held in our safe for ${held.data.from || 'the buyer'}`].filter(Boolean).join('; ');
  }

  const ready = !head && newest(of('readyForDelivery'), 'ts', 'soldDate');
  if (ready) {
    const d = ready.data;
    head = {
      headline: d.status === 'shipped' ? 'Sold — shipped to the buyer' : 'Sold — waiting for delivery',
      detail: [d.soldToBuyer && `to ${d.soldToBuyer}`, d.soldDate && `sold ${day(d.soldDate)}`, d.soldFromLocation && `from ${d.soldFromLocation}`].filter(Boolean).join(', '),
      tone: 'moving',
      since: when(d.soldDate) || when(d.ts),
      itemId: ready.id,
    };
  }

  const out = !head && newest(of('checkoutStock'), 'checkedOutDate');
  if (out) {
    const d = out.data;
    head = {
      headline: 'Checked out',
      detail: [d.checkedOutBy, d.checkedOutDate && `on ${day(d.checkedOutDate)}`, d.originLocation && `from ${d.originLocation}`].filter(Boolean).join(', '),
      tone: 'away',
      since: when(d.checkedOutDate),
      itemId: out.id,
    };
  }

  if (!head) {
    for (const [kind, place] of PLACES) {
      const row = newest(
        of(kind).filter((i) => ['current', 'consignment', '', undefined].includes(i.data.status)),
        'receivedAt',
        'movedAt',
        'createdAt'
      );
      if (!row) continue;
      const d = row.data;
      const bits = [corner(d)];
      let headline = kind === 'safeStock' ? 'In our safe (a client’s watch)' : `In ${place}`;
      let tone = 'here';
      if (d.consignment?.with || d.status === 'consignment') {
        const c = d.consignment || {};
        headline = c.direction === 'from_client' ? `In ${place} — on consignment from ${c.with || 'a client'}` : `On consignment with ${c.with || 'a client'}`;
        if (c.date) bits.push(`since ${day(c.date)}`);
        if (c.returnDate) bits.push(`due back ${day(c.returnDate)}`);
        tone = 'away';
      }
      if (d.polish && d.polish.status !== 'done' && d.polish.sentTo) {
        headline = `At polish with ${d.polish.sentTo}`;
        bits.push(`from ${place}`, d.polish.sentDate && `since ${day(d.polish.sentDate)}`, d.polish.expectedBack && `expected back ${day(d.polish.expectedBack)}`);
        tone = 'away';
      }
      head = { headline, detail: bits.filter(Boolean).join(', '), tone, since: when(d.receivedAt) || when(d.movedAt) || when(d.createdAt), itemId: row.id };
      break;
    }
  }

  const hk = !head && newest(of('hkSituation').filter((i) => i.data.section !== 'sold'), 'createdAt');
  if (hk) {
    const d = hk.data;
    const where = { in_hand: 'In Hong Kong', incoming: 'On its way to Hong Kong', outgoing: 'Leaving Hong Kong' }[d.section] || 'Hong Kong';
    head = { headline: where, detail: [d.holder && `held by ${d.holder}`, d.stockStatus].filter(Boolean).join(', '), tone: d.section === 'in_hand' ? 'here' : 'moving', since: when(d.createdAt), itemId: hk.id };
  }

  // Sold through the HK situation list: no Sold Stocks record is made for those.
  const hkSold = !head && newest(of('hkSituation').filter((i) => i.data.section === 'sold'), 'createdAt');
  if (hkSold) {
    const d = hkSold.data;
    const sale = [...(Array.isArray(d.movements) ? d.movements : [])].reverse().find((m) => m.sale)?.sale;
    head = {
      headline: 'Sold (Hong Kong)',
      detail: [sale?.clientName && `to ${sale.clientName}`, d.holder && `held by ${d.holder}`].filter(Boolean).join(', '),
      tone: 'sold',
      since: when(d.createdAt),
      itemId: hkSold.id,
    };
  }

  const inc = !head && newest(of('incomings').filter((i) => !/cancel/i.test(i.data.status || '')), 'arrivedAt', 'createdAt');
  if (inc) {
    const d = inc.data;
    const arrived = d.status === 'arrived';
    // Received into stock already: the stock row it became is the watch's place — and none is live now.
    const received = Boolean(d.inventoryId || d.inventoryMovedAt);
    head = {
      headline: received ? 'Received into stock' : arrived ? 'Arrived — not yet put into stock' : d.status === 'consignment' ? 'Coming in on consignment' : 'On its way in',
      detail: received
        ? [d.inventoryDest && `put into ${d.inventoryDest}`, d.inventoryMovedAt && day(d.inventoryMovedAt), 'no current place recorded since'].filter(Boolean).join(', ')
        : [d.supplier && `from ${d.supplier}`, (d.inventoryDest || d.location) && `to ${d.inventoryDest || d.location}`, !arrived && d.eta && `expected ${d.eta}`].filter(Boolean).join(', '),
      tone: received ? 'none' : arrived ? 'here' : 'moving',
      since: when(d.inventoryMovedAt) || when(d.arrivedAt) || when(d.createdAt),
      itemId: inc.id,
    };
  }

  head ||= { headline: '', detail: '', tone: 'none', since: null, itemId: null };

  /* What is moving it, whatever its place. */
  const overlays = [];
  for (const i of of('shipments').filter((x) => shipmentOpen(x.data))) {
    const s = i.data;
    const st = stage(s);
    overlays.push({
      text: ['On a shipment', route(s, clientName), st.label, st.track?.location, s.tracking && `${st.track?.carrier || 'tracking'} ${s.tracking}`].filter(Boolean).join(' · '),
      tone: st.key === 'exception' ? 'problem' : st.key === 'customs' ? 'warn' : 'moving',
      asOf: st.track?.asOf || null,
      itemId: i.id,
    });
  }
  for (const i of of('thirdPartyShipments').filter((x) => !['delivered', 'cancelled'].includes(x.data.status))) {
    const d = i.data;
    overlays.push({ text: ['With mover', d.moverName, [d.fromCountry, d.toCountry].filter(Boolean).join(' → '), d.status].filter(Boolean).join(' · '), tone: 'moving', itemId: i.id });
  }
  for (const i of of('personTrips').filter((x) => x.data.status !== 'completed')) {
    const d = i.data;
    overlays.push({ text: [`On ${d.personName ? `${d.personName}’s` : 'a'} trip`, [d.fromLocation, d.toLocation].filter(Boolean).join(' → '), d.startDate && `from ${day(d.startDate)}`].filter(Boolean).join(' · '), tone: 'moving', itemId: i.id });
  }
  for (const i of of('driverDeliveries').filter((x) => x.data.status === 'out')) {
    const d = i.data;
    overlays.push({ text: ['With driver', d.driverName, d.destination && `to ${d.destination}`].filter(Boolean).join(' · '), tone: 'moving', itemId: i.id });
  }
  for (const i of of('externalPolish').filter((x) => x.data.status !== 'done')) {
    overlays.push({ text: ['At external polish', i.data.sentTo].filter(Boolean).join(' · '), tone: 'away', itemId: i.id });
  }
  const give = of('accGive').length;
  const collect = of('accCollect').length;
  let txGive = 0;
  let txCollect = 0;
  for (const i of of('transactions')) {
    for (const it of Array.isArray(i.data.items) ? i.data.items : []) {
      if (it.status === 'done') continue;
      if (it.direction === 'give') txGive += 1;
      else txCollect += 1;
    }
  }
  if (give + txGive || collect + txCollect) {
    overlays.push({
      text: ['Accessories', give + txGive && `${give + txGive} to give`, collect + txCollect && `${collect + txCollect} to collect`].filter(Boolean).join(' · '),
      tone: 'warn',
    });
  }
  // At the polisher from a row that is not a place's (a sold watch polished before delivery).
  const atPolish = live.find((i) => !PLACES.some(([k]) => k === i.kind) && i.data.polish?.sentTo && i.data.polish.status !== 'done');
  if (atPolish) overlays.push({ text: `At polish with ${atPolish.data.polish.sentTo}`, tone: 'away', itemId: atPolish.id });
  const polishing = live.some((i) => i.data.polish?.sentTo && i.data.polish.status !== 'done');
  const placeRow = !polishing && live.find((i) => PLACES.some(([k]) => k === i.kind) && i.data.needPolish && (i.data.status || 'current') !== 'moved');
  if (placeRow) overlays.push({ text: 'Needs polish', tone: 'warn', itemId: placeRow.id });

  return { ...head, overlays };
}

/* ── the watch's logistics history ────────────────────────────────── */

/* The app's movement types. Accessories are noted on the watch's row as movements, but nothing moved the watch. */
const MOVE_WORDS = {
  dubai: 'Moved to Dubai',
  london: 'Moved to London',
  hk: 'Moved to Hong Kong',
  arrival_from_dubai: 'Arrived from Dubai',
  arrival_from_london: 'Arrived from London',
  arrival_from_hk: 'Arrived from Hong Kong',
  sold_held_in_safe: 'Sold — held in our safe for the buyer',
  accessories_pending_collect: 'Accessories: to collect (noted)',
  accessories_pending_give: 'Accessories: to give (noted)',
  accessories_received: 'Accessories: received',
  accessories_given: 'Accessories: given',
};
const moveWords = (mv) =>
  MOVE_WORDS[mv.moveType] ||
  (/^arrival_from_/.test(mv.moveType || '') ? `Arrived from ${mv.moveType.slice(13).replace(/_/g, ' ')}` : '') ||
  (mv.toSection ? `HK: ${mv.fromSection || ''} → ${mv.toSection}` : mv.destination ? `Moved — ${mv.destination}` : 'Moved');

/**
 * Everything that happened to the watch, newest first: the movements kept on
 * every row it was ever in (moved, sold and gone rows too), shipments, sale,
 * delivery, polish, checkout, costs.
 */
export function timeline(items, ctx = {}) {
  const clientName = ctx.clientName || (() => '');
  const out = [];
  const seen = new Set();
  const push = (e) => {
    // Movements repeat across rows (a sold row keeps its origin row's): one each. Two costs on one day are two.
    const key = e.key || `${e.itemId}|${e.at}|${e.text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(e);
  };
  const movementsOf = (d) => [...(Array.isArray(d.movements) ? d.movements : []), ...(Array.isArray(d.originRow?.movements) ? d.originRow.movements : [])];
  // A record a PERSON deleted here is not history; one the logistics app dropped is (a sale takes a row out of its place).
  const byPerson = (i) => i.deleted_at && !(i.source_gone_at && +new Date(i.deleted_at) === +new Date(i.source_gone_at));
  const today = Date.now();

  for (const i of items) {
    if (byPerson(i)) continue;
    const d = i.data || {};
    const gone = Boolean(i.deleted_at);
    for (const mv of movementsOf(d)) {
      const at = when(mv.ts) || when(mv.date) || when(mv.movedAt);
      const words = moveWords(mv);
      push({
        key: `mv:${mv.id || `${at}|${words}`}`,
        at,
        kind: i.kind,
        itemId: i.id,
        text: words,
        detail: [mv.destination && !words.includes(mv.destination) && mv.destination, mv.carrier, mv.notes].filter(Boolean).join(' · '),
      });
    }
    switch (i.kind) {
      case 'incomings':
        push({ at: when(d.createdAt), kind: i.kind, itemId: i.id, text: 'Expected in', detail: [d.supplier && `from ${d.supplier}`, d.eta && `ETA ${d.eta}`].filter(Boolean).join(' · ') });
        if (d.arrivedAt) push({ at: when(d.arrivedAt), kind: i.kind, itemId: i.id, text: 'Arrived', detail: d.location || '' });
        if (d.inventoryMovedAt) push({ at: when(d.inventoryMovedAt), kind: i.kind, itemId: i.id, text: 'Put into stock', detail: d.inventoryDest || '' });
        break;
      case 'londonStock':
      case 'dubaiStock':
      case 'hkStock':
      case 'safeStock': {
        const place = PLACES.find(([k]) => k === i.kind)[1];
        if (d.receivedAt || d.createdAt) push({ at: when(d.receivedAt) || when(d.createdAt), kind: i.kind, itemId: i.id, text: `Into ${place}`, detail: d.from ? `from ${d.from}` : '' });
        if (d.consignment?.with) push({ at: when(d.consignment.date), kind: i.kind, itemId: i.id, text: d.consignment.direction === 'from_client' ? `On consignment from ${d.consignment.with}` : `On consignment with ${d.consignment.with}`, detail: d.consignment.notes || '' });
        // A consignment recalled is kept on the row as consignmentRecord: still the watch's history.
        const past = d.consignmentRecord;
        if (past?.with) {
          push({ key: `cr:${i.id}:${past.date}`, at: when(past.date), kind: i.kind, itemId: i.id, text: `${past.direction === 'from_client' ? `On consignment from ${past.with}` : `On consignment with ${past.with}`} — since recalled`, detail: past.notes || '' });
        }
        if (d.polish?.sentTo) {
          push({ at: when(d.polish.sentDate) || when(d.polish.createdAt), kind: i.kind, itemId: i.id, text: `Sent to polish — ${d.polish.sentTo}`, detail: d.polish.itemDescription || '' });
        }
        // A finished polish keeps the day it came back (returnedDate) and the notes made then.
        for (const p of Array.isArray(d.polishHistory) ? d.polishHistory : []) {
          push({ key: `po:${p.id || p.sentDate}`, at: when(p.returnedDate) || when(p.sentDate), kind: i.kind, itemId: i.id, text: `Back from polish${p.sentTo ? ` (${p.sentTo})` : ''}`, detail: p.returnNotes || '' });
        }
        break;
      }
      case 'checkoutStock':
        push({ at: when(d.checkedOutDate), kind: i.kind, itemId: i.id, text: 'Checked out', detail: [d.checkedOutBy, d.originLocation && `from ${d.originLocation}`].filter(Boolean).join(' · ') });
        break;
      case 'readyForDelivery':
        push({ at: when(d.soldDate) || when(d.ts), kind: i.kind, itemId: i.id, text: 'Sold', detail: [d.soldToBuyer && `to ${d.soldToBuyer}`, d.soldFromLocation && `from ${d.soldFromLocation}`].filter(Boolean).join(' · ') });
        break;
      case 'soldStocks':
        // A sold row the logistics app dropped is a sale it took back (Cancel Sale).
        push({ at: when(d.soldDate) || when(d.ts), kind: i.kind, itemId: i.id, text: gone ? 'Sold — the sale was later cancelled' : 'Sold', detail: [d.soldToBuyer && `to ${d.soldToBuyer}`, d.soldFromLocation && `from ${d.soldFromLocation}`].filter(Boolean).join(' · ') });
        if (d.deliveredAt && !gone) push({ at: when(d.deliveredAt), kind: i.kind, itemId: i.id, text: 'Delivered to the buyer', detail: d.deliveredVia === 'in_person' ? 'in person' : d.deliveredVia === 'shipment' ? 'by shipment' : '' });
        break;
      case 'shipments': {
        const st = stage(d);
        if (st.key === 'cancelled') {
          push({ at: when(d.date) || when(d.createdAt), kind: i.kind, itemId: i.id, text: 'Shipment booked, then cancelled', detail: route(d, clientName) });
          break;
        }
        push({ at: when(d.date) || when(d.createdAt), kind: i.kind, itemId: i.id, text: 'Shipped', detail: [route(d, clientName), d.tracking].filter(Boolean).join(' · ') });
        if (d.deliveredAt || st.key === 'delivered') push({ at: when(d.deliveredAt) || when(st.track?.asOf), kind: i.kind, itemId: i.id, text: 'Shipment delivered', detail: route(d, clientName) });
        else if (st.key === 'exception' || st.key === 'customs') push({ at: st.track?.asOf || null, kind: i.kind, itemId: i.id, text: st.label, detail: st.track?.label || '' });
        break;
      }
      case 'thirdPartyShipments':
        push({ at: when(d.shipmentDate) || when(d.ts), kind: i.kind, itemId: i.id, text: `With mover ${d.moverName || ''}`.trim(), detail: [d.fromCountry, d.toCountry].filter(Boolean).join(' → ') });
        if (d.deliveryDate) push({ at: when(d.deliveryDate), kind: i.kind, itemId: i.id, text: 'Mover delivered', detail: d.moverName || '' });
        break;
      case 'personTrips': {
        const at = when(d.startDate);
        push({ at, kind: i.kind, itemId: i.id, text: `${at && at > today ? 'Trip planned' : 'Trip'} — ${d.personName || ''}`.replace(/ — $/, ''), detail: [d.fromLocation, d.toLocation].filter(Boolean).join(' → ') });
        break;
      }
      case 'driverDeliveries':
        push({ at: when(d.dateGiven) || when(d.ts), kind: i.kind, itemId: i.id, text: `Given to driver ${d.driverName || ''}`.trim(), detail: d.destination || '' });
        break;
      case 'externalPolish':
        push({ at: when(d.sentDate) || when(d.createdAt), kind: i.kind, itemId: i.id, text: `External polish — ${d.sentTo || ''}`.trim(), detail: d.status === 'done' ? `back ${day(d.returnDate)}` : '' });
        break;
      case 'logisticCosts':
        push({ at: when(d.date) || when(d.ts), kind: i.kind, itemId: i.id, text: `Cost — ${d.title || 'logistics'}`, detail: [d.currency, d.amount].filter((x) => x !== undefined && x !== '').join(' '), money: true });
        break;
      case 'hkSituation':
        push({ at: when(d.createdAt), kind: i.kind, itemId: i.id, text: 'On the HK list', detail: [d.section, d.holder && `held by ${d.holder}`].filter(Boolean).join(' · ') });
        break;
      default:
        break;
    }
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

/* ── what the watch has cost to move ──────────────────────────────── */

/**
 * The logistics app's own costing (costsForStock), line for line:
 *   1. logistic costs naming the watch, split evenly over every watch they
 *      name — except a completed trip's lines (tripId), counted in 3
 *   2. a shipment's own cost, split the same way, unless a logistic cost
 *      already stands for that shipment and watch
 *   3. a trip's cost lines, split over every watch on the trip
 *   4. what the watch cost to buy, from its incoming record
 * Amounts stay in their own currency; nothing is converted here. A cost with
 * no currency is dollars, as the app counts it (its convertToUSD takes an
 * unknown currency at 1).
 *
 * @param stockNo     the watch's stock number
 * @param items       logistics items naming it (live ones)
 * @param tripStocks  (trip item) → how many watches the trip carried
 */
export function costs(stockNo, items, { tripStocks = (i) => Math.max(1, (i.data.stockIds || []).length) } = {}) {
  const sn = String(stockNo).trim().toLowerCase();
  const names = (v) => stockList(v).map((s) => s.toLowerCase());
  const out = [];
  const live = items.filter((i) => !i.deleted_at);
  const costsList = live.filter((i) => i.kind === 'logisticCosts');
  for (const i of costsList) {
    const c = i.data;
    if (c.tripId) continue;
    const stocks = names(c.stockNumber);
    if (!stocks.includes(sn)) continue;
    const n = stocks.length || 1;
    out.push({ source: 'Logistic cost', title: c.title || '', detail: [[c.fromName, c.toName].filter(Boolean).join(' → '), n > 1 && `split across ${n} watches`].filter(Boolean).join(' · '), date: day(c.date || c.ts), currency: c.currency || 'USD', amount: (Number(c.amount) || 0) / n, itemId: i.id });
  }
  for (const i of live.filter((x) => x.kind === 'shipments')) {
    const s = i.data;
    const stocks = names(s.stockNumber);
    if (!stocks.includes(sn)) continue;
    const amount = Number(s.costAmount) || 0;
    if (amount <= 0) continue;
    // A shipment added here has no id of the app's: no cost line can stand for it.
    if (s.id && costsList.some((c) => c.data.shipmentId === s.id && names(c.data.stockNumber).includes(sn))) continue;
    const n = stocks.length || 1;
    out.push({ source: 'Shipment', title: s.items || '', detail: [s.tracking, n > 1 && `split across ${n} watches`].filter(Boolean).join(' · '), date: day(s.date), currency: s.costCurrency || 'USD', amount: amount / n, itemId: i.id });
  }
  for (const i of live.filter((x) => x.kind === 'personTrips')) {
    const t = i.data;
    const n = tripStocks(i);
    for (const c of Array.isArray(t.costs) ? t.costs : []) {
      if (!Number(c.amount)) continue;
      out.push({ source: 'Trip (shared)', title: [c.category, c.label].filter(Boolean).join(' · '), detail: `${t.personName || ''} trip · split across ${n} watch${n === 1 ? '' : 'es'}`.trim(), date: day(c.date || t.startDate), currency: c.currency || 'USD', amount: Number(c.amount) / n, itemId: i.id });
    }
  }
  for (const i of live.filter((x) => x.kind === 'incomings')) {
    const d = i.data;
    if (String(d.stockNumber || '').trim().toLowerCase() !== sn) continue;
    const amount = Number(d.costAmount) || 0;
    if (amount <= 0) continue;
    out.push({ source: 'Purchase', title: `Purchase · ${[d.brand, d.reference].filter(Boolean).join(' ')}`.trim(), detail: [d.supplier && `from ${d.supplier}`, d.location].filter(Boolean).join(' · '), date: day(d.eta) || '', currency: d.costCurrency || 'USD', amount, itemId: i.id });
  }
  for (const c of out) c.amount = Math.round(c.amount * 100) / 100;
  const totals = {};
  for (const c of out) {
    if (c.source === 'Purchase') continue;
    const k = c.currency || '?';
    totals[k] = Math.round(((totals[k] || 0) + c.amount) * 100) / 100;
  }
  return { lines: out, totals };
}
