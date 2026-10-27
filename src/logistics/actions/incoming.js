/*
 * Incomings — the logistics app's Incomings page, its buttons done here
 * (asked 27 Oct 2026: "all the features in the logistic side in the erp
 * system to do entries"). Each action is the app's own function, record for
 * record (its index.html, named at each one): what it writes where, the
 * field names and value forms, the activity line.
 *
 *   inc-add        openIncomingModal + saveIncoming       a new incoming
 *   inc-edit       the same form on an existing one       (the app's Edit)
 *   inc-import     importIncomingsCSV (+ downloadIncomingTemplate)
 *   inc-arrive     openArriveModal + confirmArrive        status arrived, arrival record, the
 *                                                         supplier-owes transaction for what is missing
 *   inc-receive    openReceiveToInventory + confirmReceiveToInventory
 *                                                         → a London / Dubai / HK stock row
 *   inc-ship       convertIncomingToShipment              → a live shipment carrying it
 *   inc-collect    openDeliveryPlanner + createIncomingCollection
 *                                                         → one live shipment carrying several
 *   inc-sold       openSoldModal('incomings') + confirmSold → Ready for delivery
 *   inc-cost       the Costs tab's saveLogisticCost, naming this watch (the
 *                  app's "Add Cost" on an incoming opens the cost breakdown,
 *                  which only reads; the line itself is written on Costs)
 *   inc-date       openDateEditModal('arrived') + saveDateEdit
 *   inc-vault      toggleVaultVisibility('incoming')
 *   inc-cancel     setIncomingStatus(id, 'cancelled')
 *   inc-delete     deleteIncoming
 *   inc-fob-pick   fobPickFromFob — here from OUR watches with status
 *                  incoming (Chrono Key's "To be shipped", read by the sync)
 *   inc-fob-send   fobPickedSend    the picked row → an incoming, fromFob
 *   inc-fob-drop   fobPickedDrop
 *
 * Our rule throughout: a stock number is OUR watch (the message says when it
 * is not one of ours); a client is OUR logistics client by id — the app's
 * supplier box is a pick from its client list, so the form offers the same
 * and keeps the typed name beside it, as the app keeps the name; a typed
 * name the app would match by name (ensureClientByName) is matched exactly
 * as the app matches it, and created as the app creates it. Nothing is
 * written back to the app. WhatsApp: the app opens a message after an
 * arrival, a receipt and a sale — not sent from here (no bot, no keys).
 */
import { insertItem, patchItem, softDelete, logActivity, text, dayOf, amountOf, currencyOf, uid, localToday, bad } from '../write.js';
import { query } from '../../db/index.js';
import { oursByNumber } from '../shared.js';
import { clientName } from '../../clients/index.js';
import { linksByName } from '../clients.js';
import { getRates } from '../../rates/index.js';

/* ── the app's lists and helpers ─────────────────────────────────── */

/* The app's ACCESSORIES and BRAND_ACCESSORIES: what comes with a watch of each brand. */
export const ACCESSORIES = ['Box', 'Outer Box', 'Papers', 'Warranty Card', 'Manual', 'Tag', 'Pusher', 'Link', 'Bracelet', 'Strap', 'Buckle', 'Service Card'];
export const BRAND_ACCESSORIES = {
  'Patek Philippe': ['Watch', 'Warranty Sheet', 'Booklet', 'Pouch', 'Pusher', 'White Tag', 'Service Paper', 'Invoice', 'Strap (Optional)', 'Winder (Optional)', 'Links', 'Box - Cubitus', 'Box - Special', 'Box - General'],
  Rolex: ['Watch', 'Warranty Card', 'Warranty Card Holder', 'Booklet', 'Manual', 'Box', 'Green Tag', 'White Tag', 'Strap', 'Links'],
  'Audemars Piguet': ['Watch', 'Warranty Card', 'Booklet', 'Box', 'Service Paper', 'Invoice'],
  'Richard Mille': ['Watch', 'Warranty Sheet', 'Strap', 'Box', 'Service Paper'],
  Hublot: ['Watch', 'Warranty Card', 'Booklet', 'Box', 'Outer Box', 'Strap', 'Pusher Tool', 'Rubber Strap', 'Links', 'Hangtag'],
  Cartier: ['Watch', 'Warranty Card', 'Booklet', 'Box', 'Outer Box', 'Pouch', 'Adjustment Pin', 'Links', 'Hangtag'],
  'Vacheron Constantin': ['Watch', 'Certificate', 'Booklet', 'Box', 'Outer Box', 'Pouch', 'Strap', 'Links'],
  'A. Lange & Söhne': ['Watch', 'Certificate', 'Booklet', 'Manual', 'Box', 'Outer Box', 'Hangtag', 'Loupe'],
  Omega: ['Watch', 'Warranty Card', 'Manual', 'Box', 'Outer Box', 'Pusher Tool', 'Polishing Cloth'],
  Tudor: ['Watch', 'Warranty Card', 'Booklet', 'Box', 'Outer Box', 'Strap', 'Links', 'Hangtag'],
  'Ulysse Nardin': ['Watch', 'Warranty Card', 'Booklet', 'Manual', 'Box', 'Outer Box', 'Strap', 'Links', 'Service Paper'],
  IWC: ['Watch', 'Warranty Card', 'Booklet', 'Box', 'Outer Box', 'Strap', 'Links', 'Hangtag'],
  Other: ['Watch', 'Papers', 'Box', 'Outer Box', 'Manual', 'Warranty Card', 'Strap', 'Bracelet', 'Links', 'Pusher', 'Hangtag'],
};
const BRANDS = Object.keys(BRAND_ACCESSORIES);
const brandList = (brand) => (brand && BRAND_ACCESSORIES[brand] ? BRAND_ACCESSORIES[brand] : ACCESSORIES);
const INC_STATUS = ['pending', 'in_transit', 'arrived', 'consignment', 'cancelled'];
const CURRENCIES = ['USD', 'AED', 'EUR', 'GBP', 'HKD', 'CHF'];
const DEST_LABEL = { london: '🇬🇧 London Stock', dubai: '🇦🇪 Dubai Stock', hk: '🌐 HK Stock' };
const DEST_KIND = { london: 'londonStock', dubai: 'dubaiStock', hk: 'hkStock' };
const INC_NO_LOC = 'Unknown location';
const INC_NO_SUP = 'No client';

/* A record's id as the app's records name it: the app's own, or the one insertItem gave ours. */
export const appId = (row) => row.source_id || text(row.data?.id);
/* A logistics client's id as records name it (shared.js CLIENT_ID): the app's own, or "ma-" and our row's id. */
export const clientIdOf = (row) => row.source_id || `ma-${row.id}`;
/* The app's `i.stockNumber || i.reference`. */
export const incLabel = (d) => text(d.stockNumber) || text(d.reference);
/* The app's incLocOf / incSupOf / incDestOf. */
export const incLoc = (d) => text(d.location) || INC_NO_LOC;
export const incSup = (d) => text(d.supplier) || INC_NO_SUP;
const DEST_WORDS = { london: 'London', dubai: 'Dubai', hk: 'Hong Kong' };
export const incDest = (d) => DEST_WORDS[d.inventoryDest] || text(d.destination);
/* The app's _incIsHistoric: arrived, cancelled, shipped or taken into stock. */
export const isHistoric = (d) => d.status === 'arrived' || d.status === 'cancelled' || Boolean(d.shipmentId) || Boolean(d.inventoryId);
/* The app's splitStockList. */
const splitStock = (s) => String(s ?? '').split(/[,\n;]+/).map((x) => x.trim()).filter(Boolean);
/* A comma list as the app's arrive / receive forms read a typed one. */
const listOf = (v) => String(v ?? '').split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
/* The app's _fmtDay: "27 Oct 2026". */
const fmtDay = (ms) => {
  const d = new Date(Number(ms));
  return Number(ms) && !Number.isNaN(d.getTime()) ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '–';
};
/* A day from a form as a moment: today keeps the clock time (the app stamps Date.now()); another day is noon UTC. */
const momentOf = (day) => (!day || day === localToday() ? Date.now() : Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), 12));
const bool = (v) => v === true || /^(true|yes|1|on)$/i.test(String(v ?? ''));

