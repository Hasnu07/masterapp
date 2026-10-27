/*
 * 3rd Party Movers — the logistics app's workflows, done here (asked 27 Oct
 * 2026). Each action is the app's own function, read from its index.html and
 * ported record for record:
 *
 *   tpm-mover-add / tpm-mover-edit / tpm-mover-delete   openTpmMoverModal,
 *                 saveTpmMover, deleteTpmMover
 *   tpm-add       "+ Add 3rd Party Shipment" (openTpmShipmentModal /
 *                 saveTpmShipment): the mover shipment, its cost line
 *                 (syncTpmShipmentCost: logisticCosts with
 *                 thirdPartyShipmentId, the line's id kept on the shipment),
 *                 and its mirror in Live Shipments (syncTpmShipmentToLive)
 *   tpm-edit      the same form on a mover shipment
 *   tpm-payment   the modal's Payment box on its own: pending / partial / paid
 *   tpm-status    the modal's Status box on its own
 *   tpm-not-payable   toggleTpmNotPayable ("💚")
 *   tpm-delete    deleteTpmShipment, with its cost line and its live mirror
 *   tpm-import    importTpmCsv (the app's columns), with its template
 *   tpm-import-movers   importTpmMoversCsv, with its template
 *
 * Our rule: a stock number is our watch (said in the message when it is
 * not); the "From client" is a logistics client chosen by id, or a typed
 * name — never a name matched to a client (the app matches the typed name to
 * its client list exactly; that is the one thing not ported). The customs
 * sheet's arithmetic is the app's: customs = value × rate %, in AED at the
 * typed rate; a valued watch's customs AED becomes the shipment amount.
 * Documents and photos go on through POST /api/logistics/items/:id/files
 * ?field=shippingDocuments | photos (the console draws the control).
 */
import { query } from '../../db/index.js';
import { parseCsv } from '../../import/productlist.js';
import { parseMoney } from '../../watches/fields.js';
import { insertItem, patchItem, softDelete, logActivity, listKind, text, dayOf, amountOf, currencyOf, bad, localToday } from '../write.js';
import { clientsOf, moversOf, byAppId, notOurs, isCompany } from './shipping.js';

const PAYMENTS = ['pending', 'paid', 'partial'];
const STATUSES = ['pending', 'in_transit', 'delivered', 'cancelled'];
const num = (v, fallback = 0) => {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = typeof v === 'number' ? v : parseMoney(v);
  return Number.isFinite(n) ? n : fallback;
};
const asBool = (v) => v === true || /^(true|yes|1|on)$/i.test(String(v ?? ''));
const stockOrDesc = (d) => d.stockNumber || d.description;

const MOVER_FORM = [
  { key: 'name', label: 'Mover name', type: 'text', required: true },
  { key: 'country', label: 'Country', type: 'text' },
  { key: 'contact', label: 'Contact', type: 'text', hint: 'phone, email' },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];
const moverData = (input) => {
  const name = text(input.name, 200);
  if (!name) throw bad('Mover name required');
  return { name, country: text(input.country, 100), contact: text(input.contact, 300), notes: text(input.notes, 2000) };
};

/** The customs arithmetic as the app's updateTpmCustomsCalc / saveTpmShipment do it. */
export function customsOf(input) {
  const valueUsd = amountOf(input.valueUsd, 'Value of the watch');
  const customsRatePct = num(input.customsRatePct, 0.3) || 0.3;
  const aedPerUsd = num(input.aedPerUsd, 3.67) || 3.67;
  const customsUsd = valueUsd * (customsRatePct / 100);
  const customsAed = customsUsd * aedPerUsd;
  return { valueUsd, customsRatePct, aedPerUsd, customsUsd, customsAed };
}

