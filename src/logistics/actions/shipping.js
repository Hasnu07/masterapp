/*
 * Live Shipments — the logistics app's workflows, done here (asked 27 Oct
 * 2026: "all the features in the logistic side in the erp system to do
 * entries"). Each action is the app's own function, read from its
 * index.html and ported record for record:
 *
 *   ship-add      "+ New Shipment" (openShipmentModal / saveShipment): the
 *                 shipment, its cost line in logisticCosts (shipmentId), the
 *                 HK Situation row when it heads to Hong Kong
 *                 (routeShipmentToHkSituation), and the customs mirror under
 *                 the 3rd party mover (syncShipmentToThirdPartyForCustoms);
 *                 opened from a Ready-for-delivery row (?ready=<item id>) it
 *                 links the two, as the app's openShipmentFromReady does
 *   ship-edit     "✏️ Edit shipment" / "💰 Add cost" — the same form
 *   ship-shipped, ship-pending, ship-cancel   setShipStatus
 *   ship-deliver  "✓ Mark delivered" (openDeliverModal / confirmDeliver): the
 *                 cost line, the missing accessories as a transaction, the
 *                 sale finalized when the shipment came from Ready-for-delivery
 *   ship-delete   deleteShipment, with its customs mirror
 *   route-prices, route-advice   the Route Optimizer's "Fetch Market Prices"
 *                 and "Get AI Recommendation" — the app's prompts verbatim,
 *                 asked with masterapp's own key (ai: true)
 *
 * Our rule: a stock number is OUR watch (named in the message when it is
 * not); from / to are the logistics clients by id, never matched by name;
 * nothing is written back to the app. Tracking with the carrier stays
 * read-only on the Shipments tab. Documents go on through
 * POST /api/logistics/items/:id/files?field=shippingDocuments (the console
 * draws the control on the card).
 */
import { query } from '../../db/index.js';
import { parseMoney } from '../../watches/fields.js';
import { insertItem, patchItem, softDelete, logActivity, listKind, loadItem, text, dayOf, amountOf, currencyOf, bad, localToday } from '../write.js';
import { CLIENT_ID, oursByNumber } from '../shared.js';
import { ask } from '../ai.js';
import * as routePage from '../pages/routeoptimizer.js';
import { finalizeReadyAsSold } from './sales.js';

/* ── the app's helpers, as written ───────────────────────────────── */

/** The app's splitStockList: on commas, semicolons and line breaks. */
export const splitStockList = (s) =>
  String(s || '')
    .split(/[,\n;]+/)
    .map((x) => x.trim())
    .filter(Boolean);
/** The app's isCompanyClient: a company location, or a client just called "Company". */
export const isCompany = (c) => Boolean(c && (c.isCompany === true || String(c.name || '').trim().toLowerCase() === 'company'));
/** The app's shipClientLabel — what its From / To box shows for a client. */
export const shipClientLabel = (c) => (isCompany(c) ? `🏢 ${c.country || ''}` : `${c.name || ''} (${c.country || ''})`);
/** saveShipment's fromName / toName: the client, a company as its country, else the typed place. */
export const sideName = (c, typed, blank = '?') => (c ? (isCompany(c) ? `🏢 ${c.country || ''}` : c.name || '') : typed || blank);
/** The app's parseCostString — "AED 250" / "$1,200" back into an amount and a currency. */
export function parseCostString(s) {
  if (!s) return {};
  const m = String(s)
    .trim()
    .match(/^\s*([A-Za-z€$£¥]+)?\s*([\d,.]+)\s*$/);
  if (!m) return {};
  const raw = (m[1] || '').toUpperCase();
  const map = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY' };
  return { currency: map[raw] || raw || '', amount: m[2].replace(/,/g, '') };
}
const num = (v, fallback = 0) => {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  const n = typeof v === 'number' ? v : parseMoney(v);
  return Number.isFinite(n) ? n : fallback;
};
const asBool = (v) => v === true || /^(true|yes|1|on)$/i.test(String(v ?? ''));
const HK_WORDS = /\b(hk|hong\s*kong|kowloon|causeway\s*bay|wan\s*chai|tsim\s*sha\s*tsui)\b/;
export const SHIP_STATUSES = ['pending', 'in_transit', 'delivered', 'cancelled'];
const CURRENCIES = ['USD', 'AED', 'EUR', 'GBP', 'HKD', 'CHF', 'JPY', 'CNY'];

/** The logistics clients by the id the console's client fields use (the app's id for its copies). */
export async function clientsOf(db) {
  const { rows } = await db.query(`SELECT ${CLIENT_ID} AS id, data FROM logistics_items WHERE kind = 'clients' AND deleted_at IS NULL ORDER BY lower(data->>'name')`);
  return new Map(rows.map((r) => [String(r.id), { ...(r.data || {}), id: String(r.id), name: text(r.data?.name), country: text(r.data?.country) }]));
}
/** The 3rd party movers (our rows), by the app's id. */
export async function moversOf(db) {
  const rows = await listKind(db, 'thirdPartyMovers');
  return new Map(rows.map((r) => [text(r.data?.id), r]));
}
/** One record of a kind by the app's own id (the id inside the document), or null. */
export async function byAppId(db, kind, id) {
  if (!text(id)) return null;
  const rows = await listKind(db, kind, "data->>'id' = $2", [text(id)]);
  return rows[0] || null;
}
/** The From / To choices: company locations first (by country), then every client by name — the app's datalist order. */
export function clientChoices(clients) {
  const all = [...clients.values()];
  const companies = all.filter(isCompany).sort((a, b) => (a.country || '').localeCompare(b.country || ''));
  const others = all.filter((c) => !isCompany(c)).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return [{ value: '', label: '— a typed place (below) —' }, ...[...companies, ...others].map((c) => ({ value: c.id, label: shipClientLabel(c) }))];
}
/** Which of the stock numbers are not one of our watches — said in the message, never refused. */
export async function notOurs(stockNumber) {
  const nos = splitStockList(stockNumber);
  if (!nos.length) return '';
  const ours = await oursByNumber(nos);
  const missing = nos.filter((n) => !ours.has(n));
  return missing.length ? ` · ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not one of our watches` : '';
}

