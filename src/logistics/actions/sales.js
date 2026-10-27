/*
 * The sales workflows of the logistics app, done here — its Sold Stocks,
 * Ready for delivery (on Live Shipments), In Consignment and Refinement
 * tabs. Each action is the app's own function ported record for record
 * (read from its index.html: confirmSold, finalizeReadyAsSold,
 * confirmDeliverReadyDone, cancelSoldStock, cancelReadyForDelivery,
 * moveSoldToSafe / _safeRowForSale, saveDateEdit, deleteSoldStock,
 * confirmStockConsignment, confirmRecallConsignment, deleteLondonRow,
 * confirmExtPolish, confirmExtPolishDone, deleteExtPolish) — the same
 * fields, the same value forms (days as YYYY-MM-DD, deliveredAt in
 * milliseconds, the app's status words and list names), the same activity
 * line. What differs from the app, and why:
 *
 *   - dollars (`soldPriceUsd`) at the converter's rates, never the app's
 *     fixed FX_TO_USD table; with no rate for the currency the figure is
 *     left at 0 and the message says so
 *   - the buyer / the person a watch is consigned to is OUR logistics client
 *     (`soldToClientId` / `consignment.clientId`, by id) with the typed name
 *     kept exactly as the app keeps it (`soldToBuyer` / `consignment.with`)
 *   - cancelling a sale made from HK restores the row into the list it came
 *     from (hkStock — or hkSituation when the snapshot is one of its rows);
 *     the app pushes every HK sale back into hkSituation
 *   - a source row is deleted softly, never removed; the app's "fetch image"
 *     (a web search for a reference picture) is not possible here
 *   - WhatsApp (the sale confirmation, the consignment notice) is not sent:
 *     the text is given back in the message to copy
 *
 * Send to polish / Back from polish stay POST /api/logistics/items/:id/polish
 * (polishAction) — the Sold Stocks page posts to it; not rebuilt here.
 */
import { query } from '../../db/index.js';
import { insertItem, patchItem, softDelete, logActivity, listKind, text, dayOf, amountOf, currencyOf, uid, localToday, bad } from '../write.js';
import { oursByNumber } from '../shared.js';
import { getRates } from '../../rates/index.js';

/* ── pieces ────────────────────────────────────────────────────────── */

/* The app's originLocation words (confirmSold's table) and its list per key. */
const ORIGIN_LABEL = { london: '🇬🇧 London', dubai: '🇦🇪 Dubai', hk: '🌐 HK', incomings: '📥 Incomings' };
const ORIGIN_KEY = { londonStock: 'london', dubaiStock: 'dubai', hkStock: 'hk', incomings: 'incomings' };
const PLACE_LABEL = { london: '🇬🇧 London', dubai: '🇦🇪 Dubai', hk: '🇭🇰 HK' };
const PLACE_WORDS = { london: 'London', dubai: 'Dubai', hk: 'HK' };
const PLACE_KIND = { london: 'londonStock', dubai: 'dubaiStock' };
const VIA = { in_person: 'In person (handed over)', shipment: 'By shipment', held_in_safe: 'Held in our safe' };
const CURRENCIES = ['USD', 'AED', 'EUR', 'GBP', 'HKD', 'CHF', 'JPY', 'CNY'];

const stockWords = (d) => text(d.stockNumber, 50) || text(d.watchModel, 100) || 'watch';
const money = (n) => Number(n || 0).toLocaleString('en-GB');
const dayWords = (ms) => new Date(Number(ms)).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Dubai' });

/*
 * The converter's rates, with a cap on the wait (as ratesSoon elsewhere): the
 * fresh table when it comes within 1.5 s, else the last one; none the first
 * time. USD-based: rates[cur] = units of cur per dollar.
 */
let lastRates = null;
async function ratesSoon(waitMs = 1500) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(lastRates), waitMs);
    timer.unref?.();
  });
  const fresh = getRates().then(
    (r) => (lastRates = r),
    () => lastRates
  );
  try {
    return await Promise.race([fresh, late]);
  } finally {
    clearTimeout(timer);
  }
}
/** An amount in dollars at the converter's rates; null when the currency has no rate. */
export async function usdOf(amount, currency) {
  const n = Number(amount) || 0;
  if (currency === 'USD') return n;
  const r = await ratesSoon();
  const t = r?.rates;
  if (!t || !t[currency] || !t.USD) return null;
  return Math.round(((n / t[currency]) * t.USD) * 100) / 100;
}

/* Our watch of a stock number, for a message ("not one of our watches"). */
async function ourWatch(stockNo) {
  const no = text(stockNo, 50);
  if (!no) return null;
  return (await oursByNumber([no])).get(no) || null;
}
const notOurs = async (stockNo) => (text(stockNo) && !(await ourWatch(stockNo)) ? ` — #${text(stockNo, 50)} is not one of our watches` : '');

/* The buyer: our logistics client by id (the form's select), the typed name kept as the app keeps it. */
function buyerOf(input, ctx, { idKey = 'soldToClientId', nameKey = 'soldToBuyer' } = {}) {
  const id = text(input[idKey], 80);
  const name = text(input[nameKey], 200);
  const known = id ? ctx.client(id) : '';
  if (id && !known) throw bad('That client is not on the logistics client list');
  return { id: id || null, name: name || known };
}

