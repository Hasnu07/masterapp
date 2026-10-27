/*
 * Hand Carry Plans and Movement (trips) — the logistics app's workflows, done
 * here (asked 27 Oct 2026: "all the features in the logistic side in the erp
 * system to do entries"). Each action does what the app's own function does,
 * record for record, read from its index.html:
 *
 *   plan-…   tab-kashan: newKashanPlan, renameKashanPlan, saveKashanLeg,
 *            kashanDeleteLeg, kashanDoAssign, kashanRemoveItem, kashanClearPlan,
 *            deleteKashanPlan, kashanCompletePlan, kashanRestorePlan,
 *            kashanSendToMovement, kashanParseAI (ai), kashanAIFlights (ai),
 *            kashanOptimiseRoute (ai)
 *   trip-…   tab-movement: saveTrip (add / edit, a leg, a watch, a cost line),
 *            completeTrip, deleteTrip, addAllowanceToTripCosts,
 *            removeAllowanceFromTripCosts, setAllowancePaid
 *
 * Our rule: a stock number is OUR watch (the form's hint says so and the
 * message flags one we do not hold); a trip names its watches by the app's
 * row ids with their list prefixes (lon-, dubai-, hk-, inc-, sold-, ready-),
 * so the rows are offered as a choice and a typed number is matched to its
 * row, never kept bare. Nothing is written back to the app.
 */
import { insertItem, patchItem, softDelete, logActivity, listKind, text, dayOf, amountOf, currencyOf, uid, bad } from '../write.js';
import { stockList } from '../kinds.js';
import { oursByNumber } from '../shared.js';
import { ask } from '../ai.js';
import * as DB from '../../db/index.js';

/* The app's own uid() for the ids inside a record (a leg, a delivery, a cost line). */
const newId = () => uid();
/* The app's id of our copy of a record: the app's own when synced, else the one insertItem gave it. */
export const appId = (r) => text(r.source_id) || text(r.data?.id);
const legsOf = (d) => (Array.isArray(d?.legs) ? d.legs.filter((l) => l && typeof l === 'object') : []);
const listOf = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);

/* The app's "Starting from" select (tab-kashan), in its order. */
export const PLAN_CITIES = [
  'Dubai',
  'Abu Dhabi',
  'Sharjah',
  'Doha',
  'Riyadh',
  'Jeddah',
  'Kuwait City',
  'Bahrain',
  'Muscat',
  'Beirut',
  'Amman',
  'London',
  'Manchester',
  'Birmingham',
  'Edinburgh',
  'Glasgow',
  'Liverpool',
  'Bristol',
  'Leeds',
  'Newcastle',
  'Sheffield',
  'Paris',
  'Amsterdam',
  'Brussels',
  'Luxembourg',
  'Monaco',
  'Nice',
  'Lyon',
  'Cannes',
  'Marseille',
  'Bordeaux',
  'Geneva',
  'Zurich',
  'Basel',
  'Berne',
  'Lausanne',
  'Milan',
  'Rome',
  'Florence',
  'Venice',
  'Naples',
  'Turin',
  'Bologna',
  'Madrid',
  'Barcelona',
  'Valencia',
  'Seville',
  'Marbella',
  'Ibiza',
  'Lisbon',
  'Porto',
  'Munich',
  'Frankfurt',
  'Berlin',
  'Hamburg',
  'Düsseldorf',
  'Cologne',
  'Vienna',
  'Stockholm',
  'Oslo',
  'Copenhagen',
  'Helsinki',
  'Athens',
  'Prague',
  'Budapest',
  'Warsaw',
  'Istanbul',
  'Bucharest',
  'Sofia',
  'Hong Kong',
  'Singapore',
  'Tokyo',
  'Osaka',
  'Seoul',
  'Shanghai',
  'Beijing',
  'Taipei',
  'Bangkok',
  'Kuala Lumpur',
  'Jakarta',
  'Manila',
  'Mumbai',
  'Delhi',
  'Bangalore',
  'Chennai',
  'Cairo',
  'Casablanca',
  'Johannesburg',
  'Nairobi',
  'Lagos',
  'New York',
  'Los Angeles',
  'Miami',
  'Chicago',
  'Houston',
  'Toronto',
  'Vancouver',
  'São Paulo',
  'Mexico City',
  'Buenos Aires',
  'Sydney',
  'Melbourne',
  'Auckland',
  'Other',
];
const cityChoice = (key, label, more = {}) => ({
  key,
  label,
  type: 'choice',
  options: PLAN_CITIES.map((c) => ({ value: c, label: c })),
  ...more,
});
/* The stop dialog's currency select (kashanLegCostCur) and the trip cost row's (addTripCostRow). */
const LEG_CURRENCIES = ['GBP', 'USD', 'EUR', 'AED'];
export const TRIP_CURRENCIES = ['USD', 'AED', 'EUR', 'GBP', 'HKD', 'CHF', 'JPY', 'CNY', 'OTHER'];
/* The app's TRIP_COST_CATEGORIES, in its order. */
export const TRIP_COST_CATEGORIES = ['Flight / Ticket', 'Train', 'Taxi / Car', 'Hotel', 'Food', 'SIM / Internet', 'Customs / Duty', 'Visa', 'Insurance', 'Per Diem', 'Other'];
const TRIP_STATUSES = ['planned', 'in_progress', 'completed', 'cancelled'];

/* ── what a plan can be given ─────────────────────────────────────── */

/*
 * The app's left panel (renderKashanAvailable): sales waiting for delivery
 * (readyForDelivery not shipped), incomings pending or in transit, and the
 * stock in hand — London and Dubai rows with status current, the HK
 * situation's in_hand section — each with the loc word the app writes.
 */
async function available(db) {
  // One after the other: inside a transaction the client takes one query at a time.
  const ready = await listKind(db, 'readyForDelivery', "COALESCE(data->>'status','') <> 'shipped'");
  const incs = await listKind(db, 'incomings', "data->>'status' IN ('pending','in_transit')");
  const lon = await listKind(db, 'londonStock', "data->>'status' = 'current'");
  const dub = await listKind(db, 'dubaiStock', "data->>'status' = 'current'");
  const hk = await listKind(db, 'hkSituation', "data->>'section' = 'in_hand'");
  return {
    ready,
    incs,
    stock: [...lon.map((r) => ({ r, loc: 'London' })), ...dub.map((r) => ({ r, loc: 'Dubai' })), ...hk.map((r) => ({ r, loc: 'Hong Kong' }))],
  };
}

/* A delivery, collection or stock move as kashanDoAssign writes it into a leg. */
export const deliveryOf = (r) => ({
  id: newId(),
  readyId: r.id,
  stockNumber: r.stockNumber,
  brand: r.brand,
  model: r.watchModel || r.watchReference || '',
  clientName: r.soldToBuyer || '',
  clientCountry: r.soldFromLocation || '',
});
export const collectionOf = (i) => ({
  id: newId(),
  incId: i.id,
  stockNumber: i.stockNumber,
  brand: i.brand,
  model: i.reference || i.model || '',
  supplier: i.supplier || '',
  country: i.location || i.inventoryDest || '',
});
export const stockMoveOf = (s, loc) => ({
  id: newId(),
  stockId: s.id,
  stockNumber: s.stockNumber || '',
  brand: s.brand || '',
  model: s.watchModel || s.description || s.watchReference || '',
  fromLocation: loc,
});
/* The record's data with the app's id in it, as the app's own lists carry it. */
const withId = (r) => ({ ...r.data, id: appId(r) });

/* Our watch of a stock number, for a hint or a message. */
async function oursOf(nos) {
  return oursByNumber(stockList(nos));
}
const oursWord = (ours, nos) => {
  const list = stockList(nos);
  if (!list.length) return '';
  const not = list.filter((n) => !ours.get(n));
  const yes = list.filter((n) => ours.get(n));
  return [yes.length && `our watch${yes.length > 1 ? 'es' : ''} #${yes.join(', #')}`, not.length && `#${not.join(', #')} not one of our watches`].filter(Boolean).join(' · ');
};

