/*
 * Stock-by-place actions — the logistics app's London Stock, Dubai Stock, HK
 * Stock (with its HK situation board), In Safe and Checkout workflows, done
 * here. Every one is read from the app's own function for the button and
 * writes the same records, field for field (its index.html: saveLondonRow,
 * importStockCsv / downloadStockTemplate, confirmLondonMove, londonMoveBack,
 * confirmCheckout / returnFromCheckout / deleteCheckoutRow, updateStockNote,
 * toggleVaultVisibility, deleteLondonRow, addLondonSparePrompt /
 * deleteLondonSpare, saveHkRow / saveHkMove / deleteHkRow, runStockTake).
 * The app draws London, Dubai, HK and the safe with ONE engine
 * (STOCK_LOC_CONFIG), so most actions here apply to the four kinds at once.
 *
 * Sold and Consign / Back from consignment are the sales domain's
 * (actions/sales.js: cons-sold, cons-consign, cons-edit, cons-back) and are
 * only drawn here. Polish reuses POST /api/logistics/items/:id/polish.
 *
 * Our rule throughout: a stock number is OUR watch (a number we do not hold
 * is allowed, and said so); a client is one of our logistics clients when
 * chosen, else the name as typed (linked by linksByName on the pages, never
 * matched here); nothing is written back to the app.
 *
 * Not ported, on purpose: "Reset" (the app re-seeds a place from its May
 * PDF snapshot — wiping live records here would be wrong); the app's
 * WhatsApp notices after a sale or a consignment (no bot here); the
 * "Cost" button (a read: our watch's page shows what moving it cost).
 */
import { query } from '../../db/index.js';
import { KIND } from '../kinds.js';
import { oursByNumber } from '../shared.js';
import { parseCsv } from '../../import/productlist.js';
import { ask } from '../ai.js';
import { insertItem, patchItem, softDelete, logActivity, listKind, text, dayOf, amountOf, currencyOf, uid, localToday, bad } from '../write.js';

const f = (key, label, type = 'text', more = {}) => ({ key, label, type, ...more });

/* The app's STOCK_LOC_CONFIG, by the kind the records are kept as. */
export const PLACES = {
  londonStock: { kind: 'londonStock', loc: 'london', label: '🇬🇧 London', place: 'London', page: 'londonstock', csv: 'London Stock', spares: 'londonSpares', corners: [['inMayfair', 'In Mayfair'], ['inNcl', 'In NCL']], dest: 'London Stock' },
  dubaiStock: { kind: 'dubaiStock', loc: 'dubai', label: '🇦🇪 Dubai', place: 'Dubai', page: 'dubaistock', csv: 'Dubai Stock', spares: 'dubaiSpares', corners: [['inOffice', 'In office'], ['inSafe', 'In safe']], dest: 'Dubai Stock' },
  hkStock: { kind: 'hkStock', loc: 'hk', label: '🌐 HK Stock', place: 'Hong Kong', page: 'hkstock', csv: 'HK Stock', spares: 'hkSpares', corners: [['inVault', 'In vault'], ['withClient', 'With client']], dest: 'Hong Kong' },
  safeStock: { kind: 'safeStock', loc: 'safe', label: '🔒 In Safe', place: 'the safe', page: 'safe', csv: 'Safe Stock', spares: 'safeSpares', corners: [['inSafe', 'In safe / box'], ['withClient', 'Back with owner']], dest: 'In Safe' },
};
const STOCK_KINDS = Object.keys(PLACES);
const byLoc = (loc) => Object.values(PLACES).find((p) => p.loc === loc);
export const HK_SECTIONS = [
  { key: 'in_hand', title: 'HK Stock (In Hand)' },
  { key: 'incoming', title: 'Incomings to HK' },
  { key: 'outgoing', title: 'Going out from HK' },
  { key: 'sold', title: '💰 Sold Stock' },
];
const hkSectionTitle = (key) => HK_SECTIONS.find((s) => s.key === key)?.title || key;
/* The app's brand list (BRAND_ACCESSORIES' keys), offered as a hint. */
const BRANDS = ['Patek Philippe', 'Rolex', 'Audemars Piguet', 'Richard Mille', 'Cartier', 'Vacheron Constantin', 'Omega', 'Other'];

const what = (d) => text(d.stockNumber) || text(d.watchModel) || text(d.watchReference) || 'watch';
const sn = (d) => text(d.stockNumber);
/* "Watch, Box, Papers" as a list, the app's own split (comma). */
const accList = (v) => text(v, 2000).split(',').map((s) => s.trim()).filter(Boolean);
/* "Links ×2" → { accessory, qty }, as the app's grid gives it. */
const accQty = (s) => {
  const m = String(s).match(/^(.*?)\s*[×x]\s*(\d+)$/i);
  return m ? { accessory: m[1].trim(), qty: Math.max(1, parseInt(m[2], 10) || 1) } : { accessory: String(s).trim(), qty: 1 };
};
const withQty = (a) => a.accessory + (a.qty > 1 ? ' ×' + a.qty : '');
const snapshot = (d) => JSON.parse(JSON.stringify(d));

/* ' (not one of our watches)' for a number we do not hold — the rule's flag. */
async function oursNote(stockNumber) {
  const n = text(stockNumber);
  if (!n) return '';
  const ours = await oursByNumber([n]);
  return ours.has(n) ? '' : ' — not one of our watches';
}

/*
 * The app's findDuplicateStockNumber: a number already in the safe, London,
 * Dubai or HK (not a moved row), coming in (not cancelled, not received),
 * waiting for delivery or sold is refused.
 */
async function duplicateOf(db, stockNumber, { exceptItemId = null, exceptAppIds = [] } = {}) {
  const n = text(stockNumber).toLowerCase();
  if (!n) return null;
  const { rows } = await db.query(
    `SELECT id, kind, data FROM logistics_items WHERE deleted_at IS NULL AND kind = ANY($1) AND lower(trim(data->>'stockNumber')) = $2 ORDER BY id`,
    [['safeStock', 'londonStock', 'dubaiStock', 'hkStock', 'incomings', 'readyForDelivery', 'soldStocks'], n]
  );
  const where = { safeStock: '🔒 In Safe', londonStock: '🇬🇧 London Stock', dubaiStock: '🇦🇪 Dubai Stock', hkStock: '🌐 HK Stock', incomings: '📥 Incomings', readyForDelivery: '📦 Ready for Delivery', soldStocks: '✅ Sold Stocks' };
  for (const r of rows) {
    const d = r.data || {};
    if (r.id === exceptItemId || exceptAppIds.includes(d.id)) continue;
    if (STOCK_KINDS.includes(r.kind) && d.status === 'moved') continue;
    if (r.kind === 'incomings' && (d.status === 'cancelled' || d.inventoryId)) continue;
    return { where: where[r.kind], label: [d.brand, r.kind === 'incomings' ? d.reference : d.watchModel].filter(Boolean).join(' · ') };
  }
  return null;
}

/* ── the stock row's form (the app's Add / Edit Row modal) ──────── */