/* The hint under a stock number: our watch, with its clients. */
async function oursHint(stockNo) {
  const w = await ourWatch(stockNo);
  if (!w) return text(stockNo) ? `#${text(stockNo, 50)} is not one of our watches` : '';
  return `our watch #${w.stock_no}${w.bought_from ? ` · bought from ${w.bought_from.name}` : ''}${w.sold_to ? ` · sold to ${w.sold_to.name}` : ''}`;
}

/* The record of a kind whose app id is `appId`, not deleted (our copy of the app's row). */
async function byAppId(db, kind, appId) {
  if (!appId) return null;
  const { rows } = await db.query("SELECT * FROM logistics_items WHERE kind = $1 AND deleted_at IS NULL AND data->>'id' = $2 ORDER BY id LIMIT 1 FOR UPDATE", [kind, String(appId)]);
  return rows[0] || null;
}

/* The source row's words as confirmSold reads them (an HK stock row says `description` / `reference`). */
const specOf = (row) => ({
  stockNumber: text(row.stockNumber, 50),
  brand: text(row.brand, 100),
  watchModel: text(row.watchModel || row.description || row.reference, 300),
  watchReference: text(row.watchReference || row.reference, 100),
  watchSerial: text(row.watchSerial || row.serial, 100),
  watchDate: text(row.watchDate, 50),
});

/*
 * The app's finalizeReadyAsSold: the Ready row becomes a Sold Stocks row,
 * delivered now. Returns the sold record's data (inserted) — the caller
 * deletes the Ready row.
 */
export async function finalizeReadyAsSold(db, ready, user, { deliveredVia = 'in_person', deliveryNotes = '' } = {}) {
  const r = ready.data;
  const now = Date.now();
  const sold = {
    id: uid(),
    stockNumber: r.stockNumber ?? '',
    brand: r.brand ?? '',
    watchModel: r.watchModel ?? '',
    watchReference: r.watchReference ?? '',
    watchSerial: r.watchSerial ?? '',
    watchDate: r.watchDate ?? '',
    originLocation: r.originLocation ?? '',
    originKey: r.originKey ?? '',
    originRow: r.originRow ?? null,
    soldPrice: r.soldPrice ?? 0,
    soldCurrency: r.soldCurrency ?? '',
    soldPriceUsd: r.soldPriceUsd ?? 0,
    soldDate: r.soldDate ?? '',
    soldToBuyer: r.soldToBuyer ?? '',
    soldFromLocation: r.soldFromLocation ?? '',
    soldNotes: r.soldNotes ?? '',
    photos: Array.isArray(r.photos) ? r.photos : [],
    deliveredVia,
    shipmentId: r.shipmentId || null,
    deliveryNotes,
    deliveryPhotos: [],
    deliveredAt: now,
    ts: now,
  };
  // Ours: the buyer by id travels with the sale.
  if (r.soldToClientId) sold.soldToClientId = r.soldToClientId;
  const row = await insertItem(db, 'soldStocks', sold, user);
  await softDelete(db, ready.id, user);
  return { row, sold };
}

/* The app's _safeRowForSale: a Safe row holding the sold watch for its buyer. */
function safeRowForSale(rec, buyer) {
  const now = Date.now();
  return {
    stockNumber: rec.stockNumber || '',
    from: buyer,
    brand: rec.brand || '',
    watchModel: rec.watchModel || '',
    watchReference: rec.watchReference || '',
    watchDate: rec.watchDate || '',
    watchSerial: rec.watchSerial || '',
    accessoriesPresent: (rec.originRow && rec.originRow.accessoriesPresent) || '',
    accessoriesMissing: (rec.originRow && rec.originRow.accessoriesMissing) || '',
    inSafe: '',
    withClient: '',
    photos: [...(Array.isArray(rec.photos) ? rec.photos : [])],
    notes: '',
    status: 'current',
    heldForBuyer: true,
    soldId: rec.id,
    receivedAt: now,
    movements: [
      {
        id: uid(),
        ts: now,
        date: localToday(),
        destination: '🔒 In Safe',
        notes: `Sold to ${buyer} — held in our safe at their request.`,
        moveType: 'sold_held_in_safe',
        photos: [],
        takenAccessories: [],
        leftSpareAccessories: [],
      },
    ],
    createdAt: now,
  };
}

/*
 * The list a sale's snapshot goes back into (cancelSoldStock /
 * cancelReadyForDelivery). The app pushes an HK sale into hkSituation though
 * openSoldModal took it from hkStock — here an HK snapshot goes back where it
 * came from: hkSituation when it is one of its rows (a `section`), else hkStock.
 */
function restoreKind(originKey, snapshot) {
  if (originKey === 'london') return 'londonStock';
  if (originKey === 'dubai') return 'dubaiStock';
  if (originKey === 'incomings') return 'incomings';
  if (originKey === 'hk') return snapshot && (snapshot.section || snapshot.stockStatus || snapshot.holder !== undefined) ? 'hkSituation' : 'hkStock';
  return null;
}