/** A record by the id the app's records use (its own, or ours), locked for the transaction. */
export async function byAppId(db, kind, id, { lock = true } = {}) {
  const key = text(id);
  if (!key) return null;
  const { rows } = await db.query(`SELECT * FROM logistics_items WHERE kind = $1 AND deleted_at IS NULL AND (source_id = $2 OR data->>'id' = $2) ORDER BY id LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [kind, key]);
  return rows[0] || null;
}

/* The app's isCompanyClient. */
const isCompany = (d) => d?.isCompany === true || text(d?.name).toLowerCase() === 'company';

/**
 * The app's ensureClientByName: the client of that exact name (case aside,
 * never a company one), its blank country filled in; else a new client as
 * the app writes one. Returns the client's id as records name it.
 */
export async function ensureClientByName(db, name, country, user) {
  const trimmed = text(name, 200);
  if (!trimmed) return null;
  const realCountry = text(country, 100);
  const { rows } = await db.query("SELECT * FROM logistics_items WHERE kind = 'clients' AND deleted_at IS NULL AND lower(btrim(data->>'name')) = lower($1) ORDER BY id FOR UPDATE", [trimmed]);
  const c = rows.find((r) => !isCompany(r.data));
  if (c) {
    const had = text(c.data.country);
    if (realCountry && (!had || had === '—')) await patchItem(db, c, { ...c.data, country: realCountry }, user);
    return clientIdOf(c);
  }
  const row = await insertItem(db, 'clients', { name: trimmed, country: realCountry || '—', notes: 'Auto-added from incoming/shipment' }, user);
  await logActivity(db, `Auto-created client ${trimmed}${realCountry ? ` (${realCountry})` : ''}`, user);
  return clientIdOf(row);
}

/* The app's company client for a country (one of "us"), else its first; '' when the app's company locations were never made. */
export async function companyClient(db, country) {
  const { rows } = await db.query("SELECT id, source_id, data FROM logistics_items WHERE kind = 'clients' AND deleted_at IS NULL AND (data->>'isCompany' = 'true' OR lower(btrim(data->>'name')) = 'company') ORDER BY id");
  const hit = rows.find((r) => text(r.data.country) === text(country)) || rows[0];
  return hit ? clientIdOf(hit) : '';
}

/* The app's findDuplicateStockNumber: where a stock number already is, in its words. */
export async function duplicateStock(db, stockNumber, excludeAppIds = []) {
  const sn = text(stockNumber).toLowerCase();
  if (!sn) return null;
  const skip = new Set(excludeAppIds.filter(Boolean).map(String));
  const { rows } = await db.query(
    "SELECT id, kind, source_id, data FROM logistics_items WHERE deleted_at IS NULL AND kind = ANY($1) AND lower(btrim(data->>'stockNumber')) = $2 ORDER BY id",
    [['safeStock', 'londonStock', 'dubaiStock', 'hkStock', 'incomings', 'readyForDelivery', 'soldStocks'], sn]
  );
  const WHERE = { safeStock: '🔒 In Safe', londonStock: '🇬🇧 London Stock', dubaiStock: '🇦🇪 Dubai Stock', hkStock: '🌐 HK Stock', incomings: '📥 Incomings', readyForDelivery: '📦 Ready for Delivery', soldStocks: '✅ Sold Stocks' };
  for (const kind of Object.keys(WHERE)) {
    for (const r of rows.filter((x) => x.kind === kind)) {
      const d = r.data || {};
      if (skip.has(appId(r))) continue;
      if (['safeStock', 'londonStock', 'dubaiStock', 'hkStock'].includes(kind) && d.status === 'moved') continue;
      if (kind === 'incomings' && (d.status === 'cancelled' || d.inventoryId)) continue;
      return { where: WHERE[kind], label: [d.brand, kind === 'incomings' ? d.reference : d.watchModel].filter(Boolean).join(' · ') };
    }
  }
  return null;
}
const refuseDuplicate = (c, sn) => {
  if (c) throw bad(`Stock # "${sn}" already exists in ${c.where}${c.label ? ` · ${c.label}` : ''}. Each stock number must be unique.`);
};

/* The app's suggestNextStock: one counter over transactions, shipments and incomings. */
export async function suggestNextStock(db) {
  const { rows } = await db.query("SELECT kind, data->>'stockNumber' AS sn FROM logistics_items WHERE deleted_at IS NULL AND kind = ANY($1)", [['transactions', 'shipments', 'incomings']]);
  let max = 0;
  const consider = (s) => {
    const m = String(s ?? '').match(/(\d+)/g);
    if (m) max = Math.max(max, parseInt(m[m.length - 1], 10));
  };
  for (const r of rows) (r.kind === 'shipments' ? splitStock(r.sn) : [r.sn]).forEach(consider);
  return `STK-${String(max + 1).padStart(3, '0')}`;
}

/* " · not one of our watches" when no watch of ours carries the number (our rule: a stock number is our watch). */
export async function oursNote(sn) {
  const no = text(sn);
  if (!no) return '';
  return (await oursByNumber([no])).get(no) ? '' : ' · not one of our watches';
}

/* The app's transaction for what a supplier still owes after an arrival / a receipt. */
const owedItems = (missing) => missing.map((m) => ({ id: uid(), accessory: m.accessory, qty: m.qty, direction: 'receive', status: 'pending', settledBy: null, settlementId: null }));

/* A cost line as the app's saveLogisticCost writes one (the Costs tab's form). */
export function costLine(input) {
  const title = text(input.title, 200);
  if (!title) throw bad('Title is required');
  const amount = amountOf(input.amount, 'Amount');
  if (!amount) throw bad('Amount is required');
  return { title, shipmentId: null, stockNumber: text(input.stockNumber, 500), fromName: text(input.fromName, 200), toName: text(input.toName, 200), date: dayOf(input.date, 'Date'), currency: currencyOf(input.currency, 'USD'), amount, notes: text(input.notes, 2000) };
}

/* The logistics client prefilled for a typed supplier: the one of that name (linksByName — the typed-name link). */
async function supplierChoice(d) {
  const sup = text(d.supplier);
  if (!sup) return '';
  const link = (await linksByName([sup])).get(sup);
  if (!link?.lg_client_id) return '';
  const { rows } = await query("SELECT id, source_id FROM logistics_items WHERE kind = 'clients' AND id = $1", [link.lg_client_id]);
  return rows[0] ? clientIdOf(rows[0]) : '';
}

/* ── the incoming's form (the app's Add / Edit Incoming modal, every box) ── */

export const FIELDS = {
  incomings: [
    { key: 'destination', label: 'Destination (typed)', type: 'text' },
    { key: 'watchDate', label: 'Watch date', type: 'text' },
    { key: 'buyPrice', label: 'Purchase price (what you paid)', type: 'money', currency: 'buyCurrency' },
    { key: 'buyCurrency', label: 'Purchase currency', type: 'currency' },
    { key: 'hideFromVault', label: 'Hidden from the Watch Vault', type: 'bool' },
    { key: 'watchModel', label: 'Model', type: 'text' },
    { key: 'caseMaterial', label: 'Case material', type: 'text' },
    { key: 'caseDiameter', label: 'Case size', type: 'text' },
    { key: 'dial', label: 'Dial', type: 'text' },
    { key: 'bezel', label: 'Bezel', type: 'text' },
    { key: 'movement', label: 'Movement', type: 'text' },
    { key: 'complications', label: 'Complications', type: 'text' },
  ],
};

const brandField = (more = {}) => ({ key: 'brand', label: 'Brand', type: 'choice', options: [{ value: '', label: '— pick brand —' }, ...BRANDS.map((b) => ({ value: b, label: b }))], ...more });
const INC_FORM = [
  { key: 'stockNumber', label: 'Stock #', type: 'stock' },
  { key: 'reference', label: 'Reference', type: 'text' },
  brandField(),
  { key: 'location', label: 'Location (where it is)', type: 'text' },
  { key: 'supplierClientId', label: 'Supplier (a client)', type: 'client', hint: 'the app picks the supplier from its client list; the name is kept on the record' },
  { key: 'supplier', label: 'Supplier (typed, if not a client yet)', type: 'text' },
  { key: 'destination', label: 'Destination', type: 'text' },
  { key: 'eta', label: 'ETA', type: 'date' },
  { key: 'status', label: 'Status', type: 'enum', options: INC_STATUS },
  { key: 'serial', label: 'Serial', type: 'text' },
  { key: 'watchDate', label: 'Watch date', type: 'text' },
  { key: 'buyPrice', label: 'Purchase price (what you paid)', type: 'money', currency: 'buyCurrency' },
  { key: 'buyCurrency', label: 'Purchase currency', type: 'currency' },
  { key: 'costAmount', label: 'Shipping cost', type: 'money', currency: 'costCurrency' },
  { key: 'costCurrency', label: 'Shipping cost currency', type: 'currency' },
  { key: 'watchModel', label: 'Model', type: 'text' },
  { key: 'caseMaterial', label: 'Case material', type: 'text' },
  { key: 'caseDiameter', label: 'Case size', type: 'text' },
  { key: 'dial', label: 'Dial', type: 'text' },
  { key: 'bezel', label: 'Bezel', type: 'text' },
  { key: 'movement', label: 'Movement', type: 'text' },
  { key: 'complications', label: 'Complications', type: 'text' },
  { key: 'showInVault', label: 'Show to Watch Vault', type: 'bool' },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];

/* The app's saveIncoming: the form's values as the record carries them. */
async function incomingData(input, ctx) {
  const costAmount = amountOf(input.costAmount, 'Shipping cost');
  const costCurrency = currencyOf(input.costCurrency, 'AED', 'Shipping cost currency');
  const buyCurrency = currencyOf(input.buyCurrency, 'USD', 'Purchase currency');
  const buyPrice = amountOf(input.buyPrice, 'Purchase price') || null;
  const clientId = text(input.supplierClientId, 60);
  const supplier = clientId ? ctx.client(clientId) || text(input.supplier, 200) : text(input.supplier, 200);
  const eta = input.eta ? dayOf(input.eta, 'ETA', { blank: '' }) : '';
  const status = text(input.status, 20) || 'pending';
  if (!INC_STATUS.includes(status)) throw bad(`Status: "${status}" is not one of ${INC_STATUS.join(', ')}`);
  const brand = text(input.brand, 60);
  const data = {
    stockNumber: text(input.stockNumber, 60),
    reference: text(input.reference, 200),
    brand,
    location: text(input.location, 100),
    supplier,
    destination: text(input.destination, 100),
    eta,
    status,
    serial: text(input.serial, 100),
    watchDate: text(input.watchDate, 60),
    buyPrice,
    buyCurrency,
    costCurrency,
    costAmount,
    cost: costAmount > 0 ? `${costCurrency} ${costAmount}` : '',
    notes: text(input.notes, 5000),
    hideFromVault: !bool(input.showInVault ?? true),
    watchModel: text(input.watchModel, 200),
    caseMaterial: text(input.caseMaterial, 100),
    caseDiameter: text(input.caseDiameter, 60),
    dial: text(input.dial, 100),
    bezel: text(input.bezel, 100),
    movement: text(input.movement, 100),
    complications: text(input.complications, 200),
  };
  if (!data.reference && !data.stockNumber) throw bad('Stock # or Reference required');
  return data;
}
const incomingValues = (d) => ({ ...d, showInVault: !d.hideFromVault, buyCurrency: d.buyCurrency || 'USD', costCurrency: d.costCurrency || 'AED' });

/* ── CSV (the app's parseCSV, importIncomingsCSV, downloadIncomingTemplate) ── */

/** The app's parseCSV: quoted fields, commas inside quotes, blank rows dropped. */
export function parseCSV(input) {
  let s = String(input ?? '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = [];
  let i = 0;
  let field = '';
  let row = [];
  let inQuotes = false;
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
    } else {
      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === ',') {
        row.push(field);
        field = '';
        i += 1;
        continue;
      }
      if (ch === '\r') {
        i += 1;
        continue;
      }
      if (ch === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v && v.trim() !== ''));
}