const PRICE_FIELDS = [
  f('buyPrice', 'Cost price', 'money', { currency: 'buyCurrency' }),
  f('buyCurrency', 'Cost currency', 'currency'),
  f('b2bPrice', 'B2B price', 'money', { currency: 'b2bCurrency' }),
  f('b2bCurrency', 'B2B currency', 'currency'),
  f('b2cPrice', 'B2C price', 'money', { currency: 'b2cCurrency' }),
  f('b2cCurrency', 'B2C currency', 'currency'),
];
const rowForm = (cfg) => [
  f('stockNumber', 'Stock number', 'stock', { required: true, hint: 'one of our watches, or a number we do not hold yet' }),
  f('from', 'From / owner', 'text', { hint: 'the client it came from, as the app types it' }),
  f('brand', 'Brand', 'text', { hint: BRANDS.join(', ') }),
  f('watchModel', 'Watch model', 'text', { required: true }),
  f('watchReference', 'Reference'),
  f('watchDate', 'Watch date'),
  f('watchSerial', 'Serial'),
  f('caseMaterial', 'Case material'),
  f('caseDiameter', 'Case size'),
  f('dial', 'Dial'),
  f('bezel', 'Bezel'),
  f('movement', 'Movement'),
  f('complications', 'Complications'),
  f('accessoriesPresent', 'Accessories with it', 'longtext', { hint: 'comma separated' }),
  f('accessoriesMissing', 'Accessories missing', 'longtext', { hint: 'comma separated, "3 Links" for a quantity' }),
  f(cfg.corners[0][0], cfg.corners[0][1], 'text', { hint: '✓, or where' }),
  f(cfg.corners[1][0], cfg.corners[1][1], 'text'),
  f('needPolish', 'Needs polish', 'bool'),
  f('showInVault', 'Show to Watch Vault', 'bool'),
  f('receivedAt', 'Received', 'date'),
  f('notes', 'Notes', 'longtext'),
  ...(cfg.kind === 'safeStock' ? [] : PRICE_FIELDS),
];

/* The row as the app's saveLondonRow builds it from the form. */
function rowData(input, cfg) {
  const money = (v, label) => (v === undefined || v === null || String(v).trim() === '' ? null : amountOf(v, label) || null);
  const d = {
    stockNumber: text(input.stockNumber, 60),
    from: text(input.from, 200),
    brand: text(input.brand, 100),
    watchReference: text(input.watchReference, 200),
    watchModel: text(input.watchModel, 300),
    caseMaterial: text(input.caseMaterial, 100),
    caseDiameter: text(input.caseDiameter, 100),
    dial: text(input.dial, 100),
    bezel: text(input.bezel, 100),
    movement: text(input.movement, 100),
    complications: text(input.complications, 200),
    watchDate: text(input.watchDate, 40),
    watchSerial: text(input.watchSerial, 100),
    accessoriesPresent: accList(input.accessoriesPresent).join(', '),
    accessoriesMissing: accList(input.accessoriesMissing).join(', '),
    [cfg.corners[0][0]]: text(input[cfg.corners[0][0]], 100),
    [cfg.corners[1][0]]: text(input[cfg.corners[1][0]], 100),
    needPolish: input.needPolish === true || /^(true|yes|1|on)$/i.test(String(input.needPolish ?? '')),
    hideFromVault: !(input.showInVault === undefined || input.showInVault === true || /^(true|yes|1|on)$/i.test(String(input.showInVault))),
    notes: text(input.notes, 2000),
  };
  const received = dayOf(input.receivedAt, 'Received', { blank: '' });
  if (received) d.receivedAt = new Date(received).getTime();
  if (cfg.kind !== 'safeStock') {
    Object.assign(d, {
      buyPrice: money(input.buyPrice, 'Cost price'),
      buyCurrency: currencyOf(input.buyCurrency, 'USD', 'Cost currency'),
      b2bPrice: money(input.b2bPrice, 'B2B price'),
      b2bCurrency: currencyOf(input.b2bCurrency, 'USD', 'B2B currency'),
      b2cPrice: money(input.b2cPrice, 'B2C price'),
      b2cCurrency: currencyOf(input.b2cCurrency, 'USD', 'B2C currency'),
    });
  }
  if (!d.stockNumber) throw bad('Stock # is required (and must be unique)');
  if (!d.watchModel) throw bad('Watch Model required');
  return d;
}

const dupMessage = (c, n) => `Stock # "${n}" already exists in ${c.where}${c.label ? ' · ' + c.label : ''}. Each stock number must be unique across London, Dubai, HK and Incomings.`;

/* ── CSV import, the app's downloadStockTemplate / importStockCsv ── */

const TEMPLATE_ROWS = {
  london:
    '809,HAYAT,Rolex,Rolex Oyster Perpetual 41 Beige Dial,134300,08/2025,6t54c009,"Watch, Card, W-tag, Box, holder",Booklet,,,no\n' +
    '1109,Robin,Patek Philippe,Patek Philippe Nautilus,Ref 5990/1A-011,12/2024,7736164/6691291,"(Pouch, Watch, Box & Papers)","No Pusher, 2 links Short, No Booklet, Needs Polish",,,yes\n' +
    '1219,Zeith club,Patek Philippe,PP Nautilus,5711/1A,11/2019,7311834/6375392,Full Set,,,,yes\n' +
    '1283,Arfan,Other,Tudor Black Bay Chrono,M79360N-0024,3/2026,,Full Set,,,,no\n',
  dubai:
    '1184,Adam Rasul,Patek Philippe,Patek Philippe Nautilus,5711/1A-014,07/2020,7311834/6375392,"Full Set","",,,no\n' +
    '1212,Adam Rasul,Audemars Piguet,AP Royal Oak,15500ST.OO.1220ST.04,02/2023,K58702,"Watch, Box, Cards, Pouch","Booklet",✓,,no\n' +
    '1300,STEFANO,Rolex,Rolex Daytona Rainbow,116595RBOW,11/2019,5Q2042X1,"Watch, Card, Box","",,✓,no\n' +
    '1322,HAYAT,Rolex,Rolex Daytona,116508,05/2024,6t54c009,"Watch, Card, W-tag","Booklet, Box (in transit)",✓,,yes\n',
  hk:
    '1401,Wing,Patek Philippe,Patek Philippe Nautilus,5711/1A-014,03/2021,7311834/0011223,"Full Set","",✓,,no\n' +
    '1402,Winnie,Audemars Piguet,AP Royal Oak,15500ST.OO.1220ST.04,08/2022,K99802,"Watch, Box, Cards","Booklet",,Winnie Chan,no\n' +
    '1403,RK HK,Rolex,Rolex Daytona,116508,11/2020,5Q8842X1,"Watch, Card, Box","",,,,no\n' +
    '1404,Local Client,Other,Tudor Black Bay 41,M79540-0006,5/2025,,"Full Set",,✓,,no\n',
};
/* The app's template, column for column (the safe gets its own two corners — the app hands it London's). */
export function template(cfg) {
  const [tog1, tog2] = [cfg.corners[0][0], cfg.corners[1][0]];
  return `stockNumber,from,brand,watchModel,watchReference,watchDate,watchSerial,accessoriesPresent,accessoriesMissing,${tog1},${tog2},needPolish\n${TEMPLATE_ROWS[cfg.loc] || TEMPLATE_ROWS.london}`;
}