/* A shipment linked to a sale is kept, unlinked (delete ship.readyForDeliveryId). */
async function unlinkShipment(db, shipmentId, user) {
  const ship = await byAppId(db, 'shipments', shipmentId);
  if (ship && ship.data.readyForDeliveryId !== undefined) await patchItem(db, ship, { ...ship.data, readyForDeliveryId: undefined }, user);
}

/* The app's WhatsApp text for a sale (buildSoldWhatsAppMessage) — given back to copy, never sent. */
function soldWhatsApp(ready) {
  const desc = [ready.brand, ready.watchModel || ready.watchReference].filter(Boolean).join(' · ');
  return [`💵 Sold — ${desc}${ready.stockNumber ? ` (Stock ${ready.stockNumber})` : ''}`, ready.soldToBuyer && `👤 ${ready.soldToBuyer}`, `💰 ${ready.soldCurrency} ${money(ready.soldPrice)}`, `📅 ${ready.soldDate}`, ready.soldFromLocation && `📍 From ${ready.soldFromLocation}`].filter(Boolean).join('\n');
}

/* ── the forms ─────────────────────────────────────────────────────── */

const SALE_FORM = async (item) => [
  { key: 'soldPrice', label: 'Sold price', type: 'money', currency: 'soldCurrency', required: true, hint: await oursHint(item?.data?.stockNumber) },
  { key: 'soldCurrency', label: 'Currency', type: 'choice', options: CURRENCIES.map((c) => ({ value: c, label: c })) },
  { key: 'soldDate', label: 'Sold on', type: 'date' },
  { key: 'soldToClientId', label: 'Buyer — our client', type: 'client', hint: 'the logistics client it was sold to; the name typed below is kept as the app keeps it' },
  { key: 'soldToBuyer', label: 'Buyer as typed', type: 'text', hint: "a name, or 'walk-in'" },
  { key: 'soldFromLocation', label: 'Sold from (place)', type: 'text', hint: 'Mayfair, Dubai office …' },
  { key: 'soldNotes', label: 'Notes', type: 'longtext' },
];

const CONSIGN_FORM = async (item, ctx, query, direction) => [
  ...(direction ? [] : [{ key: 'direction', label: 'Direction', type: 'choice', options: [{ value: 'to_client', label: 'Our watch → client' }, { value: 'from_client', label: "Client's watch → us" }] }]),
  { key: 'clientId', label: 'With — our client', type: 'client', hint: 'the logistics client; the name typed below is what the app shows' },
  { key: 'with', label: 'With, as typed', type: 'text', hint: item ? await oursHint(item.data.stockNumber) : '' },
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'accessories', label: 'Accessories with it', type: 'text' },
  { key: 'returnDate', label: 'Return by', type: 'date' },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];

const EXT_POLISH_FORM = [
  { key: 'description', label: 'Watch', type: 'text', required: true, hint: 'whose watch and what it is; a bare stock number is our watch' },
  { key: 'sentTo', label: 'Sent to', type: 'text', required: true },
  { key: 'sentDate', label: 'Sent on', type: 'date' },
  { key: 'expectedBack', label: 'Expected back', type: 'date' },
  { key: 'cost', label: 'Cost', type: 'money', currency: 'costCurrency' },
  { key: 'costCurrency', label: 'Cost currency', type: 'currency' },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];

/* The stock rows a page-level consignment can pick (the app's picker: London and Dubai rows in stock). */
async function stockChoices(db) {
  const rows = [...(await listKind(db, 'londonStock')), ...(await listKind(db, 'dubaiStock'))].filter((r) => ['', 'current'].includes(text(r.data.status)));
  return rows
    .sort((a, b) => String(a.data.stockNumber || '').localeCompare(String(b.data.stockNumber || ''), undefined, { numeric: true }))
    .map((r) => ({ value: String(r.id), label: [`#${text(r.data.stockNumber, 50) || '—'}`, [r.data.brand, r.data.watchModel || r.data.watchReference].filter(Boolean).join(' ').slice(0, 60), PLACE_WORDS[ORIGIN_KEY[r.kind]]].filter(Boolean).join(' · ') }));
}

/* What the consignment form writes (confirmStockConsignment). */
function consignmentOf(input, ctx, current, direction) {
  const who = buyerOf(input, ctx, { idKey: 'clientId', nameKey: 'with' });
  if (!who.name) throw bad('Say who the watch is with');
  const dir = direction || (text(input.direction) === 'from_client' ? 'from_client' : text(input.direction) === 'to_client' ? 'to_client' : current?.direction || 'to_client');
  return {
    direction: dir,
    with: who.name,
    ...(who.id ? { clientId: who.id } : {}),
    date: dayOf(input.date, 'Date'),
    accessories: text(input.accessories, 500),
    returnDate: input.returnDate ? dayOf(input.returnDate, 'Return by') : '',
    notes: text(input.notes, 2000),
    photosBefore: Array.isArray(current?.photosBefore) ? current.photosBefore : [],
  };
}