const stopLabel = (leg, i) => `Stop ${i + 1} — ${text(leg.toCity) || '?'}${text(leg.date) ? ` · ${text(leg.date)}` : ''}`;
const stopChoice = (d, key = 'legId', label = 'Stop') => ({
  key,
  label,
  type: 'choice',
  options: legsOf(d).map((l, i) => ({
    value: text(l.id),
    label: stopLabel(l, i),
  })),
  required: true,
});
const legById = (d, id) => {
  const leg = legsOf(d).find((l) => text(l.id) === text(id));
  if (!leg) throw bad('Say which stop');
  return leg;
};
const STOP_FIELDS = [
  { key: 'fromCity', label: 'From city', type: 'text' },
  { key: 'toCity', label: 'To city / country', type: 'text', required: true },
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'time', label: 'Time', type: 'text', hint: 'HH:MM' },
  { key: 'flightInfo', label: 'Flight # / info', type: 'text' },
  {
    key: 'flightCostCurrency',
    label: 'Flight cost currency',
    type: 'enum',
    options: LEG_CURRENCIES,
  },
  {
    key: 'flightCost',
    label: 'Flight cost',
    type: 'money',
    currency: 'flightCostCurrency',
  },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];
/* A stop as saveKashanLeg reads the dialog. */
function stopData(input) {
  const toCity = text(input.toCity, 200);
  if (!toCity) throw bad('Please enter a destination city');
  const time = text(input.time, 20);
  if (time && !/^\d{1,2}:\d{2}$/.test(time)) throw bad(`Time: "${time}" is not HH:MM`);
  const currency = text(input.flightCostCurrency, 4).toUpperCase() || 'GBP';
  if (!LEG_CURRENCIES.includes(currency)) throw bad(`Flight cost currency: one of ${LEG_CURRENCIES.join(', ')}`);
  return {
    fromCity: text(input.fromCity, 200),
    toCity,
    date: dayOf(input.date, 'Date', { blank: '' }),
    time,
    flightInfo: text(input.flightInfo, 200),
    flightCostCurrency: currency,
    flightCost: amountOf(input.flightCost, 'Flight cost') || null,
    notes: text(input.notes, 2000),
  };
}
const startCityOf = (input, d) => {
  const c = text(input.currentCity, 100);
  if (c && !PLAN_CITIES.includes(c)) throw bad('Starting from: pick a city from the list');
  return c || text(d.currentCity) || 'Dubai';
};

/* ── the Movement trip a plan becomes (kashanSendToMovement) ──────── */

export function tripFromPlan(d) {
  const startCity = text(d.currentCity) || 'Dubai';
  const legs = legsOf(d);
  const tripLegs = legs.map((leg, idx) => ({
    id: newId(),
    from: leg.fromCity || (idx === 0 ? startCity : legs[idx - 1]?.toCity || startCity),
    to: leg.toCity || '',
    date: leg.date || '',
  }));
  const stockIdSet = new Set();
  legs.forEach((leg) => {
    listOf(leg.stockMoves).forEach((m) => {
      if (m.stockId) stockIdSet.add(m.stockId);
    });
    listOf(leg.deliveries).forEach((x) => {
      if (x.readyId) stockIdSet.add('ready-' + x.readyId);
    });
    listOf(leg.collections).forEach((c) => {
      if (c.incId) stockIdSet.add('inc-' + c.incId);
    });
  });
  return {
    personName: d.name || 'Kashan',
    fromLocation: tripLegs[0]?.from || startCity,
    toLocation: tripLegs[tripLegs.length - 1]?.to || '',
    startDate: tripLegs[0]?.date || '',
    endDate: tripLegs[tripLegs.length - 1]?.date || '',
    purpose: 'From Kashan Plan: ' + (d.name || 'Kashan'),
    status: 'planned',
    legs: tripLegs,
    stockIds: [...stockIdSet],
    costs: [],
    photos: [],
    notes: d.notes || '',
  };
}

/* ── the AI prompts, verbatim (kashanParseAI, kashanAIFlights, kashanOptimiseRoute) ── */

let asker = ask;
/** For a test: a stand-in for the AI. */
export const _setAsker = (fn) => {
  asker = fn || ask;
};

const FLIGHT_WORDS = /flight|ticket|fly|skyscanner|cheapest.*route|route.*cheap|airfare|airline/i;
export const isFlightRequest = (s) => FLIGHT_WORDS.test(String(s || ''));

export function parseSystemPrompt(readyRows, incRows) {
  const ready = readyRows.map((r) => `DELIVER: stock ${r.stockNumber} ${r.brand} ${r.watchModel || r.watchReference || ''} → ${r.soldToBuyer || '?'} (${r.soldFromLocation || '?'})`).join('\n');
  const incs = incRows.map((i) => `COLLECT: stock ${i.stockNumber} ${i.brand} ${i.reference || ''} ← ${i.supplier || '?'} (${i.location || i.inventoryDest || '?'})`).join('\n');
  return `You are a logistics planner for a luxury watch business. Parse the user's instruction into a structured trip plan for Kashan (a courier/delivery person).
Available items to assign:
${ready || '(none ready for delivery)'}
${incs || '(none to collect)'}

Respond ONLY with valid JSON — no explanation, no markdown, just the raw JSON object:
{
  "legs": [
    {
      "toCity": "city name",
      "fromCity": "city name or empty string",
      "date": "YYYY-MM-DD or empty string",
      "deliveries": [{"stockNumber":"...", "clientName":"..."}],
      "collections": [{"stockNumber":"...", "supplier":"..."}]
    }
  ]
}
Match stock numbers exactly from the Available items list. If a name is mentioned without a stock number, find the closest match by client/supplier name.`;
}

/** The AI's answer turned into stops on the plan, as kashanParseAI does it; returns how many were added. */
export function applyParsed(d, parsed, readyRows, incRows) {
  let added = 0;
  const legs = legsOf(d);
  for (const pleg of Array.isArray(parsed?.legs) ? parsed.legs : []) {
    if (!pleg || !pleg.toCity) continue;
    const leg = {
      id: newId(),
      toCity: String(pleg.toCity),
      fromCity: pleg.fromCity || '',
      date: pleg.date || '',
      time: '',
      flightInfo: '',
      flightCost: null,
      flightCostCurrency: 'GBP',
      notes: '',
      deliveries: [],
      collections: [],
    };
    for (const pd of Array.isArray(pleg.deliveries) ? pleg.deliveries : []) {
      const sn = String(pd?.stockNumber || '').trim();
      const r = readyRows.find((x) => (sn && String(x.stockNumber || '').trim() === sn) || (pd?.clientName && (x.soldToBuyer || '').toLowerCase().includes(String(pd.clientName).toLowerCase())));
      if (r) leg.deliveries.push(deliveryOf(r));
    }
    for (const pc of Array.isArray(pleg.collections) ? pleg.collections : []) {
      const sn = String(pc?.stockNumber || '').trim();
      const i = incRows.find((x) => (sn && String(x.stockNumber || '').trim() === sn) || (pc?.supplier && (x.supplier || '').toLowerCase().includes(String(pc.supplier).toLowerCase())));
      if (i) leg.collections.push(collectionOf(i));
    }
    legs.push(leg);
    added++;
  }
  d.legs = legs;
  return added;
}

export function flightsPrompt(d) {
  const startCity = text(d.currentCity) || 'Dubai';
  const itinerary = legsOf(d)
    .map((l, i) => `Stop ${i + 1}: ${l.fromCity || startCity} → ${l.toCity}${l.date ? ' on ' + l.date : ''}`)
    .join('\n');
  return `I need to plan a business trip for a luxury watch delivery courier. Itinerary:\n\nStart: ${startCity}\n${itinerary}\n\nFor each leg:\n1. Best airline + cheapest booking window\n2. Rough GBP price range\n3. Practical tip to save money (day of week, advance booking, etc.)\n4. If any legs can be combined/re-routed to save money\n\nBe specific and concise. Format clearly with each leg on a new line.`;
}
export const FLIGHTS_SYSTEM = 'You are a professional travel consultant specialising in business trips for luxury goods couriers across Europe, Middle East and Asia.';