/** The app's importStockCsv, up to the records: what each line becomes, and why one is skipped. */
export function readStockCsv(csvText, cfg) {
  const rows = parseCsv(String(csvText || '')).filter((r) => r.some((c) => String(c).trim()));
  if (rows.length < 2) throw bad('CSV is empty or only has a header row.');
  const header = rows[0].map((h) => String(h || '').trim().toLowerCase().replace(/\s+/g, ' '));
  const col = (name, alts = []) => {
    const all = [name, ...alts].map((n) => n.toLowerCase());
    for (let h = 0; h < header.length; h += 1) if (all.includes(header[h])) return h;
    return -1;
  };
  const idx = {
    stock: col('stocknumber', ['stock', 'stock #', 'stock no', 'sno']),
    from: col('from', ['supplier', 'consignor', 'owner', 'client']),
    brand: col('brand', ['make']),
    model: col('watchmodel', ['model', 'watch model', 'description']),
    reference: col('watchreference', ['reference', 'ref']),
    date: col('watchdate', ['date', 'watch date']),
    serial: col('watchserial', ['serial', 'watch serial', 'sno', 'serial number']),
    present: col('accessoriespresent', ['present', 'accessories present', 'accessories', 'has']),
    missing: col('accessoriesmissing', ['missing', 'accessories missing', 'needs']),
    mayfair: col('inmayfair', ['mayfair', 'in mayfair']),
    ncl: col('inncl', ['ncl', 'in ncl']),
    office: col('inoffice', ['office', 'in office']),
    safe: col('insafe', ['safe', 'in safe']),
    vault: col('invault', ['vault', 'in vault']),
    withclient: col('withclient', ['with client', 'client']),
    needPolish: col('needpolish', ['polish', 'need polish', 'needs polish']),
  };
  const missingCols = [];
  if (idx.stock < 0) missingCols.push('stockNumber');
  if (idx.model < 0) missingCols.push('watchModel');
  if (missingCols.length) throw bad(`CSV missing required columns: ${missingCols.join(', ')}. Detected headers: ${header.join(', ')}. Download the Template for the correct format.`);
  const truthy = (v) => /^(y|yes|1|true|need polish|needs polish|✓)$/i.test(String(v || '').trim());
  const out = { rows: [], skipped: [] };
  rows.slice(1).forEach((r, rowIdx) => {
    const lineNum = rowIdx + 2;
    const get = (k) => (idx[k] >= 0 ? String(r[idx[k]] || '').trim() : '');
    const stockNumber = get('stock');
    const watchModel = get('model');
    if (!stockNumber && !watchModel) return;
    if (!watchModel) {
      out.skipped.push(`Line ${lineNum}: missing watchModel`);
      return;
    }
    const d = {
      stockNumber,
      from: get('from'),
      brand: get('brand'),
      watchModel,
      watchReference: get('reference'),
      watchDate: get('date'),
      watchSerial: get('serial'),
      accessoriesPresent: get('present'),
      accessoriesMissing: get('missing'),
      needPolish: truthy(get('needPolish')) || /need[s]?\s*polish/i.test(get('missing') + ' ' + get('present')),
      status: 'current',
    };
    if (cfg.loc === 'dubai') Object.assign(d, { inOffice: get('office'), inSafe: get('safe') });
    else if (cfg.loc === 'hk') Object.assign(d, { inVault: get('vault'), withClient: get('withclient') });
    else if (cfg.loc === 'safe') Object.assign(d, { inSafe: get('safe'), withClient: get('withclient') });
    else Object.assign(d, { inMayfair: get('mayfair'), inNcl: get('ncl') });
    out.rows.push(d);
  });
  return out;
}

/* ── the move (confirmLondonMove), shared by Move and the safe's Give ── */

async function moveRow({ db, item, user, ctx, moveType, destination, date, carrier, notes, taken, leftBehind, linkedShipmentId, linkedTripId }) {
  const cfg = PLACES[item.kind];
  const r = item.data;
  const target = moveType === 'external' ? null : byLoc(moveType);
  if (moveType !== 'external' && !target) throw bad(`There is no stock list called ${moveType}`);
  if (target && target.kind === item.kind) throw bad(`Already in ${cfg.place}`);
  if (!destination) throw bad('Destination required');
  const created = [];
  const stamp = Date.now();
  const movement = {
    id: uid(),
    ts: stamp,
    date,
    destination,
    carrier,
    takenAccessories: taken.map(withQty),
    leftSpareAccessories: leftBehind.map(withQty),
    notes,
    moveType,
    linkedShipmentId: linkedShipmentId || null,
    linkedTripId: linkedTripId || null,
    sendingPhotos: [],
    receivingPhotos: [],
  };
  await patchItem(db, item, { ...r, movements: [movement, ...(Array.isArray(r.movements) ? r.movements : [])], status: 'moved', movedAt: stamp }, user);
  for (const a of leftBehind) {
    const s = await insertItem(
      db,
      cfg.spares,
      { brand: text(r.brand), accessory: a.accessory, qty: a.qty, fromStock: sn(r), fromWatch: text(r.watchModel), notes: `Left when ${what(r)} moved to ${destination}`, addedAt: stamp },
      user
    );
    created.push(s.id);
  }
  let crossNote = '';
  let destStockId = null;
  if (target) {
    destStockId = uid();
    const row = await insertItem(
      db,
      target.kind,
      {
        id: destStockId,
        stockNumber: r.stockNumber,
        from: r.from,
        brand: r.brand,
        watchModel: r.watchModel,
        watchReference: r.watchReference,
        watchDate: r.watchDate,
        watchSerial: r.watchSerial,
        caseMaterial: r.caseMaterial,
        caseDiameter: r.caseDiameter,
        dial: r.dial,
        bezel: r.bezel,
        movement: r.movement,
        complications: r.complications,
        accessoriesPresent: taken.map((a) => a.accessory).join(', '),
        accessoriesMissing: r.accessoriesMissing || '',
        inMayfair: '',
        inNcl: '',
        inOffice: '',
        inSafe: '',
        inVault: '',
        withClient: '',
        needPolish: Boolean(r.needPolish),
        b2cPrice: r.b2cPrice || null,
        b2cCurrency: r.b2cCurrency || null,
        b2bPrice: r.b2bPrice || null,
        b2bCurrency: r.b2bCurrency || null,
        b2bGbp: r.b2bGbp || null,
        b2bEur: r.b2bEur || null,
        b2bHkd: r.b2bHkd || null,
        b2bUsd: r.b2bUsd || null,
        buyPrice: r.buyPrice || null,
        buyCurrency: r.buyCurrency || null,
        photos: [...(Array.isArray(r.photos) ? r.photos : [])],
        receivingPhotos: [...(Array.isArray(r.receivingPhotos) ? r.receivingPhotos : [])],
        status: 'current',
        receivedAt: date ? new Date(date).getTime() : stamp,
        movements: [
          {
            id: uid(),
            ts: stamp,
            date,
            destination: `From ${cfg.label} Stock`,
            carrier,
            notes: `Arrived from ${cfg.label}. ${leftBehind.length} item${leftBehind.length === 1 ? '' : 's'} left as ${cfg.label} spare.`,
            takenAccessories: taken.map((a) => a.accessory),
            leftSpareAccessories: [],
            moveType: 'arrival_from_' + cfg.loc,
            linkedShipmentId: linkedShipmentId || null,
            linkedTripId: linkedTripId || null,
          },
        ],
        createdAt: stamp,
      },
      user
    );
    created.push(row.id);
    crossNote = ` Created in ${target.label} Stock.`;
  }
  // A linked trip gets the watch, by the row's id with the list's prefix, so the trip's cost splits over it (the app's buildKey).
  if (linkedTripId) {
    const trip = (await listKind(db, 'personTrips', "data->>'id' = $2", [linkedTripId]))[0];
    if (trip) {
      const buildKey = (loc, id) => (loc === 'london' ? 'lon-' : loc + '-') + id;
      const targetLoc = ['london', 'dubai', 'hk'].includes(moveType) ? moveType : cfg.loc;
      const key = buildKey(targetLoc, destStockId || r.id);
      const stockIds = Array.isArray(trip.data.stockIds) ? trip.data.stockIds : [];
      if (!stockIds.includes(key)) {
        await patchItem(db, trip, { ...trip.data, stockIds: [...stockIds, key] }, user);
        const route = [trip.data.fromLocation, trip.data.toLocation].filter(Boolean).join(' → ');
        await logActivity(db, `🚗 Attached ${what(r)} to trip "${trip.data.personName} · ${route}" (cost now splits across ${stockIds.length + 1} stocks)`, user);
      }
    }
  }
  await logActivity(db, `📤 Moved ${cfg.label} Stock ${what(r)} to ${destination} · ${taken.length} acc taken · ${leftBehind.length} spare${crossNote}`, user);
  return { message: `Moved.${crossNote} ${leftBehind.length} spare item${leftBehind.length === 1 ? '' : 's'} added to ${cfg.label} Spares.`, created, open: destStockId ? `#/logistics/${target.page}` : undefined };
}