async function consign(db, item, input, user, ctx, direction) {
  const d = item.data;
  const c = consignmentOf(input, ctx, d.consignment, direction);
  await patchItem(db, item, { ...d, status: 'consignment', consignment: c }, user);
  const dirLabel = c.direction === 'from_client' ? '📥 client gave us' : '🤝 gave to client';
  await logActivity(db, `${dirLabel}: Stock #${d.stockNumber || d.id} (${d.watchModel || ''}) with ${c.with}`, user);
  const note = `${c.direction === 'from_client' ? '📥 Consignment received' : '🤝 Consignment'} — ${[d.brand, d.watchModel || d.watchReference].filter(Boolean).join(' ')}${d.stockNumber ? ` (Stock ${d.stockNumber})` : ''}\n👤 ${c.with}\n📅 ${c.date}${c.returnDate ? `\n↩️ Return by ${c.returnDate}` : ''}${c.accessories ? `\n🎁 ${c.accessories}` : ''}`;
  return { message: `On consignment with ${c.with}${await notOurs(d.stockNumber)}. WhatsApp is not sent from here — the notice to copy:\n${note}`, open: '#/logistics/consignment' };
}

/* What the external polish form writes (confirmExtPolish's `fields`). */
function extPolishOf(input) {
  const description = text(input.description, 300);
  const sentTo = text(input.sentTo, 200);
  if (!description) throw bad('Say what the watch is');
  if (!sentTo) throw bad('Say who it is sent to');
  return {
    description,
    sentTo,
    sentDate: dayOf(input.sentDate, 'Sent on'),
    expectedBack: input.expectedBack ? dayOf(input.expectedBack, 'Expected back') : '',
    cost: amountOf(input.cost, 'Cost'),
    costCurrency: currencyOf(input.costCurrency, 'USD'),
    notes: text(input.notes, 2000),
  };
}

/* ── the actions ───────────────────────────────────────────────────── */