/** The app's importIncomingsCSV, up to the writes: the rows read, and why any was skipped. */
export function readIncomingsCsv(csvText) {
  const rows = parseCSV(csvText);
  if (rows.length < 2) throw bad('CSV is empty or only has a header row.');
  const header = rows[0].map((h) => (h || '').trim().toLowerCase().replace(/\s+/g, ' '));
  const col = (name, alts = []) => {
    const all = [name, ...alts].map((n) => n.toLowerCase());
    for (let h = 0; h < header.length; h++) if (all.includes(header[h])) return h;
    return -1;
  };
  const idx = {
    stock: col('stocknumber', ['stock', 'stock #', 'stock_number', 'stock no', 'sno', 's no', 'stock number']),
    ref: col('reference', ['ref', 'model', 'watch']),
    brand: col('brand', ['make']),
    location: col('location', ['country', 'region', 'destination', 'where']),
    supplier: col('client', ['supplier', 'from', 'source', 'origin', 'vendor', 'owner', 'consignor', 'name']),
    eta: col('eta', ['expected', 'expected_arrival', 'arrival', 'date']),
    status: col('status', ['state']),
    serial: col('serial', ['serial_number', 'serial #']),
    cost: col('cost', ['price', 'value']),
    notes: col('notes', ['note', 'comment', 'comments', 'description']),
  };
  const missingCols = [];
  if (idx.stock < 0) missingCols.push('Stock # (header: stockNumber, stock, stock #, stock number)');
  if (idx.ref < 0) missingCols.push('Reference (header: reference, ref, model)');
  if (idx.supplier < 0) missingCols.push('Client (header: client, supplier, owner, name)');
  if (idx.location < 0) missingCols.push('Location (header: location, country, region)');
  if (missingCols.length) throw bad(`CSV is missing required column(s): ${missingCols.join('; ')}. Download the template for the format. Detected headers: ${header.join(', ')}`);
  const out = [];
  const skipped = [];
  rows.slice(1).forEach((r, rowIdx) => {
    const lineNum = rowIdx + 2;
    const get = (k) => (idx[k] >= 0 ? (r[idx[k]] || '').trim() : '');
    const stockNumber = get('stock');
    const reference = get('ref');
    const supplier = get('supplier');
    const location = get('location');
    if (!stockNumber && !reference && !supplier && !location) return;
    const missing = [];
    if (!stockNumber) missing.push('stock#');
    if (!reference) missing.push('reference');
    if (!supplier) missing.push('client');
    if (!location) missing.push('location');
    if (missing.length) {
      skipped.push(`Line ${lineNum}: missing ${missing.join(', ')}`);
      return;
    }
    const status = (get('status') || 'pending').toLowerCase().replace(/[^a-z_]/g, '_');
    out.push({
      stockNumber,
      reference,
      brand: get('brand'),
      location,
      supplier,
      eta: get('eta'),
      status: ['pending', 'in_transit', 'arrived', 'cancelled'].includes(status) ? status : 'pending',
      serial: get('serial'),
      cost: get('cost'),
      notes: get('notes'),
    });
  });
  return { rows: out, skipped };
}