/* ── the form (the app's shipment modal) ─────────────────────────── */

async function shipForm(db = { query }) {
  const clients = await clientsOf(db);
  const movers = await moversOf(db);
  const moverOptions = [...movers.values()].map((m) => ({ value: text(m.data.id), label: `${text(m.data.name)}${m.data.country ? ` (${text(m.data.country)})` : ''}` }));
  return [
    { key: 'stockNumber', label: 'Stock numbers', type: 'stock', hint: 'comma separated — each is our watch when we hold it' },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'fromClientId', label: 'From (client)', type: 'choice', options: clientChoices(clients) },
    { key: 'fromText', label: 'From (typed place)', type: 'text' },
    { key: 'toClientId', label: 'To (client)', type: 'choice', options: clientChoices(clients) },
    { key: 'toText', label: 'To (typed place)', type: 'text' },
    { key: 'items', label: 'Shipping items', type: 'longtext', required: true },
    { key: 'tracking', label: 'Tracking number', type: 'text' },
    { key: 'costAmount', label: 'Cost', type: 'money', currency: 'costCurrency' },
    { key: 'costCurrency', label: 'Cost currency', type: 'currency' },
    { key: 'deliveryDate', label: 'Expected delivery', type: 'date' },
    { key: 'situation', label: 'Situation / note', type: 'text' },
    { key: 'status', label: 'Status', type: 'enum', options: SHIP_STATUSES },
    { key: 'hasWatch', label: 'Carries a watch', type: 'bool' },
    { key: 'hkHolder', label: 'HK holder', type: 'text', hint: 'who receives it in Hong Kong' },
    { key: 'viaThirdParty', label: 'Through a 3rd party mover (customs)', type: 'bool' },
    { key: 'thirdPartyMoverId', label: 'Mover', type: 'choice', options: [{ value: '', label: moverOptions.length ? '— pick a mover —' : '— No movers — add one in 3rd Party Movers —' }, ...moverOptions] },
    { key: 'thirdPartyPaymentStatus', label: 'Mover payment', type: 'enum', options: ['pending', 'paid', 'not_applicable'] },
    { key: 'watchBrand', label: 'Watch brand (customs)', type: 'text' },
    { key: 'watchReference', label: 'Watch reference (customs)', type: 'text' },
    { key: 'valueUsd', label: 'Value of the watch (USD)', type: 'money' },
    { key: 'customsRatePct', label: 'Customs rate %', type: 'number' },
    { key: 'aedPerUsd', label: 'AED per USD', type: 'number' },
  ];
}

/**
 * The shipment's fields from the form, as saveShipment reads its modal.
 * `was` is the record being edited (its documents and the rest are kept).
 */
export function shipData(input, { clients, movers, was = {} }) {
  const fromClientId = text(input.fromClientId, 80);
  const toClientId = text(input.toClientId, 80);
  if (fromClientId && !clients.has(fromClientId)) throw bad('From: no logistics client with that id');
  if (toClientId && !clients.has(toClientId)) throw bad('To: no logistics client with that id');
  const costCurrency = currencyOf(input.costCurrency, 'AED', 'Cost currency');
  const costAmountRaw = text(input.costAmount, 30);
  const costAmount = amountOf(costAmountRaw, 'Cost');
  const viaThirdParty = asBool(input.viaThirdParty);
  const thirdPartyMoverId = viaThirdParty ? text(input.thirdPartyMoverId, 80) : '';
  const mover = thirdPartyMoverId ? movers.get(thirdPartyMoverId) : null;
  if (thirdPartyMoverId && !mover) throw bad('Mover: no 3rd party mover with that id');
  const valueUsd = viaThirdParty ? amountOf(input.valueUsd, 'Value of the watch') : 0;
  const customsRatePct = num(input.customsRatePct, 0.3) || 0.3;
  const aedPerUsd = num(input.aedPerUsd, 3.67) || 3.67;
  const customsUsd = valueUsd * (customsRatePct / 100);
  const customsAed = customsUsd * aedPerUsd;
  const status = text(input.status, 20) || 'pending';
  if (!SHIP_STATUSES.includes(status)) throw bad(`Status: "${status}" is not one of ${SHIP_STATUSES.join(', ')}`);
  const payment = text(input.thirdPartyPaymentStatus, 20) || 'pending';
  if (!['pending', 'paid', 'not_applicable'].includes(payment)) throw bad('Mover payment: pending, paid or not_applicable');
  const data = {
    stockNumber: text(input.stockNumber, 500),
    date: dayOf(input.date, 'Date'),
    // The app's resolveShipClient: a client chosen → its id and no text; else the typed place.
    fromClientId: fromClientId || '',
    fromText: fromClientId ? '' : text(input.fromText, 200),
    toClientId: toClientId || '',
    toText: toClientId ? '' : text(input.toText, 200),
    items: text(input.items, 2000),
    tracking: text(input.tracking, 100),
    cost: costAmount > 0 ? `${costCurrency} ${costAmountRaw}` : '',
    costCurrency,
    costAmount,
    deliveryDate: dayOf(input.deliveryDate, 'Expected delivery', { blank: '' }),
    situation: text(input.situation, 500),
    status,
    hasWatch: input.hasWatch === undefined ? true : asBool(input.hasWatch),
    hkHolder: text(input.hkHolder, 200),
    viaThirdParty,
    thirdPartyMoverId,
    thirdPartyMoverName: mover ? text(mover.data.name) : '',
    thirdPartyPaymentStatus: viaThirdParty ? payment : '',
    thirdPartyDocuments: viaThirdParty ? (Array.isArray(was.thirdPartyDocuments) ? was.thirdPartyDocuments : []) : [],
    shippingDocuments: Array.isArray(was.shippingDocuments) ? was.shippingDocuments : [],
    watchBrand: text(input.watchBrand, 100),
    watchReference: text(input.watchReference, 100),
    valueUsd,
    customsRatePct,
    aedPerUsd,
    customsUsd,
    customsAed,
  };
  if (!(data.fromClientId || data.fromText) || !(data.toClientId || data.toText)) throw bad('From & To required');
  if (!data.items) throw bad('Shipping items required');
  return { data, costAmountRaw };
}