export function optimisePrompt(d, { movers = [], shipments = [], now = new Date() } = {}) {
  const legs = legsOf(d);
  const startCity = text(d.currentCity) || 'Dubai';
  const today = now.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  const moverWords = movers.map((m) => `${m.name} (${m.country || '?'})`).join(', ') || 'Ferrari, RK, FORAK';
  const fmtDate = (x) =>
    x
      ? new Date(x + 'T12:00:00').toLocaleDateString('en-GB', {
          day: 'numeric',
          month: 'short',
        })
      : 'no date';
  const itinLines = [`Starting city: ${startCity}`];
  legs.forEach((leg, i) => {
    itinLines.push(`\nStop ${i + 1}: ${leg.fromCity || startCity} → ${leg.toCity || '?'} (${fmtDate(leg.date)})`);
    if (leg.flightInfo) itinLines.push(`  Flight info: ${leg.flightInfo}`);
    if (leg.flightCost) itinLines.push(`  Planned flight cost: ${leg.flightCostCurrency || 'GBP'} ${leg.flightCost}`);
    if (leg.notes) itinLines.push(`  Notes: ${leg.notes}`);
    listOf(leg.deliveries).forEach((x) => itinLines.push(`  📦 DELIVER: Stock #${x.stockNumber} ${x.brand} ${x.model || ''} → to ${x.clientName || '?'}`));
    listOf(leg.collections).forEach((c) => itinLines.push(`  📥 COLLECT: Stock #${c.stockNumber} ${c.brand} ${c.model || ''} ← from ${c.supplier || '?'}`));
    listOf(leg.stockMoves).forEach((m) => itinLines.push(`  📍 MOVING: Stock #${m.stockNumber} ${m.brand} ${m.model || ''} (from ${m.fromLocation})`));
  });
  itinLines.push(`\nReturn to: ${startCity}`);
  const allStockNums = new Set();
  legs.forEach((l) => {
    listOf(l.deliveries).forEach((x) => allStockNums.add(x.stockNumber));
    listOf(l.collections).forEach((c) => allStockNums.add(c.stockNumber));
    listOf(l.stockMoves).forEach((m) => allStockNums.add(m.stockNumber));
  });
  const cityPairs = [];
  const allCities = [startCity, ...legs.map((l) => l.toCity || ''), startCity];
  for (let i = 0; i < allCities.length - 1; i++) cityPairs.push([allCities[i], allCities[i + 1]]);
  const histLines = [];
  cityPairs.forEach(([f, t]) => {
    const relevant = shipments
      .filter((s) => {
        const from = (s.fromText || '').toLowerCase();
        const to = (s.toText || '').toLowerCase();
        return (from.includes(f.toLowerCase()) && to.includes(t.toLowerCase())) || (from.includes(t.toLowerCase()) && to.includes(f.toLowerCase()));
      })
      .slice(0, 5);
    if (relevant.length) histLines.push(`  ${f} ↔ ${t}: ${relevant.map((s) => (s.cost ? `${s.costCurrency || 'GBP'} ${s.cost}` : 'no cost')).join(', ')}`);
  });
  return `You are a luxury watch logistics expert advising Purosangue Watches (a high-end watch trading business operating across Dubai, London, Hong Kong, Switzerland, and Europe).

Date: ${today}
Our 3rd-party movers: ${moverWords}

KASHAN'S FULL PLANNED ITINERARY:
${itinLines.join('\n')}

TOTAL WATCHES IN THIS TRIP: ${allStockNums.size} watch${allStockNums.size !== 1 ? 'es' : ''}

OUR HISTORICAL SHIPPING COSTS ON RELEVANT ROUTES:
${histLines.length ? histLines.join('\n') : '  No historical data for these specific routes'}

YOUR TASK — analyse this full multi-stop itinerary and provide:

## ✅ Best Route Order
Is the current stop order optimal, or should any stops be reordered to save time/cost/miles? Give the recommended sequence clearly.

## ✈️ Flight Options Per Leg
For each leg (${allCities
    .slice(0, -1)
    .map((c, i) => `${c}→${allCities[i + 1]}`)
    .join(', ')}), provide:
- Best 1-2 airlines / flight options with estimated fare range
- Approximate flight time
- Any layover or routing recommendation

## 💰 Estimated Total Trip Cost
Break down cost per leg (flights + any ground transport) and give a total range.

## ⚠️ Key Watch Logistics Points
- How many watches is Kashan carrying at peak? Any customs declaration thresholds to be aware of?
- Any legs where using Ferrari/RK/FORAK to ship watches separately would be smarter than personal carry?
- Timing risks (e.g. if Stop 2 depends on collecting at Stop 1)?

## 🏆 Overall Recommendation
One clear recommended action plan: best route order, best transport per leg, estimated total cost, and the most important tip for this specific trip.

Be practical, specific, and use numbers. Anchor any estimates to our historical data where available.`;
}

/* ── trips ────────────────────────────────────────────────────────── */

/* The app's trip stocks grid (buildTripStocksGrid): every row of these lists, in this order, with its prefix and flag. */
const TRIP_SOURCES = [
  ['londonStock', 'lon-', '🇬🇧 London', null],
  ['dubaiStock', 'dubai-', '🇦🇪 Dubai', null],
  ['hkStock', 'hk-', '🌐 HK', "data->>'status' = 'current'"],
  ['hkSituation', 'hk-', '🌐 HK', null],
  ['incomings', 'inc-', '📥 Incoming', null],
  ['soldStocks', 'sold-', '💵 Sold', null],
  ['readyForDelivery', 'ready-', '📦 Ready', null],
];
async function tripRows(db) {
  const out = [];
  for (const [kind, prefix, flag, where] of TRIP_SOURCES) {
    for (const r of await listKind(db, kind, where || '')) {
      const d = r.data || {};
      const model = kind === 'hkSituation' ? text(d.description) : kind === 'incomings' ? text(d.reference) : text(d.watchModel);
      const extra =
        kind === 'hkSituation'
          ? d.holder
            ? `with ${text(d.holder)}`
            : ''
          : kind === 'incomings'
            ? text(d.location)
            : kind === 'soldStocks'
              ? `sold ${text(d.soldDate)}${d.soldToBuyer ? ' to ' + text(d.soldToBuyer) : ''}`
              : kind === 'readyForDelivery'
                ? `ready · ${text(d.soldToBuyer) || '?'}`
                : d.from
                  ? `from ${text(d.from)}`
                  : '';
      out.push({
        id: prefix + appId(r),
        stockNumber: text(d.stockNumber),
        label: `${flag} #${text(d.stockNumber) || '–'} ${[text(d.brand), model].filter(Boolean).join(' ')}${extra ? ` · ${extra}` : ''}`.trim(),
      });
    }
  }
  return out;
}
/* The app's getTripLegs: the legs, else the old single from → to. */
const tripLegs = (d) =>
  legsOf(d).length
    ? legsOf(d)
    : d.fromLocation || d.toLocation
      ? [
          {
            id: 'leg',
            from: d.fromLocation || '',
            to: d.toLocation || '',
            date: d.startDate || '',
          },
        ]
      : [];