export const ACTIONS = [
  /* ── Sold Stocks ── */
  {
    key: 'sale-deliver',
    label: 'Set delivery date',
    kinds: ['soldStocks'],
    form: [
      { key: 'deliveredAt', label: 'Delivered on', type: 'date', required: true },
      { key: 'deliveredVia', label: 'Delivered', type: 'choice', options: Object.entries(VIA).map(([value, label]) => ({ value, label })) },
    ],
    prefill: async (it) => ({ deliveredAt: it.data.deliveredAt ? new Date(Number(it.data.deliveredAt) + 4 * 3600_000).toISOString().slice(0, 10) : localToday(), deliveredVia: text(it.data.deliveredVia) || 'in_person' }),
    run: async ({ db, item, input, user }) => {
      const d = item.data;
      const day = dayOf(input.deliveredAt, 'Delivered on', { blank: '' });
      if (!day) throw bad('Pick the day it was delivered');
      const via = text(input.deliveredVia) || text(d.deliveredVia) || 'in_person';
      if (!VIA[via]) throw bad(`Delivered: "${input.deliveredVia}" is not one of ${Object.keys(VIA).join(', ')}`);
      // The app keeps whatever time of day was already recorded, so only the day moves; a first date is noon in Dubai.
      const [y, m, dd] = day.split('-').map(Number);
      const old = Number(d.deliveredAt) || 0;
      const oldDay = old ? Date.UTC(new Date(old).getUTCFullYear(), new Date(old).getUTCMonth(), new Date(old).getUTCDate()) : 0;
      const ms = old ? Date.UTC(y, m - 1, dd) + (old - oldDay) : Date.UTC(y, m - 1, dd, 8);
      await patchItem(db, item, { ...d, deliveredAt: ms, deliveredVia: via }, user);
      await logActivity(db, `📅 Delivery date for stock #${d.stockNumber || '–'} set to ${dayWords(ms)}`, user);
      return { message: `Delivered ${VIA[via].toLowerCase()} on ${dayWords(ms)}` };
    },
  },
  {
    key: 'sale-safe',
    label: 'Hold in safe',
    kinds: ['soldStocks', 'readyForDelivery'],
    run: async ({ db, item, user }) => {
      const rec = item.data;
      const buyer = text(rec.soldToBuyer, 200);
      if (!buyer) throw bad('This sale has no buyer name, so there is nobody to hold it for');
      const { rows: already } = await db.query("SELECT id FROM logistics_items WHERE kind = 'safeStock' AND deleted_at IS NULL AND data->>'soldId' = $1 AND COALESCE(data->>'status', 'current') = 'current'", [String(rec.id)]);
      if (already.length) throw bad(`Already in the safe for ${buyer}`);
      let sold = rec;
      // A sale still awaiting handover is now handed over: into our own safe (the app's words).
      if (item.kind === 'readyForDelivery') sold = (await finalizeReadyAsSold(db, item, user, { deliveredVia: 'held_in_safe', deliveryNotes: 'Client asked us to keep it in our safe.' })).sold;
      const row = safeRowForSale(sold, buyer);
      const safe = await insertItem(db, 'safeStock', row, user);
      await logActivity(db, `🔒 ${row.stockNumber ? `#${row.stockNumber} ` : ''}${[row.brand, row.watchReference].filter(Boolean).join(' ')} — sold to ${buyer}, held in our safe`, user);
      return { message: `Held in the safe for ${buyer}${await notOurs(row.stockNumber)}`, created: [safe.id], open: '#/logistics/safe' };
    },
  },
  {
    key: 'sale-cancel',
    label: 'Cancel sale',
    kinds: ['soldStocks', 'readyForDelivery'],
    danger: true,
    run: async ({ db, item, user }) => {
      const s = item.data;
      const ready = item.kind === 'readyForDelivery';
      const snapshot = s.originRow && typeof s.originRow === 'object' ? JSON.parse(JSON.stringify(s.originRow)) : null;
      const kind = restoreKind(text(s.originKey), snapshot);
      if (!snapshot || !kind) {
        if (ready) {
          // cancelReadyForDelivery removes the row even without a snapshot; nothing is restored.
          if (s.shipmentId) await unlinkShipment(db, s.shipmentId, user);
          await softDelete(db, item.id, user);
          await logActivity(db, `↩️ Cancelled ready-for-delivery ${stockWords(s)} — restored to ${s.originLocation || ''}`, user);
          return { message: 'Sale cancelled — the app kept no snapshot of the stock row, so nothing was restored', open: '#/logistics/shipments' };
        }
        // cancelSoldStock: "Original inventory snapshot is missing — cannot restore the row. Delete the sold record anyway?" — the confirm was this dialog.
        await softDelete(db, item.id, user);
        return { message: 'Sold record removed (no restore possible — the app kept no snapshot of the stock row)', open: '#/logistics/soldstocks' };
      }
      const destLabel = s.originLocation || s.originKey;
      if (ready) {
        // The snapshot keeps its id; a row sold while on consignment comes back as active stock.
        if ((kind === 'londonStock' || kind === 'dubaiStock') && snapshot.status === 'consignment') {
          snapshot.status = 'current';
          delete snapshot.consignment;
        }
      } else {
        // The sold snapshot: cleared of stale flags, and a fresh id (the app avoids collisions this way).
        if ((kind === 'londonStock' || kind === 'dubaiStock') && snapshot.status !== 'current') snapshot.status = 'current';
        snapshot.id = uid();
      }
      const restored = await insertItem(db, kind, snapshot, user);
      if (s.shipmentId) await unlinkShipment(db, s.shipmentId, user);
      await softDelete(db, item.id, user);
      await logActivity(
        db,
        ready ? `↩️ Cancelled ready-for-delivery ${stockWords(s)} — restored to ${s.originLocation || ''}` : `↩️ Cancelled sale ${stockWords(s)} (${s.soldCurrency} ${s.soldPrice}) — restored to ${destLabel}`,
        user
      );
      return { message: `Sale cancelled · watch restored to ${destLabel}`, created: [restored.id], open: `#/lg/${restored.id}` };
    },
  },
  {
    key: 'sale-delete',
    label: 'Delete sale record',
    kinds: ['soldStocks'],
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      return { message: 'Sold record deleted — the stock row is not restored (Cancel sale does that)', open: '#/logistics/soldstocks' };
    },
  },

  /* ── Ready for delivery (the Shipments tab) ── */
  {
    key: 'sale-handover',
    label: 'Mark delivered',
    kinds: ['readyForDelivery'],
    form: async (item) => [
      { key: 'deliveryNotes', label: 'Delivery notes', type: 'longtext', hint: `to ${text(item.data.soldToBuyer) || 'the buyer'}${item.data.shipmentId ? ' — a shipment is linked: delivered by shipment' : ' — handed over in person'}; proof photos are added on the Sold Stocks page after` },
    ],
    run: async ({ db, item, input, user }) => {
      const r = item.data;
      const { row, sold } = await finalizeReadyAsSold(db, item, user, { deliveredVia: r.shipmentId ? 'shipment' : 'in_person', deliveryNotes: text(input.deliveryNotes, 2000) });
      await logActivity(db, `📦➡️💰 ${stockWords(sold)} delivered to ${r.soldToBuyer || 'buyer'}`, user);
      const desc = [sold.brand, sold.watchModel || sold.watchReference].filter(Boolean).join(' · ');
      const msg = [`✅ Watch Delivered`, `📦 ${desc}${sold.stockNumber ? ` (Stock ${sold.stockNumber})` : ''}`, sold.soldToBuyer && `👤 To: ${sold.soldToBuyer}`, `📅 ${localToday()}`, `💰 ${sold.soldCurrency} ${money(sold.soldPrice)}`, sold.deliveryNotes && `📝 ${sold.deliveryNotes}`].filter(Boolean).join('\n');
      return { message: `Delivered → moved to Sold Stocks${await notOurs(sold.stockNumber)}. WhatsApp is not sent from here — the confirmation to copy:\n${msg}`, created: [row.id], open: '#/logistics/soldstocks' };
    },
  },
  {
    key: 'sale-ship',
    label: 'Link to shipment',
    kinds: ['readyForDelivery'],
    form: async (item, ctx) => {
      const no = text(item.data.stockNumber, 50);
      const live = (await listKind(pool(), 'shipments')).filter((s) => !/^(delivered|cancelled|done)$/i.test(text(s.data.status)));
      const label = (s) => `${(s.stock_nos || []).includes(no) ? '★ ' : ''}${text(s.data.date, 10) || '—'} · ${ctx.route(s.data) || text(s.data.items, 60) || 'shipment'}${s.data.trackingNumber ? ` · ${text(s.data.trackingNumber, 40)}` : ''}`;
      const options = live
        .sort((a, b) => Number((b.stock_nos || []).includes(no)) - Number((a.stock_nos || []).includes(no)) || String(b.data.date || '').localeCompare(String(a.data.date || '')))
        .map((s) => ({ value: String(s.id), label: label(s) }));
      return [{ key: 'shipment', label: 'Shipment', type: 'choice', options, required: true, hint: options.length ? '★ already names this stock number; a new shipment is made on the Shipments tab' : 'no live shipment yet — make one on the Shipments tab first' }];
    },
    run: async ({ db, item, input, user }) => {
      const r = item.data;
      const { rows } = await db.query("SELECT * FROM logistics_items WHERE id = $1 AND kind = 'shipments' AND deleted_at IS NULL FOR UPDATE", [Number(input.shipment) || 0]);
      const ship = rows[0];
      if (!ship) throw bad('Pick the shipment');
      if (/^(delivered|cancelled|done)$/i.test(text(ship.data.status))) throw bad(`That shipment is ${text(ship.data.status)} — pick a live one`);
      await patchItem(db, item, { ...r, shipmentId: ship.data.id, status: 'shipped' }, user);
      await patchItem(db, ship, { ...ship.data, readyForDeliveryId: r.id }, user);
      await logActivity(db, `🚚 Ready-for-delivery ${stockWords(r)} linked to shipment ${text(ship.data.items, 40) || ship.data.id}`, user);
      return { message: 'Shipped — the sale is finalized when the shipment is delivered', open: '#/logistics/shipments' };
    },
  },

  /* ── In Consignment ── */
  {
    key: 'cons-out',
    label: 'Our watch → client',
    kinds: null,
    page: 'consignment',
    form: async (item, ctx) => [{ key: 'row', label: 'Watch', type: 'choice', options: await stockChoices(pool()), required: true, hint: 'London and Dubai stock in place' }, ...(await CONSIGN_FORM(null, ctx, {}, 'to_client'))],
    prefill: async () => ({ date: localToday() }),
    run: async ({ db, input, user, ctx }) => {
      const row = await pickStock(db, input.row);
      return consign(db, row, input, user, ctx, 'to_client');
    },
  },
  {
    key: 'cons-in',
    label: "Client's watch → us",
    kinds: null,
    page: 'consignment',
    form: async (item, ctx) => [{ key: 'row', label: 'Watch', type: 'choice', options: await stockChoices(pool()), required: true, hint: 'the row in London or Dubai stock' }, ...(await CONSIGN_FORM(null, ctx, {}, 'from_client'))],
    prefill: async () => ({ date: localToday() }),
    run: async ({ db, input, user, ctx }) => {
      const row = await pickStock(db, input.row);
      return consign(db, row, input, user, ctx, 'from_client');
    },
  },
  {
    key: 'cons-consign',
    label: 'Put on consignment',
    kinds: ['londonStock', 'dubaiStock'],
    form: async (item, ctx, q) => CONSIGN_FORM(item, ctx, q),
    prefill: async (it) => ({ direction: 'to_client', date: localToday(), accessories: listWords(it.data.accessoriesPresent || it.data.accessoriesTaken) }),
    run: async ({ db, item, input, user, ctx }) => {
      if (text(item.data.status) === 'consignment') throw bad('Already on consignment — use Edit consignment');
      if (!['', 'current'].includes(text(item.data.status))) throw bad(`This row is ${text(item.data.status)}, not in stock`);
      return consign(db, item, input, user, ctx);
    },
  },
  {
    key: 'cons-edit',
    label: 'Edit consignment',
    kinds: ['londonStock', 'dubaiStock'],
    form: async (item, ctx, q) => CONSIGN_FORM(item, ctx, q),
    prefill: async (it) => {
      const c = it.data.consignment || {};
      return { direction: c.direction || 'to_client', clientId: c.clientId || '', with: c.with || '', date: c.date || localToday(), accessories: c.accessories ?? listWords(it.data.accessoriesPresent || it.data.accessoriesTaken), returnDate: c.returnDate || '', notes: c.notes || '' };
    },
    run: async ({ db, item, input, user, ctx }) => {
      if (text(item.data.status) !== 'consignment') throw bad('This row is not on consignment');
      return consign(db, item, input, user, ctx);
    },
  },
  {
    key: 'cons-back',
    label: 'Move back',
    kinds: ['londonStock', 'dubaiStock'],
    form: [
      { key: 'dest', label: 'Back to', type: 'choice', options: [{ value: 'london', label: 'London Stock' }, { value: 'dubai', label: 'Dubai Stock' }, { value: 'hk', label: 'HK Situation (in hand)' }] },
      { key: 'notes', label: 'Notes', type: 'longtext' },
    ],
    prefill: async (it) => ({ dest: ORIGIN_KEY[it.kind] }),
    run: async ({ db, item, input, user }) => {
      const r = item.data;
      if (text(r.status) !== 'consignment') throw bad('This row is not on consignment');
      const loc = ORIGIN_KEY[item.kind];
      const dest = text(input.dest) || loc;
      if (!PLACE_LABEL[dest]) throw bad(`Back to: "${input.dest}" is not London, Dubai or HK`);
      const notes = text(input.notes, 2000);
      const consignRecord = r.consignment ? { ...r.consignment, photosAfter: [] } : null;
      const id = r.stockNumber || r.id;
      let created = null;
      if (dest === 'hk') {
        await softDelete(db, item.id, user);
        const hkRow = {
          stockNumber: r.stockNumber || '',
          brand: r.brand || '',
          section: 'in_hand',
          holder: '',
          stockStatus: 'IN HAND',
          description: `${r.watchModel || ''} ${r.watchReference ? `| Ref ${r.watchReference}` : ''} | Recalled from consignment${notes ? ` — ${notes}` : ''}`.trim(),
          notes: notes || (r.notes || ''),
          movements: [],
          photos: Array.isArray(r.photos) ? [...r.photos] : [],
        };
        if (consignRecord) hkRow.consignmentRecord = consignRecord;
        created = await insertItem(db, 'hkSituation', hkRow, user);
        await logActivity(db, `↩️ Stock #${id} recalled from consignment → HK Situation${notes ? ` (${notes})` : ''}`, user);
      } else if (dest !== loc) {
        await softDelete(db, item.id, user);
        const movedRow = { ...r, status: 'current', id: uid() };
        delete movedRow.consignment;
        if (consignRecord) movedRow.consignmentRecord = consignRecord;
        if (notes) movedRow.notes = (movedRow.notes ? `${movedRow.notes} | ` : '') + notes;
        created = await insertItem(db, PLACE_KIND[dest], movedRow, user);
        await logActivity(db, `↩️ Stock #${id} recalled from consignment → ${PLACE_LABEL[dest]} Stock${notes ? ` (${notes})` : ''}`, user);
      } else {
        const next = { ...r, status: 'current', consignment: undefined };
        if (consignRecord) next.consignmentRecord = consignRecord;
        if (notes) next.notes = (r.notes ? `${r.notes} | ` : '') + notes;
        await patchItem(db, item, next, user);
        await logActivity(db, `↩️ Stock #${id} recalled from consignment → back to ${PLACE_LABEL[loc]} Stock${notes ? ` (${notes})` : ''}`, user);
      }
      return { message: `Moved back to ${PLACE_WORDS[dest]}`, created: created ? [created.id] : [], open: created ? `#/lg/${created.id}` : undefined };
    },
  },
  {
    key: 'cons-sold',
    label: 'Mark sold',
    kinds: ['londonStock', 'dubaiStock', 'hkStock', 'incomings'],
    form: SALE_FORM,
    prefill: async () => ({ soldCurrency: 'USD', soldDate: localToday(), soldFromLocation: '' }),
    run: async ({ db, item, input, user, ctx }) => {
      const row = item.data;
      const price = amountOf(input.soldPrice, 'Sold price');
      if (price <= 0) throw bad('Sold price required');
      const currency = currencyOf(input.soldCurrency, 'USD');
      const buyer = buyerOf(input, ctx);
      const sourceKey = ORIGIN_KEY[item.kind];
      const usd = await usdOf(price, currency);
      const snap = JSON.parse(JSON.stringify(row));
      // Sold while on consignment: the snapshot comes back as active stock if the sale is cancelled.
      if (snap.status === 'consignment') {
        snap.status = 'current';
        delete snap.consignment;
      }
      const ready = {
        ...specOf(row),
        originLocation: ORIGIN_LABEL[sourceKey],
        originKey: sourceKey,
        originRow: snap,
        soldPrice: price,
        soldCurrency: currency,
        soldPriceUsd: usd ?? 0,
        soldDate: dayOf(input.soldDate, 'Sold on'),
        soldToBuyer: buyer.name,
        ...(buyer.id ? { soldToClientId: buyer.id } : {}),
        soldFromLocation: text(input.soldFromLocation, 200),
        soldNotes: text(input.soldNotes, 2000),
        photos: [],
        shipmentId: null,
        status: 'pending_ship',
      };
      const made = await insertItem(db, 'readyForDelivery', ready, user);
      await softDelete(db, item.id, user);
      await logActivity(db, `💵 SOLD ${stockWords(ready)} · ${currency} ${money(price)} ≈ $${money(ready.soldPriceUsd)} · from ${ready.originLocation}${buyer.name ? ` to ${buyer.name}` : ''} → 📦 Ready for Delivery`, user);
      const rate = usd === null ? ` — no rate for ${currency}: the dollar figure is left at 0` : '';
      return { message: `Sold · ${currency} ${money(price)} → Ready for Delivery${await notOurs(ready.stockNumber)}${rate}. WhatsApp is not sent from here — the confirmation to copy:\n${soldWhatsApp(ready)}`, created: [made.id], open: '#/logistics/shipments' };
    },
  },
  {
    key: 'cons-delete',
    label: 'Delete row',
    kinds: ['londonStock', 'dubaiStock'],
    danger: true,
    run: async ({ db, item, user }) => {
      if (text(item.data.status) !== 'consignment') throw bad('Only a row on consignment is deleted here — a watch in stock should be moved, not deleted');
      await softDelete(db, item.id, user);
      return { message: 'Row deleted', open: '#/logistics/consignment' };
    },
  },

  /* ── Refinement: external watches at polish ── */
  {
    key: 'ref-add',
    label: 'Send external watch to polish',
    kinds: null,
    page: 'refinement',
    form: EXT_POLISH_FORM,
    prefill: async () => ({ sentDate: localToday(), costCurrency: 'USD' }),
    run: async ({ db, input, user }) => {
      const fields = extPolishOf(input);
      const row = await insertItem(db, 'externalPolish', { ...fields, photos: [], status: 'at_polish', returnDate: '', returnNotes: '', returnPhotos: [] }, user);
      await logActivity(db, `✨ External watch sent to polish: ${fields.description} → ${fields.sentTo}`, user);
      return { message: `✨ Sent to polish${/^\d{3,4}$/.test(fields.description) ? await notOurs(fields.description) : ''}`, created: [row.id] };
    },
  },
  {
    key: 'ref-done',
    label: 'Mark done',
    kinds: ['externalPolish'],
    form: [
      { key: 'returnDate', label: 'Returned on', type: 'date' },
      { key: 'returnNotes', label: 'Notes', type: 'longtext' },
    ],
    prefill: async () => ({ returnDate: localToday() }),
    run: async ({ db, item, input, user }) => {
      if (text(item.data.status) === 'done') throw bad('This polish is already done');
      await patchItem(db, item, { ...item.data, status: 'done', returnDate: dayOf(input.returnDate, 'Returned on'), returnNotes: text(input.returnNotes, 2000), returnPhotos: Array.isArray(item.data.returnPhotos) ? item.data.returnPhotos : [] }, user);
      await logActivity(db, `✅ External polish done: ${text(item.data.description, 300)}`, user);
      return { message: '✅ Marked as returned' };
    },
  },
  {
    key: 'ref-edit',
    label: 'Edit polish',
    kinds: ['externalPolish'],
    form: EXT_POLISH_FORM,
    prefill: async (it) => ({ ...it.data, costCurrency: it.data.costCurrency || 'USD' }),
    run: async ({ db, item, input, user }) => {
      const fields = extPolishOf(input);
      await patchItem(db, item, { ...item.data, ...fields }, user);
      await logActivity(db, `✏️ External polish edited: ${fields.description}`, user);
      return { message: 'Updated' };
    },
  },
  {
    key: 'ref-delete',
    label: 'Delete polish',
    kinds: ['externalPolish'],
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      return { message: 'Deleted', open: '#/logistics/refinement' };
    },
  },
];