/* The app's downloadIncomingTemplate, line for line. */
const TEMPLATE = [
  'stockNumber,reference,client,location,brand,eta,status,serial,cost,notes',
  '1240,5711/1A-014,Robin Casanova,Switzerland,Patek Philippe,2026-06-10,in_transit,7311834/6375392,USD 130000,"full set, papers + box"',
  '1241,5167A-001,Davinder Kalsi,United Kingdom,Patek Philippe,2026-05-22,in_transit,7245612/6498320,USD 38000,"full set"',
  '1242,5968G-010,Quaseem Mounir,United Kingdom,Patek Philippe,,consignment,,,"booklet missing — supplier holds it"',
  '1243,126508,Hayat,United Kingdom,Rolex,2026-05-25,in_transit,5Q2042X1,USD 45000,"YML / yellow gold, card + box only"',
  '1244,228235,Stefano Conzodari,Italy,Rolex,,pending,,,"olive dial, consignment from STEFANO"',
  '1245,15510OR,Igor,Switzerland,Audemars Piguet,,pending,WJ1062R,,"40th Anniversary, gold"',
  '1246,RM010 Ti Mon-02067,Avneet,Spain,Richard Mille,2026-06-01,in_transit,,,"titanium black"',
  '1247,WSSA0071,Davinder Kasi,Italy,Cartier,,pending,4072504647EY,,"green dial, full kit"',
  '1248,4500V/110A-B128,Jeremy,Germany,Vacheron Constantin,,pending,678678,,"Overseas salmon dial"',
  '1249,M79360N-0024,Arfan,Dubai,Tudor,2026-05-30,in_transit,,,"Black Bay Chrono, full set"',
  '1250,278274,Hayat,United Kingdom,Rolex,,cancelled,,,"buyer pulled out"',
  '1251,5990/1A-011,Robin Casanova,Switzerland,Patek Philippe,2026-05-08,arrived,7736164/6691291,USD 95000,"watch + papers + pouch, missing pusher & 2 links"',
].join('\n') + '\n';

/* ── the stock row a receipt writes (the app's confirmReceiveToInventory) ── */

const RECEIVE_FORM = [
  { key: 'dest', label: 'Into', type: 'choice', options: [{ value: 'london', label: '🇬🇧 London Stock' }, { value: 'dubai', label: '🇦🇪 Dubai Stock' }, { value: 'hk', label: '🌐 HK Stock' }], required: true },
  { key: 'stockNumber', label: 'Stock #', type: 'stock', required: true },
  { key: 'receiveDate', label: 'Received on', type: 'date' },
  { key: 'from', label: 'From (as written on the row)', type: 'text' },
  { key: 'supplierClientId', label: 'Supplier (a client, for what is owed)', type: 'client', hint: 'the app would match the typed supplier by name; here the client is chosen' },
  brandField(),
  { key: 'ref', label: 'Reference', type: 'text' },
  { key: 'model', label: 'Model', type: 'text' },
  { key: 'serial', label: 'Serial', type: 'text' },
  { key: 'watchDate', label: 'Watch date', type: 'text' },
  { key: 'costAmount', label: 'Buy price (cost)', type: 'money', currency: 'costCurrency' },
  { key: 'costCurrency', label: 'Cost currency', type: 'currency' },
  { key: 'caseMaterial', label: 'Case material', type: 'text' },
  { key: 'caseDiameter', label: 'Case size', type: 'text' },
  { key: 'dial', label: 'Dial', type: 'text' },
  { key: 'bezel', label: 'Bezel', type: 'text' },
  { key: 'movement', label: 'Movement', type: 'text' },
  { key: 'complications', label: 'Complications', type: 'text' },
  { key: 'present', label: 'Accessories present', type: 'longtext', hint: 'comma separated; the brand’s own list is filled in to tick off' },
  { key: 'missing', label: 'Accessories missing', type: 'longtext' },
  { key: 'owed', label: 'Log missing as owed by the supplier', type: 'bool' },
  { key: 'inMayfair', label: 'London · in Mayfair', type: 'text' },
  { key: 'inNcl', label: 'London · in NCL', type: 'text' },
  { key: 'inOffice', label: 'Dubai · in office', type: 'text' },
  { key: 'inSafe', label: 'Dubai · in safe', type: 'text' },
  { key: 'needPolish', label: 'Needs polish (London / Dubai)', type: 'bool' },
  { key: 'hkSection', label: 'HK · section', type: 'enum', options: ['in_hand', 'incoming', 'outgoing', 'sold'] },
  { key: 'hkHolder', label: 'HK · with (holder)', type: 'text' },
  { key: 'hkStatus', label: 'HK · stock status', type: 'text' },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];
const KNOWN_CURS = ['USD', 'GBP', 'EUR', 'AED', 'CHF', 'HKD', 'JPY', 'CNY', 'SGD'];
/* The app's openReceiveToInventory: the destination guessed from the location, the price from buyPrice else the old cost text. */
function receivePrefill(d) {
  const loc = text(d.location).toLowerCase();
  const dest = loc.includes('dubai') || loc.includes('uae') || loc.includes('emirat') ? 'dubai' : loc.includes('hong') || loc === 'hk' || loc.includes('kong') ? 'hk' : 'london';
  let costCur = 'USD';
  let costAmt = '';
  if (d.buyPrice !== '' && d.buyPrice !== null && d.buyPrice !== undefined) {
    costAmt = String(d.buyPrice).replace(/[, ]/g, '');
    if (KNOWN_CURS.includes(text(d.buyCurrency).toUpperCase())) costCur = text(d.buyCurrency).toUpperCase();
  } else if (d.cost) {
    const m = String(d.cost).match(/^\s*([A-Za-z]{2,4})\s*([\d.,]+)/);
    if (m) {
      if (KNOWN_CURS.includes(m[1].toUpperCase())) costCur = m[1].toUpperCase();
      costAmt = m[2].replace(/[, ]/g, '');
    } else {
      const m2 = String(d.cost).match(/[\d.,]+/);
      if (m2) costAmt = m2[0].replace(/[, ]/g, '');
    }
  }
  return { dest, stockNumber: text(d.stockNumber), receiveDate: localToday(), from: text(d.supplier), brand: text(d.brand), ref: text(d.reference), model: text(d.reference), serial: text(d.serial), watchDate: '', costCurrency: costCur, costAmount: costAmt, present: 'Watch', missing: '', owed: true, hkSection: 'in_hand', notes: text(d.notes) };
}

/* ── the actions ─────────────────────────────────────────────────── */