/* ── what saveShipment does around the record ────────────────────── */

/** The cost line in logisticCosts that stands for the shipment, kept in step (saveShipment's "💰" block). */
export async function syncShipmentCost(db, ship, { clients, user, costAmountRaw }) {
  const s = ship.data;
  const lines = await listKind(db, 'logisticCosts', "data->>'shipmentId' = $2", [text(s.id)]);
  if (s.costAmount > 0) {
    const fromName = sideName(clients.get(text(s.fromClientId)), s.fromText);
    const toName = sideName(clients.get(text(s.toClientId)), s.toText);
    const stockLabel = splitStockList(s.stockNumber).join(', ');
    const lc = lines[0];
    if (lc) {
      await patchItem(
        db,
        lc,
        {
          ...lc.data,
          title: lc.data.title || `${fromName} → ${toName} shipment Cost`,
          stockNumber: stockLabel,
          fromName,
          toName,
          fromClientId: s.fromClientId,
          toClientId: s.toClientId,
          date: s.date || lc.data.date,
          currency: s.costCurrency,
          amount: s.costAmount,
        },
        user
      );
    } else {
      await insertItem(
        db,
        'logisticCosts',
        {
          title: `${fromName} → ${toName} shipment Cost`,
          shipmentId: s.id,
          stockNumber: stockLabel,
          fromClientId: s.fromClientId,
          toClientId: s.toClientId,
          fromName,
          toName,
          date: s.date || localToday(),
          currency: s.costCurrency,
          amount: s.costAmount,
          notes: '',
        },
        user
      );
    }
    await logActivity(db, `💰 Shipment cost: ${s.costCurrency} ${costAmountRaw ?? s.costAmount} · ${fromName} → ${toName}`, user);
    return true;
  }
  // The cost cleared: the auto-synced line goes, unless somebody wrote notes on it.
  for (const lc of lines) if (!text(lc.data.notes)) await softDelete(db, lc.id, user);
  return false;
}

/** The app's shipmentIsHeadingToHK. */
export function headingToHK(s, clients) {
  if (!s) return false;
  const toC = clients.get(text(s.toClientId));
  if (toC) {
    const country = text(toC.country).toLowerCase();
    if (country === 'hk' || country === 'hong kong' || country.includes('hong kong')) return true;
    if (HK_WORDS.test(text(toC.name).toLowerCase())) return true;
  }
  return HK_WORDS.test(text(s.toText).toLowerCase());
}

/** The app's routeShipmentToHkSituation: a row in HK Situation's Incomings for a shipment heading to Hong Kong, kept in step. */
export async function routeToHk(db, ship, { clients, user }) {
  const s = ship.data;
  const linked = await listKind(db, 'hkSituation', "data->>'linkedShipmentId' = $2", [text(s.id)]);
  const existing = linked[0] || null;
  if (!headingToHK(s, clients)) {
    // No longer heading to HK: the auto-row goes, unless movements were started on it.
    if (existing && !(Array.isArray(existing.data.movements) && existing.data.movements.length)) await softDelete(db, existing.id, user);
    return null;
  }
  const stocks = splitStockList(s.stockNumber);
  const stockLabel = stocks.length ? stocks.join(', ') : text(s.stockNumber);
  // The app enriches the description from the matching London / Dubai / incoming row.
  const rows = stocks.length
    ? (await db.query("SELECT kind, data FROM logistics_items WHERE deleted_at IS NULL AND kind IN ('londonStock', 'dubaiStock', 'incomings') AND stock_nos && $1::text[] ORDER BY CASE kind WHEN 'londonStock' THEN 1 WHEN 'dubaiStock' THEN 2 ELSE 3 END, id", [stocks])).rows
    : [];
  const matchOf = (sn) => rows.find((r) => text(r.data?.stockNumber) === sn)?.data || null;
  const enriched = [];
  for (const sn of stocks) {
    const m = matchOf(sn);
    if (m) enriched.push(`${sn} · ${[m.brand, m.watchModel || m.reference, m.watchReference || '', m.watchSerial ? `SN ${m.watchSerial}` : ''].filter(Boolean).join(' · ')}`);
  }
  const descParts = [];
  if (enriched.length) descParts.push(enriched.join('\n'));
  else if (s.items) descParts.push(s.items);
  if (s.tracking) descParts.push(`TR: ${s.tracking}`);
  if (s.cost) descParts.push(s.cost);
  const desc = descParts.join(' · ');
  const brand = stocks.map((sn) => matchOf(sn)?.brand || '').filter(Boolean)[0] || '';
  const fromC = clients.get(text(s.fromClientId));
  const noteParts = [];
  if (fromC) noteParts.push(`From ${isCompany(fromC) ? `🏢 ${fromC.country}` : fromC.name}`);
  else if (s.fromText) noteParts.push(`From ${s.fromText}`);
  if (s.situation) noteParts.push(s.situation);
  if (s.deliveryDate) noteParts.push(`ETA ${s.deliveryDate}`);
  const noteStr = noteParts.join(' · ');
  if (existing) {
    const e = existing.data;
    await patchItem(
      db,
      existing,
      {
        ...e,
        stockNumber: stockLabel || e.stockNumber,
        description: e.userEdited ? e.description : desc,
        brand: brand && !e.brand ? brand : e.brand,
        holder: s.hkHolder && !e.holder ? s.hkHolder : e.holder,
        notes: noteStr,
      },
      user
    );
    await logActivity(db, `🌐 Updated HK Incoming auto-row for shipment "${text(s.items).slice(0, 40)}"`, user);
    return existing;
  }
  const row = await insertItem(
    db,
    'hkSituation',
    { stockNumber: stockLabel, brand, description: desc, section: 'incoming', holder: s.hkHolder || '', stockStatus: '', notes: noteStr, movements: [], linkedShipmentId: s.id },
    user
  );
  await logActivity(db, `🌐 Auto-filed in HK Situation Incomings: ${stockLabel || text(s.items).slice(0, 40)}${s.hkHolder ? ` · holder: ${s.hkHolder}` : ''}`, user);
  return row;
}