/* A typed accessories list, or the app's array form, as words. */
function listWords(v) {
  if (!v) return '';
  return (Array.isArray(v) ? v : String(v).split(',')).map((s) => text(typeof s === 'object' && s ? s.name || s.accessory : s)).filter(Boolean).join(', ');
}

/* A stock row picked on the page (the app's consignment picker), locked. */
async function pickStock(db, id) {
  const { rows } = await db.query("SELECT * FROM logistics_items WHERE id = $1 AND deleted_at IS NULL AND kind IN ('londonStock', 'dubaiStock') FOR UPDATE", [Number(id) || 0]);
  if (!rows[0]) throw bad('Pick the watch');
  if (!['', 'current'].includes(text(rows[0].data.status))) throw bad(`That row is ${text(rows[0].data.status)}, not in stock`);
  return rows[0];
}

/* The pool, for a form built outside a transaction (listKind takes anything with .query). */
const pool = () => ({ query });

/*
 * Extra typed fields for the Add / Edit forms: the app's sale form and what
 * finalizeReadyAsSold writes, so every field of a sale has a proper control.
 */
const f = (key, label, type = 'text', more = {}) => ({ key, label, type, ...more });
const SALE_EXTRA = [
  f('soldToClientId', 'Buyer — our client', 'client'),
  f('soldPriceUsd', 'Sold for, in dollars', 'money', { fixedCurrency: 'USD' }),
  f('originKey', 'Sold from (list)', 'enum', { options: ['london', 'dubai', 'hk', 'incomings'] }),
  f('originLocation', 'Sold from (the app’s words)'),
  f('shipmentId', 'Shipment (the app’s id)'),
];
export const FIELDS = {
  soldStocks: [...SALE_EXTRA, f('deliveryNotes', 'Delivery notes', 'longtext')],
  readyForDelivery: SALE_EXTRA,
  externalPolish: [f('returnNotes', 'Return notes', 'longtext')],
};