const openShipments = async (db) => (await listKind(db, 'shipments', "data->>'status' IN ('pending','in_transit')")).sort((a, b) => String(b.data.date || '').localeCompare(String(a.data.date || '')));
const openTrips = async (db) => (await listKind(db, 'personTrips', "data->>'status' IN ('planned','in_progress')")).sort((a, b) => String(b.data.startDate || '').localeCompare(String(a.data.startDate || '')));
const stockWords = (v) => text(v, 500).split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean).join(', ');

/* The move's form — the app's modal: where to, the accessories going and staying, a shipment or a trip to link. */
const moveForm = async (item, ctx, db) => [
  f('moveType', 'Move to', 'choice', {
    options: [
      { value: 'external', label: '📤 External (out of internal stocks)' },
      ...Object.values(PLACES)
        .filter((p) => p.kind !== item.kind)
        .map((p) => ({ value: p.loc, label: `${p.label}${p.loc === 'safe' ? ' (a client watch we hold)' : ' Stock (creates entry there)'}` })),
    ],
  }),
  f('destination', 'Destination', 'text', { hint: 'where it went; blank for another of our places' }),
  f('date', 'Date', 'date'),
  f('carrier', 'Carrier / how'),
  f('takenAccessories', 'Accessories going with it', 'longtext', { hint: 'comma separated, "Links ×2" for a quantity' }),
  f('spareAccessories', 'Left behind as spares', 'longtext', { hint: 'comma separated' }),
  f('linkedShipmentId', 'Shipment', 'choice', { options: [{ value: '', label: '— none —' }, ...(await openShipments(db)).map((s) => ({ value: text(s.data.id), label: `${stockWords(s.data.stockNumber) || text(s.data.items).slice(0, 30)} · ${text(s.data.status)}` }))] }),
  f('linkedTripId', 'Trip', 'choice', { options: [{ value: '', label: '— none —' }, ...(await openTrips(db)).map((t) => ({ value: text(t.data.id), label: `${text(t.data.personName)} · ${text(t.data.fromLocation) || '?'} → ${text(t.data.toLocation) || '?'} · ${text(t.data.startDate)}` }))] }),
  f('notes', 'Notes', 'longtext'),
];
/* The app ticks "Watch" and every accessory the row has present. */
const takenDefault = (d) => {
  const list = accList(d.accessoriesPresent);
  return (list.some((a) => a.toLowerCase() === 'watch') ? list : ['Watch', ...list]).join(', ');
};
const moveInput = (input) => ({
  moveType: text(input.moveType, 20) || 'external',
  date: dayOf(input.date, 'Date'),
  carrier: text(input.carrier, 200),
  notes: text(input.notes, 2000),
  taken: accList(input.takenAccessories).map(accQty),
  leftBehind: accList(input.spareAccessories).map(accQty),
  linkedShipmentId: text(input.linkedShipmentId, 40),
  linkedTripId: text(input.linkedTripId, 40),
});

/* ── the HK situation board's move (saveHkMove) ──────────────────── */