export const ACTIONS = [
  {
    key: 'inc-add',
    label: 'Add incoming',
    kinds: null,
    page: 'incoming',
    form: INC_FORM,
    prefill: async () => ({ status: 'pending', buyCurrency: 'USD', costCurrency: 'AED', showInVault: true }),
    run: async ({ db, input, user, ctx }) => {
      const data = await incomingData(input, ctx);
      if (data.stockNumber) refuseDuplicate(await duplicateStock(db, data.stockNumber), data.stockNumber);
      // Suppliers ARE clients (the app): the typed name is matched as the app matches it, or created as it creates one.
      if (data.supplier) await ensureClientByName(db, data.supplier, data.location, user);
      const row = await insertItem(db, 'incomings', { ...data, photos: [], shipmentId: null }, user);
      await logActivity(db, `Added incoming ${incLabel(data)} from ${data.supplier || 'supplier'}`, user);
      return { message: `Incoming ${incLabel(data)} added${await oursNote(data.stockNumber)}`, open: `#/lg/${row.id}`, created: [row.id] };
    },
  },
  {
    key: 'inc-edit',
    label: 'Edit incoming',
    kinds: ['incomings'],
    form: INC_FORM,
    prefill: async (it) => ({ ...incomingValues(it.data), supplierClientId: await supplierChoice(it.data) }),
    run: async ({ db, item, input, user, ctx }) => {
      const data = await incomingData(input, ctx);
      if (data.stockNumber) refuseDuplicate(await duplicateStock(db, data.stockNumber, [appId(item)]), data.stockNumber);
      if (data.supplier) await ensureClientByName(db, data.supplier, data.location, user);
      // The app assigns every box of the form; a box the record never had and the form left blank is not a change here — it would only lock a field against the sync for nothing.
      const next = { ...item.data };
      for (const [k, v] of Object.entries(data)) {
        if (!(k in item.data) && (v === '' || v === null || v === false || v === 0 || (k === 'buyCurrency' && !data.buyPrice) || (k === 'costCurrency' && !data.costAmount))) continue;
        next[k] = v;
      }
      await patchItem(db, item, next, user);
      await logActivity(db, `Updated incoming ${incLabel(data)}`, user);
      return { message: `Incoming ${incLabel(data)} changed${await oursNote(data.stockNumber)}` };
    },
  },
  {
    key: 'inc-import',
    label: 'Import CSV',
    kinds: null,
    page: 'incoming',
    form: [{ key: 'csv', label: 'CSV file', type: 'csv', hint: 'columns as the template: stockNumber, reference, client, location, brand, eta, status, serial, cost, notes — a stock number already in Incomings is updated' }],
    template: () => TEMPLATE,
    run: async ({ db, input, user }) => {
      const { rows, skipped } = readIncomingsCsv(input.csv);
      let added = 0;
      let updated = 0;
      const created = [];
      for (const r of rows) {
        await ensureClientByName(db, r.supplier, r.location, user);
        const { rows: had } = await db.query("SELECT * FROM logistics_items WHERE kind = 'incomings' AND deleted_at IS NULL AND btrim(data->>'stockNumber') = $1 ORDER BY id LIMIT 1 FOR UPDATE", [r.stockNumber]);
        const existing = had[0];
        if (existing) {
          const d = existing.data;
          await patchItem(
            db,
            existing,
            {
              ...d,
              reference: r.reference,
              brand: r.brand || d.brand,
              location: r.location,
              supplier: r.supplier,
              eta: r.eta || d.eta,
              status: r.status,
              serial: r.serial || d.serial,
              cost: r.cost || d.cost,
              ...(r.notes ? { notes: r.notes } : {}),
            },
            user
          );
          updated += 1;
          continue;
        }
        const row = await insertItem(db, 'incomings', { ...r, photos: [], shipmentId: null }, user);
        created.push(row.id);
        added += 1;
      }
      await logActivity(db, `CSV import — added ${added}, updated ${updated}, skipped ${skipped.length}`, user);
      const why = skipped.length ? ` Skipped: ${skipped.slice(0, 20).join('; ')}${skipped.length > 20 ? ` … and ${skipped.length - 20} more` : ''}.` : '';
      return { message: `Import complete — added ${added}, updated ${updated}, skipped ${skipped.length}.${why}`, created };
    },
  },
  {
    key: 'inc-arrive',
    label: 'Mark arrived',
    kinds: ['incomings'],
    form: async (it) => {
      const d = it.data;
      const list = brandList(text(d.brand));
      return [
        { key: 'location', label: 'Location', type: 'text' },
        { key: 'arriveDate', label: 'Arrived on', type: 'date' },
        brandField(),
        { key: 'present', label: 'Arrived with', type: 'longtext', hint: `comma separated — the app ticks Watch and lists the rest of ${text(d.brand) || 'the'} list as missing until ticked` },
        { key: 'missing', label: 'Missing', type: 'longtext', hint: `${list.join(', ')}; anything else typed is added` },
        { key: 'supplierClientId', label: 'Supplier (a client), owes what is missing', type: 'client' },
        { key: 'notes', label: 'Notes on arrival', type: 'longtext' },
      ];
    },
    prefill: async (it) => {
      const d = it.data;
      const list = brandList(text(d.brand));
      return {
        location: text(d.location),
        arriveDate: localToday(),
        brand: text(d.brand),
        present: list.filter((a) => a.toLowerCase() === 'watch').join(', '),
        missing: list.filter((a) => a.toLowerCase() !== 'watch').join(', '),
        supplierClientId: await supplierChoice(d),
      };
    },
    run: async ({ db, item, input, user }) => {
      const i = { ...item.data };
      const location = text(input.location, 100);
      const arriveDate = input.arriveDate ? dayOf(input.arriveDate, 'Arrived on') : localToday();
      const brand = text(input.brand, 60);
      const notes = text(input.notes, 2000);
      const arrived = listOf(input.present).map((a) => ({ accessory: a, qty: 1 }));
      const missing = listOf(input.missing).map((a) => ({ accessory: a, qty: 1 }));
      i.status = 'arrived';
      i.arrivedAt = momentOf(arriveDate);
      if (location) i.location = location;
      if (brand && !i.brand) i.brand = brand;
      if (notes) i.notes = `${i.notes ? `${i.notes} · ` : ''}On arrival: ${notes}`;
      i.photos = Array.isArray(i.photos) ? i.photos : [];
      i.arrivalRecord = { arrivedAt: i.arrivedAt, location, brand, arrived: arrived.map((a) => a.accessory), missing: missing.map((a) => a.accessory), notes, photoCount: 0 };
      let line = `📥 Arrived ${incLabel(i)} — nothing missing 🎉`;
      let txNote = '';
      if (missing.length > 0 && text(i.supplier)) {
        const clientId = text(input.supplierClientId, 60) || (await ensureClientByName(db, i.supplier, i.location, user));
        if (clientId) {
          const tx = await insertItem(
            db,
            'transactions',
            {
              type: 'bought',
              date: arriveDate,
              clientId,
              reference: i.reference || i.stockNumber || '(arrival)',
              stockNumber: i.stockNumber || '',
              brand,
              notes: `Auto-created on arrival of incoming ${incLabel(i)}. Supplier owes us these accessories.`,
              items: owedItems(missing),
              incomingId: appId(item),
            },
            user
          );
          i.arrivalTransactionId = tx.data.id;
          line = `📥 Arrived ${incLabel(i)} — ${arrived.length} present, ${missing.length} missing (auto-tx created)`;
          txNote = ` · ${missing.length} missing item${missing.length > 1 ? 's' : ''} owed by the supplier (transaction written)`;
        }
      }
      await patchItem(db, item, i, user);
      await logActivity(db, line, user);
      return {
        message: `Arrived${txNote}${await oursNote(i.stockNumber)}. Photos: add them on the record. The app's WhatsApp "Watch Received" message is not sent from here.`,
        open: `#/lg/${item.id}`,
      };
    },
  },
  {
    key: 'inc-receive',
    label: 'Receive to inventory',
    kinds: ['incomings'],
    form: RECEIVE_FORM,
    prefill: async (it) => ({ ...receivePrefill(it.data), supplierClientId: await supplierChoice(it.data) }),
    run: async ({ db, item, input, user }) => {
      const i = { ...item.data };
      if (i.inventoryId) throw bad('It has already been received into inventory');
      const dest = text(input.dest, 10);
      if (!DEST_KIND[dest]) throw bad('Pick a destination');
      const stockNumber = text(input.stockNumber, 60);
      if (!stockNumber) throw bad('Stock # is required');
      refuseDuplicate(await duplicateStock(db, stockNumber, [appId(item)]), stockNumber);
      const present = listOf(input.present);
      const missing = listOf(input.missing);
      const owedMissing = bool(input.owed) ? missing : [];
      const brand = text(input.brand, 60);
      const fromName = text(input.from, 200);
      const ref = text(input.ref, 200);
      const model = text(input.model, 200);
      const serial = text(input.serial, 100);
      const watchDate = text(input.watchDate, 60);
      const notes = text(input.notes, 5000);
      const costCur = currencyOf(input.costCurrency, 'USD', 'Cost currency');
      const costAmtRaw = text(input.costAmount, 40).replace(/[, ]/g, '');
      if (costAmtRaw && !Number.isFinite(Number(costAmtRaw))) throw bad(`Buy price: "${input.costAmount}" is not an amount`);
      const costStr = costAmtRaw ? `${costCur} ${costAmtRaw}` : '';
      const receivedAt = momentOf(input.receiveDate ? dayOf(input.receiveDate, 'Received on') : localToday());
      const spec = { caseMaterial: text(input.caseMaterial, 100), caseDiameter: text(input.caseDiameter, 60), dial: text(input.dial, 100), bezel: text(input.bezel, 100), movement: text(input.movement, 100), complications: text(input.complications, 200) };
      const base = {
        stockNumber,
        from: fromName,
        brand,
        watchReference: ref,
        watchModel: model,
        watchDate,
        watchSerial: serial,
        ...spec,
        accessoriesPresent: present.join(', '),
        accessoriesMissing: missing.join(', '),
        photos: [],
        receivingPhotos: [],
        notes,
        status: 'current',
        receivedFromIncomingId: appId(item),
        receivedAt,
        cost: costStr,
        costCurrency: costCur,
        costAmount: costAmtRaw,
        buyPrice: costAmtRaw === '' ? '' : Number(costAmtRaw),
        buyCurrency: costCur,
      };
      let newRow;
      if (dest === 'london') newRow = { ...base, inMayfair: text(input.inMayfair, 100), inNcl: text(input.inNcl, 100), needPolish: bool(input.needPolish) };
      else if (dest === 'dubai') newRow = { ...base, inOffice: text(input.inOffice, 100), inSafe: text(input.inSafe, 100), needPolish: bool(input.needPolish) };
      else {
        const hkStatus = text(input.hkStatus, 200);
        newRow = { ...base, inVault: text(input.hkSection, 20), withClient: text(input.hkHolder, 200), notes: hkStatus ? `${hkStatus}${notes ? ` · ${notes}` : ''}` : notes, needPolish: false, movements: [] };
      }
      const row = await insertItem(db, DEST_KIND[dest], newRow, user);
      const destLabel = DEST_LABEL[dest];

      // The incoming goes to history, its stock number link intact.
      i.inventoryDest = dest;
      i.inventoryId = row.data.id;
      i.inventoryMovedAt = Date.now();
      i.status = 'arrived';
      i.arrivedAt = i.arrivedAt || Date.now();

      if (owedMissing.length && text(i.supplier)) {
        const clientId = text(input.supplierClientId, 60) || (await ensureClientByName(db, i.supplier, i.location, user));
        if (clientId) {
          const tx = await insertItem(
            db,
            'transactions',
            {
              type: 'bought',
              date: localToday(),
              clientId,
              reference: ref || stockNumber || '(received)',
              stockNumber,
              brand,
              notes: `Auto-created on receive of stock ${stockNumber} → ${destLabel}. Supplier owes us these accessories.`,
              items: owedItems(owedMissing.map((m) => ({ accessory: m, qty: 1 }))),
              incomingId: appId(item),
            },
            user
          );
          i.arrivalTransactionId = tx.data.id;
        }
      }
      await patchItem(db, item, i, user);
      await logActivity(db, `📥➡️🏠 Received Stock ${stockNumber} from incoming → ${destLabel}${missing.length ? ` · ${missing.length} missing (supplier owes)` : ''}`, user);
      return {
        message: `Stock #${stockNumber} → ${destLabel}${missing.length ? ` · ${missing.length} owed by supplier` : ''}${await oursNote(stockNumber)}. The app's WhatsApp "Received to Inventory" message is not sent from here.`,
        open: `#/lg/${row.id}`,
        created: [row.id],
      };
    },
  },
  {
    key: 'inc-ship',
    label: 'Create shipment',
    kinds: ['incomings'],
    form: [
      { key: 'fromClientId', label: 'From (the supplier, a client)', type: 'client', hint: 'the app matches the supplier by name and creates the client if missing' },
      { key: 'toClientId', label: 'To (our company location)', type: 'client' },
    ],
    prefill: async (it) => ({ fromClientId: await supplierChoice(it.data), toClientId: await companyClient({ query }, text(it.data.location)) }),
    run: async ({ db, item, input, user }) => {
      const i = { ...item.data };
      if (i.shipmentId) throw bad('It is already on a shipment');
      const fromClientId = text(input.fromClientId, 60) || (text(i.supplier) ? await ensureClientByName(db, i.supplier, i.location, user) : '') || '';
      const toClientId = text(input.toClientId, 60) || (await companyClient(db, text(i.location)));
      const ship = await insertItem(
        db,
        'shipments',
        {
          stockNumber: text(i.stockNumber) || (await suggestNextStock(db)),
          date: localToday(),
          fromClientId,
          toClientId,
          items: text(i.reference) + (i.brand ? ` (${text(i.brand)})` : ''),
          tracking: '',
          cost: i.cost || '',
          deliveryDate: i.eta || '',
          situation: i.notes || '',
          notes: i.notes || '',
          incomingId: appId(item),
          status: i.status === 'arrived' ? 'delivered' : i.status === 'in_transit' ? 'in_transit' : 'pending',
          deliveredAt: null,
          deliveryNotes: '',
          deliveryPhotos: Array.isArray(i.photos) ? [...i.photos] : [],
          missingItems: [],
        },
        user
      );
      i.shipmentId = ship.data.id;
      i.shippedAt = Date.now();
      await patchItem(db, item, i, user);
      await logActivity(db, `📦 Shipped incoming ${incLabel(i)}${i.notes ? ` (note: ${String(i.notes).slice(0, 60)})` : ''} → live shipment`, user);
      return { message: `Shipped → moved to history${toClientId ? '' : ' · no company location client exists to ship it to'}${await oursNote(i.stockNumber)}`, open: `#/lg/${ship.id}`, created: [ship.id] };
    },
  },
  {
    key: 'inc-collect',
    label: 'Plan collections',
    kinds: null,
    page: 'incoming',
    /* The app's Delivery Planner: tick what travels together. Opened from Owner Decisions, the approved group is ticked. */
    form: async () => {
      const { rows } = await query("SELECT id, data FROM logistics_items WHERE kind = 'incomings' AND deleted_at IS NULL ORDER BY id");
      const active = rows.filter((r) => !isHistoric(r.data || {}));
      if (!active.length) return [{ key: 'none', label: 'Nothing waiting to be collected', type: 'text', hint: 'every incoming has arrived, was cancelled, shipped or received' }];
      const sorted = active.sort((a, b) => incLoc(a.data).localeCompare(incLoc(b.data)) || incSup(a.data).localeCompare(incSup(b.data)));
      return sorted.map((r) => ({ key: `pick_${r.id}`, label: `${incLoc(r.data)} · ${incSup(r.data)} · #${text(r.data.stockNumber) || '—'} ${text(r.data.reference) || text(r.data.brand) || ''}`.trim(), type: 'bool' }));
    },
    prefill: async (item, ctx, q) => {
      const [inc, od] = await Promise.all([
        query("SELECT id, source_id, data FROM logistics_items WHERE kind = 'incomings' AND deleted_at IS NULL"),
        query("SELECT source_id, data FROM logistics_items WHERE kind = 'ownerDecisions' AND deleted_at IS NULL"),
      ]);
      const ids = new Set(text(q.ids).split(',').map((s) => s.trim()).filter(Boolean));
      const out = {};
      // From the execution queue: the app's odGroupItems — approved / in execution, same place → destination and collector.
      if (q.from !== undefined || q.to !== undefined) {
        const dec = new Map(od.rows.map((r) => [r.source_id || text(r.data?.id), r.data || {}]));
        for (const r of inc.rows) {
          const d = r.data || {};
          if (isHistoric(d)) continue;
          const o = d.ownerDecisionId ? dec.get(String(d.ownerDecisionId)) : null;
          if (!o || !['APPROVED', 'IN_EXECUTION'].includes(o.status)) continue;
          const to = text(o.destination) || incDest(d) || 'Destination not set';
          if (incLoc(d) === text(q.from) && to === text(q.to) && text(o.collector) === text(q.collector)) ids.add(String(r.id));
        }
      }
      for (const id of ids) out[`pick_${id}`] = true;
      return out;
    },
    run: async ({ db, input, user }) => {
      const picked = Object.entries(input)
        .filter(([k, v]) => /^pick_\d+$/.test(k) && bool(v))
        .map(([k]) => Number(k.slice(5)));
      if (!picked.length) throw bad('Tick at least one watch');
      const { rows } = await db.query("SELECT * FROM logistics_items WHERE kind = 'incomings' AND deleted_at IS NULL AND id = ANY($1) ORDER BY id FOR UPDATE", [picked]);
      const items = rows.filter((r) => !isHistoric(r.data || {}));
      if (!items.length) throw bad('None of those is still waiting');
      const froms = [...new Set(items.map((r) => incLoc(r.data)))];
      const sups = [...new Set(items.map((r) => incSup(r.data)))];
      const dests = [...new Set(items.map((r) => incDest(r.data)).filter(Boolean))];
      const dest = dests.length === 1 ? dests[0] : dests.length ? 'several destinations' : 'no destination set';
      const supplierClient = sups.length === 1 && sups[0] !== INC_NO_SUP ? await ensureClientByName(db, sups[0], froms[0], user) : null;
      const company = await companyClient(db, froms[0]);
      const n = items.length;
      const ship = await insertItem(
        db,
        'shipments',
        {
          stockNumber: items.map((r) => text(r.data.stockNumber)).filter(Boolean).join(', '),
          date: localToday(),
          fromClientId: supplierClient || '',
          toClientId: company || '',
          fromText: froms.join(', '),
          toText: dests.length === 1 ? dests[0] : '',
          items: items.map((r) => (text(r.data.reference) || text(r.data.brand)).trim()).filter(Boolean).join(', '),
          tracking: '',
          cost: '',
          deliveryDate: '',
          situation: `Collection of ${n} from ${froms.join(', ')}`,
          notes: '',
          status: 'pending',
          deliveredAt: null,
          deliveryNotes: '',
          deliveryPhotos: [],
          missingItems: [],
        },
        user
      );
      const stamp = Date.now();
      for (const r of items) await patchItem(db, r, { ...r.data, shipmentId: ship.data.id, shippedAt: stamp }, user);
      await logActivity(db, `🚚 Collection of ${n} incoming${n === 1 ? '' : 's'} from ${froms.join(', ')} → ${dest}`, user);
      return { message: `Collection of ${n} created — one live shipment from ${froms.join(', ')} to ${dest}`, open: `#/lg/${ship.id}`, created: [ship.id] };
    },
  },
  {
    key: 'inc-sold',
    label: 'Mark sold',
    kinds: ['incomings'],
    form: [
      { key: 'soldPrice', label: 'Sold for', type: 'money', currency: 'soldCurrency', required: true },
      { key: 'soldCurrency', label: 'Currency', type: 'currency' },
      { key: 'soldDate', label: 'Sale date', type: 'date' },
      { key: 'buyerClientId', label: 'Sold to (a client)', type: 'client', hint: 'our rule: the buyer is a client by id; the name is kept on the row as the app keeps it' },
      { key: 'soldToBuyer', label: 'Sold to (typed, if not a client)', type: 'text' },
      { key: 'soldFromLocation', label: 'Sold from', type: 'text' },
      { key: 'soldNotes', label: 'Notes', type: 'longtext' },
    ],
    prefill: async () => ({ soldCurrency: 'USD', soldDate: localToday() }),
    run: async ({ db, item, input, user, ctx }) => {
      const row = item.data;
      const price = amountOf(input.soldPrice, 'Sold for');
      if (price <= 0) throw bad('Sold price required');
      const currency = currencyOf(input.soldCurrency, 'USD');
      const soldDate = input.soldDate ? dayOf(input.soldDate, 'Sale date') : localToday();
      const buyerClientId = text(input.buyerClientId, 60);
      const buyer = buyerClientId ? ctx.client(buyerClientId) || text(input.soldToBuyer, 200) : text(input.soldToBuyer, 200);
      // Dollars at the converter's rates (the app: its fixed FX_TO_USD table).
      let usd = null;
      try {
        const r = await getRates();
        if (r.rates?.[currency]) usd = Math.round((price / r.rates[currency]) * 100) / 100;
      } catch {
        usd = null;
      }
      const snap = JSON.parse(JSON.stringify(row));
      if (snap.status === 'consignment') {
        snap.status = 'current';
        delete snap.consignment;
      }
      const ready = await insertItem(
        db,
        'readyForDelivery',
        {
          stockNumber: text(row.stockNumber),
          brand: text(row.brand),
          watchModel: text(row.watchModel || row.description || row.reference),
          watchReference: text(row.watchReference || row.reference),
          watchSerial: text(row.watchSerial || row.serial),
          watchDate: text(row.watchDate),
          originLocation: '📥 Incomings',
          originKey: 'incomings',
          originRow: snap,
          soldPrice: price,
          soldCurrency: currency,
          soldPriceUsd: usd ?? price,
          soldDate,
          soldToBuyer: buyer,
          ...(buyerClientId ? { soldToClientId: buyerClientId } : {}),
          soldFromLocation: text(input.soldFromLocation, 200),
          soldNotes: text(input.soldNotes, 2000),
          photos: [],
          shipmentId: null,
          status: 'pending_ship',
        },
        user
      );
      // The app takes the incoming off its list; here that is a deletion, which stands.
      await softDelete(db, item.id, user);
      const usdWords = usd === null ? '' : ` ≈ $${usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
      await logActivity(db, `💵 SOLD ${text(row.stockNumber) || text(row.watchModel || row.reference)} · ${currency} ${price.toLocaleString('en-US')}${usdWords} · from 📥 Incomings${buyer ? ` to ${buyer}` : ''} → 📦 Ready for Delivery`, user);
      return { message: `Sold · ${currency} ${price.toLocaleString('en-US')} → Ready for delivery${await oursNote(row.stockNumber)}. The app's WhatsApp sale confirmation is not sent from here.`, open: `#/lg/${ready.id}`, created: [ready.id] };
    },
  },
  {
    key: 'inc-cost',
    label: 'Add cost',
    kinds: ['incomings'],
    form: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'title', label: 'What for', type: 'text', required: true },
      { key: 'stockNumber', label: 'Stock numbers', type: 'stock', hint: 'this watch; add others comma separated' },
      { key: 'amount', label: 'Amount', type: 'money', currency: 'currency', required: true },
      { key: 'currency', label: 'Currency', type: 'currency' },
      { key: 'fromName', label: 'From', type: 'text' },
      { key: 'toName', label: 'To', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'longtext' },
    ],
    prefill: async (it) => ({ date: localToday(), stockNumber: text(it.data.stockNumber), currency: 'USD' }),
    run: async ({ db, item, input, user }) => {
      const line = costLine({ ...input, stockNumber: text(input.stockNumber) || text(item.data.stockNumber) });
      const row = await insertItem(db, 'logisticCosts', line, user);
      await logActivity(db, `💰 Added logistic cost: ${line.title} · ${line.currency} ${line.amount}`, user);
      return { message: `Cost added: ${line.currency} ${line.amount.toLocaleString('en-GB')}`, created: [row.id] };
    },
  },
  {
    key: 'inc-date',
    label: 'Edit date received',
    kinds: ['incomings'],
    form: [{ key: 'day', label: 'The day it was received', type: 'date', required: true, hint: 'the stock row of the same number moves with it, as in the app' }],
    prefill: async (it) => {
      const sn = text(it.data.stockNumber).toLowerCase();
      const { rows } = sn ? await query("SELECT data->>'receivedAt' AS at FROM logistics_items WHERE kind = ANY($1) AND deleted_at IS NULL AND lower(btrim(data->>'stockNumber')) = $2 ORDER BY id LIMIT 1", [['dubaiStock', 'londonStock', 'hkStock'], sn]) : { rows: [] };
      const cur = Number(rows[0]?.at) || Number(it.data.arrivedAt) || Date.now();
      return { day: new Date(cur).toISOString().slice(0, 10) };
    },
    run: async ({ db, item, input, user }) => {
      const day = dayOf(input.day, 'The day');
      const sn = text(item.data.stockNumber).toLowerCase();
      const { rows } = sn ? await db.query("SELECT * FROM logistics_items WHERE kind = ANY($1) AND deleted_at IS NULL AND lower(btrim(data->>'stockNumber')) = $2 ORDER BY id LIMIT 1 FOR UPDATE", [['dubaiStock', 'londonStock', 'hkStock'], sn]) : { rows: [] };
      const stockRow = rows[0] || null;
      // The clock time already recorded stays; only the day moves.
      const old = Number(stockRow?.data?.receivedAt) || Number(item.data.arrivedAt) || Date.now();
      const when = new Date(old);
      when.setUTCFullYear(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
      const ms = when.getTime();
      await patchItem(db, item, { ...item.data, arrivedAt: ms }, user);
      if (stockRow) await patchItem(db, stockRow, { ...stockRow.data, receivedAt: ms }, user);
      await logActivity(db, `📅 Receiving date for stock #${text(item.data.stockNumber) || '–'} set to ${fmtDay(ms)}`, user);
      return { message: `Receiving date set to ${fmtDay(ms)}${stockRow ? ' on the incoming and its stock row' : ''}` };
    },
  },
  {
    key: 'inc-vault',
    label: 'Show to Watch Vault on / off',
    kinds: ['incomings'],
    run: async ({ db, item, user }) => {
      const hidden = !item.data.hideFromVault;
      await patchItem(db, item, { ...item.data, hideFromVault: hidden }, user);
      const what = text(item.data.stockNumber) || text(item.data.watchModel) || text(item.data.reference) || 'watch';
      await logActivity(db, hidden ? `🚫 ${what} hidden from Watch Vault` : `🌐 ${what} shown in Watch Vault again`, user);
      return { message: hidden ? 'Hidden from the Watch Vault' : 'Showing in the Watch Vault' };
    },
  },
  {
    key: 'inc-cancel',
    label: 'Cancel incoming',
    kinds: ['incomings'],
    danger: true,
    run: async ({ db, item, user }) => {
      if (item.data.status === 'cancelled') throw bad('It is already cancelled');
      await patchItem(db, item, { ...item.data, status: 'cancelled' }, user);
      await logActivity(db, `Incoming ${incLabel(item.data)} → cancelled`, user);
      return { message: `Incoming ${incLabel(item.data)} cancelled` };
    },
  },
  {
    key: 'inc-delete',
    label: 'Delete incoming',
    kinds: ['incomings'],
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      await logActivity(db, 'Deleted incoming', user);
      return { message: `Incoming ${incLabel(item.data)} deleted`, open: '#/logistics/incoming' };
    },
  },
  {
    key: 'inc-fob-pick',
    label: 'Pick from Chrono Key',
    kinds: null,
    page: 'incoming',
    /* The app reads FOB's list and holds what it does not have yet in the "Picked from FOB" box. Here: OUR watches with status incoming. */
    form: async () => {
      const [{ rows: ours }, { rows: held }] = await Promise.all([
        query("SELECT id, stock_no, brand, model, reference FROM watches WHERE status = 'incoming' AND deleted_at IS NULL ORDER BY stock_no"),
        query("SELECT lower(btrim(data->>'stockNumber')) AS sn FROM logistics_items WHERE deleted_at IS NULL AND kind = ANY($1)", [['incomings', 'londonStock', 'dubaiStock', 'hkStock', 'soldStocks', 'readyForDelivery', 'fobPicked']]),
      ]);
      const have = new Set(held.map((r) => r.sn).filter(Boolean));
      const options = ours.filter((w) => !have.has(String(w.stock_no).trim().toLowerCase())).map((w) => ({ value: String(w.id), label: `#${w.stock_no} · ${[w.brand, w.model, w.reference].filter(Boolean).join(' ')}` }));
      return [
        { key: 'watchId', label: 'Our incoming watch', type: 'choice', options: options.length ? options : [{ value: '', label: 'Nothing new — every incoming watch of ours is already in the app' }], required: true, hint: `${ours.length - options.length} of our ${ours.length} incoming watches already held` },
        { key: 'supplier', label: 'Who is sending it', type: 'text', hint: 'blank: the client we bought it from' },
        { key: 'location', label: 'Where it is', type: 'text', hint: 'blank: Chrono Key’s category (Dubai, UK …)' },
        { key: 'destination', label: 'Destination', type: 'text' },
        { key: 'eta', label: 'ETA', type: 'date' },
        { key: 'buyPrice', label: 'Cost price', type: 'money', currency: 'buyCurrency', hint: 'blank: the purchase price' },
        { key: 'buyCurrency', label: 'Currency', type: 'currency' },
        { key: 'send', label: 'Straight into Incomings', type: 'bool', hint: 'no: held in the picked box, as the app holds them, until sent' },
      ];
    },
    prefill: async () => ({ send: false }),
    run: async ({ db, input, user }) => {
      const id = Number(input.watchId) || 0;
      const { rows } = await db.query(
        `SELECT w.id, w.stock_no, w.brand, w.model, w.reference, w.serial, w.status, w.location, w.purchase_price, w.purchase_currency,
                (SELECT c.id FROM clients c WHERE c.id = w.purchased_from_client_id AND c.deleted_at IS NULL) AS from_id
           FROM watches w WHERE w.id = $1 AND w.deleted_at IS NULL`,
        [id]
      );
      const w = rows[0];
      if (!w) throw bad('Pick one of our watches');
      if (w.status !== 'incoming') throw bad(`Our watch #${w.stock_no} is ${w.status}, not incoming`);
      const sn = String(w.stock_no).trim().toLowerCase();
      const { rows: held } = await db.query("SELECT kind FROM logistics_items WHERE deleted_at IS NULL AND kind = ANY($1) AND lower(btrim(data->>'stockNumber')) = $2 LIMIT 1", [['incomings', 'londonStock', 'dubaiStock', 'hkStock', 'soldStocks', 'readyForDelivery', 'fobPicked'], sn]);
      if (held[0]) throw bad(`#${w.stock_no} is already in the app (${held[0].kind})`);
      let supplier = text(input.supplier, 200);
      if (!supplier && w.from_id) {
        const { rows: c } = await db.query('SELECT forename, surname, nickname, company FROM clients WHERE id = $1', [w.from_id]);
        supplier = c[0] ? clientName(c[0]) : '';
      }
      const buyPrice = input.buyPrice !== undefined && String(input.buyPrice).trim() !== '' ? String(amountOf(input.buyPrice, 'Cost price')) : w.purchase_price !== null && w.purchase_price !== undefined ? String(Number(w.purchase_price)) : '';
      const buyCurrency = text(input.buyCurrency, 4).toUpperCase() || (w.purchase_currency ? String(w.purchase_currency).toUpperCase() : 'USD');
      const picked = {
        ts: Date.now(),
        stockNumber: String(w.stock_no),
        reference: text(w.reference),
        brand: text(w.brand),
        watchModel: text(w.model),
        serial: text(w.serial),
        supplier,
        location: text(input.location, 100) || text(w.location),
        destination: text(input.destination, 100),
        eta: input.eta ? dayOf(input.eta, 'ETA', { blank: '' }) : '',
        status: 'in_transit',
        buyPrice,
        buyCurrency,
        notes: '',
        fobStatus: text(w.status),
      };
      const row = await insertItem(db, 'fobPicked', picked, user);
      await logActivity(db, '📥 Picked 1 watch from FOB', user);
      if (!bool(input.send)) return { message: `#${w.stock_no} picked — in the box until sent to Incomings`, open: `#/lg/${row.id}`, created: [row.id] };
      const inc = await sendPicked(db, row, user);
      return { message: `#${w.stock_no} picked and added to Incomings`, open: `#/lg/${inc.id}`, created: [row.id, inc.id] };
    },
  },
  {
    key: 'inc-fob-send',
    label: 'Send to Incomings',
    kinds: ['fobPicked'],
    run: async ({ db, item, user }) => {
      const inc = await sendPicked(db, item, user);
      return { message: `#${text(item.data.stockNumber)} added to Incomings`, open: `#/lg/${inc.id}`, created: [inc.id] };
    },
  },
  {
    key: 'inc-fob-drop',
    label: 'Remove from the picked box',
    kinds: ['fobPicked'],
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      return { message: 'Removed from the picked box — it is not deleted from Chrono Key', open: '#/logistics/incoming' };
    },
  },
];

/* The app's fobPickedSend for one row: the incoming it makes, fromFob, and the picked row gone. */
async function sendPicked(db, row, user) {
  const r = row.data;
  const inc = await insertItem(
    db,
    'incomings',
    {
      stockNumber: text(r.stockNumber),
      reference: text(r.reference),
      brand: text(r.brand),
      watchModel: text(r.watchModel),
      serial: text(r.serial),
      supplier: text(r.supplier),
      location: text(r.location),
      destination: text(r.destination),
      eta: text(r.eta),
      status: text(r.status) || 'in_transit',
      buyPrice: r.buyPrice ? parseFloat(r.buyPrice) : null,
      buyCurrency: text(r.buyCurrency) || 'USD',
      notes: text(r.notes),
      photos: [],
      shipmentId: null,
      fromFob: true,
    },
    user
  );
  if (text(r.supplier)) await ensureClientByName(db, r.supplier, r.location || '', user);
  await softDelete(db, row.id, user);
  await logActivity(db, '📥 Added 1 FOB pick to Incomings', user);
  return inc;
}