/** The app's syncShipmentToThirdPartyForCustoms: the shipment's mirror under its 3rd party mover, for the customs sheet. */
export async function syncShipmentToTpm(db, ship, { clients, movers, user }) {
  const s = ship.data;
  const mirrors = await listKind(db, 'thirdPartyShipments', "data->>'liveShipmentId' = $2", [text(s.id)]);
  const existing = mirrors[0] || null;
  if (!s.viaThirdParty || !s.thirdPartyMoverId) {
    // The flag cleared: the mirror goes only when this shipment made it.
    if (existing && existing.data.originLive) {
      await softDelete(db, existing.id, user);
      await logActivity(db, `🚛 Removed customs mirror for shipment ${text(s.items).slice(0, 30)} (3rd-party flag cleared)`, user);
    }
    return null;
  }
  const mover = movers.get(text(s.thirdPartyMoverId));
  const fromC = clients.get(text(s.fromClientId));
  const toC = clients.get(text(s.toClientId));
  const fromName = fromC ? (isCompany(fromC) ? `🏢 ${fromC.country || fromC.name}` : fromC.name) : s.fromText || '?';
  const toName = toC ? (isCompany(toC) ? `🏢 ${toC.country || toC.name}` : toC.name) : s.toText || '?';
  const fromCountry = (fromC && fromC.country) || s.fromText || '';
  const toCountry = (toC && toC.country) || s.toText || '';
  const nDocs = (s.thirdPartyDocuments || []).length;
  const mirror = {
    moverId: s.thirdPartyMoverId,
    moverName: mover ? text(mover.data.name) : s.thirdPartyMoverName || '',
    isOurStock: true,
    stockNumber: s.stockNumber || '',
    description: '',
    fromClientId: s.fromClientId || '',
    fromClientName: fromName,
    fromCountry,
    toCountry,
    items: s.items || '',
    currency: 'AED',
    amount: Number(s.customsAed) || 0,
    paymentStatus: s.thirdPartyPaymentStatus === 'paid' ? 'paid' : s.thirdPartyPaymentStatus === 'not_applicable' ? 'not_applicable' : 'pending',
    status: s.status === 'delivered' ? 'delivered' : s.status === 'cancelled' ? 'cancelled' : s.status === 'in_transit' ? 'in_transit' : 'pending',
    trackingNumber: s.tracking || '',
    shipmentDate: s.date || '',
    deliveryDate: s.deliveryDate || '',
    notes: `🚛 Auto-synced from Live Shipment customs sheet. Value ${s.valueUsd ? `USD ${Number(s.valueUsd).toLocaleString('en-US')}` : '–'}, customs ${s.customsRatePct || 0}% = $${Number(s.customsUsd || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })} (≈ AED ${Number(s.customsAed || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}).`,
    photos: existing ? existing.data.photos || [] : [],
    // The customs panel's documents travel with the mirror; the mover's own paperwork is kept.
    shippingDocuments: [...(s.thirdPartyDocuments || []).map((d) => (typeof d === 'object' && d ? { ...d, fromLive: true } : d)), ...((existing && existing.data.shippingDocuments) || []).filter((d) => d && !(typeof d === 'object' && d.fromLive))],
    liveShipmentId: s.id,
    originLive: true,
    watchBrand: s.watchBrand || '',
    watchReference: s.watchReference || '',
    valueUsd: Number(s.valueUsd) || 0,
    customsRatePct: Number(s.customsRatePct) || 0.3,
    aedPerUsd: Number(s.aedPerUsd) || 3.67,
    customsUsd: Number(s.customsUsd) || 0,
    customsAed: Number(s.customsAed) || 0,
  };
  if (existing) {
    await patchItem(db, existing, { ...existing.data, ...mirror, id: existing.data.id, ts: existing.data.ts }, user);
    await logActivity(db, `🚛 Updated customs entry for shipment ${text(s.items).slice(0, 30)} via ${mover ? text(mover.data.name) : ''}${nDocs ? ` · ${nDocs} document${nDocs === 1 ? '' : 's'}` : ''}`, user);
    return existing;
  }
  const row = await insertItem(db, 'thirdPartyShipments', mirror, user);
  await logActivity(db, `🚛 Added customs entry for shipment ${text(s.items).slice(0, 30)} via ${mover ? text(mover.data.name) : ''}`, user);
  return row;
}

/** Everything saveShipment does after the record itself: the cost line, HK, the customs mirror. */
async function afterSave(db, ship, ctx) {
  await syncShipmentCost(db, ship, ctx);
  await routeToHk(db, ship, ctx);
  await syncShipmentToTpm(db, ship, ctx);
}

/* "Box (Rolex), Papers (Rolex)" → [{ brand, accessory }], as the deliver grid's ticks. */
export function parseAccessoryList(s) {
  return splitStockList(s).map((part) => {
    const m = part.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    return m ? { brand: m[2].trim(), accessory: m[1].trim() } : { brand: '', accessory: part };
  });
}

const statusAction = (key, label, status, extra = {}) => ({
  key,
  label,
  kinds: ['shipments'],
  ...extra,
  // The app's setShipStatus for anything but delivered.
  run: async ({ db, item, user }) => {
    const clients = await clientsOf(db);
    const movers = await moversOf(db);
    await patchItem(db, item, { ...item.data, status, deliveredAt: null }, user);
    if (item.data.viaThirdParty || item.data.thirdPartyMoverId) await syncShipmentToTpm(db, item, { clients, movers, user });
    await logActivity(db, `Shipment ${text(item.data.items).slice(0, 30)} → ${status}`, user);
    return { message: `Shipment marked ${status.replace('_', ' ')}` };
  },
});

/* ── the Route Optimizer's AI (the app's fetchRouteMarketPrices / runRouteOptimizerAI) ── */

const usdWords = (n) => `$${Math.round(n).toLocaleString('en-US')}`;