const KNOWN_COURIERS = ['rk', 'ferrari', 'dhl', 'fedex', 'forak'];
async function hkMove({ db, item, input, user, ctx }) {
  const r = item.data;
  const toSection = text(input.toSection, 20);
  if (!['in_hand', 'incoming', 'outgoing', 'sold', 'london', 'dubai'].includes(toSection)) throw bad('Say where it is going: in hand, incoming, outgoing, sold, London or Dubai');
  const toHolder = text(input.toHolder, 100);
  const date = dayOf(input.date, 'Date');
  const carrier = text(input.carrier, 200);
  const destination = text(input.destination, 200);
  const costCurrency = currencyOf(input.costCurrency, 'AED', 'Cost currency');
  const costAmount = amountOf(input.costAmount, 'Cost');
  const costAmountRaw = costAmount ? costAmount.toLocaleString('en-GB') : '';
  const cost = costAmount > 0 ? `${costCurrency} ${costAmountRaw}` : '';
  const notes = text(input.notes, 2000);
  const stamp = Date.now();
  const created = [];
  // A sale is possible only from In Hand to Going out, as the app shows the sale fields.
  const isSale = (input.isSale === true || /^(true|yes|1|on)$/i.test(String(input.isSale ?? ''))) && r.section === 'in_hand' && toSection === 'outgoing';
  let saleInfo = null;
  let createdTxId = null;
  if (isSale) {
    const saleClientId = text(input.saleClientId, 60);
    if (!saleClientId) throw bad('Pick the client this watch was sold to');
    const clientName = ctx.client(saleClientId);
    if (!clientName) throw bad('That client is not on the logistics client list');
    const saleBrand = text(input.saleBrand, 100);
    const salePrice = text(input.salePrice, 100);
    const givenAccs = accList(input.givenAccessories).map(accQty);
    const remainingAccs = accList(input.owedAccessories).map(accQty);
    const items = remainingAccs.map((a) => ({ id: uid(), accessory: a.accessory, qty: a.qty, direction: 'give', status: 'pending', settledBy: null, settlementId: null }));
    const tx = {
      id: uid(),
      type: 'sold',
      date,
      clientId: saleClientId,
      reference: sn(r) || text(r.description).slice(0, 30),
      stockNumber: sn(r),
      brand: saleBrand,
      notes: `Sold from HK Stock${salePrice ? ' for ' + salePrice : ''}. Given: ${givenAccs.map((a) => a.accessory).join(', ') || 'none'}. Owed: ${remainingAccs.map((a) => a.accessory).join(', ') || 'none'}.`,
      items,
      hkRowId: r.id,
      createdAt: stamp,
    };
    const row = await insertItem(db, 'transactions', tx, user);
    created.push(row.id);
    createdTxId = tx.id;
    saleInfo = { clientId: saleClientId, clientName, brand: saleBrand, price: salePrice, givenAccessories: givenAccs.map((a) => a.accessory), remainingAccessories: remainingAccs.map((a) => a.accessory), transactionId: tx.id };
    await logActivity(db, `💰 SOLD ${sn(r)} to ${clientName} — ${remainingAccs.length} item${remainingAccs.length === 1 ? '' : 's'} pending`, user);
  }
  const movement = {
    id: uid(),
    date,
    ts: stamp,
    fromSection: r.section,
    fromHolder: r.holder,
    toSection,
    toHolder,
    carrier,
    destination,
    cost,
    sale: saleInfo,
    transactionId: createdTxId,
    deliveryPhotos: [],
    receivingPhotos: [],
    notes,
  };
  const next = { ...r, movements: [movement, ...(Array.isArray(r.movements) ? r.movements : [])], section: isSale ? 'sold' : toSection };
  if (toHolder) {
    next.holder = toHolder;
    const upper = toHolder.toUpperCase();
    if (upper === 'IN SAFE' || upper === 'IN HAND') next.stockStatus = 'IN SAFE';
    else if (upper === 'RK') next.stockStatus = 'WITH RK';
    else if (upper === 'WINNIE') next.stockStatus = 'WITH WINNIE';
    else if (upper === 'WINSON') next.stockStatus = 'WITH WINSON';
    else if (upper.startsWith('BY ')) next.stockStatus = '';
    else next.stockStatus = 'WITH ' + upper;
  }
  // A move into London or Dubai leaves the HK row "outgoing" and creates the row there (the app's cross-location move).
  if (toSection === 'london' || toSection === 'dubai') next.section = 'outgoing';
  await patchItem(db, item, next, user);
  await logActivity(db, `HK ${sn(r)}: ${hkSectionTitle(movement.fromSection)} → ${hkSectionTitle(movement.toSection)}${toHolder ? ' (' + toHolder + ')' : ''}`, user);
  if (costAmount > 0) {
    const c = await insertItem(
      db,
      'logisticCosts',
      {
        title: `HK ${sn(r)} move${destination ? ' to ' + destination : ''}${carrier ? ' (' + carrier + ')' : ''}`.trim(),
        shipmentId: null,
        hkMovementId: movement.id,
        stockNumber: sn(r),
        fromName: '🇭🇰 HK',
        toName: destination || '?',
        date,
        currency: costCurrency,
        amount: costAmount,
        notes: notes || carrier || '',
      },
      user
    );
    created.push(c.id);
    await logActivity(db, `💰 HK Move cost: ${costCurrency} ${costAmountRaw}`, user);
  }
  // A carrier that is one of the 3rd party movers (or a courier always tracked) gets the move in its shipment history.
  let carrierRaw = carrier;
  if (!carrierRaw && /^by\s+/i.test(toHolder)) carrierRaw = toHolder.replace(/^by\s+/i, '').trim();
  if (carrierRaw) {
    const lc = carrierRaw.toLowerCase();
    let mover = (await listKind(db, 'thirdPartyMovers')).find((m) => text(m.data.name).toLowerCase() === lc)?.data || null;
    if (!mover && KNOWN_COURIERS.includes(lc)) {
      mover = { id: uid(), ts: stamp, name: carrierRaw, country: '', contact: '', notes: 'Auto-created from HK movement' };
      const m = await insertItem(db, 'thirdPartyMovers', mover, user);
      created.push(m.id);
      await logActivity(db, `🚛 Auto-created 3rd party mover "${mover.name}" from HK movement`, user);
    }
    if (mover) {
      const ship = await insertItem(
        db,
        'thirdPartyShipments',
        {
          logisticCostId: null,
          moverId: mover.id,
          moverName: mover.name,
          isOurStock: true,
          stockNumber: sn(r),
          description: '',
          fromClientId: null,
          fromClientName: '🇭🇰 HK Stock',
          fromCountry: 'HK',
          toCountry: destination || '',
          items: text(r.description).slice(0, 200),
          currency: costCurrency || 'USD',
          amount: costAmount || 0,
          paymentStatus: 'pending',
          status: 'in_transit',
          trackingNumber: '',
          shipmentDate: date,
          deliveryDate: '',
          notes: notes || `Auto-created from HK movement · holder ${toHolder}`,
          photos: [],
          hkMovementId: movement.id,
        },
        user
      );
      created.push(ship.id);
      await logActivity(db, `🚛 Logged shipment under ${mover.name}: HK ${sn(r)} → ${destination || '?'}${costAmount > 0 ? ' · ' + costCurrency + ' ' + costAmountRaw : ''}`, user);
    }
  }
  if (toSection === 'london' || toSection === 'dubai') {
    const target = byLoc(toSection);
    const present = accList(r.accessories || r.accessoriesPresent);
    const row = await insertItem(
      db,
      target.kind,
      {
        stockNumber: sn(r),
        from: 'HK',
        brand: text(r.brand),
        watchModel: text(r.description),
        watchReference: text(r.reference),
        watchDate: '',
        watchSerial: '',
        caseMaterial: '',
        caseDiameter: '',
        dial: '',
        bezel: '',
        movement: '',
        complications: '',
        accessoriesPresent: present.join(', '),
        accessoriesMissing: accList(r.accessoriesMissing).join(', '),
        inMayfair: '',
        inNcl: '',
        inOffice: '',
        inSafe: '',
        needPolish: false,
        photos: [...(Array.isArray(r.photos) ? r.photos : [])],
        status: 'current',
        movements: [{ id: uid(), ts: stamp, date, destination: 'From HK', carrier, notes: `Arrived from HK Situation${notes ? '. ' + notes : ''}.`, takenAccessories: present, leftSpareAccessories: [], moveType: 'arrival_from_hk' }],
        createdAt: stamp,
      },
      user
    );
    created.push(row.id);
    await logActivity(db, `📤 HK ${sn(r)} moved to ${target.label} Stock`, user);
  }
  return { message: `Movement recorded${isSale ? ' · sold' : ''}${costAmount ? ` · cost ${cost}` : ''}`, created };
}

/* ── the AI stock take (runStockTake): the prompt and what its answer means ── */

