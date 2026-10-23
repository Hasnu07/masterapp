/*
 * The logistics app's lists, as masterapp shows and edits them.
 *
 * The logistics app (Purosangue Watches Logistics) keeps about thirty-five
 * lists in one document. Each is a KIND here: which tab it belongs to, how one
 * of its records is summed up in a list (title, a line under it, its status, a
 * date), and the fields a person edits with a proper control — a date, an
 * amount with its currency, a choice. Every other field a record carries is
 * still shown and kept: the app adds fields as it goes, and nothing it holds is
 * dropped for not being listed here.
 *
 * Field names are the logistics app's own (camelCase), because the records
 * are its records until the switch-over.
 */

export const GROUPS = [
  { key: 'overview', label: 'Overview' },
  { key: 'shipments', label: 'Shipments' },
  { key: 'incoming', label: 'Incoming' },
  { key: 'stock', label: 'Stock by place' },
  { key: 'sales', label: 'Sales & delivery' },
  { key: 'trips', label: 'Trips' },
  { key: 'accessories', label: 'Accessories' },
  { key: 'services', label: 'Polish & services' },
  { key: 'costs', label: 'Costs' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'log', label: 'Activity' },
];

/* ── field types ─────────────────────────────────────────────────────
 *   text, longtext   words
 *   number           a plain number (a rate, a percentage, a quantity)
 *   money            an amount; `currency` names the field holding its currency
 *   currency         a 3–4 letter code
 *   date             a day, kept as YYYY-MM-DD (the app's own form for days)
 *   when             a moment the app keeps as either milliseconds or a day
 *   enum             one of `options`
 *   bool             yes / no
 *   stock            one or more stock numbers, comma separated
 *   client           a logistics client, by its id
 */

const f = (key, label, type = 'text', more = {}) => ({ key, label, type, ...more });

const SPEC = [
  f('brand', 'Brand'),
  f('watchModel', 'Model'),
  f('watchReference', 'Reference'),
  f('watchSerial', 'Serial'),
  f('watchDate', 'Date on the papers'),
];

const LOCATION_STOCK_FIELDS = [
  f('stockNumber', 'Stock number', 'stock'),
  ...SPEC,
  f('status', 'Status', 'enum', { options: ['current', 'consignment', 'moved'] }),
  f('from', 'Bought from'),
  f('accessoriesPresent', 'Accessories with it', 'longtext'),
  f('accessoriesMissing', 'Accessories missing', 'longtext'),
  f('needPolish', 'Needs polish', 'bool'),
  f('costAmount', 'Cost', 'money', { currency: 'costCurrency' }),
  f('costCurrency', 'Cost currency', 'currency'),
  f('dial', 'Dial'),
  f('caseMaterial', 'Case material'),
  f('caseDiameter', 'Case size'),
  f('bezel', 'Bezel'),
  f('movement', 'Movement'),
  f('complications', 'Complications'),
  f('receivedAt', 'Received', 'when'),
  f('notes', 'Notes', 'longtext'),
];

const SALE_FIELDS = [
  f('stockNumber', 'Stock number', 'stock'),
  ...SPEC,
  f('soldToBuyer', 'Sold to'),
  f('soldPrice', 'Sold for', 'money', { currency: 'soldCurrency' }),
  f('soldCurrency', 'Sale currency', 'currency'),
  f('soldDate', 'Sale date', 'date'),
  f('soldFromLocation', 'Sold from'),
  f('soldNotes', 'Sale notes', 'longtext'),
];

const CUSTOMS = [
  f('watchBrand', 'Watch brand'),
  f('watchReference', 'Watch reference'),
  f('valueUsd', 'Value of the watch', 'money', { fixedCurrency: 'USD' }),
  f('customsRatePct', 'Customs rate %', 'number'),
  f('aedPerUsd', 'AED per USD', 'number'),
  f('customsUsd', 'Customs', 'money', { fixedCurrency: 'USD' }),
  f('customsAed', 'Customs in AED', 'money', { fixedCurrency: 'AED' }),
];