/** The market-prices prompt, verbatim; `watches` as the page's available rows. */
export function marketPricesPrompt(watches) {
  const watchList = watches.map((r) => `${r.stock_no}: ${r.brand || '?'} ${r.model || ''} (Ref: ${r.reference || 'unknown'})`).join('\n');
  return `You are a luxury watch market pricing expert. For each watch below, provide the current (2025) secondary market price in USD based on your knowledge of Chrono24, WatchBox, Bob's Watches, and dealer prices.

Return ONLY a JSON array, no explanation, no markdown:
[
  { "stockNumber": "...", "marketPriceUsd": 12000, "confidence": "high|medium|low", "note": "brief source note" },
  ...
]

Watches:
${watchList}`;
}

/** The answer into what the app's card shows: market $ and, against the cost price, the profit per watch. */
export function parseMarketPrices(answer, watches) {
  let list = answer;
  if (typeof answer === 'string') {
    const raw = answer.trim().replace(/^```[a-z]*\n?/i, '').replace(/```$/, '').trim();
    const m = raw.match(/\[[\s\S]*\]/);
    try {
      list = JSON.parse(m ? m[0] : raw);
    } catch {
      throw Object.assign(new Error('The AI answered with something that is not a price list'), { status: 502 });
    }
  }
  if (!Array.isArray(list)) throw Object.assign(new Error('The AI answered with something that is not a price list'), { status: 502 });
  return list
    .filter((p) => p && typeof p === 'object')
    .map((p) => {
      const stockNumber = text(p.stockNumber, 40);
      const w = watches.find((x) => String(x.stock_no) === stockNumber) || null;
      const usd = Number(p.marketPriceUsd);
      const marketPriceUsd = Number.isFinite(usd) && usd >= 0 ? Math.round(usd) : null;
      const buyUsd = w?.buy_usd ?? null;
      const profit = buyUsd && marketPriceUsd ? Math.round(marketPriceUsd - buyUsd) : null;
      return {
        stockNumber,
        label: w ? `${w.brand || ''} ${w.model || w.reference || ''}`.trim() : stockNumber,
        marketPriceUsd,
        confidence: ['high', 'medium', 'low'].includes(String(p.confidence)) ? String(p.confidence) : 'medium',
        note: text(p.note, 300),
        buyUsd: buyUsd != null ? Math.round(buyUsd) : null,
        profit,
        item_id: w?.id ?? null,
      };
    });
}

/** The app's _routeHistSummaryText, over the page's moves on the route. */
export function routeHistoryText(moves, fromLoc, toLoc) {
  const all = moves.length;
  if (!all) return `No previous moves recorded in this app for ${fromLoc} → ${toLoc}.`;
  const lines = [`Historical moves (${fromLoc} → ${toLoc}) — ${all} recorded:`];
  const byMethod = new Map();
  for (const m of moves) {
    const k = m.kind === 'trip' ? `Personal carry (${m.person || 'person'})` : m.kind === 'shipment' ? m.method || 'Courier' : m.kind === 'mover' ? m.method || '3rd Party' : m.method || 'Other';
    const v = byMethod.get(k) || { count: 0, total: 0 };
    v.count += 1;
    v.total += m.usd || 0;
    byMethod.set(k, v);
  }
  for (const [k, v] of byMethod) lines.push(`  • ${k}: ${v.count} time${v.count > 1 ? 's' : ''}, avg $${Math.round(v.total / v.count).toLocaleString('en-US')} USD`);
  return lines.join('\n');
}

/** The route recommendation prompt, verbatim. */
export function routePrompt({ fromLabel, toLabel, watches, histText, movers, prices = {}, today }) {
  const stocksText = watches
    .map((r) => {
      const buyUsd = r.buy_usd || null;
      const mkt = prices[String(r.stock_no)];
      const profit = buyUsd && mkt?.usd ? mkt.usd - buyUsd : null;
      return (
        `  • Stock #${r.stock_no}: ${r.brand || '?'} ${r.model || r.reference || ''} (Ref ${r.reference || 'n/a'})` +
        (buyUsd ? ` — cost price ${usdWords(buyUsd)} USD` : ' — no cost price recorded') +
        (mkt?.usd ? ` — market value ${usdWords(mkt.usd)} USD (${mkt.confidence || 'est'})` : '') +
        (profit !== null ? ` — potential profit ${usdWords(profit)} USD` : '') +
        (r.log_usd > 0 ? ` — existing logistics cost ${usdWords(r.log_usd)} USD` : '')
      );
    })
    .join('\n');
  const totalBuyUsd = watches.reduce((t, r) => t + (r.buy_usd || 0), 0);
  const totalMktUsd = watches.reduce((t, r) => t + (prices[String(r.stock_no)]?.usd || 0), 0);
  const moversOnFile = movers.map((m) => `${m.name} (${m.country || '?'})`).join(', ') || 'Ferrari, RK, FORAK (standard)';
  const n = watches.length;
  return `You are a luxury watch logistics expert advising Purosangue Watches, a high-end watch trading business (Dubai, London, Hong Kong, Switzerland).

Date: ${today}
Route: ${fromLabel} → ${toLabel}
Watches: ${n} watch${n > 1 ? 'es' : ''}${totalBuyUsd > 0 ? ` | total cost price ~${usdWords(totalBuyUsd)} USD` : ''}${totalMktUsd > 0 ? ` | total market value ~${usdWords(totalMktUsd)} USD` : ''}${totalMktUsd > 0 && totalBuyUsd > 0 ? ` | potential profit ~${usdWords(totalMktUsd - totalBuyUsd)} USD` : ''}

WATCHES BEING MOVED:
${stocksText}

OUR HISTORICAL DATA FOR THIS ROUTE:
${histText}

OUR 3RD PARTY MOVERS ON FILE: ${moversOnFile}

Please provide a detailed logistics recommendation covering these options (skip any not applicable to the route):

## ✈️ Option A — Personal Carry (Person Trip)
Cover: best airlines for this city pair, typical economy/business fare range, airline cargo allowance for high-value items, risk of customs declaration, total estimated cost, pros/cons.

## 🚚 Option B — Ferrari Logistics
Cover: suitability for this route, our historical avg cost if available, door-to-door service, typical turnaround, insurance, customs handling, estimated total cost.

## 📦 Option C — RK (or FORAK)
Same structure as above.

## 📬 Option D — Express Courier (FedEx/DHL)
Cover: best service tier for watches (FedEx Priority / DHL Express), insurance limit per shipment, packaging requirements for luxury watches, estimated cost per watch and total, transit time.

## ✅ Recommendation
Give a clear winner for THIS specific move (${n} watch${n > 1 ? 'es' : ''}, ${fromLabel} → ${toLabel}).
State: recommended option, estimated total cost, key reason, and one practical tip.
If personal carry is cheapest, say which airline and roughly what a round-trip or one-way costs on this route.

Be specific with numbers and practical. Use our historical data when available to anchor estimates.`;
}