const stockTakeLine = (s) => {
  const parts = [`Stock#: ${s.stockNumber || '?'}`];
  if (s.brand) parts.push(`Brand: ${s.brand}`);
  if (s.watchModel) parts.push(`Model: ${s.watchModel}`);
  if (s.watchReference) parts.push(`Ref: ${s.watchReference}`);
  if (s.watchSerial) parts.push(`Serial: ${s.watchSerial}`);
  return parts.join(' | ');
};
/** The app's prompt, word for word, over the Dubai rows in stock (filtered by brand as the app filters). */
export function stockTakePrompt(current, photoCount) {
  return `You are a luxury watch inventory expert doing a physical stock take for a Dubai showroom.

I have uploaded ${photoCount} photo${photoCount > 1 ? 's' : ''} taken by our Dubai employee showing the watches that are physically present.

DUBAI STOCK — ${current.length} watches that SHOULD be present:
${current.map(stockTakeLine).join('\n') || '(no stock records found)'}

INSTRUCTIONS:
1. Scan EVERY watch visible across ALL photos carefully
2. Match each visible watch to an entry above using: brand on dial, reference, model shape, serial number, stock tag/sticker
3. Only mark "confirmed" if you can reasonably identify the watch — use confidence: high/medium/low
4. Mark as "missing" any stock-list watches NOT visible in any photo
5. Note any watch visible in photos that does NOT appear in the stock list

Return ONLY valid JSON — no markdown, no explanation:
{
  "confirmed": [{ "stockNumber": "...", "brand": "...", "reference": "...", "confidence": "high|medium|low", "note": "how identified" }],
  "missing":   [{ "stockNumber": "...", "brand": "...", "reference": "...", "note": "..." }],
  "unexpected": ["Description of watch seen but not in stock list"],
  "summary": "One sentence overall finding",
  "photoQuality": "good|fair|poor",
  "photoNotes": "Brief note on photo coverage or quality issues"
}`;
}
/** The answer as the app reads it (_stRenderReport): confirmed / missing / unexpected, each missing one tied to its row. */
export function stockTakeReport(answer, current) {
  const raw = typeof answer === 'string' ? JSON.parse(String(answer).trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim()) : answer || {};
  const list = (v) => (Array.isArray(v) ? v : []);
  const rowOf = (m) => current.find((s) => String(s.stockNumber) === String(m?.stockNumber)) || null;
  const confirmed = list(raw.confirmed).map((c) => ({ stockNumber: text(c?.stockNumber), brand: text(c?.brand), reference: text(c?.reference), confidence: text(c?.confidence), note: text(c?.note), row: rowOf(c) }));
  const missing = list(raw.missing).map((m) => ({ stockNumber: text(m?.stockNumber), brand: text(m?.brand), reference: text(m?.reference), note: text(m?.note), row: rowOf(m) }));
  const unexpected = list(raw.unexpected).map((u) => text(u)).filter(Boolean);
  const total = current.length;
  const missPct = total > 0 ? missing.length / total : 0;
  return {
    confirmed,
    missing,
    unexpected,
    total,
    tone: missPct === 0 ? 'good' : missPct < 0.25 ? 'warn' : 'bad',
    summary: text(raw.summary) || `${confirmed.length} of ${total} watches confirmed`,
    photoQuality: text(raw.photoQuality),
    photoNotes: text(raw.photoNotes),
  };
}

/* ── the actions ─────────────────────────────────────────────────── */

export const ACTIONS = [];

for (const cfg of Object.values(PLACES)) {
  ACTIONS.push(
    {
      key: `stock-add-${cfg.loc}`,
      label: 'Add row',
      kinds: null,
      page: cfg.page,
      form: rowForm(cfg),
      prefill: async () => ({ receivedAt: localToday(), showInVault: true, buyCurrency: 'USD', b2bCurrency: 'USD', b2cCurrency: 'USD' }),
      run: async ({ db, input, user }) => {
        const d = rowData(input, cfg);
        const dup = await duplicateOf(db, d.stockNumber);
        if (dup) throw bad(dupMessage(dup, d.stockNumber));
        const row = await insertItem(db, cfg.kind, { ...d, photos: [], receivingPhotos: [], braceletPhotos: [], status: 'current', movements: [] }, user);
        const present = accList(d.accessoriesPresent).length;
        const missing = accList(d.accessoriesMissing).length;
        await logActivity(db, `Added ${cfg.label} Stock ${d.stockNumber || d.watchModel} · present: ${present} · missing: ${missing}`, user);
        return { message: `Added ${d.stockNumber} to ${cfg.place}${await oursNote(d.stockNumber)}`, created: [row.id], open: `#/lg/${row.id}` };
      },
    },
    {
      key: `stock-import-${cfg.loc}`,
      label: 'Import CSV',
      kinds: null,
      page: cfg.page,
      form: [f('csv', 'CSV file', 'csv', { hint: 'the Template’s columns; a stock number already there is updated' })],
      template: () => template(cfg),
      run: async ({ db, input, user }) => {
        const read = readStockCsv(input.csv, cfg);
        let added = 0;
        let updated = 0;
        const notOurs = [];
        const current = await listKind(db, cfg.kind, "COALESCE(data->>'status','current') = 'current'");
        for (const d of read.rows) {
          const existing = d.stockNumber ? current.find((x) => text(x.data.stockNumber) === d.stockNumber) : null;
          if (existing) {
            await patchItem(db, existing, { ...existing.data, ...d }, user);
            updated += 1;
          } else {
            await insertItem(db, cfg.kind, { ...d, movements: [] }, user);
            added += 1;
          }
          if (d.stockNumber && (await oursNote(d.stockNumber))) notOurs.push(d.stockNumber);
        }
        await logActivity(db, `${cfg.csv} CSV import — added ${added}, updated ${updated}, skipped ${read.skipped.length}`, user);
        const reasons = read.skipped.slice(0, 20).map((s) => ` • ${s}`).join('\n');
        return {
          message: `${cfg.place} import complete — added ${added}, updated ${updated}, skipped ${read.skipped.length}${reasons ? `\n${reasons}` : ''}${notOurs.length ? `\nNot one of our watches: ${notOurs.join(', ')}` : ''}`,
        };
      },
    },
    {
      key: `stock-spare-add-${cfg.loc}`,
      label: 'Add spare',
      kinds: null,
      page: cfg.page,
      form: [f('brand', 'Brand', 'text', { hint: BRANDS.join(', ') }), f('accessory', 'Accessory', 'text', { required: true }), f('qty', 'Quantity', 'number')],
      prefill: async () => ({ qty: 1 }),
      run: async ({ db, input, user }) => {
        const accessory = text(input.accessory, 200);
        if (!accessory) throw bad('Say which accessory');
        const qty = Math.max(1, parseInt(String(input.qty || '1'), 10) || 1);
        const row = await insertItem(db, cfg.spares, { brand: text(input.brand, 100), accessory, qty, fromStock: '', fromWatch: '', notes: 'Added manually', addedAt: Date.now() }, user);
        return { message: 'Spare added', created: [row.id] };
      },
    }
  );
}