/* The app's tripRouteLabel. */
export function routeLabel(d) {
  const legs = tripLegs(d);
  if (!legs.length) return '(no legs)';
  const cities = [];
  legs.forEach((l, i) => {
    if (i === 0 && l.from) cities.push(l.from);
    else if (l.from && cities[cities.length - 1] !== l.from) cities.push(l.from);
    cities.push(l.to || '?');
  });
  return cities.filter(Boolean).join(' → ');
}
const TRIP_FIELDS = [
  { key: 'personName', label: 'Who', type: 'text', required: true },
  { key: 'status', label: 'Status', type: 'enum', options: TRIP_STATUSES },
  { key: 'startDate', label: 'Starts', type: 'date' },
  { key: 'endDate', label: 'Ends', type: 'date' },
  { key: 'endTime', label: 'Ends at', type: 'text', hint: 'HH:MM' },
  { key: 'purpose', label: 'Purpose', type: 'longtext' },
];
function tripHead(input, current = {}) {
  const personName = text(input.personName, 200);
  if (!personName) throw bad('Person name required');
  const status = text(input.status, 20) || 'planned';
  if (!TRIP_STATUSES.includes(status)) throw bad(`Status: one of ${TRIP_STATUSES.join(', ')}`);
  const endTime = text(input.endTime, 20);
  if (endTime && !/^\d{1,2}:\d{2}$/.test(endTime)) throw bad(`Ends at: "${endTime}" is not HH:MM`);
  return {
    personName,
    status,
    startDate: dayOf(input.startDate, 'Starts', { blank: '' }) || (current.startDate ?? ''),
    endDate: dayOf(input.endDate, 'Ends', { blank: '' }),
    endTime,
    purpose: text(input.purpose, 2000),
  };
}
const LEG_FIELDS = [
  { key: 'from', label: 'From', type: 'text' },
  { key: 'to', label: 'To', type: 'text' },
  { key: 'date', label: 'Leaves on', type: 'date' },
  { key: 'time', label: 'Leaves at', type: 'text', hint: 'HH:MM' },
  { key: 'arrDate', label: 'Arrives on', type: 'date' },
  { key: 'arrTime', label: 'Arrives at', type: 'text', hint: 'HH:MM' },
];
function legData(input) {
  const from = text(input.from, 200);
  const to = text(input.to, 200);
  if (!from && !to) throw bad('Say where the leg goes from or to');
  for (const k of ['time', 'arrTime']) if (text(input[k], 20) && !/^\d{1,2}:\d{2}$/.test(text(input[k], 20))) throw bad(`"${text(input[k])}" is not HH:MM`);
  return {
    id: newId(),
    from,
    to,
    date: dayOf(input.date, 'Leaves on', { blank: '' }),
    time: text(input.time, 20),
    arrDate: dayOf(input.arrDate, 'Arrives on', { blank: '' }),
    arrTime: text(input.arrTime, 20),
  };
}
/* fromLocation / toLocation as the app keeps them beside the legs: the first from and the last to. */
const endsOf = (legs) => ({
  fromLocation: legs.length ? legs[0].from : '',
  toLocation: legs.length ? legs[legs.length - 1].to : '',
});

const COST_FIELDS = (d) => [
  {
    key: 'category',
    label: 'Category',
    type: 'enum',
    options: TRIP_COST_CATEGORIES,
  },
  {
    key: 'label',
    label: 'What',
    type: 'text',
    hint: 'e.g. BA flight, hotel, sim, taxi',
  },
  {
    key: 'amount',
    label: 'Amount',
    type: 'money',
    currency: 'currency',
    required: true,
  },
  {
    key: 'currency',
    label: 'Currency',
    type: 'enum',
    options: TRIP_CURRENCIES,
  },
  { key: 'date', label: 'Date', type: 'date' },
  {
    key: 'legId',
    label: 'Leg',
    type: 'choice',
    options: [
      { value: '', label: '— whole trip —' },
      ...tripLegs(d).map((l) => ({
        value: text(l.id),
        label: `${l.from || '?'} → ${l.to || '?'}${l.date ? ` · ${l.date}` : ''}`,
      })),
    ],
  },
  {
    key: 'paidBy',
    label: 'Paid by',
    type: 'choice',
    options: [
      { value: 'company', label: 'We paid' },
      { value: 'traveller', label: 'His own card' },
    ],
  },
];
/* A cost line as saveTrip reads a row: whose money, and settled at once when it was ours. */
function costLine(input, d, had = {}) {
  const category = text(input.category, 50) || 'Flight / Ticket';
  if (!TRIP_COST_CATEGORIES.includes(category)) throw bad(`Category: one of ${TRIP_COST_CATEGORIES.join(', ')}`);
  const label = text(input.label, 300);
  const amount = amountOf(input.amount, 'Amount');
  if (amount === 0 && !label) throw bad('Say the amount, or what it was for');
  const currency = text(input.currency, 5).toUpperCase() || 'USD';
  if (!TRIP_CURRENCIES.includes(currency)) throw bad(`Currency: one of ${TRIP_CURRENCIES.join(', ')}`);
  const legId = text(input.legId, 40);
  if (legId && !tripLegs(d).some((l) => text(l.id) === legId)) throw bad('No such leg on this trip');
  const paidBy = text(input.paidBy, 20) || 'company';
  if (!['company', 'traveller'].includes(paidBy)) throw bad('Paid by: we paid, or his own card');
  return {
    id: had.id || newId(),
    category,
    label,
    amount,
    currency,
    date: dayOf(input.date, 'Date', { blank: '' }),
    legId,
    paidBy,
    settled: paidBy === 'company' ? true : Boolean(had.settled),
    notes: had.notes || '',
  };
}
const costLabel = (c) => `${text(c.category) || 'Other'}${text(c.label) ? ` · ${text(c.label)}` : ''} · ${text(c.currency) || 'USD'} ${Number(c.amount) || 0}${c.perDiem ? ' (allowance)' : ''}`;
const costChoice = (d) => ({
  key: 'costId',
  label: 'Expense',
  type: 'choice',
  options: listOf(d.costs).map((c) => ({
    value: text(c.id),
    label: costLabel(c),
  })),
  required: true,
});
const costById = (d, id) => {
  const c = listOf(d.costs).find((x) => text(x.id) === text(id));
  if (!c) throw bad('Say which expense');
  return c;
};

/* The travel allowance's lines, as the console's pdAllowance worked them out (the app's tripAllowance, run in the browser). */
function allowanceLines(raw) {
  let a;
  try {
    a = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw bad('The allowance could not be read — open the Movement tab and use its button');
  }
  if (!a || typeof a !== 'object') throw bad('The allowance is worked out on the Movement tab — use its button there');
  const currency = currencyOf(a.currency, 'EUR', 'Allowance currency');
  const payable = (Array.isArray(a.byPlace) ? a.byPlace : [])
    .map((r) => ({
      place: text(r?.place, 100),
      days: Math.round(Number(r?.days) || 0),
      rate: Number(r?.rate) || 0,
      amount: Math.round((Number(r?.amount) || 0) * 100) / 100,
      first: dayOf(r?.first, 'First day', { blank: '' }),
    }))
    .filter((r) => r.amount > 0);
  const extra = (Array.isArray(a.extra) ? a.extra : [])
    .map((x) => ({
      label: text(x?.label, 200),
      amount: Math.round((Number(x?.amount) || 0) * 100) / 100,
    }))
    .filter((x) => x.amount !== 0);
  const total = Math.round((payable.reduce((s, r) => s + r.amount, 0) + extra.reduce((s, x) => s + x.amount, 0)) * 100) / 100;
  return {
    currency,
    payable,
    extra,
    total,
    start: dayOf(a.start, 'Start', { blank: '' }),
  };
}
/* addAllowanceToTripCosts: the Per Diem lines replaced, by hand lines first, then by place. */
function withAllowance(d, a) {
  const costs = listOf(d.costs).filter((c) => !c.perDiem);
  a.extra.forEach((x) =>
    costs.push({
      id: newId(),
      perDiem: true,
      category: 'Per Diem',
      label: x.label || 'Added by hand',
      amount: x.amount,
      currency: a.currency,
      date: d.startDate || a.start || '',
      legId: '',
      notes: 'Travel allowance — manual line',
    })
  );
  a.payable.forEach((r) =>
    costs.push({
      id: newId(),
      perDiem: true,
      category: 'Per Diem',
      label: `${r.place} · ${r.days} day${r.days === 1 ? '' : 's'} × ${a.currency} ${r.rate}`,
      amount: r.amount,
      currency: a.currency,
      date: r.first || d.startDate || '',
      legId: '',
      notes: 'Travel allowance',
    })
  );
  return costs;
}

/* completeTrip: the stock numbers of a trip's rows, by their prefixed ids. */
const TRIP_PREFIX = [
  ['lon-', ['londonStock']],
  ['dubai-', ['dubaiStock']],
  ['hk-', ['hkSituation', 'hkStock']],
  ['inc-', ['incomings']],
  ['sold-', ['soldStocks']],
  ['ready-', ['readyForDelivery']],
];
async function tripStockNumbers(db, stockIds) {
  const { rows } = await db.query("SELECT kind, COALESCE(source_id, data->>'id') AS app_id, data->>'stockNumber' AS stock FROM logistics_items WHERE deleted_at IS NULL AND kind = ANY($1)", [
    TRIP_PREFIX.flatMap(([, k]) => k),
  ]);
  const m = new Map(rows.map((r) => [`${r.kind}:${r.app_id}`, r.stock || '']));
  return (Array.isArray(stockIds) ? stockIds : [])
    .map((sid) => {
      const s = String(sid);
      const hit = TRIP_PREFIX.find(([p]) => s.startsWith(p));
      if (!hit) return null;
      for (const kind of hit[1]) {
        const n = m.get(`${kind}:${s.slice(hit[0].length)}`);
        if (n) return n;
      }
      return null;
    })
    .filter(Boolean)
    .join(', ');
}