/** The answer's "## …" sections, for the console to draw (the app renders the markdown as is). */
export function parseRecommendation(answer) {
  const sections = [];
  let cur = { heading: '', lines: [] };
  for (const line of String(answer || '').split(/\r?\n/)) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      if (cur.heading || cur.lines.some((l) => l.trim())) sections.push(cur);
      cur = { heading: h[1].trim(), lines: [] };
    } else cur.lines.push(line);
  }
  if (cur.heading || cur.lines.some((l) => l.trim())) sections.push(cur);
  const recommended = sections.find((s) => /recommendation/i.test(s.heading)) || null;
  return { text: String(answer || ''), sections: sections.map((s) => ({ heading: s.heading, body: s.lines.join('\n').trim() })), recommendation: recommended ? recommended.lines.join('\n').trim() : '' };
}

const pickedOf = (p, ids) => {
  const want = new Set(String(ids || '').split(',').map((x) => Number(x.trim())).filter(Boolean));
  const all = Object.values(p.available || {}).flat();
  return all.filter((w) => want.has(w.id));
};
const parseJson = (s, fallback) => {
  if (s && typeof s === 'object') return s;
  try {
    return s ? JSON.parse(String(s)) : fallback;
  } catch {
    return fallback;
  }
};

/* ── the actions ─────────────────────────────────────────────────── */