async function tpmForm(db = { query }) {
  const movers = await moversOf(db);
  const clients = await clientsOf(db);
  const moverOptions = [...movers.values()].map((m) => ({ value: text(m.data.id), label: `${text(m.data.name)}${m.data.country ? ` (${text(m.data.country)})` : ''}` }));
  const clientOptions = [...clients.values()].sort((a, b) => a.name.localeCompare(b.name)).map((c) => ({ value: c.id, label: isCompany(c) ? `🏢 ${c.country}` : `${c.name}${c.country ? ` (${c.country})` : ''}` }));
  return [
    { key: 'moverId', label: 'Mover', type: 'choice', required: true, options: moverOptions.length ? moverOptions : [{ value: '', label: '— add a Mover first —' }] },
    { key: 'isOurStock', label: 'Our stock (else a friend’s)', type: 'bool' },
    { key: 'stockNumber', label: 'Stock numbers', type: 'stock', hint: 'our stock — each is our watch when we hold it' },
    { key: 'description', label: 'Description', type: 'text', hint: 'a friend’s stock — what it is' },
    { key: 'fromClientId', label: 'From client', type: 'choice', options: [{ value: '', label: '— typed below —' }, ...clientOptions] },
    { key: 'fromClientName', label: 'From person / client (typed)', type: 'text' },
    { key: 'fromCountry', label: 'From country', type: 'text', required: true },
    { key: 'toCountry', label: 'To country', type: 'text', required: true },
    { key: 'items', label: 'Items', type: 'longtext' },
    { key: 'shipmentDate', label: 'Shipment date', type: 'date' },
    { key: 'deliveryDate', label: 'Delivery date', type: 'date' },
    { key: 'amount', label: 'Mover cost', type: 'money', currency: 'currency' },
    { key: 'currency', label: 'Currency', type: 'currency' },
    { key: 'paymentStatus', label: 'Payment', type: 'enum', options: PAYMENTS },
    { key: 'status', label: 'Status', type: 'enum', options: STATUSES },
    { key: 'trackingNumber', label: 'Tracking number', type: 'text' },
    { key: 'watchBrand', label: 'Watch brand (customs)', type: 'text' },
    { key: 'watchReference', label: 'Watch reference (customs)', type: 'text' },
    { key: 'valueUsd', label: 'Value of the watch (USD)', type: 'money', hint: 'a valued watch’s customs in AED becomes the shipment amount, as the app does' },
    { key: 'customsRatePct', label: 'Customs rate %', type: 'number' },
    { key: 'aedPerUsd', label: 'AED per USD', type: 'number' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
  ];
}

/** The mover shipment's fields from the form, as saveTpmShipment reads its modal. */
export function tpmData(input, { movers, clients, was = {} }) {
  if (!movers.size) throw bad('Add a mover first');
  const isOurStock = input.isOurStock === undefined ? true : asBool(input.isOurStock);
  const moverId = text(input.moverId, 80);
  const mover = movers.get(moverId);
  if (!mover) throw bad('Pick a mover');
  const fromClientId = text(input.fromClientId, 80);
  const client = fromClientId ? clients.get(fromClientId) : null;
  if (fromClientId && !client) throw bad('From client: no logistics client with that id');
  const fromClient = client ? client.name : text(input.fromClientName, 200);
  const fromCountry = text(input.fromCountry, 100);
  const toCountry = text(input.toCountry, 100);
  if (!fromClient) throw bad('From person / client name required');
  if (!fromCountry || !toCountry) throw bad('From and To country required');
  const stockNumber = text(input.stockNumber, 500);
  const description = text(input.description, 500);
  if (isOurStock && !stockNumber) throw bad("Stock # required (or switch to Friend's stock)");
  if (!isOurStock && !description) throw bad("Description required for friend's stock");
  let amount = amountOf(input.amount, 'Mover cost');
  let currency = currencyOf(input.currency, 'GBP');
  const customs = customsOf(input);
  // A valued watch: the customs AED is the recorded amount (the typed cost is the fallback).
  if (customs.valueUsd > 0 && customs.customsAed > 0) {
    amount = customs.customsAed;
    currency = 'AED';
  }
  const paymentStatus = text(input.paymentStatus, 20) || 'pending';
  if (!PAYMENTS.includes(paymentStatus)) throw bad(`Payment: "${paymentStatus}" is not one of ${PAYMENTS.join(', ')}`);
  const status = text(input.status, 20) || 'pending';
  if (!STATUSES.includes(status)) throw bad(`Status: "${status}" is not one of ${STATUSES.join(', ')}`);
  return {
    moverId,
    moverName: text(mover.data.name) || '(unknown)',
    isOurStock,
    stockNumber: isOurStock ? stockNumber : '',
    description: !isOurStock ? description : '',
    fromClientId: client ? client.id : null,
    fromClientName: fromClient,
    fromCountry,
    toCountry,
    items: text(input.items, 2000),
    currency,
    amount,
    paymentStatus,
    status,
    trackingNumber: text(input.trackingNumber, 100),
    shipmentDate: dayOf(input.shipmentDate, 'Shipment date'),
    deliveryDate: dayOf(input.deliveryDate, 'Delivery date', { blank: '' }),
    notes: text(input.notes, 2000),
    photos: Array.isArray(was.photos) ? was.photos : [],
    shippingDocuments: Array.isArray(was.shippingDocuments) ? was.shippingDocuments : [],
    watchBrand: text(input.watchBrand, 100),
    watchReference: text(input.watchReference, 100),
    ...customs,
  };
}

/** The app's syncTpmShipmentCost: the old line goes, a new one is written for our stock with a cost; its id kept on the shipment. */
export async function syncTpmCost(db, tpm, user) {
  const s = tpm.data;
  let logisticCostId = null;
  if (s.logisticCostId) {
    const old = await byAppId(db, 'logisticCosts', s.logisticCostId);
    if (old) await softDelete(db, old.id, user);
  }
  if (s.isOurStock && s.amount > 0 && s.stockNumber) {
    const lc = await insertItem(
      db,
      'logisticCosts',
      {
        thirdPartyShipmentId: s.id,
        title: `3rd Party · ${s.moverName} · ${s.items || s.stockNumber}`,
        stockNumber: s.stockNumber,
        fromClientId: s.fromClientId,
        fromName: s.fromCountry || s.fromClientName,
        toName: s.toCountry,
        date: s.shipmentDate || localToday(),
        currency: s.currency,
        amount: Number(s.amount) || 0,
        notes: s.notes || '',
      },
      user
    );
    logisticCostId = lc.data.id;
  }
  if ((s.logisticCostId || null) !== logisticCostId) await patchItem(db, tpm, { ...tpm.data, logisticCostId }, user);
  return logisticCostId;
}

/** The app's syncTpmShipmentToLive: the same shipment in Live Shipments too, its cost left on the mover's line. */
export async function syncTpmToLive(db, tpm, user) {
  const s = tpm.data;
  const found = await listKind(db, 'shipments', "data->>'tpmShipmentId' = $2 OR ($3 <> '' AND data->>'id' = $3)", [text(s.id), text(s.liveShipmentId)]);
  let live = found[0] || null;
  const status = STATUSES.includes(s.status) ? s.status : 'pending';
  const fields = {
    date: s.shipmentDate || (live ? live.data.date : localToday()),
    stockNumber: s.stockNumber || '',
    fromClientId: s.fromClientId || null,
    fromText: s.fromClientName || s.fromCountry || '',
    toClientId: null,
    toText: s.toCountry || '',
    items: s.items || s.description || (s.stockNumber ? `Stock ${s.stockNumber}` : 'Shipment'),
    tracking: s.trackingNumber || '',
    cost: '',
    costCurrency: s.currency || 'AED',
    costAmount: 0,
    deliveryDate: s.deliveryDate || '',
    situation: '',
    status,
    hasWatch: Boolean(s.isOurStock && s.stockNumber),
    viaThirdParty: true,
    thirdPartyMoverId: s.moverId || '',
    thirdPartyMoverName: s.moverName || '',
    watchBrand: s.watchBrand || '',
    watchReference: s.watchReference || '',
    valueUsd: Number(s.valueUsd) || 0,
    customsRatePct: Number(s.customsRatePct) || 0.3,
    aedPerUsd: Number(s.aedPerUsd) || 3.67,
    customsUsd: Number(s.customsUsd) || 0,
    customsAed: Number(s.customsAed) || 0,
    tpmShipmentId: s.id,
    originTpm: true,
  };
  if (live) await patchItem(db, live, { ...live.data, ...fields }, user);
  else live = await insertItem(db, 'shipments', { ...fields, deliveredAt: null, deliveryNotes: '', deliveryPhotos: [], missingItems: [] }, user);
  if (text(s.liveShipmentId) !== text(live.data.id)) await patchItem(db, tpm, { ...tpm.data, liveShipmentId: live.data.id }, user);
  return live;
}

/** The app's findOrCreateTpmMover: by name, case-insensitively; made when missing (its own note and activity line). */
export async function findOrCreateMover(db, name, movers, user) {
  const target = text(name).toLowerCase();
  if (!target) return null;
  for (const m of movers.values()) if (text(m.data.name).toLowerCase() === target) return m;
  const row = await insertItem(db, 'thirdPartyMovers', { name: text(name), country: '', contact: '', notes: 'Auto-created from HK movement' }, user);
  movers.set(text(row.data.id), row);
  await logActivity(db, `🚛 Auto-created 3rd party mover "${text(name)}" from HK movement`, user);
  return row;
}

/** The app's deleteTpmShipment / removeTpmShipmentById: the cost line and the live mirror go with it. */
async function removeTpm(db, tpm, user) {
  const s = tpm.data;
  if (s.logisticCostId) {
    const lc = await byAppId(db, 'logisticCosts', s.logisticCostId);
    if (lc) await softDelete(db, lc.id, user);
  }
  const mirrors = await listKind(db, 'shipments', "(data->>'originTpm')::boolean AND (data->>'tpmShipmentId' = $2 OR ($3 <> '' AND data->>'id' = $3))", [text(s.id), text(s.liveShipmentId)]);
  for (const m of mirrors) await softDelete(db, m.id, user);
  await softDelete(db, tpm.id, user);
}

/* The CSV helpers, as the app's importers read a sheet: headers lower-cased, by name with the app's alternatives. */
function sheetOf(csvText) {
  const rows = parseCsv(String(csvText || '')).filter((r) => r.some((v) => v && v.trim() !== ''));
  if (rows.length < 2) throw bad('CSV is empty or only has a header row.');
  const header = rows[0].map((h) => text(h).toLowerCase().replace(/\s+/g, ' '));
  const col = (name, alts = []) => {
    const all = [name, ...alts].map((n) => n.toLowerCase());
    for (let h = 0; h < header.length; h += 1) if (all.includes(header[h])) return h;
    return -1;
  };
  return { rows: rows.slice(1), header, col };
}

const tpmEdit = (label, fields, run) => ({ key: '', label, kinds: ['thirdPartyShipments'], form: fields, prefill: async (it) => ({ ...it.data }), run });

export const ACTIONS = [
  {
    key: 'tpm-mover-add',
    label: 'Add mover',
    kinds: null,
    page: 'movers',
    form: MOVER_FORM,
    run: async ({ db, input, user }) => {
      const data = moverData(input);
      const row = await insertItem(db, 'thirdPartyMovers', data, user);
      await logActivity(db, `🚛 Mover added: ${data.name}`, user);
      return { message: `Mover saved: ${data.name}`, created: [row.id] };
    },
  },
  {
    key: 'tpm-mover-edit',
    label: 'Edit mover',
    kinds: ['thirdPartyMovers'],
    form: MOVER_FORM,
    prefill: async (it) => ({ ...it.data }),
    run: async ({ db, item, input, user }) => {
      const data = moverData(input);
      await patchItem(db, item, { ...item.data, ...data }, user);
      await logActivity(db, `🚛 Mover updated: ${data.name}`, user);
      return { message: `Mover saved: ${data.name}` };
    },
  },
  {
    key: 'tpm-mover-delete',
    label: 'Delete mover',
    kinds: ['thirdPartyMovers'],
    danger: true,
    // The app: its shipments stay, shown as "(deleted mover)". No activity line there either.
    run: async ({ db, item, user }) => {
      const n = (await listKind(db, 'thirdPartyShipments', "data->>'moverId' = $2", [text(item.data.id)])).length;
      await softDelete(db, item.id, user);
      return { message: `Mover deleted${n ? ` · ${n} shipment${n === 1 ? '' : 's'} still name${n === 1 ? 's' : ''} it` : ''}`, open: '#/logistics/movers' };
    },
  },
  {
    key: 'tpm-add',
    label: 'Add shipment',
    kinds: null,
    page: 'movers',
    form: () => tpmForm(),
    prefill: async () => ({ isOurStock: true, shipmentDate: localToday(), currency: 'GBP', paymentStatus: 'pending', status: 'pending', customsRatePct: 0.3, aedPerUsd: 3.67 }),
    run: async ({ db, input, user }) => {
      const movers = await moversOf(db);
      const clients = await clientsOf(db);
      const data = tpmData(input, { movers, clients });
      const row = await insertItem(db, 'thirdPartyShipments', { ...data, logisticCostId: null }, user);
      await logActivity(db, `🚛 New 3rd party shipment: ${data.moverName} · ${stockOrDesc(data)} · ${data.fromCountry} → ${data.toCountry}`, user);
      await syncTpmCost(db, row, user);
      await syncTpmToLive(db, row, user);
      return { message: `Shipment saved · also in Live Shipments${data.isOurStock ? await notOurs(data.stockNumber) : ''}`, open: `#/lg/${row.id}`, created: [row.id] };
    },
  },
  {
    key: 'tpm-edit',
    label: 'Edit shipment',
    kinds: ['thirdPartyShipments'],
    form: () => tpmForm(),
    prefill: async (it) => ({ ...it.data, isOurStock: it.data.isOurStock !== false, currency: it.data.currency || 'GBP', customsRatePct: it.data.customsRatePct ?? 0.3, aedPerUsd: it.data.aedPerUsd ?? 3.67 }),
    run: async ({ db, item, input, user }) => {
      const movers = await moversOf(db);
      const clients = await clientsOf(db);
      const data = tpmData(input, { movers, clients, was: item.data });
      await patchItem(db, item, { ...item.data, ...data }, user);
      await logActivity(db, `🚛 Updated 3rd party shipment: ${data.moverName} · ${stockOrDesc(data)}`, user);
      await syncTpmCost(db, item, user);
      await syncTpmToLive(db, item, user);
      return { message: `Shipment saved · also in Live Shipments${data.isOurStock ? await notOurs(data.stockNumber) : ''}` };
    },
  },
  {
    ...tpmEdit('Set payment', [{ key: 'paymentStatus', label: 'Payment', type: 'enum', options: PAYMENTS, required: true }], async ({ db, item, input, user }) => {
      const paymentStatus = text(input.paymentStatus, 20);
      if (!PAYMENTS.includes(paymentStatus)) throw bad(`Payment: pending, partial or paid`);
      await patchItem(db, item, { ...item.data, paymentStatus }, user);
      await logActivity(db, `🚛 Updated 3rd party shipment: ${text(item.data.moverName)} · ${stockOrDesc(item.data)}`, user);
      return { message: `Marked ${paymentStatus}` };
    }),
    key: 'tpm-payment',
  },
  {
    ...tpmEdit('Set status', [{ key: 'status', label: 'Status', type: 'enum', options: STATUSES, required: true }], async ({ db, item, input, user }) => {
      const status = text(input.status, 20);
      if (!STATUSES.includes(status)) throw bad(`Status: ${STATUSES.join(', ')}`);
      await patchItem(db, item, { ...item.data, status }, user);
      await logActivity(db, `🚛 Updated 3rd party shipment: ${text(item.data.moverName)} · ${stockOrDesc(item.data)}`, user);
      await syncTpmToLive(db, item, user);
      return { message: `Marked ${status.replace('_', ' ')}` };
    }),
    key: 'tpm-status',
  },
  {
    key: 'tpm-not-payable',
    label: 'Payable by us: toggle',
    kinds: ['thirdPartyShipments'],
    run: async ({ db, item, user }) => {
      const notPayable = !item.data.notPayable;
      await patchItem(db, item, { ...item.data, notPayable }, user);
      await logActivity(db, `🚛 ${text(item.data.moverName)} ${stockOrDesc(item.data)}: ${notPayable ? 'NOT payable by us' : 'payable by us'}`, user);
      return { message: notPayable ? 'Marked not payable by us' : 'Marked payable by us' };
    },
  },
  {
    key: 'tpm-delete',
    label: 'Delete shipment',
    kinds: ['thirdPartyShipments'],
    danger: true,
    run: async ({ db, item, user }) => {
      await removeTpm(db, item, user);
      return { message: 'Shipment deleted · its cost line and live mirror with it', open: '#/logistics/movers' };
    },
  },
  {
    key: 'tpm-import',
    label: 'Import shipments (CSV)',
    kinds: null,
    page: 'movers',
    form: [{ key: 'csv', label: 'CSV file', type: 'csv', hint: 'the app’s columns — download the template' }],
    template: () =>
      'mover,owner,stockNumber,description,fromClient,fromCountry,toCountry,items,currency,amount,paymentStatus,status,trackingNumber,shipmentDate,deliveryDate,watchBrand,watchReference,valueUsd,customsRatePct,aedPerUsd,notes\n' +
      [
        'Ferrari,ours,1265,,Adam Rasul,UK,Dubai,"Rolex Daytona",AED,3670,paid,pending,TRK123456,2026-06-16,2026-06-20,Rolex,116500LN,20000,0.3,3.67,"customs paid in AED"',
        'RK,friend,,Patek Nautilus full set,Winnie,Hong Kong,Dubai,"PP Nautilus",USD,150,unpaid,in_transit,RK99887,2026-06-14,,,,,,,"friend stock, no customs"',
        'FORAK,ours,1300,,STEFANO,UK,Dubai,"Rolex Datejust",AED,1835,paid,delivered,FK55221,2026-06-10,2026-06-12,Rolex,126234,10000,0.3,3.67,',
      ].join('\n') +
      '\n',
    // The app's importTpmCsv, row for row — its mover made when missing, its cost line and live mirror written.
    run: async ({ db, input, user }) => {
      const { rows, header, col } = sheetOf(input.csv);
      const idx = {
        mover: col('mover', ['movername', 'mover name', 'carrier']),
        owner: col('owner', ['ourstock', 'stock owner']),
        stock: col('stocknumber', ['stock', 'stock #', 'stock no']),
        description: col('description', ['desc']),
        fromClient: col('fromclient', ['from client', 'from', 'client', 'sender']),
        fromCountry: col('fromcountry', ['from country']),
        toCountry: col('tocountry', ['to country']),
        items: col('items', ['item', 'contents']),
        currency: col('currency', ['cur']),
        amount: col('amount', ['cost', 'mover cost']),
        payment: col('paymentstatus', ['payment', 'payment status', 'paid']),
        status: col('status', ['shipment status']),
        tracking: col('trackingnumber', ['tracking', 'tracking number', 'awb']),
        shipDate: col('shipmentdate', ['shipment date', 'date', 'ship date']),
        delivDate: col('deliverydate', ['delivery date', 'eta']),
        brand: col('watchbrand', ['brand']),
        ref: col('watchreference', ['reference', 'ref']),
        valueUsd: col('valueusd', ['value', 'value usd', 'watch value']),
        rate: col('customsratepct', ['customs rate', 'customs %', 'rate']),
        aed: col('aedperusd', ['aed per usd', 'aed rate']),
        notes: col('notes', ['note', 'remarks']),
      };
      if (idx.mover < 0) throw bad(`CSV missing required "mover" column. Detected headers: ${header.join(', ')}. Download the Template for the correct format.`);
      const movers = await moversOf(db);
      const n = (v) => parseFloat(String(v || '').replace(/,/g, '')) || 0;
      let added = 0;
      let skipped = 0;
      const skipReasons = [];
      const created = [];
      const notHeld = new Set();
      for (const [i, r] of rows.entries()) {
        const lineNum = i + 2;
        const get = (k) => (idx[k] >= 0 ? text(r[idx[k]], 2000) : '');
        const moverName = get('mover');
        if (!moverName && !get('fromClient') && !get('stock')) continue;
        if (!moverName) {
          skipped += 1;
          skipReasons.push(`Line ${lineNum}: missing mover`);
          continue;
        }
        const mover = await findOrCreateMover(db, moverName, movers, user);
        const isOurStock = !/^(friend|no|theirs|0|false)$/i.test(get('owner') || 'ours');
        const valueUsd = n(get('valueUsd'));
        const customsRatePct = idx.rate >= 0 && get('rate') ? n(get('rate')) : 0.3;
        const aedPerUsd = idx.aed >= 0 && get('aed') ? n(get('aed')) : 3.67;
        const customsUsd = valueUsd * (customsRatePct / 100);
        const customsAed = customsUsd * aedPerUsd;
        let amount = n(get('amount'));
        let currency = (get('currency') || 'AED').toUpperCase();
        if (valueUsd > 0 && customsAed > 0 && amount === 0) {
          amount = customsAed;
          currency = 'AED';
        }
        const stockNumber = isOurStock ? get('stock') : '';
        const row = await insertItem(
          db,
          'thirdPartyShipments',
          {
            logisticCostId: null,
            moverId: mover ? text(mover.data.id) : null,
            moverName: mover ? text(mover.data.name) : moverName,
            isOurStock,
            stockNumber,
            description: !isOurStock ? get('description') : '',
            // The app matches the typed name to its client list; here the name is kept as typed (never matched).
            fromClientId: null,
            fromClientName: get('fromClient'),
            fromCountry: get('fromCountry'),
            toCountry: get('toCountry'),
            items: get('items'),
            currency,
            amount,
            paymentStatus: get('payment') || 'unpaid',
            status: get('status') || 'pending',
            trackingNumber: get('tracking'),
            shipmentDate: get('shipDate'),
            deliveryDate: get('delivDate'),
            notes: get('notes'),
            photos: [],
            watchBrand: get('brand'),
            watchReference: get('ref'),
            valueUsd,
            customsRatePct,
            aedPerUsd,
            customsUsd,
            customsAed,
          },
          user
        );
        await syncTpmCost(db, row, user);
        await syncTpmToLive(db, row, user);
        created.push(row.id);
        added += 1;
        if (stockNumber) {
          const flag = await notOurs(stockNumber);
          if (flag) notHeld.add(stockNumber);
        }
      }
      await logActivity(db, `🚛 3rd Party Movers CSV import — added ${added}, skipped ${skipped}`, user);
      return {
        message: `3rd Party Movers import complete · added ${added} · skipped ${skipped}${skipReasons.length ? ` (${skipReasons.slice(0, 20).join('; ')})` : ''}${notHeld.size ? ` · not our watches: ${[...notHeld].join(', ')}` : ''}`,
        created,
      };
    },
  },
  {
    key: 'tpm-import-movers',
    label: 'Import movers (CSV)',
    kinds: null,
    page: 'movers',
    form: [{ key: 'csv', label: 'CSV file', type: 'csv', hint: 'name, country, contact, notes — a mover already listed is updated' }],
    template: () =>
      'name,country,contact,notes\n' +
      'Ferrari,UK,"+44 7700 900123 · ops@ferrari-logistics.example","Main UK ↔ Dubai courier"\n' +
      'RK,Hong Kong,"+852 5555 1234 · rk@example.com","HK consolidations"\n' +
      'FORAK,Dubai,"+971 50 123 4567","Local UAE customs clearing"\n',
    // The app's importTpmMoversCsv.
    run: async ({ db, input, user }) => {
      const { rows, header, col } = sheetOf(input.csv);
      const idx = { name: col('name', ['mover', 'mover name', 'carrier', 'company']), country: col('country', ['location']), contact: col('contact', ['phone', 'email', 'contact details']), notes: col('notes', ['note', 'remarks']) };
      if (idx.name < 0) throw bad(`CSV missing required "name" column. Detected headers: ${header.join(', ')}. Download the Movers Template for the correct format.`);
      const movers = await moversOf(db);
      let added = 0;
      let updated = 0;
      let skipped = 0;
      const skipReasons = [];
      const created = [];
      for (const [i, r] of rows.entries()) {
        const get = (k) => (idx[k] >= 0 ? text(r[idx[k]], 2000) : '');
        const name = get('name');
        if (!name) {
          if (r.join('').trim()) {
            skipped += 1;
            skipReasons.push(`Line ${i + 2}: missing name`);
          }
          continue;
        }
        const data = { country: get('country'), contact: get('contact'), notes: get('notes') };
        const existing = [...movers.values()].find((m) => text(m.data.name).toLowerCase() === name.toLowerCase());
        if (existing) {
          await patchItem(db, existing, { ...existing.data, ...data }, user);
          updated += 1;
        } else {
          const row = await insertItem(db, 'thirdPartyMovers', { name, ...data }, user);
          movers.set(text(row.data.id), row);
          created.push(row.id);
          added += 1;
        }
      }
      await logActivity(db, `🚛 Movers ledger CSV import — added ${added}, updated ${updated}, skipped ${skipped}`, user);
      return { message: `Movers import complete · added ${added} · updated ${updated} · skipped ${skipped}${skipReasons.length ? ` (${skipReasons.slice(0, 20).join('; ')})` : ''}`, created };
    },
  },
];

/* Fields the app's form has that kinds.js does not type, for the record page's Edit. */
export const FIELDS = {
  thirdPartyShipments: [
    { key: 'notPayable', label: 'Not payable by us', type: 'bool' },
    { key: 'moverId', label: 'Mover (id)', type: 'text' },
  ],
};