const fmt = (n) => Number(n || 0).toLocaleString('en-GB');

/* ── the actions ──────────────────────────────────────────────────── */

export const ACTIONS = [
  /* ── Hand Carry Plans (tab-kashan) ── */
  {
    key: 'plan-new',
    label: 'New plan',
    kinds: null,
    page: 'handcarry',
    form: [
      {
        key: 'name',
        label: 'Name',
        type: 'text',
        required: true,
        hint: "e.g. the person's name or the trip name",
      },
      cityChoice('currentCity', 'Starting from'),
      { key: 'notes', label: 'Notes', type: 'longtext' },
    ],
    prefill: async () => ({ currentCity: 'Dubai' }),
    run: async ({ db, input, user }) => {
      const name = text(input.name, 200);
      if (!name) throw bad('Name the plan');
      const plan = {
        name,
        legs: [],
        currentCity: startCityOf(input, {}),
        notes: text(input.notes, 2000),
      };
      const row = await insertItem(db, 'kashanPlans', plan, user);
      await logActivity(db, `✈️ New plan created: ${name}`, user);
      return {
        message: `New plan created: ${name}`,
        open: `#/lg/${row.id}`,
        created: [row.id],
      };
    },
  },
  {
    key: 'plan-rename',
    label: 'Rename plan',
    kinds: ['kashanPlans'],
    form: [{ key: 'name', label: 'Name', type: 'text', required: true }, cityChoice('currentCity', 'Starting from'), { key: 'notes', label: 'Notes', type: 'longtext' }],
    prefill: async (it) => ({
      name: it.data.name,
      currentCity: text(it.data.currentCity) || 'Dubai',
      notes: it.data.notes,
    }),
    run: async ({ db, item, input, user }) => {
      const name = text(input.name, 200);
      if (!name) throw bad('Name the plan');
      await patchItem(
        db,
        item,
        {
          ...item.data,
          name,
          currentCity: startCityOf(input, item.data),
          notes: text(input.notes, 2000),
        },
        user
      );
      return { message: `Plan renamed: ${name}` };
    },
  },
  {
    key: 'plan-stop-add',
    label: 'Add stop',
    kinds: ['kashanPlans'],
    form: [cityChoice('currentCity', 'Starting from'), ...STOP_FIELDS],
    prefill: async (it) => {
      const legs = legsOf(it.data);
      const start = text(it.data.currentCity) || 'Dubai';
      return {
        currentCity: start,
        fromCity: legs.length ? text(legs[legs.length - 1].toCity) : start,
        flightCostCurrency: 'GBP',
      };
    },
    run: async ({ db, item, input, user }) => {
      const data = stopData(input);
      const legs = [...legsOf(item.data), { id: newId(), deliveries: [], collections: [], ...data }];
      await patchItem(db, item, { ...item.data, currentCity: startCityOf(input, item.data), legs }, user);
      await logActivity(db, `✈️ Stop added to plan "${text(item.data.name)}": ${data.toCity}`, user);
      return { message: `Stop ${legs.length} added: ${data.toCity}` };
    },
  },
  {
    key: 'plan-stop-edit',
    label: 'Edit stop',
    kinds: ['kashanPlans'],
    form: async (it) => [stopChoice(it.data), ...STOP_FIELDS],
    prefill: async (it, ctx, query) => {
      const legs = legsOf(it.data);
      const leg = legs.find((l) => text(l.id) === text(query.leg)) || legs[0];
      if (!leg) return {};
      return {
        legId: text(leg.id),
        fromCity: leg.fromCity,
        toCity: leg.toCity,
        date: leg.date,
        time: leg.time,
        flightInfo: leg.flightInfo,
        flightCostCurrency: leg.flightCostCurrency || 'GBP',
        flightCost: leg.flightCost,
        notes: leg.notes,
      };
    },
    run: async ({ db, item, input, user }) => {
      const data = stopData(input);
      legById(item.data, input.legId);
      const legs = legsOf(item.data).map((l) => (text(l.id) === text(input.legId) ? { ...l, ...data } : l));
      await patchItem(db, item, { ...item.data, legs }, user);
      return { message: `Stop changed: ${data.toCity}` };
    },
  },
  {
    key: 'plan-stop-remove',
    label: 'Remove stop',
    kinds: ['kashanPlans'],
    danger: true,
    form: async (it) => [stopChoice(it.data)],
    prefill: async (it, ctx, query) => ({
      legId: text(query.leg) || text(legsOf(it.data)[0]?.id),
    }),
    run: async ({ db, item, input, user }) => {
      const leg = legById(item.data, input.legId);
      await patchItem(
        db,
        item,
        {
          ...item.data,
          legs: legsOf(item.data).filter((l) => text(l.id) !== text(leg.id)),
        },
        user
      );
      return { message: `Stop removed: ${text(leg.toCity) || '?'}` };
    },
  },
  {
    key: 'plan-assign',
    label: 'Assign to stop',
    kinds: ['kashanPlans'],
    form: async (it) => {
      const { ready, incs, stock } = await available(DB);
      const ours = await oursOf([...ready, ...incs, ...stock.map((x) => x.r)].flatMap((r) => r.stock_nos || []));
      const w = (r) => (ours.get(stockList(r.data?.stockNumber)[0]) ? '' : ' (not one of our watches)');
      const options = [
        ...ready.map((r) => ({
          value: `readyForDelivery:${r.id}`,
          label: `Deliver #${text(r.data.stockNumber) || '–'} ${text(r.data.brand)} → ${text(r.data.soldToBuyer) || '?'}${w(r)}`,
        })),
        ...incs.map((r) => ({
          value: `incomings:${r.id}`,
          label: `Collect #${text(r.data.stockNumber) || '–'} ${text(r.data.brand)} ← ${text(r.data.supplier) || '?'}${w(r)}`,
        })),
        ...stock.map(({ r, loc }) => ({
          value: `${r.kind}:${r.id}`,
          label: `Move #${text(r.data.stockNumber) || '–'} ${text(r.data.brand)} from ${loc}${w(r)}`,
        })),
      ];
      return [
        stopChoice(it.data),
        {
          key: 'item',
          label: 'Watch',
          type: 'choice',
          options,
          required: true,
          hint: 'a sale waiting for delivery, an incoming to collect, or stock in hand to move — each our watch',
        },
      ];
    },
    prefill: async (it, ctx, query) => ({
      legId: text(query.leg) || text(legsOf(it.data)[0]?.id),
      item: text(query.item),
    }),
    run: async ({ db, item, input, user }) => {
      const legs = legsOf(item.data);
      if (!legs.length) throw bad('Add a stop first, then assign stocks to it');
      const leg = legById(item.data, input.legId);
      const [kind, id] = text(input.item, 60).split(':');
      const { rows } = await db.query('SELECT * FROM logistics_items WHERE id = $1 AND kind = $2 AND deleted_at IS NULL', [Number(id) || 0, kind || '']);
      const r = rows[0];
      if (!r) throw bad('Say which watch');
      const d = withId(r);
      const next = { ...leg };
      let what;
      if (kind === 'readyForDelivery') {
        if (listOf(leg.deliveries).find((x) => x.readyId === d.id)) throw bad('Already in this stop');
        next.deliveries = [...listOf(leg.deliveries), deliveryOf(d)];
        what = `Deliver #${text(d.stockNumber)} → ${text(d.soldToBuyer) || '?'}`;
      } else if (kind === 'incomings') {
        if (listOf(leg.collections).find((x) => x.incId === d.id)) throw bad('Already in this stop');
        next.collections = [...listOf(leg.collections), collectionOf(d)];
        what = `Collect #${text(d.stockNumber)} ← ${text(d.supplier) || '?'}`;
      } else if (['londonStock', 'dubaiStock', 'hkSituation'].includes(kind)) {
        const loc = kind === 'londonStock' ? 'London' : kind === 'dubaiStock' ? 'Dubai' : 'Hong Kong';
        if (listOf(leg.stockMoves).find((x) => x.stockId === d.id)) throw bad('Already in this stop');
        next.stockMoves = [...listOf(leg.stockMoves), stockMoveOf(d, loc)];
        what = `Move #${text(d.stockNumber)} from ${loc}`;
      } else throw bad('Say which watch');
      await patchItem(
        db,
        item,
        {
          ...item.data,
          legs: legs.map((l) => (text(l.id) === text(leg.id) ? next : l)),
        },
        user
      );
      const ours = await oursOf(d.stockNumber);
      await logActivity(db, `✅ Assigned to ${text(item.data.name)}'s plan, stop ${text(leg.toCity) || '?'}: ${what}`, user);
      return {
        message: `Assigned to stop: ${what}${ours.get(stockList(d.stockNumber)[0]) ? '' : ' — not one of our watches'}`,
      };
    },
  },
  {
    key: 'plan-unassign',
    label: 'Unassign',
    kinds: ['kashanPlans'],
    danger: true,
    form: async (it) => {
      const options = [];
      legsOf(it.data).forEach((l, i) => {
        listOf(l.deliveries).forEach((x) =>
          options.push({
            value: `${text(l.id)}|delivery|${text(x.id)}`,
            label: `${stopLabel(l, i)}: deliver #${text(x.stockNumber)} → ${text(x.clientName) || '?'}`,
          })
        );
        listOf(l.collections).forEach((x) =>
          options.push({
            value: `${text(l.id)}|collection|${text(x.id)}`,
            label: `${stopLabel(l, i)}: collect #${text(x.stockNumber)} ← ${text(x.supplier) || '?'}`,
          })
        );
        listOf(l.stockMoves).forEach((x) =>
          options.push({
            value: `${text(l.id)}|stock|${text(x.id)}`,
            label: `${stopLabel(l, i)}: move #${text(x.stockNumber)} from ${text(x.fromLocation) || '?'}`,
          })
        );
      });
      return [
        {
          key: 'item',
          label: 'Assignment',
          type: 'choice',
          options,
          required: true,
        },
      ];
    },
    // From the Hand carry tab a waiting row names itself as "<kind>:<our id>": the assignment that carries it is picked out here.
    prefill: async (it, ctx, query) => {
      const q = text(query.item, 80);
      if (q.includes('|')) return { item: q };
      const [kind, id] = q.split(':');
      if (!kind || !id) return {};
      const { rows } = await DB.query('SELECT source_id, data FROM logistics_items WHERE id = $1', [Number(id) || 0]);
      const app = rows[0] ? appId(rows[0]) : '';
      for (const l of legsOf(it.data)) {
        const d = listOf(l.deliveries).find((x) => text(x.readyId) === app);
        if (d && kind === 'readyForDelivery') return { item: `${text(l.id)}|delivery|${text(d.id)}` };
        const c = listOf(l.collections).find((x) => text(x.incId) === app);
        if (c && kind === 'incomings') return { item: `${text(l.id)}|collection|${text(c.id)}` };
        const m = listOf(l.stockMoves).find((x) => text(x.stockId) === app);
        if (m) return { item: `${text(l.id)}|stock|${text(m.id)}` };
      }
      return {};
    },
    run: async ({ db, item, input, user }) => {
      const [legId, type, itemId] = text(input.item, 80).split('|');
      const leg = legById(item.data, legId);
      const part = type === 'delivery' ? 'deliveries' : type === 'collection' ? 'collections' : type === 'stock' ? 'stockMoves' : null;
      const gone = part && listOf(leg[part]).find((x) => text(x.id) === itemId);
      if (!gone) throw bad('Say which assignment');
      const next = {
        ...leg,
        [part]: listOf(leg[part]).filter((x) => text(x.id) !== itemId),
      };
      await patchItem(
        db,
        item,
        {
          ...item.data,
          legs: legsOf(item.data).map((l) => (text(l.id) === text(leg.id) ? next : l)),
        },
        user
      );
      return {
        message: `Unassigned #${text(gone.stockNumber)} from stop ${text(leg.toCity) || '?'}`,
      };
    },
  },
  {
    key: 'plan-clear',
    label: 'Clear plan',
    kinds: ['kashanPlans'],
    danger: true,
    run: async ({ db, item, user }) => {
      await patchItem(db, item, { ...item.data, legs: [] }, user);
      return { message: 'Plan cleared — every stop and assignment removed' };
    },
  },
  {
    key: 'plan-delete',
    label: 'Delete plan',
    kinds: ['kashanPlans'],
    danger: true,
    run: async ({ db, item, user }) => {
      const plans = await listKind(db, 'kashanPlans');
      if (plans.length <= 1) throw bad('Cannot delete the only plan');
      await softDelete(db, item.id, user);
      return { message: 'Plan deleted', open: '#/logistics/handcarry' };
    },
  },
  {
    key: 'plan-complete',
    label: 'Complete plan',
    kinds: ['kashanPlans'],
    run: async ({ db, item, user }) => {
      if (item.data.status === 'completed') throw bad('This plan is already completed');
      await patchItem(db, item, { ...item.data, status: 'completed', completedAt: Date.now() }, user);
      await logActivity(db, `✅ Kashan Plan "${text(item.data.name)}" marked complete`, user);
      return { message: 'Plan completed ✓' };
    },
  },
  {
    key: 'plan-restore',
    label: 'Restore plan',
    kinds: ['kashanPlans'],
    run: async ({ db, item, user }) => {
      if (item.data.status !== 'completed') throw bad('This plan is open already');
      await patchItem(db, item, { ...item.data, status: 'active', completedAt: undefined }, user);
      await logActivity(db, `↺ Kashan Plan "${text(item.data.name)}" restored to active`, user);
      return { message: 'Plan restored ✓' };
    },
  },
  {
    key: 'plan-send',
    label: 'Send to movements',
    kinds: ['kashanPlans'],
    run: async ({ db, item, user }) => {
      if (!legsOf(item.data).length) throw bad('No stops in this plan yet.');
      const trip = tripFromPlan(item.data);
      const row = await insertItem(db, 'personTrips', trip, user);
      await logActivity(db, `🧳 Movement created from Kashan Plan "${trip.personName}"`, user);
      return {
        message: 'Movement created ✓ — add costs in the Movement tab',
        open: `#/lg/${row.id}`,
        created: [row.id],
      };
    },
  },
  {
    key: 'plan-parse',
    label: 'Parse & add',
    kinds: ['kashanPlans'],
    ai: true,
    form: [
      {
        key: 'instructions',
        label: 'Instructions',
        type: 'longtext',
        required: true,
        hint: 'e.g. Deliver stock 123 to Salva in Spain, collect incoming 456 from Diego in Italy, then go to Hong Kong and collect from Wong',
      },
    ],
    run: async ({ db, item, input, user }) => {
      const words = text(input.instructions, 4000);
      if (!words) throw bad('Say what to do');
      // The app sends a flight question to AI Flights instead.
      if (isFlightRequest(words)) {
        if (!legsOf(item.data).length) throw bad('Add stops first');
        const answer = await asker({
          system: FLIGHTS_SYSTEM,
          prompt: flightsPrompt(item.data),
        });
        return {
          message: `✈️ Flight request detected — AI Flights:\n${answer}`,
        };
      }
      const { ready, incs } = await available(db);
      const readyRows = ready.map(withId);
      const incRows = incs.map(withId);
      const parsed = await asker({
        system: parseSystemPrompt(readyRows, incRows),
        prompt: words,
        json: true,
      });
      const data = {
        ...item.data,
        legs: legsOf(item.data).map((l) => ({ ...l })),
      };
      const added = applyParsed(data, parsed, readyRows, incRows);
      if (!added) throw bad('⚠️ No stops could be parsed — try being more specific');
      await patchItem(db, item, data, user);
      await logActivity(db, `🤖 ${added} stop${added > 1 ? 's' : ''} added to plan "${text(item.data.name)}" from instructions`, user);
      return {
        message: `✅ Added ${added} stop${added > 1 ? 's' : ''} to the plan`,
      };
    },
  },
  {
    key: 'plan-flights',
    label: 'AI flights',
    kinds: ['kashanPlans'],
    ai: true,
    run: async ({ item }) => {
      if (!legsOf(item.data).length) throw bad('Add stops first');
      const answer = await asker({
        system: FLIGHTS_SYSTEM,
        prompt: flightsPrompt(item.data),
      });
      return { message: `✈️ AI Flight Suggestions\n${answer}` };
    },
  },
  {
    key: 'plan-optimise',
    label: 'Optimise full route',
    kinds: ['kashanPlans'],
    ai: true,
    run: async ({ db, item }) => {
      if (!legsOf(item.data).length) throw bad('Add at least one stop to the plan first');
      const movers = await listKind(db, 'thirdPartyMovers');
      const shipments = await listKind(db, 'shipments');
      const answer = await asker({
        prompt: optimisePrompt(item.data, {
          movers: movers.map((r) => r.data),
          shipments: shipments.map((r) => r.data),
        }),
        maxTokens: 3000,
      });
      return { message: `📊 Route analysis\n${answer}` };
    },
  },

  /* ── Movement (tab-movement) ── */
  {
    key: 'trip-add',
    label: 'Add trip',
    kinds: null,
    page: 'trips',
    form: [
      ...TRIP_FIELDS,
      ...LEG_FIELDS.slice(0, 3),
      {
        key: 'stockNumbers',
        label: 'Stock numbers',
        type: 'stock',
        hint: 'comma separated — each must be a row of the logistics lists (London, Dubai, HK, incoming, sold, ready); each is our watch',
      },
    ],
    prefill: async () => ({
      status: 'planned',
      startDate: new Date().toISOString().slice(0, 10),
    }),
    run: async ({ db, input, user }) => {
      const head = tripHead(input);
      const legs =
        text(input.from) || text(input.to)
          ? [
              legData({
                from: input.from,
                to: input.to,
                date: input.date || head.startDate,
              }),
            ]
          : [];
      const nos = stockList(input.stockNumbers);
      const rows = nos.length ? await tripRows(db) : [];
      const stockIds = [];
      for (const n of nos) {
        const r = rows.find((x) => stockList(x.stockNumber).includes(n));
        if (!r) throw bad(`#${n} is on none of the logistics lists — add it to London, Dubai or HK stock, the incomings or the sales first`);
        if (!stockIds.includes(r.id)) stockIds.push(r.id);
      }
      const trip = {
        ...head,
        ...endsOf(legs),
        legs,
        stockIds,
        costs: [],
        photos: [],
      };
      const row = await insertItem(db, 'personTrips', trip, user);
      const ours = await oursOf(nos);
      await logActivity(db, `🚗 Trip added: ${head.personName} · ${routeLabel(trip)}`, user);
      return {
        message: `Trip saved${nos.length ? ` · ${oursWord(ours, nos)}` : ''}`,
        open: `#/lg/${row.id}`,
        created: [row.id],
      };
    },
  },
  {
    key: 'trip-edit',
    label: 'Edit trip',
    kinds: ['personTrips'],
    form: [...TRIP_FIELDS, { key: 'notes', label: 'Notes', type: 'longtext' }],
    prefill: async (it) => ({
      personName: it.data.personName,
      status: it.data.status || 'planned',
      startDate: it.data.startDate,
      endDate: it.data.endDate,
      endTime: it.data.endTime,
      purpose: it.data.purpose,
      notes: it.data.notes,
    }),
    run: async ({ db, item, input, user }) => {
      const head = tripHead(input, item.data);
      const data = { ...item.data, ...head, notes: text(input.notes, 2000) };
      await patchItem(db, item, data, user);
      await logActivity(db, `🚗 Trip updated: ${head.personName} · ${routeLabel(data)}`, user);
      return { message: 'Trip saved' };
    },
  },
  {
    key: 'trip-leg-add',
    label: 'Add leg',
    kinds: ['personTrips'],
    form: LEG_FIELDS,
    prefill: async (it) => {
      const legs = tripLegs(it.data);
      return {
        from: legs.length ? text(legs[legs.length - 1].to) : '',
        date: legs.length ? '' : text(it.data.startDate),
      };
    },
    run: async ({ db, item, input, user }) => {
      const legs = [...tripLegs(item.data).map((l) => ({ ...l })), legData(input)];
      const data = { ...item.data, legs, ...endsOf(legs) };
      await patchItem(db, item, data, user);
      await logActivity(db, `🚗 Trip updated: ${text(item.data.personName)} · ${routeLabel(data)}`, user);
      return {
        message: `Leg added: ${legs[legs.length - 1].from || '?'} → ${legs[legs.length - 1].to || '?'}`,
      };
    },
  },
  {
    key: 'trip-leg-remove',
    label: 'Remove leg',
    kinds: ['personTrips'],
    danger: true,
    form: async (it) => [
      {
        key: 'legId',
        label: 'Leg',
        type: 'choice',
        options: tripLegs(it.data).map((l) => ({
          value: text(l.id),
          label: `${l.from || '?'} → ${l.to || '?'}${l.date ? ` · ${l.date}` : ''}`,
        })),
        required: true,
      },
    ],
    prefill: async (it, ctx, query) => ({ legId: text(query.leg) }),
    run: async ({ db, item, input, user }) => {
      const all = tripLegs(item.data);
      const leg = all.find((l) => text(l.id) === text(input.legId));
      if (!leg) throw bad('Say which leg');
      const legs = all.filter((l) => l !== leg);
      const data = { ...item.data, legs, ...endsOf(legs) };
      await patchItem(db, item, data, user);
      await logActivity(db, `🚗 Trip updated: ${text(item.data.personName)} · ${routeLabel(data)}`, user);
      return { message: `Leg removed: ${leg.from || '?'} → ${leg.to || '?'}` };
    },
  },
  {
    key: 'trip-stock-add',
    label: 'Add watch',
    kinds: ['personTrips'],
    form: async (it) => {
      const rows = await tripRows(DB);
      const had = new Set((Array.isArray(it.data.stockIds) ? it.data.stockIds : []).map(String));
      const ours = await oursOf(rows.map((r) => r.stockNumber));
      return [
        {
          key: 'stockId',
          label: 'Watch',
          type: 'choice',
          options: rows
            .filter((r) => !had.has(r.id))
            .map((r) => ({
              value: r.id,
              label: `${r.label}${ours.get(stockList(r.stockNumber)[0]) ? '' : ' (not one of our watches)'}`,
            })),
          required: true,
          hint: 'the rows of the logistics lists, as the app offers them — each our watch',
        },
      ];
    },
    run: async ({ db, item, input, user }) => {
      const id = text(input.stockId, 80);
      const rows = await tripRows(db);
      const r = rows.find((x) => x.id === id);
      if (!r) throw bad('Say which watch');
      const stockIds = [...new Set([...(Array.isArray(item.data.stockIds) ? item.data.stockIds : []).map(String), id])];
      await patchItem(db, item, { ...item.data, stockIds }, user);
      const ours = await oursOf(r.stockNumber);
      return {
        message: `#${r.stockNumber} added to the trip${ours.get(stockList(r.stockNumber)[0]) ? '' : ' — not one of our watches'}`,
      };
    },
  },
  {
    key: 'trip-stock-remove',
    label: 'Remove watch',
    kinds: ['personTrips'],
    danger: true,
    form: async (it) => {
      const stockIds = (Array.isArray(it.data.stockIds) ? it.data.stockIds : []).map(String);
      const rows = await tripRows(DB);
      return [
        {
          key: 'stockId',
          label: 'Watch',
          type: 'choice',
          options: stockIds.map((s) => ({
            value: s,
            label: rows.find((r) => r.id === s)?.label || s,
          })),
          required: true,
        },
      ];
    },
    run: async ({ db, item, input, user }) => {
      const id = text(input.stockId, 80);
      const stockIds = (Array.isArray(item.data.stockIds) ? item.data.stockIds : []).map(String);
      if (!stockIds.includes(id)) throw bad('Say which watch');
      await patchItem(db, item, { ...item.data, stockIds: stockIds.filter((s) => s !== id) }, user);
      return { message: 'Watch removed from the trip' };
    },
  },
  {
    key: 'trip-cost-add',
    label: 'Add expense',
    kinds: ['personTrips'],
    form: async (it) => COST_FIELDS(it.data),
    prefill: async (it, ctx, query) => ({
      category: 'Flight / Ticket',
      currency: 'USD',
      paidBy: 'company',
      legId: text(query.leg),
    }),
    run: async ({ db, item, input, user }) => {
      const line = costLine(input, item.data);
      await patchItem(db, item, { ...item.data, costs: [...listOf(item.data.costs), line] }, user);
      await logActivity(db, `🚗 Trip updated: ${text(item.data.personName)} · ${routeLabel(item.data)} · expense ${costLabel(line)}`, user);
      return { message: `Expense added: ${costLabel(line)}` };
    },
  },
  {
    key: 'trip-cost-edit',
    label: 'Edit expense',
    kinds: ['personTrips'],
    form: async (it) => [costChoice(it.data), ...COST_FIELDS(it.data)],
    prefill: async (it, ctx, query) => {
      const costs = listOf(it.data.costs);
      const c = costs.find((x) => text(x.id) === text(query.cost)) || costs[0];
      return c
        ? {
            costId: text(c.id),
            category: c.category,
            label: c.label,
            amount: c.amount,
            currency: c.currency || 'USD',
            date: c.date,
            legId: c.legId || '',
            paidBy: c.paidBy || 'company',
          }
        : {};
    },
    run: async ({ db, item, input, user }) => {
      const had = costById(item.data, input.costId);
      const line = { ...had, ...costLine(input, item.data, had) };
      await patchItem(
        db,
        item,
        {
          ...item.data,
          costs: listOf(item.data.costs).map((c) => (text(c.id) === text(had.id) ? line : c)),
        },
        user
      );
      return { message: `Expense changed: ${costLabel(line)}` };
    },
  },
  {
    key: 'trip-cost-remove',
    label: 'Remove expense',
    kinds: ['personTrips'],
    danger: true,
    form: async (it) => [costChoice(it.data)],
    prefill: async (it, ctx, query) => ({ costId: text(query.cost) }),
    run: async ({ db, item, input, user }) => {
      const had = costById(item.data, input.costId);
      await patchItem(
        db,
        item,
        {
          ...item.data,
          costs: listOf(item.data.costs).filter((c) => text(c.id) !== text(had.id)),
        },
        user
      );
      return { message: `Expense removed: ${costLabel(had)}` };
    },
  },
  {
    key: 'trip-allowance-add',
    label: 'Allowance → expenses',
    kinds: ['personTrips'],
    // The allowance is worked out on the Movement tab (the app's tripAllowance, by the browser's clock): its button sends the lines.
    run: async ({ db, item, user, query }) => {
      if (!query.lines) throw bad('The allowance is worked out on the Movement tab — use its "Allowance → expenses" button there');
      const a = allowanceLines(query.lines);
      if (!a.payable.length && !a.extra.length) throw bad('Nothing to add — no day has a rate. Map the places under ⚙️ Rates.');
      await patchItem(db, item, { ...item.data, costs: withAllowance(item.data, a) }, user);
      await logActivity(db, `👤 Travel allowance added to ${text(item.data.personName) || 'trip'} · ${routeLabel(item.data)} · ${a.currency} ${fmt(a.total)}`, user);
      return { message: `Allowance added · ${a.currency} ${fmt(a.total)}` };
    },
  },
  {
    key: 'trip-allowance-remove',
    label: 'Remove allowance',
    kinds: ['personTrips'],
    danger: true,
    run: async ({ db, item, user }) => {
      await patchItem(
        db,
        item,
        {
          ...item.data,
          costs: listOf(item.data.costs).filter((c) => !c.perDiem),
          allowancePaid: false,
        },
        user
      );
      await logActivity(db, `👤 Travel allowance removed from ${text(item.data.personName) || 'trip'} · ${routeLabel(item.data)}`, user);
      return { message: 'Allowance removed' };
    },
  },
  {
    key: 'trip-allowance-paid',
    label: 'Allowance paid?',
    kinds: ['personTrips'],
    form: [
      {
        key: 'paid',
        label: 'Paid',
        type: 'bool',
        hint: 'Yes: it is now part of the trip cost, settled by us. No: back to owed, its lines removed.',
      },
    ],
    prefill: async (it) => ({ paid: Boolean(it.data.allowancePaid) }),
    run: async ({ db, item, input, user, query }) => {
      const yes = input.paid === true || /^(true|yes|1|on)$/i.test(String(input.paid));
      let costs = listOf(item.data.costs);
      const data = { ...item.data };
      if (yes) {
        if (query.lines) costs = withAllowance(item.data, allowanceLines(query.lines));
        if (!costs.some((c) => c.perDiem)) throw bad('Nothing to pay — add the allowance to the expenses first');
        data.allowancePaid = true;
        data.costs = costs.map((c) => (c.perDiem ? { ...c, paidBy: 'company', settled: true } : c));
      } else {
        data.allowancePaid = false;
        data.costs = costs.filter((c) => !c.perDiem);
      }
      await patchItem(db, item, data, user);
      await logActivity(db, `${yes ? '💶' : '↩️'} Travel allowance for ${text(item.data.personName) || 'trip'} marked ${yes ? 'paid — it is now part of the trip cost' : 'not paid'}`, user);
      return {
        message: yes ? 'Allowance paid — added to the trip total' : 'Allowance back to owed',
      };
    },
  },
  {
    key: 'trip-complete',
    label: 'Complete trip',
    kinds: ['personTrips'],
    run: async ({ db, item, user }) => {
      const t = item.data;
      // The old ledger lines of this trip go, so a re-sync never doubles them.
      for (const old of await listKind(db, 'logisticCosts', "data->>'tripId' = $2", [appId(item)])) await softDelete(db, old.id, user);
      const stockNumber = await tripStockNumbers(db, t.stockIds);
      const newLcIds = [];
      const created = [];
      for (const c of listOf(t.costs)) {
        if (!c.amount) continue;
        const leg = tripLegs(t).find((l) => text(l.id) === text(c.legId));
        const route = leg ? `${leg.from || '?'} → ${leg.to || '?'}` : routeLabel(t);
        const lcId = newId();
        const row = await insertItem(
          db,
          'logisticCosts',
          {
            id: lcId,
            tripId: appId(item),
            tripCostId: c.id,
            legId: c.legId || '',
            title: `${c.category}${c.label ? ' · ' + c.label : ''} (${t.personName} trip · ${route})`,
            shipmentId: null,
            stockNumber,
            fromName: leg ? leg.from : t.fromLocation || '',
            toName: leg ? leg.to : t.toLocation || '',
            date: c.date || leg?.date || t.startDate || new Date().toISOString().slice(0, 10),
            currency: c.currency,
            amount: Number(c.amount) || 0,
            notes: `Trip · ${t.personName} · ${c.category}${c.label ? ' · ' + c.label : ''}`,
          },
          user
        );
        newLcIds.push(lcId);
        created.push(row.id);
      }
      await patchItem(
        db,
        item,
        {
          ...t,
          status: 'completed',
          completedAt: Date.now(),
          logisticCostIds: newLcIds,
        },
        user
      );
      await logActivity(db, `✅ Trip completed: ${t.personName} · ${routeLabel(t)} · ${newLcIds.length} cost line${newLcIds.length === 1 ? '' : 's'} added to dashboard`, user);
      return {
        message: `✅ Trip completed · ${newLcIds.length} cost line${newLcIds.length === 1 ? '' : 's'} synced to the logistic cost ledger`,
        created,
      };
    },
  },
  {
    key: 'trip-delete',
    label: 'Delete trip',
    kinds: ['personTrips'],
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      await logActivity(db, `Deleted trip ${text(item.data.personName)}`, user);
      return { message: 'Trip deleted', open: '#/logistics/trips' };
    },
  },
];

/* Extra typed fields for the records' own Edit forms: what the app's dialogs type that kinds.js does not. */
export const FIELDS = {
  kashanPlans: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'currentCity', label: 'Starting from', type: 'text' },
    {
      key: 'status',
      label: 'Status',
      type: 'enum',
      options: ['active', 'completed'],
    },
    { key: 'notes', label: 'Notes', type: 'longtext' },
  ],
  personTrips: [
    { key: 'endTime', label: 'Ends at', type: 'text' },
    { key: 'allowancePaid', label: 'Allowance paid', type: 'bool' },
  ],
};