export const ACTIONS = [
  {
    key: 'ship-add',
    label: 'Add shipment',
    kinds: null,
    page: 'shipments',
    form: () => shipForm(),
    // From a Ready-for-delivery row (?ready=<our item id>, the app's Ship Now): what its openShipmentFromReady fills in.
    prefill: async (item, ctx, q = {}) => {
      const values = { date: localToday(), costCurrency: 'AED', status: 'pending', hasWatch: true, customsRatePct: 0.3, aedPerUsd: 3.67, thirdPartyPaymentStatus: 'pending' };
      const readyId = q.ready ?? q.readyId ?? q.readyid;
      if (!readyId) return values;
      const { rows } = await query("SELECT * FROM logistics_items WHERE id = $1 AND kind = 'readyForDelivery' AND deleted_at IS NULL", [Number(readyId) || 0]);
      const r = rows[0]?.data;
      if (!r) return values;
      const parts = [];
      if (r.brand) parts.push(r.brand);
      if (r.watchModel) parts.push(r.watchModel);
      else if (r.watchReference) parts.push(r.watchReference);
      if (r.watchReference && r.watchModel && r.watchReference !== r.watchModel) parts.push(`Ref ${r.watchReference}`);
      if (r.watchSerial) parts.push(`SN ${r.watchSerial}`);
      return { ...values, stockNumber: r.stockNumber || '', fromText: r.soldFromLocation || r.originLocation || '', toText: r.soldToBuyer || '', items: parts.join(' · ') || `Watch ${r.stockNumber || ''}`, hasWatch: true };
    },
    run: async ({ db, input, user, query: q = {} }) => {
      const clients = await clientsOf(db);
      const movers = await moversOf(db);
      const { data, costAmountRaw } = shipData(input, { clients, movers });
      let ready = null;
      const readyId = q.ready ?? q.readyId ?? q.readyid;
      if (readyId) {
        ready = await loadItem(db, readyId);
        if (ready.kind !== 'readyForDelivery') throw bad('readyId is not a Ready-for-delivery row');
      }
      const ship = await insertItem(db, 'shipments', { ...data, deliveredAt: null, deliveryNotes: '', deliveryPhotos: [], missingItems: [], ...(ready ? { readyForDeliveryId: ready.data.id } : {}) }, user);
      if (ready) await patchItem(db, ready, { ...ready.data, shipmentId: ship.data.id, status: 'shipped' }, user);
      const fromC = clients.get(text(data.fromClientId));
      const toC = clients.get(text(data.toClientId));
      await logActivity(db, `New shipment: ${fromC?.name || data.fromText || '?'} → ${toC?.name || data.toText || '?'} · ${data.items.slice(0, 40)}${ready ? ' (linked to Ready-for-Delivery)' : ''}`, user);
      await afterSave(db, ship, { clients, movers, user, costAmountRaw });
      return {
        message: `Shipment saved${data.viaThirdParty && data.thirdPartyMoverId ? ' · customs entry synced' : ''}${ready ? ' · linked to the sale waiting for delivery' : ''}${await notOurs(data.stockNumber)}`,
        open: `#/lg/${ship.id}`,
        created: [ship.id],
      };
    },
  },
  {
    key: 'ship-edit',
    label: 'Edit shipment',
    kinds: ['shipments'],
    form: () => shipForm(),
    prefill: async (it) => {
      const d = it.data;
      const v = { ...d };
      // The app's backward-compat: a cost kept only as "AED 250".
      if (!(d.costAmount !== undefined && d.costCurrency) && d.cost) {
        const m = String(d.cost).trim().match(/^([A-Z]{3})\s*([\d.,]+)/i);
        if (m) {
          v.costCurrency = m[1].toUpperCase();
          v.costAmount = m[2];
        } else v.costAmount = d.cost;
      }
      v.costCurrency ||= 'AED';
      v.customsRatePct ??= 0.3;
      v.aedPerUsd ??= 3.67;
      v.thirdPartyPaymentStatus ||= 'pending';
      v.status ||= 'pending';
      return v;
    },
    run: async ({ db, item, input, user }) => {
      const clients = await clientsOf(db);
      const movers = await moversOf(db);
      const { data, costAmountRaw } = shipData(input, { clients, movers, was: item.data });
      await patchItem(db, item, { ...item.data, ...data }, user);
      await logActivity(db, `Updated shipment: ${data.items.slice(0, 40)}`, user);
      await afterSave(db, item, { clients, movers, user, costAmountRaw });
      return { message: `Shipment saved${data.viaThirdParty && data.thirdPartyMoverId ? ' · customs entry synced' : ''}${await notOurs(data.stockNumber)}` };
    },
  },
  statusAction('ship-shipped', 'Mark in transit', 'in_transit'),
  statusAction('ship-pending', 'Mark pending', 'pending'),
  statusAction('ship-cancel', 'Mark cancelled', 'cancelled', { danger: true }),
  {
    key: 'ship-deliver',
    label: 'Mark delivered',
    kinds: ['shipments'],
    form: [
      { key: 'nothingMissing', label: 'Nothing missing', type: 'bool' },
      { key: 'missingItems', label: 'Missing accessories', type: 'text', hint: 'accessory (brand), comma separated — each is logged as owed' },
      { key: 'presentItems', label: 'Accessories present', type: 'text' },
      { key: 'deliveryNotes', label: 'Delivery notes', type: 'longtext' },
      { key: 'costTitle', label: 'Logistic cost — what for', type: 'text' },
      { key: 'costAmount', label: 'Logistic cost', type: 'money', currency: 'costCurrency', hint: 'leave blank to record no cost' },
      { key: 'costCurrency', label: 'Cost currency', type: 'currency' },
      { key: 'costDate', label: 'Cost date', type: 'date' },
      { key: 'costNotes', label: 'Cost notes', type: 'longtext', hint: 'delivery photos go on after, with the card’s "Add documents"; the app’s WhatsApp confirmation is not sent from here' },
    ],
    prefill: async (it) => {
      const s = it.data;
      const clients = await clientsOf({ query });
      const fromName = sideName(clients.get(text(s.fromClientId)), '', '?');
      const toName = sideName(clients.get(text(s.toClientId)), '', '?');
      const guess = parseCostString(s.cost || '');
      return { nothingMissing: false, costTitle: `${fromName} → ${toName} shipment Cost`, costCurrency: guess.currency || 'USD', costAmount: guess.amount || '', costDate: s.date || localToday() };
    },
    // The app's confirmDeliver.
    run: async ({ db, item, input, user }) => {
      const s = item.data;
      if (s.status === 'delivered') throw bad('This shipment is already delivered');
      const clients = await clientsOf(db);
      const movers = await moversOf(db);
      const nothingMissing = asBool(input.nothingMissing);
      const notes = text(input.deliveryNotes, 2000);
      const missing = nothingMissing ? [] : parseAccessoryList(input.missingItems);
      const present = parseAccessoryList(input.presentItems);
      const next = { ...s, status: 'delivered', deliveredAt: Date.now(), deliveryNotes: notes, deliveryPhotos: Array.isArray(s.deliveryPhotos) ? s.deliveryPhotos : [], missingItems: missing, presentItems: present };
      const fromC = clients.get(text(s.fromClientId));
      const toC = clients.get(text(s.toClientId));
      const fromName = sideName(fromC, '', '?');
      const toName = sideName(toC, '', '?');
      const stockLabel = splitStockList(s.stockNumber).join(', ');
      const bits = [];
      const costAmountRaw = text(input.costAmount, 30);
      if (costAmountRaw) {
        const costTitle = text(input.costTitle, 200);
        const currency = currencyOf(input.costCurrency, 'USD', 'Cost currency');
        const costDate = dayOf(input.costDate, 'Cost date', { blank: '' }) || s.date || localToday();
        const amount = amountOf(costAmountRaw, 'Logistic cost');
        await insertItem(
          db,
          'logisticCosts',
          { title: costTitle || `${fromName} → ${toName} shipment Cost`, shipmentId: s.id, stockNumber: stockLabel, fromClientId: s.fromClientId, toClientId: s.toClientId, fromName, toName, date: costDate, currency, amount, notes: text(input.costNotes, 2000) },
          user
        );
        next.cost = `${currency} ${costAmountRaw}`;
        await logActivity(db, `💰 Logistic cost recorded: ${costTitle || stockLabel} · ${currency} ${costAmountRaw}`, user);
        bits.push(`cost ${currency} ${costAmountRaw} recorded`);
      }
      await patchItem(db, item, next, user);
      // Missing items: owed by the FROM side to the TO side, as a transaction against the real client.
      if (!nothingMissing && missing.length) {
        const companyFrom = isCompany(fromC);
        const companyTo = isCompany(toC);
        let txClient = null;
        let txType = null;
        let direction = null;
        if (companyFrom && !companyTo) [txClient, txType, direction] = [toC, 'sold', 'give'];
        else if (companyTo && !companyFrom) [txClient, txType, direction] = [fromC, 'bought', 'receive'];
        else if (!companyFrom && !companyTo) [txClient, txType, direction] = [toC, 'sold', 'give'];
        if (txClient) {
          const stamp = Date.now();
          await insertItem(
            db,
            'transactions',
            {
              type: txType,
              date: localToday(),
              clientId: txClient.id,
              reference: text(s.items).slice(0, 30),
              stockNumber: `SHIP-${s.tracking || String(s.id).slice(0, 4)}`,
              notes: `Auto-created from delivered shipment. Missing: ${missing.map((m) => m.accessory).join(', ')}`,
              items: missing.map((m) => ({ id: `${stamp.toString(36)}${Math.random().toString(36).slice(2, 6)}`, accessory: `${m.accessory} (${m.brand})`, qty: 1, direction, status: 'pending', settledBy: null, settlementId: null })),
              shipmentId: s.id,
            },
            user
          );
          await logActivity(db, `Missing items from shipment routed to ${txClient.name}: ${missing.map((m) => m.accessory).join(', ')}`, user);
          bits.push(`${missing.length} missing item${missing.length === 1 ? '' : 's'} owed by ${txClient.name}`);
        } else bits.push('missing items noted (no client to owe them)');
      }
      // From a Ready-for-delivery row: the sale is finalized into Sold Stocks.
      let finalized = false;
      if (s.readyForDeliveryId) {
        const ready = await byAppId(db, 'readyForDelivery', s.readyForDeliveryId);
        if (ready) {
          // The sales domain's port of the app's finalizeReadyAsSold (sales.js): the Sold Stocks row, the waiting row gone.
          const { sold } = await finalizeReadyAsSold(db, ready, user, { deliveredVia: 'shipment', deliveryNotes: notes });
          await logActivity(db, `📦➡️💰 Ready-for-delivery ${text(sold.stockNumber)} finalized as SOLD (via shipment)`, user);
          finalized = true;
        }
      }
      if (s.viaThirdParty || s.thirdPartyMoverId) await syncShipmentToTpm(db, item, { clients, movers, user });
      await logActivity(db, `Delivered shipment "${text(s.items).slice(0, 40)}"${nothingMissing ? ' (nothing missing)' : ` (${missing.length} missing)`}`, user);
      return { message: `Delivered ✓${finalized ? ' · sale finalized' : ''}${bits.length ? ` · ${bits.join(' · ')}` : ''}` };
    },
  },
  {
    key: 'ship-delete',
    label: 'Delete shipment',
    kinds: ['shipments'],
    danger: true,
    // The app's deleteShipment: the customs mirror under the mover goes with it. The app asks a password for a
    // delivered or cancelled one; here the confirm and the sign-in stand for it.
    run: async ({ db, item, user }) => {
      const s = item.data;
      if (s.tpmShipmentId) {
        const tpm = await byAppId(db, 'thirdPartyShipments', s.tpmShipmentId);
        if (tpm) {
          const lc = tpm.data.logisticCostId ? await byAppId(db, 'logisticCosts', tpm.data.logisticCostId) : null;
          if (lc) await softDelete(db, lc.id, user);
          await softDelete(db, tpm.id, user);
        }
      }
      for (const m of await listKind(db, 'thirdPartyShipments', "data->>'liveShipmentId' = $2 AND (data->>'originLive')::boolean", [text(s.id)])) await softDelete(db, m.id, user);
      await softDelete(db, item.id, user);
      const history = s.status === 'delivered' || s.status === 'cancelled';
      await logActivity(db, `Deleted shipment "${text(s.items).slice(0, 40)}"${history ? ' (history)' : ''}`, user);
      return { message: 'Shipment deleted', open: '#/logistics/shipments' };
    },
  },

  /* ── the Route Optimizer ── */
  {
    key: 'route-prices',
    label: 'Fetch market prices',
    kinds: null,
    page: 'routeoptimizer',
    ai: true,
    form: [],
    // input.ids: the picked watches' item ids, comma separated (the page's available rows).
    run: async ({ input }) => {
      const p = await routePage.page();
      const watches = pickedOf(p, input.ids);
      if (!watches.length) throw bad('Select watches first');
      const answer = await ask({ prompt: marketPricesPrompt(watches), maxTokens: 1024 });
      const prices = parseMarketPrices(answer, watches);
      const result = { prices, asked: watches.length };
      return { message: JSON.stringify(result), data: result };
    },
  },
  {
    key: 'route-advice',
    label: 'Get AI recommendation',
    kinds: null,
    page: 'routeoptimizer',
    ai: true,
    form: [],
    // input: ids, from, to, custom (the typed place for "Other"), prices (the market prices fetched, JSON by stock number).
    run: async ({ db, input }) => {
      const fromVal = text(input.from, 60);
      const toVal = text(input.to, 60);
      const custom = text(input.custom, 60);
      const fromLabel = fromVal === 'Other' ? custom : fromVal;
      const toLabel = toVal === 'Other' ? custom : toVal;
      if (!fromLabel || !toLabel) throw bad('Select From and To locations first');
      if (fromLabel === toLabel) throw bad('From and To must be different');
      const p = await routePage.page();
      const watches = pickedOf(p, input.ids);
      if (!watches.length) throw bad('Add at least one watch to the move');
      // The route's history as the page computes it (a cost line standing for a shipment or trip is that move already).
      const from = fromVal === 'Other' ? routePage.placeOf(custom) : fromVal;
      const to = toVal === 'Other' ? routePage.placeOf(custom) : toVal;
      const moves = (p.moves || []).filter((m) => m.from === from && m.to === to && m.usd > 0 && !(m.kind === 'cost' && ['shipment', 'mover', 'trip'].includes(m.stands_for)));
      const given = parseJson(input.prices, {});
      const prices = {};
      for (const [k, v] of Object.entries(given && typeof given === 'object' ? given : {})) {
        const usd = Number(v?.usd ?? v?.marketPriceUsd);
        if (Number.isFinite(usd) && usd > 0) prices[k] = { usd, confidence: text(v?.confidence, 10) || 'est' };
      }
      const movers = (await listKind(db, 'thirdPartyMovers')).map((m) => ({ name: text(m.data.name), country: text(m.data.country) }));
      const today = new Date(Date.now() + 4 * 3600_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
      const prompt = routePrompt({ fromLabel, toLabel, watches, histText: routeHistoryText(moves, fromLabel, toLabel), movers, prices, today });
      const answer = await ask({ prompt, maxTokens: 2048 });
      const result = parseRecommendation(answer);
      return { message: result.text, data: result };
    },
  },
];

/* Fields the app's shipment form has that kinds.js does not type, for the record page's Edit. */
export const FIELDS = {
  shipments: [
    { key: 'thirdPartyMoverId', label: 'Mover (id)', type: 'text' },
    { key: 'thirdPartyPaymentStatus', label: 'Mover payment', type: 'enum', options: ['pending', 'paid', 'not_applicable'] },
    { key: 'cost', label: 'Cost as typed', type: 'text' },
    { key: 'readyForDeliveryId', label: 'Ready-for-delivery row (id)', type: 'text' },
  ],
};

export { CURRENCIES };