/** The first of these fields that has something in it. */
const first = (d, keys) => {
  for (const k of keys) {
    const v = d?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
};
const join = (...parts) => parts.filter((p) => p && String(p).trim()).join(' · ');
const spec = (d) => [d.brand, d.watchModel || d.model || d.description, d.watchReference || d.reference].filter(Boolean).join(' ');

/* A place's own corners: London's Mayfair and NCL, Dubai's office and safe. */
const corner = (d) => [d.inMayfair && 'Mayfair', d.inNcl && 'NCL', d.inOffice && 'office', d.inSafe && 'safe'].filter(Boolean).join(', ');

const locationKind = (key, label, place) => ({
  key,
  label,
  group: 'stock',
  place,
  fields: LOCATION_STOCK_FIELDS,
  summary: (d) => ({
    title: spec(d) || first(d, ['description']),
    sub: join(corner(d), d.consignment?.with && `on consignment with ${d.consignment.with}`, d.polish?.sentTo && d.polish.status !== 'done' && `at polish with ${d.polish.sentTo}`),
    status: d.status || 'current',
    date: d.receivedAt || d.createdAt,
  }),
});

const SPARES = (key, label) => ({
  key,
  label,
  group: 'stock',
  fields: [f('brand', 'Brand'), f('accessory', 'Accessory'), f('qty', 'Quantity', 'number'), f('fromStock', 'From stock', 'stock'), f('fromWatch', 'From watch'), f('notes', 'Notes', 'longtext')],
  summary: (d) => ({ title: join(d.accessory, d.qty > 1 && `× ${d.qty}`), sub: join(d.brand, d.fromStock && `from ${d.fromStock}`), date: d.addedAt }),
});

export const KINDS = [
  /* ── shipments ── */
  {
    key: 'shipments',
    label: 'Live shipments',
    group: 'shipments',
    fields: [
      f('date', 'Date', 'date'),
      f('stockNumber', 'Stock numbers', 'stock'),
      f('items', 'What is in it', 'longtext'),
      f('fromClientId', 'From (client)', 'client'),
      f('fromText', 'From (place)'),
      f('toClientId', 'To (client)', 'client'),
      f('toText', 'To (place)'),
      f('tracking', 'Tracking number'),
      f('status', 'Status', 'enum', { options: ['pending', 'in_transit', 'delivered', 'cancelled'] }),
      f('costAmount', 'Cost', 'money', { currency: 'costCurrency' }),
      f('costCurrency', 'Cost currency', 'currency'),
      f('deliveryDate', 'Expected delivery'),
      f('deliveredAt', 'Delivered', 'when'),
      f('situation', 'Situation'),
      f('hasWatch', 'Carries a watch', 'bool'),
      f('hkHolder', 'HK holder'),
      f('viaThirdParty', 'Through a mover', 'bool'),
      f('thirdPartyMoverName', 'Mover'),
      ...CUSTOMS,
      f('deliveryNotes', 'Delivery notes', 'longtext'),
      f('notes', 'Notes', 'longtext'),
    ],
    summary: (d, ctx) => ({
      title: first(d, ['items']) || join(d.watchBrand, d.watchReference) || 'Shipment',
      sub: join(ctx.route(d), d.tracking),
      status: ctx.stage(d).label,
      date: d.date || d.createdAt,
    }),
  },
  {
    key: 'thirdPartyShipments',
    label: 'Mover shipments',
    group: 'shipments',
    fields: [
      f('moverName', 'Mover'),
      f('stockNumber', 'Stock numbers', 'stock'),
      f('description', 'Description', 'longtext'),
      f('items', 'Items', 'longtext'),
      f('fromClientName', 'From'),
      f('fromCountry', 'From country'),
      f('toCountry', 'To country'),
      f('amount', 'Mover cost', 'money', { currency: 'currency' }),
      f('currency', 'Currency', 'currency'),
      f('paymentStatus', 'Paid', 'enum', { options: ['pending', 'paid'] }),
      f('status', 'Status', 'enum', { options: ['pending', 'in_transit', 'delivered', 'cancelled'] }),
      f('trackingNumber', 'Tracking number'),
      f('shipmentDate', 'Shipped', 'date'),
      f('deliveryDate', 'Delivered', 'date'),
      f('isOurStock', 'Our stock', 'bool'),
      ...CUSTOMS,
      f('notes', 'Notes', 'longtext'),
    ],
    summary: (d) => ({
      title: first(d, ['description', 'items']) || join(d.watchBrand, d.watchReference) || 'Mover shipment',
      sub: join(d.moverName, [d.fromCountry, d.toCountry].filter(Boolean).join(' → '), d.trackingNumber),
      status: join(d.status, d.paymentStatus === 'paid' ? 'paid' : d.paymentStatus && 'not paid'),
      date: d.shipmentDate || d.ts,
    }),
  },
  {
    key: 'thirdPartyMovers',
    label: 'Movers',
    group: 'shipments',
    fields: [f('name', 'Name'), f('country', 'Country'), f('contact', 'Contact'), f('notes', 'Notes', 'longtext')],
    summary: (d) => ({ title: d.name || 'Mover', sub: join(d.country, d.contact), date: d.ts }),
  },
  {
    key: 'driverDeliveries',
    label: 'Driver deliveries',
    group: 'shipments',
    stockField: 'stockNumbers',
    fields: [
      f('driverName', 'Driver'),
      f('dateGiven', 'Given', 'date'),
      f('stockNumbers', 'Stock numbers', 'stock'),
      f('destination', 'Destination'),
      f('status', 'Status', 'enum', { options: ['out', 'delivered', 'returned'] }),
      f('notes', 'Notes', 'longtext'),
    ],
    summary: (d) => ({ title: join(d.driverName && `Driver ${d.driverName}`, d.destination && `to ${d.destination}`), sub: d.notes, status: d.status, date: d.dateGiven || d.ts }),
  },
  {
    key: 'shipmentDocs',
    label: 'Shipping documents',
    group: 'shipments',
    summary: (d) => ({ title: first(d, ['title', 'name', 'docType', 'type']) || 'Document', sub: first(d, ['notes', 'description']), date: d.date || d.ts || d.createdAt }),
  },
  {
    key: 'pickupCodes',
    label: 'Pickup codes',
    group: 'shipments',
    // The handover code itself is not the title: it is on the record's own page, not in every list.
    summary: (d) => ({ title: first(d, ['title', 'name', 'carrier', 'courier', 'client', 'clientName']) || 'Pickup code', sub: first(d, ['address', 'location', 'notes']), status: d.status, date: d.date || d.ts || d.createdAt }),
  },
  {
    key: 'logisticsAddresses',
    label: 'Addresses',
    group: 'shipments',
    summary: (d) => ({ title: first(d, ['name', 'label', 'title']) || 'Address', sub: first(d, ['address', 'city', 'country', 'notes']) }),
  },

  /* ── incoming ── */
  {
    key: 'incomings',
    label: 'Incomings',
    group: 'incoming',
    fields: [
      f('stockNumber', 'Stock number', 'stock'),
      f('brand', 'Brand'),
      f('reference', 'Reference'),
      f('serial', 'Serial'),
      f('supplier', 'Supplier'),
      f('location', 'Where it is'),
      f('inventoryDest', 'Going to'),
      f('eta', 'Expected'),
      f('status', 'Status', 'enum', { options: ['pending', 'in_transit', 'arrived', 'consignment', 'cancelled'] }),
      f('costAmount', 'Cost', 'money', { currency: 'costCurrency' }),
      f('costCurrency', 'Cost currency', 'currency'),
      f('arrivedAt', 'Arrived', 'when'),
      f('fromFob', 'From Chrono Key', 'bool'),
      f('notes', 'Notes', 'longtext'),
    ],
    summary: (d) => ({
      title: [d.brand, d.reference].filter(Boolean).join(' ') || 'Incoming watch',
      sub: join(d.supplier && `from ${d.supplier}`, (d.inventoryDest || d.location) && `to ${d.inventoryDest || d.location}`, d.eta && `expected ${d.eta}`),
      status: d.status || 'pending',
      date: d.arrivedAt || d.createdAt,
    }),
  },
  {
    key: 'ownerDecisions',
    label: 'Owner decisions',
    group: 'incoming',
    summary: (d) => ({ title: join(d.action || d.decision || 'Decision', d.destination), sub: first(d, ['notes', 'collector']), status: d.status, date: d.updatedAt || d.createdAt }),
  },
  {
    key: 'fobPicked',
    label: 'Picked from Chrono Key',
    group: 'incoming',
    summary: (d) => ({ title: join(d.brand, d.model, d.reference), sub: join(d.supplier && `from ${d.supplier}`, d.location), status: d.status }),
  },

  /* ── stock by place ── */
  locationKind('londonStock', 'London', 'London'),
  locationKind('dubaiStock', 'Dubai', 'Dubai'),
  locationKind('hkStock', 'Hong Kong', 'Hong Kong'),
  {
    ...locationKind('safeStock', 'Safe (clients’ watches)', 'our safe'),
    // The safe holds clients' property: never counted as our stock.
    theirs: true,
  },
  {
    key: 'checkoutStock',
    label: 'Checked out',
    group: 'stock',
    fields: [
      f('stockNumber', 'Stock number', 'stock'),
      ...SPEC,
      f('checkedOutBy', 'Checked out by / why'),
      f('checkedOutDate', 'Checked out', 'date'),
      f('originLocation', 'From'),
      f('notes', 'Notes', 'longtext'),
    ],
    summary: (d) => ({ title: spec(d) || 'Checked out', sub: join(d.checkedOutBy, d.originLocation && `from ${d.originLocation}`), status: 'checked out', date: d.checkedOutDate }),
  },
  {
    key: 'hkSituation',
    label: 'HK situation',
    group: 'stock',
    fields: [
      f('stockNumber', 'Stock number', 'stock'),
      f('brand', 'Brand'),
      f('description', 'Description', 'longtext'),
      f('section', 'Section', 'enum', { options: ['in_hand', 'incoming', 'outgoing', 'sold'] }),
      f('holder', 'Held by'),
      f('stockStatus', 'Stock status'),
      f('notes', 'Notes', 'longtext'),
    ],
    summary: (d) => ({ title: join(d.brand, d.description) || 'HK watch', sub: d.holder && `held by ${d.holder}`, status: d.section, date: d.createdAt }),
  },
  SPARES('londonSpares', 'London spares'),
  SPARES('dubaiSpares', 'Dubai spares'),
  SPARES('hkSpares', 'HK spares'),
  SPARES('safeSpares', 'Safe spares'),

  /* ── sales & delivery ── */
  {
    key: 'readyForDelivery',
    label: 'Ready for delivery',
    group: 'sales',
    fields: [...SALE_FIELDS, f('status', 'Status', 'enum', { options: ['pending_ship', 'shipped'] })],
    summary: (d) => ({ title: spec(d) || 'Sold watch', sub: join(d.soldToBuyer && `to ${d.soldToBuyer}`, d.soldFromLocation && `from ${d.soldFromLocation}`), status: d.status === 'shipped' ? 'shipped' : 'waiting to ship', date: d.soldDate || d.ts }),
  },
  {
    key: 'soldStocks',
    label: 'Sold',
    group: 'sales',
    fields: [
      ...SALE_FIELDS,
      f('deliveredVia', 'Delivered by', 'enum', { options: ['in_person', 'shipment'] }),
      f('deliveredAt', 'Delivered', 'when'),
    ],
    summary: (d) => ({ title: spec(d) || 'Sold watch', sub: join(d.soldToBuyer && `to ${d.soldToBuyer}`, d.soldDate), status: d.deliveredAt ? 'delivered' : 'sold', date: d.soldDate || d.ts }),
  },

  /* ── trips ── */
  {
    key: 'personTrips',
    label: 'Trips',
    group: 'trips',
    stockField: 'stockIds',
    fields: [
      f('personName', 'Who'),
      f('fromLocation', 'From'),
      f('toLocation', 'To'),
      f('startDate', 'Starts', 'date'),
      f('endDate', 'Ends', 'date'),
      f('purpose', 'Purpose', 'longtext'),
      f('status', 'Status', 'enum', { options: ['planned', 'in_progress', 'completed'] }),
      f('notes', 'Notes', 'longtext'),
    ],
    summary: (d) => ({ title: join(d.personName, [d.fromLocation, d.toLocation].filter(Boolean).join(' → ')) || 'Trip', sub: d.purpose, status: d.status, date: d.startDate }),
  },
  {
    key: 'kashanPlans',
    label: 'Travel plans',
    group: 'trips',
    stockField: 'legs',
    summary: (d) => ({ title: d.name || 'Plan', sub: (d.legs || []).map((l) => l.toCity || l.to).filter(Boolean).join(' → '), status: d.status, date: d.date || d.createdAt }),
  },

  /* ── accessories ── */
  {
    key: 'transactions',
    label: 'Accessory transactions',
    group: 'accessories',
    fields: [
      f('type', 'Kind', 'enum', { options: ['bought', 'sold'] }),
      f('date', 'Date', 'date'),
      f('clientId', 'Client', 'client'),
      f('stockNumber', 'Stock number', 'stock'),
      f('brand', 'Brand'),
      f('reference', 'Reference'),
      f('notes', 'Notes', 'longtext'),
    ],
    summary: (d, ctx) => {
      const items = Array.isArray(d.items) ? d.items : [];
      const open = items.filter((i) => i.status !== 'done');
      return {
        title: join(d.type === 'sold' ? 'Sold' : d.type === 'bought' ? 'Bought' : '', [d.brand, d.reference].filter(Boolean).join(' ')) || 'Transaction',
        sub: join(ctx.client(d.clientId), open.length ? `${open.length} accessor${open.length === 1 ? 'y' : 'ies'} still open` : items.length && 'all settled'),
        status: open.length ? 'open' : 'settled',
        date: d.date || d.createdAt,
      };
    },
  },
  {
    key: 'accCollect',
    label: 'To collect',
    group: 'accessories',
    fields: [f('stockNumber', 'Stock number', 'stock'), f('items', 'What', 'longtext'), f('fromClient', 'From'), f('receivedFrom', 'Received from'), f('notes', 'Notes', 'longtext')],
    summary: (d) => ({ title: d.items || 'Accessories to collect', sub: d.fromClient && `from ${d.fromClient}`, status: 'to collect', date: d.ts || d.createdAt }),
  },
  {
    key: 'accGive',
    label: 'To give',
    group: 'accessories',
    fields: [f('stockNumber', 'Stock number', 'stock'), f('items', 'What', 'longtext'), f('toClient', 'To'), f('notes', 'Notes', 'longtext')],
    summary: (d) => ({ title: d.items || 'Accessories to give', sub: d.toClient && `to ${d.toClient}`, status: 'to give', date: d.ts || d.createdAt }),
  },
  {
    key: 'settlements',
    label: 'Settlements',
    group: 'accessories',
    summary: (d) => ({ title: `Settled ${(d.itemIds || []).length || ''} item(s)`.replace('  ', ' '), sub: d.notes, status: d.direction, date: d.ts || d.date }),
  },
  {
    key: 'swaps',
    label: 'Swaps',
    group: 'accessories',
    summary: (d) => ({ title: first(d, ['title', 'notes']) || 'Swap', date: d.ts || d.date }),
  },

  /* ── polish & services ── */
  {
    key: 'externalPolish',
    label: 'External polish',
    group: 'services',
    fields: [
      f('description', 'Watch', 'longtext'),
      f('sentTo', 'Sent to'),
      f('takenBy', 'Taken by'),
      f('sentDate', 'Sent', 'date'),
      f('expectedBack', 'Expected back', 'date'),
      f('costAmount', 'Cost', 'money', { currency: 'costCurrency' }),
      f('costCurrency', 'Cost currency', 'currency'),
      f('status', 'Status', 'enum', { options: ['at_polish', 'done'] }),
      f('returnDate', 'Back', 'date'),
      f('notes', 'Notes', 'longtext'),
    ],
    summary: (d) => ({ title: d.description || 'Polish', sub: join(d.sentTo && `with ${d.sentTo}`, d.sentDate && `since ${d.sentDate}`), status: d.status === 'done' ? 'back' : 'at polish', date: d.sentDate || d.createdAt }),
  },
  {
    key: 'goldSoukTasks',
    label: 'Gold souk tasks',
    group: 'services',
    summary: (d) => ({ title: first(d, ['title', 'task', 'description']) || 'Task', sub: first(d, ['shop', 'notes']), status: d.status, date: d.date || d.ts || d.createdAt }),
  },

  /* ── costs ── */
  {
    key: 'logisticCosts',
    label: 'Logistic costs',
    group: 'costs',
    fields: [
      f('date', 'Date', 'date'),
      f('title', 'What for'),
      f('stockNumber', 'Stock numbers', 'stock'),
      f('fromName', 'From'),
      f('toName', 'To'),
      f('amount', 'Amount', 'money', { currency: 'currency' }),
      f('currency', 'Currency', 'currency'),
      f('notes', 'Notes', 'longtext'),
    ],
    summary: (d) => ({ title: d.title || 'Cost', sub: [d.fromName, d.toName].filter(Boolean).join(' → '), money: { amount: Number(d.amount) || 0, currency: d.currency || '' }, date: d.date || d.ts }),
  },

  /* ── contacts ── */
  {
    key: 'clients',
    label: 'Logistics clients',
    group: 'contacts',
    fields: [f('name', 'Name'), f('country', 'Country'), f('isCompany', 'Company', 'bool'), f('notes', 'Notes', 'longtext')],
    summary: (d) => ({ title: d.name || 'Client', sub: join(d.country, d.isCompany && 'company'), date: d.createdAt }),
  },
  {
    key: 'companies',
    label: 'Companies',
    group: 'contacts',
    summary: (d) => ({ title: first(d, ['name', 'title']) || 'Company', sub: first(d, ['country', 'notes']) }),
  },

  /* ── activity ── */
  {
    key: 'activity',
    label: 'Activity',
    group: 'log',
    // The app keeps its last 200 lines only: an old line falling off the end
    // is not a deletion, so this list never mirrors one.
    keepGone: true,
    summary: (d) => ({ title: d.text || '', date: d.ts }),
  },
  { key: 'vaultNotifications', label: 'Vault notifications', group: 'log', keepGone: true, summary: (d) => ({ title: first(d, ['text', 'message', 'type']) || 'Notification', sub: first(d, ['field', 'loc']), status: d.status, date: d.ts }) },
  { key: 'ownerBriefs', label: 'Owner briefs', group: 'log', keepGone: true, summary: (d) => ({ title: first(d, ['title', 'text', 'message']).slice(0, 140) || 'Brief', date: d.ts || d.sentAt }) },
  { key: 'otherReceivingPics', label: 'Receiving pictures', group: 'log', summary: (d) => ({ title: first(d, ['title', 'description', 'clientName']) || 'Pictures', sub: d.notes, date: d.date || d.ts }) },
  { key: 'todoItems', label: 'To-do', group: 'log', summary: (d) => ({ title: first(d, ['text', 'title']) || 'To-do', status: d.done ? 'done' : 'open', date: d.ts || d.createdAt }) },
  // The vault's record of who holds which watch, keyed by the stock row's id (a map, not a list).
  { key: 'vaultTracking', label: 'Vault holders', group: 'log', map: true, stockField: 'mapKey', summary: (d) => ({ title: first(d, ['holder', 'location', 'loc']) || 'Vault tracking', sub: first(d, ['notes', 'status']), date: d.ts || d.updatedAt }) },
];

// No prototype: a kind or a field name comes from a request.
export const KIND = Object.assign(Object.create(null), Object.fromEntries(KINDS.map((k) => [k.key, k])));

/*
 * Never copied, whatever it is called: the logistics app's settings hold its
 * passwords — Chrono Key's sign-in, FedEx, the AI keys, the worker's own key,
 * the vault PIN — and masterapp keeps none of them.
 */
export const NEVER_COPIED = new Set(['settings', 'notepad']);
const SECRET = /^(password|secret|token|apikey|api_key|pin|vaultpin|.*(password|secret|token|apikey))$/i;
export const isSecret = (key) => SECRET.test(String(key));

/* ── stock numbers ─────────────────────────────────────────────────── */

/**
 * The stock numbers a value names: "1617", "1617, 1618", "#1617", a list of
 * them … The app's own rule splits on commas, semicolons and line breaks.
 * "-" is its placeholder for "none", and "SHIP-…" stands for a shipment.
 */
export function stockList(v) {
  const out = [];
  const add = (x) => {
    for (const part of String(x ?? '').split(/[,\n;]+/)) {
      const s = part.replace(/\s+/g, ' ').trim().replace(/^#\s*/, '');
      if (!s || s === '-' || /^ship-/i.test(s) || s.length > 40) continue;
      if (!out.includes(s)) out.push(s);
    }
  };
  if (Array.isArray(v)) v.forEach((x) => (typeof x === 'object' && x ? add(x.stockNumber) : add(x)));
  else add(v);
  return out;
}

/*
 * A trip names its watches by the id of the row they were in, with a prefix
 * for the list: lon-, dubai-, hk- (the HK situation list, then HK stock),
 * inc-, sold-, ready-. An id with no prefix is looked for in London, Dubai and
 * the HK lists.
 */
const TRIP_PREFIX = [
  ['lon-', ['londonStock']],
  ['dubai-', ['dubaiStock']],
  ['hk-', ['hkSituation', 'hkStock']],
  ['inc-', ['incomings']],
  ['sold-', ['soldStocks']],
  ['ready-', ['readyForDelivery']],
];

/** Every stock number a record names. `rowStock(kind, id)` finds a row's stock number. */
export function stockOf(kind, d, rowStock = () => '') {
  const k = KIND[kind];
  if (!d || typeof d !== 'object') return [];
  if (k?.stockField === 'stockIds') {
    const out = [];
    for (const sid of Array.isArray(d.stockIds) ? d.stockIds : []) {
      const s = String(sid);
      const hit = TRIP_PREFIX.find(([p]) => s.startsWith(p));
      const lists = hit ? hit[1] : ['londonStock', 'dubaiStock', 'hkSituation', 'hkStock'];
      const id = hit ? s.slice(hit[0].length) : s;
      for (const list of lists) {
        const n = rowStock(list, id);
        if (n) {
          out.push(...stockList(n));
          break;
        }
      }
    }
    return [...new Set([...out, ...stockList(d.stockNumber)])];
  }
  if (k?.stockField === 'legs') {
    const out = [];
    for (const leg of Array.isArray(d.legs) ? d.legs : []) {
      for (const part of ['deliveries', 'collections', 'stockMoves', 'items']) {
        for (const x of Array.isArray(leg?.[part]) ? leg[part] : []) out.push(...stockList(x?.stockNumber));
      }
    }
    return [...new Set(out)];
  }
  if (k?.stockField === 'mapKey') {
    const n = d.stockNumber || rowStock('*', d._key);
    return stockList(n);
  }
  if (k?.stockField === 'stockNumbers') return stockList(d.stockNumbers ?? d.stockNumber);
  if (kind === 'vaultNotifications' && !d.stockNumber && d.watchId) return stockList(rowStock('*', d.watchId));
  return stockList(d.stockNumber);
}