ACTIONS.push(
  {
    key: 'stock-move',
    label: 'Move',
    kinds: STOCK_KINDS,
    // The form reads the open shipments and trips outside any transaction.
    form: async (item, ctx) => moveForm(item, ctx, { query }),
    prefill: async (item) => ({ moveType: 'external', date: localToday(), takenAccessories: takenDefault(item.data) }),
    run: async ({ db, item, input, user, ctx }) => {
      if (item.data.status === 'moved') throw bad('Already moved out — use Move back');
      const m = moveInput(input);
      const target = m.moveType === 'external' ? null : byLoc(m.moveType);
      const destination = text(input.destination, 200) || (target ? target.dest : '');
      return moveRow({ db, item, user, ctx, ...m, destination });
    },
  },
  {
    key: 'stock-move-back',
    label: 'Move back',
    kinds: STOCK_KINDS,
    run: async ({ db, item, user }) => {
      const cfg = PLACES[item.kind];
      const r = item.data;
      if (r.status !== 'moved') throw bad('This row is in stock already');
      const m = {
        id: uid(),
        ts: Date.now(),
        date: localToday(),
        destination: `BACK TO ${cfg.place.toUpperCase()}`,
        carrier: '',
        takenAccessories: [],
        leftSpareAccessories: [],
        notes: `Moved back from outside ${cfg.place}`,
        returned: true,
      };
      await patchItem(db, item, { ...r, movements: [m, ...(Array.isArray(r.movements) ? r.movements : [])], status: 'current', movedAt: null }, user);
      await logActivity(db, `↺ Moved ${cfg.label} Stock ${what(r)} back to current`, user);
      return { message: 'Back in current stock' };
    },
  },
  {
    key: 'stock-checkout',
    label: 'Check out',
    kinds: ['londonStock', 'dubaiStock', 'hkStock', 'hkSituation'],
    form: [f('checkedOutBy', 'Reason / who has it', 'text', { required: true }), f('checkedOutDate', 'Checked out', 'date'), f('notes', 'Notes', 'longtext')],
    prefill: async () => ({ checkedOutDate: localToday() }),
    run: async ({ db, item, input, user }) => {
      const r = item.data;
      if (r.status === 'moved') throw bad('This row was moved out already');
      const loc = PLACES[item.kind]?.loc || 'hk';
      const reason = text(input.checkedOutBy, 300);
      if (!reason) throw bad('Say why, or who has it');
      const entry = {
        stockNumber: sn(r),
        brand: text(r.brand),
        watchModel: text(r.watchModel) || text(r.description),
        watchReference: text(r.watchReference) || text(r.reference),
        watchSerial: text(r.watchSerial) || text(r.serial),
        watchDate: text(r.watchDate),
        originLocation: loc,
        originKey: item.kind,
        originRow: snapshot(r),
        checkedOutDate: dayOf(input.checkedOutDate, 'Checked out'),
        checkedOutBy: reason,
        notes: text(input.notes, 2000),
        photos: [...(Array.isArray(r.photos) ? r.photos : [])],
        checkoutPhotos: [],
      };
      const created = await insertItem(db, 'checkoutStock', entry, user);
      await softDelete(db, item.id, user);
      await logActivity(db, `📤 Checked out ${sn(r) || text(r.brand) || r.id} from ${loc} stock` + (reason ? ` · ${reason}` : ''), user);
      return { message: `Moved to Checkout${await oursNote(sn(r))}`, created: [created.id], open: '#/logistics/checkout' };
    },
  },
  {
    key: 'stock-checkout-return',
    label: 'Return to stock',
    kinds: ['checkoutStock'],
    run: async ({ db, item, user }) => {
      const e = item.data;
      const destKey = text(e.originKey) || 'londonStock';
      if (!KIND[destKey] || KIND[destKey].map) throw bad(`There is no stock list called ${destKey}`);
      const row = e.originRow && typeof e.originRow === 'object' ? snapshot(e.originRow) : null;
      if (!row) throw bad('The row it came from was not kept — add it again by hand');
      // The row it came from was deleted here when it was checked out: it comes back as it was, rather than twice.
      const gone = row.id ? (await db.query("SELECT * FROM logistics_items WHERE kind = $1 AND deleted_at IS NOT NULL AND data->>'id' = $2 ORDER BY id DESC LIMIT 1 FOR UPDATE", [destKey, String(row.id)])).rows[0] : null;
      let restoredId;
      if (gone) {
        await softDelete(db, gone.id, user, { restore: true });
        await patchItem(db, gone, row, user);
        restoredId = gone.id;
      } else {
        restoredId = (await insertItem(db, destKey, row, user)).id;
      }
      await softDelete(db, item.id, user);
      await logActivity(db, `↩ Returned ${sn(e) || text(e.brand) || e.id} from Checkout to ${text(e.originLocation) || destKey} stock`, user);
      return { message: `Returned to ${text(e.originLocation) || 'stock'}`, created: gone ? [] : [restoredId], open: `#/lg/${restoredId}` };
    },
  },
  {
    key: 'stock-checkout-delete',
    label: 'Delete',
    kinds: ['checkoutStock'],
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      return { message: 'Deleted from Checkout', open: '#/logistics/checkout' };
    },
  },
  {
    key: 'stock-notes',
    label: 'Write a note',
    kinds: [...STOCK_KINDS, 'hkSituation'],
    form: [f('notes', 'Notes', 'longtext')],
    prefill: async (item) => ({ notes: text(item.data.notes, 2000) }),
    run: async ({ db, item, input, user }) => {
      const r = item.data;
      const value = text(input.notes, 2000);
      if (text(r.notes, 2000) === value) return { message: 'The note is unchanged' };
      await patchItem(db, item, { ...r, notes: value }, user);
      // The app logs a stock row's note; an HK board row's it saves silently (updateHkNote).
      if (item.kind !== 'hkSituation') await logActivity(db, `Updated note on stock ${what(r)}: "${value.slice(0, 60)}"`, user);
      return { message: 'Note saved' };
    },
  },
  {
    key: 'stock-vault',
    label: 'Show / hide in Vault',
    kinds: STOCK_KINDS,
    run: async ({ db, item, user }) => {
      const r = item.data;
      const hidden = !r.hideFromVault;
      await patchItem(db, item, { ...r, hideFromVault: hidden }, user);
      await logActivity(db, hidden ? `🚫 ${what(r)} hidden from Watch Vault` : `🌐 ${what(r)} shown in Watch Vault again`, user);
      return { message: hidden ? 'Hidden from the Watch Vault' : 'Showing in the Watch Vault' };
    },
  },
  {
    key: 'stock-delete',
    label: 'Delete',
    kinds: [...STOCK_KINDS, 'hkSituation'],
    danger: true,
    run: async ({ db, item, user }) => {
      const cfg = PLACES[item.kind];
      await softDelete(db, item.id, user);
      if (cfg) await logActivity(db, `Deleted ${cfg.label} Stock ${what(item.data)} (deleted here)`, user);
      return { message: 'Row deleted', open: `#/logistics/${cfg ? cfg.page : 'hkstock'}` };
    },
  },
  {
    key: 'stock-spare-delete',
    label: 'Delete spare',
    kinds: Object.values(PLACES).map((p) => p.spares),
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      return { message: `Spare ${text(item.data.accessory)} deleted` };
    },
  },
  {
    key: 'stock-safe-give',
    label: 'Give back to owner',
    kinds: ['safeStock'],
    form: [f('date', 'Date', 'date'), f('takenAccessories', 'Accessories going with it', 'longtext', { hint: 'comma separated' }), f('spareAccessories', 'Left in the safe as spares', 'longtext'), f('notes', 'Notes', 'longtext')],
    prefill: async (item) => ({ date: localToday(), takenAccessories: takenDefault(item.data) }),
    run: async ({ db, item, input, user, ctx }) => {
      if (item.data.status === 'moved') throw bad('Already given back — use Move back');
      const owner = text(item.data.from, 200) || 'its owner';
      const m = moveInput(input);
      return moveRow({ db, item, user, ctx, ...m, moveType: 'external', destination: `Given back to ${owner}` });
    },
  },
  {
    key: 'stock-hk-add',
    label: 'Add HK row',
    kinds: null,
    page: 'hkstock',
    form: [
      f('stockNumber', 'Stock number', 'stock'),
      f('brand', 'Brand', 'text', { hint: BRANDS.join(', ') }),
      f('section', 'Section', 'choice', { options: HK_SECTIONS.map((s) => ({ value: s.key, label: s.title })) }),
      f('holder', 'Holder', 'text', { hint: 'e.g. RK, Winnie, By Ferrari, IN SAFE' }),
      f('stockStatus', 'Stock status'),
      f('description', 'Description', 'longtext'),
      f('notes', 'Notes', 'longtext'),
    ],
    prefill: async () => ({ section: 'in_hand' }),
    run: async ({ db, input, user }) => {
      const section = text(input.section, 20);
      if (!HK_SECTIONS.some((s) => s.key === section)) throw bad('Say which section');
      const d = { stockNumber: text(input.stockNumber, 60), stockStatus: text(input.stockStatus, 100), section, holder: text(input.holder, 100), description: text(input.description, 2000), brand: text(input.brand, 100), notes: text(input.notes, 2000) };
      if (!d.stockNumber && !d.description) throw bad('Stock # or description required');
      if (d.stockNumber) {
        const dup = await duplicateOf(db, d.stockNumber);
        if (dup) throw bad(dupMessage(dup, d.stockNumber));
      }
      const row = await insertItem(db, 'hkSituation', { ...d, movements: [] }, user);
      await logActivity(db, `HK row ${d.stockNumber} added to ${hkSectionTitle(section)}`, user);
      return { message: `Added to ${hkSectionTitle(section)}${await oursNote(d.stockNumber)}`, created: [row.id], open: `#/lg/${row.id}` };
    },
  },
  {
    key: 'stock-hk-move',
    label: 'Move on the board',
    kinds: ['hkSituation'],
    form: [
      f('toSection', 'To', 'choice', {
        options: [
          ...HK_SECTIONS.map((s) => ({ value: s.key, label: s.title })),
          { value: 'london', label: '🇬🇧 → London Stock (creates entry there)' },
          { value: 'dubai', label: '🇦🇪 → Dubai Stock (creates entry there)' },
        ],
      }),
      f('toHolder', 'New holder / status', 'text', { hint: 'e.g. RK, Winnie, By Ferrari, IN SAFE' }),
      f('date', 'Date', 'date'),
      f('carrier', 'Carrier'),
      f('destination', 'Destination'),
      f('costAmount', 'Cost', 'money', { currency: 'costCurrency' }),
      f('costCurrency', 'Cost currency', 'currency'),
      f('isSale', 'Sold on this move', 'bool', { hint: 'only from In Hand to Going out' }),
      f('saleClientId', 'Sold to', 'client'),
      f('saleBrand', 'Brand (for the accessories)', 'text'),
      f('salePrice', 'Price', 'text'),
      f('givenAccessories', 'Accessories given', 'text', { hint: 'comma separated' }),
      f('owedAccessories', 'Accessories still owed', 'text', { hint: 'comma separated — become a pending "give"' }),
      f('notes', 'Notes', 'longtext'),
    ],
    prefill: async (item) => ({ toSection: item.data.section === 'in_hand' ? 'outgoing' : 'in_hand', date: localToday(), costCurrency: 'AED', isSale: false }),
    run: hkMove,
  },
  {
    key: 'stock-hk-cancel-sale',
    label: 'Cancel sale',
    kinds: ['hkSituation'],
    danger: true,
    run: async ({ db, item, user }) => {
      const r = item.data;
      const movements = Array.isArray(r.movements) ? r.movements : [];
      const i = movements.findIndex((m) => m && m.sale);
      if (r.section !== 'sold' || i < 0) throw bad('This row is not sold on the board');
      const m = movements[i];
      // Back to where it was before the sale — the board's section it came from, with its holder — never into another list.
      const section = HK_SECTIONS.some((s) => s.key === m.fromSection) ? m.fromSection : 'in_hand';
      const next = { ...r, section, holder: text(m.fromHolder), movements: movements.map((x, j) => (j === i ? { ...x, cancelledAt: Date.now() } : x)) };
      await patchItem(db, item, next, user);
      if (m.transactionId) {
        const tx = (await listKind(db, 'transactions', "data->>'id' = $2", [String(m.transactionId)]))[0];
        if (tx) await softDelete(db, tx.id, user);
      }
      await logActivity(db, `↩️ Cancelled HK sale ${sn(r)}${m.sale?.clientName ? ' to ' + m.sale.clientName : ''} — restored to ${hkSectionTitle(section)}`, user);
      return { message: `Sale cancelled · back in ${hkSectionTitle(section)}` };
    },
  },
  {
    key: 'stock-take',
    label: 'Stock take by AI',
    kinds: null,
    page: 'dubaistock',
    ai: true,
    form: [f('brand', 'Only this brand', 'text', { hint: 'blank for every watch in Dubai' })],
    run: async ({ db, input }) => {
      const brand = text(input.brand, 100).toLowerCase();
      const current = (await listKind(db, 'dubaiStock', "data->>'status' = 'current'")).map((r) => r.data).filter((s) => !brand || text(s.brand).toLowerCase().includes(brand));
      const photos = Array.isArray(input.photos) ? input.photos.filter((p) => typeof p === 'string' && p.startsWith('data:image/')) : [];
      if (!photos.length) throw bad('Add at least one photo first — the stock take reads the shelf from photos');
      const prompt = stockTakePrompt(current, photos.length);
      const report = stockTakeReport(await ask({ prompt, json: true, images: photos }), current);
      const lines = [report.summary, `${report.confirmed.length} confirmed · ${report.missing.length} missing · ${report.total} in stock${report.unexpected.length ? ` · ${report.unexpected.length} unexpected` : ''}`];
      if (report.missing.length) lines.push(`Missing: ${report.missing.map((m) => m.stockNumber).join(', ')}`);
      return { message: lines.join('\n') };
    },
  }
);

/* The app's row form has these, which kinds.js does not type: the Edit form gets proper controls for them. */
const cornerFields = (cfg) => cfg.corners.map(([key, label]) => f(key, label, 'text'));
export const FIELDS = {
  londonStock: [...cornerFields(PLACES.londonStock), f('hideFromVault', 'Hidden from the Watch Vault', 'bool'), ...PRICE_FIELDS],
  dubaiStock: [...cornerFields(PLACES.dubaiStock), f('hideFromVault', 'Hidden from the Watch Vault', 'bool'), ...PRICE_FIELDS],
  hkStock: [...cornerFields(PLACES.hkStock), f('hideFromVault', 'Hidden from the Watch Vault', 'bool'), ...PRICE_FIELDS],
  safeStock: [...cornerFields(PLACES.safeStock), f('hideFromVault', 'Hidden from the Watch Vault', 'bool')],
  hkSituation: [f('accessoriesPresent', 'Accessories with it', 'longtext'), f('accessoriesMissing', 'Accessories missing', 'longtext')],
};
