/*
 * Accessory actions — the logistics app's Transactions, Swaps, Need to give &
 * collect and Missing Accessories workflows, done here. Each `run` is the
 * app's own function ported record for record (saveTransaction,
 * confirmSettle, undoSettlement, deleteTransaction, editAccessoryItem,
 * deleteAccessoryItem, saveSwap, deleteSwap, saveAccCollect,
 * confirmReceiveAccCollect, saveAccGive, confirmDeliverAccGive,
 * recordAccessoryHistory, saveLondonRow's accessory grids), with its field
 * names, value forms and activity lines.
 *
 * Our rule: a stock number is OUR watch (named in the message); a client is
 * one of our logistics clients by its id. The app's "to collect" / "to give"
 * rows carry the client's NAME (its own form offers names): the name is
 * written as the app writes it, and the chosen id beside it
 * (`fromClientId` / `toClientId`), so nothing is ever matched by name.
 *
 * Photos (a settlement's proof, a to-collect entry's pictures) come through
 * the files route after the record exists: the pages offer the control.
 */
import { query } from '../../db/index.js';
import { insertItem, patchItem, softDelete, logActivity, loadItem, text, dayOf, uid, localToday, bad } from '../write.js';
import { CLIENT_ID, oursByNumber } from '../shared.js';
import { stockList } from '../kinds.js';
import { normalizeAccessoryName, parseMissingTokens } from '../pages/missingacc.js';

/* The app's own lists: the generic accessories, and the exact list per brand. */
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
export const BRANDS = Object.keys(BRAND_ACCESSORIES);
const accListFor = (brand) => (brand && Object.hasOwn(BRAND_ACCESSORIES, brand) ? BRAND_ACCESSORIES[brand] : ACCESSORIES);

/* The lists the app searches for the watch's row when it writes accessory history (its _accHistoryTarget, in its order). */
const HISTORY_KINDS = ['londonStock', 'dubaiStock', 'hkStock', 'safeStock', 'soldStocks', 'readyForDelivery', 'incomings'];
/* The app's own label of a stock list, as its row-update activity line names it. */
const LOC_LABEL = { londonStock: '🇬🇧 London', dubaiStock: '🇦🇪 Dubai', hkStock: '🌐 HK Stock', hkSituation: '🌐 HK' };

/* ── readers ──────────────────────────────────────────────────────── */

/* The app's id of a record held here (its own, or the sync's source id). */
export const appId = (it) => text(it.data?.id) || text(it.source_id);
const label = (it) => `${it.accessory}${Number(it.qty) > 1 ? ` × ${it.qty}` : ''}`;
const itemsOf = (d) => (Array.isArray(d.items) ? d.items.filter((x) => x && typeof x === 'object') : []);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* The logistics clients, by the id their records carry. */
async function clientsById(db = { query }) {
  const { rows } = await db.query(`SELECT ${CLIENT_ID} AS id, data->>'name' AS name, data->>'country' AS country FROM logistics_items WHERE kind = 'clients' AND deleted_at IS NULL`);
  return new Map(rows.map((r) => [String(r.id), { id: String(r.id), name: text(r.name), country: text(r.country) }]));
}
const clientChoices = async () =>
  [...(await clientsById()).values()].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })).map((c) => ({ value: c.id, label: `${c.name || c.id}${c.country ? ` (${c.country})` : ''}` }));

/* "Our watch #1668 (in stock)" or "not one of our watches" — our rule, said in the message and the hint. */
async function ourWatchWords(stockNumber) {
  const nos = stockList(stockNumber);
  if (!nos.length) return '';
  const ours = await oursByNumber(nos);
  const found = nos.filter((n) => ours.has(n));
  const missing = nos.filter((n) => !ours.has(n));
  return [found.length && `our watch${found.length > 1 ? 'es' : ''} ${found.map((n) => `#${n}`).join(', ')}`, missing.length && `${missing.map((n) => `#${n}`).join(', ')} not one of our watches`].filter(Boolean).join(' · ');
}

/* The transaction record (locked) the app's id names. */
async function txByAppId(db, id) {
  const { rows } = await db.query("SELECT id FROM logistics_items WHERE kind = 'transactions' AND deleted_at IS NULL AND (data->>'id' = $1 OR source_id = $1) ORDER BY id LIMIT 1", [text(id)]);
  return rows[0] ? loadItem(db, rows[0].id) : null;
}

/* The stock row the app writes accessory history on: the first list, in its order, with a row of that number. */
async function historyRow(db, stockNumber) {
  const sn = text(stockNumber);
  if (!sn) return null;
  const { rows } = await db.query("SELECT id, kind FROM logistics_items WHERE kind = ANY($1) AND deleted_at IS NULL AND btrim(data->>'stockNumber') = $2", [HISTORY_KINDS, sn]);
  const r = rows.sort((a, b) => HISTORY_KINDS.indexOf(a.kind) - HISTORY_KINDS.indexOf(b.kind) || a.id - b.id)[0];
  return r ? loadItem(db, r.id) : null;
}

/* A movement as the app's recordAccessoryHistory / confirmReceiveAccCollect / confirmDeliverAccGive write one. */
const movement = ({ destination, notes, moveType, photos = [] }) => ({
  id: uid(),
  ts: Date.now(),
  date: localToday(),
  destination,
  notes,
  moveType,
  photos: [...photos],
  takenAccessories: [],
  leftSpareAccessories: [],
});

/* The app's _accChanged: a history line only when items, notes or the person moved. */
const accChanged = (was, now) => !was || text(was.items) !== text(now.items) || text(was.notes) !== text(now.notes) || text(was.who) !== text(now.who);

/* The app's recordAccessoryHistory: a movement on the watch's row, the typed note last. */
async function recordAccessoryHistory(db, stockNumber, opt, user) {
  const row = await historyRow(db, stockNumber);
  if (!row) return false;
  const head = opt.changed ? `${opt.title} (updated)` : opt.title;
  const m = movement({
    destination: opt.destination,
    notes: [head, opt.items || '', opt.who ? `${opt.prep} ${opt.who}` : '', opt.notes].filter(Boolean).join(' · '),
    moveType: opt.moveType,
    photos: opt.photos,
  });
  await patchItem(db, row, { ...row.data, movements: [m, ...(Array.isArray(row.data.movements) ? row.data.movements : [])] }, user);
  return true;
}

/* "Box, Links × 3, 2 Pushers" → items as the app's grid would give them. */
export function parseItems(v) {
  const out = [];
  for (const raw of String(v ?? '').split(/[\n,]+/)) {
    const s = raw.replace(/\s+/g, ' ').trim();
    if (!s) continue;
    let m = s.match(/^(.*?)\s*[x×]\s*(\d+)$/i);
    if (m) out.push({ accessory: m[1].trim(), qty: Math.max(parseInt(m[2], 10) || 1, 1) });
    else if ((m = s.match(/^(\d+)\s+(.+)$/))) out.push({ accessory: m[2].trim(), qty: Math.max(parseInt(m[1], 10) || 1, 1) });
    else out.push({ accessory: s, qty: 1 });
  }
  return out.filter((x) => x.accessory);
}

/* The client a form chose: its record, or a refusal. */
async function chosenClient(db, id, { required = true } = {}) {
  const cid = text(id);
  if (!cid) {
    if (required) throw bad('Pick a client');
    return null;
  }
  const c = (await clientsById(db)).get(cid);
  if (!c) throw bad('That client is not in the logistics clients');
  return c;
}

/* ── transactions ─────────────────────────────────────────────────── */

const TX_FORM = [
  { key: 'type', label: 'Type', type: 'enum', options: ['bought', 'sold'], required: true },
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'clientId', label: 'Client', type: 'client', required: true },
  { key: 'stockNumber', label: 'Stock number', type: 'stock', hint: 'our watch' },
  { key: 'brand', label: 'Brand', type: 'choice', options: BRANDS.map((b) => ({ value: b, label: b })) },
  { key: 'reference', label: 'Reference', type: 'text', required: true },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];

/* The typed fields of a transaction, checked as saveTransaction checks them. */
function txFields(input, current = {}) {
  const type = text(input.type) === 'sold' ? 'sold' : text(input.type) === 'bought' ? 'bought' : '';
  if (!type) throw bad('Type: bought or sold');
  const reference = text(input.reference, 200);
  if (!reference) throw bad('Reference required');
  const brand = text(input.brand, 100);
  if (brand && !BRANDS.includes(brand) && brand !== text(current.brand)) throw bad(`Brand: pick one of ${BRANDS.join(', ')}`);
  return { type, date: dayOf(input.date, 'Date'), reference, stockNumber: text(input.stockNumber, 200), brand, notes: text(input.notes, 5000) };
}

export const ACTIONS = [
  {
    key: 'tx-new',
    label: 'New transaction',
    kinds: null,
    page: 'transactions',
    form: [...TX_FORM.slice(0, 6), { key: 'items', label: 'Accessories', type: 'longtext', hint: 'one per line, "Links × 3" for a quantity — bought: what the client still has to give us; sold: what we still owe them' }, TX_FORM[6]],
    prefill: async () => ({ type: 'bought', date: localToday() }),
    run: async ({ db, input, user }) => {
      const f = txFields(input);
      const c = await chosenClient(db, input.clientId);
      // One direction per transaction, as the app: bought → receive (we collect), sold → give.
      const dir = f.type === 'sold' ? 'give' : 'receive';
      const items = parseItems(input.items).map((x) => ({ id: uid(), accessory: x.accessory, qty: x.qty, direction: dir, status: 'pending', settledBy: null }));
      const row = await insertItem(db, 'transactions', { ...f, clientId: c.id, items }, user);
      await logActivity(db, `${f.type === 'bought' ? 'Bought' : 'Sold'} ${f.reference} ${f.type === 'bought' ? 'from' : 'to'} ${c.name}`, user);
      const ours = await ourWatchWords(f.stockNumber);
      return { message: `Transaction saved${items.length ? ` · ${plural(items.length, 'accessory', 'accessories')} pending` : ''}${ours ? ` · ${ours}` : ''}`, created: [row.id], open: `#/lg/${row.id}` };
    },
  },
  {
    key: 'tx-edit',
    label: 'Edit transaction',
    kinds: ['transactions'],
    form: TX_FORM,
    prefill: async (it) => ({ ...it.data, date: String(it.data.date ?? '').slice(0, 10) }),
    run: async ({ db, item, input, user }) => {
      const f = txFields(input, item.data);
      const c = await chosenClient(db, input.clientId);
      await patchItem(db, item, { ...item.data, ...f, clientId: c.id }, user);
      await logActivity(db, `Updated transaction ${f.reference}${f.brand ? ` · ${f.brand}` : ''}`, user);
      const ours = await ourWatchWords(f.stockNumber);
      return { message: `Transaction changed${ours ? ` · ${ours}` : ''}` };
    },
  },
  {
    key: 'tx-item-add',
    label: 'Add accessory',
    kinds: ['transactions'],
    form: async (it) => [
      { key: 'accessory', label: 'Accessory', type: 'text', required: true, hint: accListFor(text(it.data.brand)).join(', ') },
      { key: 'qty', label: 'Quantity', type: 'number' },
    ],
    prefill: async () => ({ qty: 1 }),
    run: async ({ db, item, input, user }) => {
      const accessory = text(input.accessory, 100);
      if (!accessory) throw bad('Name the accessory');
      const qty = Math.max(parseInt(String(input.qty ?? '1'), 10) || 1, 1);
      const dir = item.data.type === 'sold' ? 'give' : 'receive';
      const items = [...itemsOf(item.data), { id: uid(), accessory, qty, direction: dir, status: 'pending', settledBy: null }];
      await patchItem(db, item, { ...item.data, items }, user);
      await logActivity(db, `Updated transaction ${text(item.data.reference)}${item.data.brand ? ` · ${text(item.data.brand)}` : ''}`, user);
      return { message: `${label({ accessory, qty })} added, pending` };
    },
  },
  {
    key: 'tx-item-edit',
    label: 'Change accessory',
    kinds: ['transactions'],
    form: async (it) => [
      { key: 'itemId', label: 'Pending accessory', type: 'choice', options: itemsOf(it.data).filter((x) => x.status !== 'done').map((x) => ({ value: text(x.id), label: label(x) })), required: true },
      { key: 'accessory', label: 'New name', type: 'text', required: true },
      { key: 'qty', label: 'Quantity', type: 'number' },
    ],
    run: async ({ db, item, input, user }) => {
      const it = itemsOf(item.data).find((x) => text(x.id) === text(input.itemId));
      if (!it) throw bad('Pick one of the pending accessories');
      if (it.status === 'done') throw bad('That item is already settled — undo the settlement first');
      const accessory = text(input.accessory, 100);
      if (!accessory) throw bad('Name cannot be empty');
      const qty = parseInt(String(input.qty ?? '1'), 10);
      if (!Number.isFinite(qty) || qty < 1) throw bad('Qty must be 1 or more');
      const oldStr = `${it.accessory} × ${it.qty || 1}`;
      const items = itemsOf(item.data).map((x) => (x === it ? { ...x, accessory, qty } : x));
      await patchItem(db, item, { ...item.data, items }, user);
      await logActivity(db, `✏️ Edited pending accessory on ${text(item.data.reference) || appId(item)}: ${oldStr} → ${accessory} × ${qty}`, user);
      return { message: `${oldStr} → ${accessory} × ${qty}` };
    },
  },
  {
    key: 'tx-item-remove',
    label: 'Remove accessory',
    kinds: ['transactions'],
    danger: true,
    form: async (it) => [{ key: 'itemId', label: 'Pending accessory', type: 'choice', options: itemsOf(it.data).filter((x) => x.status !== 'done').map((x) => ({ value: text(x.id), label: label(x) })), required: true }],
    run: async ({ db, item, input, user }) => {
      const it = itemsOf(item.data).find((x) => text(x.id) === text(input.itemId));
      if (!it) throw bad('Pick one of the pending accessories');
      if (it.status === 'done') throw bad("Settled items can't be deleted — undo the settlement first");
      const words = label(it);
      const items = itemsOf(item.data).filter((x) => x !== it);
      await patchItem(db, item, { ...item.data, items }, user);
      await logActivity(db, `🗑️ Removed pending "${words}" from ${text(item.data.reference) || appId(item)}`, user);
      // The app then offers to delete an emptied transaction: here it stays — Delete transaction is its own button.
      return { message: `${words} removed${items.length ? '' : ' — the transaction has no accessories left'}` };
    },
  },
  {
    key: 'tx-settle',
    label: 'Settle',
    kinds: ['transactions'],
    form: async (it) => {
      const pending = itemsOf(it.data).filter((x) => x.status !== 'done');
      return [
        { key: 'itemId', label: 'What', type: 'choice', options: [{ value: 'all', label: `All pending (${pending.map(label).join(', ') || 'none'})` }, ...pending.map((x) => ({ value: text(x.id), label: label(x) }))] },
        { key: 'notes', label: 'Notes', type: 'longtext', hint: 'proof photos can be added to the settlement on the Accessory History page' },
      ];
    },
    prefill: async () => ({ itemId: 'all' }),
    run: async ({ db, item, input, user }) => {
      const pending = itemsOf(item.data).filter((x) => x.status !== 'done');
      const chosen = text(input.itemId) === 'all' || !text(input.itemId) ? pending : pending.filter((x) => text(x.id) === text(input.itemId));
      if (!chosen.length) throw bad('Nothing pending to settle');
      const direction = chosen[0].direction === 'give' ? 'give' : 'receive';
      const ids = chosen.map((x) => text(x.id));
      const settlement = { id: uid(), txId: appId(item), itemIds: ids, direction, notes: text(input.notes, 2000), photos: [], ts: Date.now() };
      const row = await insertItem(db, 'settlements', settlement, user);
      const items = itemsOf(item.data).map((x) => (ids.includes(text(x.id)) ? { ...x, status: 'done', settlementId: settlement.id } : x));
      await patchItem(db, item, { ...item.data, items }, user);
      const verb = direction === 'give' ? 'Delivered' : 'Received';
      await logActivity(db, `${verb} ${chosen.map((x) => x.accessory).join(', ')} for ${text(item.data.reference)}`, user);
      return { message: `${verb}: ${chosen.map(label).join(', ')}`, created: [row.id] };
    },
  },
  {
    key: 'tx-settle-undo',
    label: 'Undo settlement',
    kinds: ['settlements'],
    danger: true,
    run: async ({ db, item, user }) => {
      const tx = await txByAppId(db, item.data.txId);
      if (tx) {
        const ids = (Array.isArray(item.data.itemIds) ? item.data.itemIds : []).map(String);
        const items = itemsOf(tx.data).map((x) => (ids.includes(text(x.id)) ? { ...x, status: 'pending', settlementId: null, settledBy: null } : x));
        await patchItem(db, tx, { ...tx.data, items }, user);
      }
      await softDelete(db, item.id, user);
      await logActivity(db, `Undid settlement on ${tx ? text(tx.data.reference) : 'unknown'}`, user);
      return { message: 'Settlement undone — the items are pending again', open: tx ? `#/lg/${tx.id}` : '#/logistics/history' };
    },
  },
  {
    key: 'tx-delete',
    label: 'Delete transaction',
    kinds: ['transactions'],
    danger: true,
    run: async ({ db, item, user }) => {
      const id = appId(item);
      // The app drops the swaps that name the transaction.
      const { rows: swaps } = await db.query("SELECT id FROM logistics_items WHERE kind = 'swaps' AND deleted_at IS NULL AND (data->>'giveTxId' = $1 OR data->>'receiveTxId' = $1)", [id]);
      for (const s of swaps) await softDelete(db, s.id, user);
      await softDelete(db, item.id, user);
      await logActivity(db, `Deleted transaction ${text(item.data.reference)}`, user);
      return { message: `Transaction deleted${swaps.length ? ` with ${plural(swaps.length, 'swap')} that named it` : ''}`, open: '#/logistics/transactions' };
    },
  },

  /* ── swaps ── */
  {
    key: 'swap-new',
    label: 'New swap',
    kinds: null,
    page: 'swaps',
    form: async (_item, ctx) => {
      const { rows } = await query("SELECT id, source_id, data FROM logistics_items WHERE kind = 'transactions' AND deleted_at IS NULL ORDER BY id");
      const side = (dir) =>
        rows.flatMap((r) =>
          itemsOf(r.data)
            .filter((x) => x.status === 'pending' && (x.direction === 'give') === (dir === 'give'))
            .map((x) => ({ value: `${r.id}|${text(x.id)}`, label: `${ctx.client(r.data.clientId) || '?'} · ${text(r.data.reference)} · ${text(x.accessory)}${Number(x.qty) > 1 ? ` ×${x.qty}` : ''}` }))
        );
      return [
        { key: 'give', label: 'We give (an item we owe)', type: 'choice', options: side('give'), required: true },
        { key: 'receive', label: 'We receive (an item owed to us)', type: 'choice', options: side('receive'), required: true },
        { key: 'notes', label: 'Notes', type: 'longtext' },
      ];
    },
    run: async ({ db, input, user }) => {
      const pick = async (v, dir) => {
        const [rowId, itemId] = String(v ?? '').split('|');
        if (!rowId || !itemId) throw bad('Pick both items');
        const tx = await loadItem(db, rowId);
        if (tx.kind !== 'transactions') throw bad('Pick both items');
        const it = itemsOf(tx.data).find((x) => text(x.id) === itemId);
        if (!it || it.status !== 'pending' || (it.direction === 'give') !== (dir === 'give')) throw bad(`Pick a pending item we ${dir}`);
        return { tx, it };
      };
      const g = await pick(input.give, 'give');
      const r = await pick(input.receive, 'receive');
      const swap = { id: uid(), giveTxId: appId(g.tx), giveItemId: text(g.it.id), receiveTxId: appId(r.tx), receiveItemId: text(r.it.id), notes: text(input.notes, 2000), ts: Date.now() };
      const row = await insertItem(db, 'swaps', swap, user);
      const mark = (tx, it) => itemsOf(tx.data).map((x) => (x === it ? { ...x, status: 'done', settledBy: swap.id } : x));
      if (g.tx.id === r.tx.id) {
        const items = itemsOf(g.tx.data).map((x) => (x === g.it || x === r.it ? { ...x, status: 'done', settledBy: swap.id } : x));
        await patchItem(db, g.tx, { ...g.tx.data, items }, user);
      } else {
        await patchItem(db, g.tx, { ...g.tx.data, items: mark(g.tx, g.it) }, user);
        await patchItem(db, r.tx, { ...r.tx.data, items: mark(r.tx, r.it) }, user);
      }
      await logActivity(db, `Swapped ${g.it.accessory} (${text(g.tx.data.reference)}) ↔ ${r.it.accessory} (${text(r.tx.data.reference)})`, user);
      return { message: `Swap saved: ${g.it.accessory} ↔ ${r.it.accessory}`, created: [row.id] };
    },
  },
  {
    key: 'swap-delete',
    label: 'Delete swap',
    kinds: ['swaps'],
    danger: true,
    run: async ({ db, item, user }) => {
      const reopen = async (txId, itemId) => {
        const tx = await txByAppId(db, txId);
        if (!tx) return;
        const items = itemsOf(tx.data).map((x) => (text(x.id) === text(itemId) ? { ...x, status: 'pending', settledBy: null } : x));
        await patchItem(db, tx, { ...tx.data, items }, user);
      };
      await reopen(item.data.giveTxId, item.data.giveItemId);
      await reopen(item.data.receiveTxId, item.data.receiveItemId);
      await softDelete(db, item.id, user);
      await logActivity(db, 'Removed swap', user);
      return { message: 'Swap deleted — both items are pending again', open: '#/logistics/swaps' };
    },
  },

  /* ── to collect ── */
  ...collectActions(),
  /* ── to give ── */
  ...giveActions(),

  /* ── missing accessories on a stock row ── */
  {
    key: 'acc-missing',
    label: 'Edit what is missing',
    kinds: Object.keys(LOC_LABEL),
    form: async (it) => {
      const list = accListFor(text(it.data.brand));
      return [
        ...list.map((a, i) => ({ key: `acc${i}`, label: a, type: 'bool' })),
        ...(list.some((a) => /^links?$/i.test(a)) ? [{ key: 'linksQty', label: 'How many links', type: 'number' }] : []),
        { key: 'custom', label: 'Other missing items', type: 'text', hint: 'comma separated — e.g. Pusher tool, Spring bar' },
      ];
    },
    prefill: async (it) => {
      const list = accListFor(text(it.data.brand));
      const tokens = String(it.data.accessoriesMissing ?? it.data.missing ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const values = { linksQty: 1 };
      const custom = [];
      for (const tok of tokens) {
        const links = tok.match(/^(\d+)\s*links?$/i);
        const i = links ? list.findIndex((a) => /^links?$/i.test(a)) : list.findIndex((a) => a.toLowerCase() === tok.toLowerCase() || normalizeAccessoryName(a) === normalizeAccessoryName(tok));
        if (i < 0) custom.push(tok);
        else {
          values[`acc${i}`] = true;
          if (links) values.linksQty = Math.max(parseInt(links[1], 10) || 1, 1);
        }
      }
      values.custom = custom.join(', ');
      return values;
    },
    run: async ({ db, item, input, user }) => {
      const list = accListFor(text(item.data.brand));
      const missing = [];
      list.forEach((a, i) => {
        if (!(input[`acc${i}`] === true || /^(true|yes|1|on)$/i.test(String(input[`acc${i}`] ?? '')))) return;
        if (/^links?$/i.test(a)) {
          const n = Math.max(1, parseInt(String(input.linksQty ?? '1'), 10) || 1);
          missing.push(`${n} ${n === 1 ? 'Link' : 'Links'}`);
        } else missing.push(a);
      });
      for (const c of String(input.custom ?? '').split(',').map((s) => s.trim()).filter(Boolean)) if (!missing.some((x) => x.toLowerCase() === c.toLowerCase())) missing.push(c);
      await patchItem(db, item, { ...item.data, accessoriesMissing: missing.join(', ') }, user);
      const present = String(item.data.accessoriesPresent ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      await logActivity(db, `${LOC_LABEL[item.kind]} Stock ${text(item.data.stockNumber)} updated · present: ${present.length} · missing: ${missing.length}`, user);
      const words = parseMissingTokens(missing.join(', ')).map((t) => (t.qty > 1 ? `${t.accessory} × ${t.qty}` : t.accessory));
      return { message: words.length ? `Missing: ${words.join(', ')}` : 'Nothing missing' };
    },
  },
];

/* ── to collect / to give — the app's two "Need to give & collect" lists ── */

function collectActions() {
  const FORM = [
    { key: 'stockNumber', label: 'Stock number', type: 'stock', hint: 'our watch' },
    { key: 'items', label: 'What to collect', type: 'text', required: true, hint: 'comma separated' },
    { key: 'fromClientId', label: 'From client', type: 'client' },
    { key: 'receivedFrom', label: 'Received from', type: 'text' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
  ];
  const values = async (db, input) => {
    const items = text(input.items, 500);
    if (!items) throw bad('Say what is to be collected');
    const c = await chosenClient(db, input.fromClientId, { required: false });
    return { stockNumber: text(input.stockNumber, 100), items, fromClient: c ? c.name : '', fromClientId: c ? c.id : '', receivedFrom: text(input.receivedFrom, 200), notes: text(input.notes, 2000) };
  };
  const hist = (v, photos) => ({ title: 'To collect', destination: 'Pending — Collect Accessories', moveType: 'accessories_pending_collect', prep: 'from', items: v.items, who: v.fromClient, notes: v.notes, photos });
  return [
    {
      key: 'acc-collect-add',
      label: 'Add to collect',
      kinds: null,
      page: 'accessories',
      form: FORM,
      run: async ({ db, input, user }) => {
        const v = await values(db, input);
        const row = await insertItem(db, 'accCollect', { ...v, photos: [] }, user);
        const logged = await recordAccessoryHistory(db, v.stockNumber, hist(v, []), user);
        await logActivity(db, `📥 To collect for Stock #${v.stockNumber}: ${v.items}${v.fromClient ? ` from ${v.fromClient}` : ''}`, user);
        const ours = await ourWatchWords(v.stockNumber);
        return { message: `To collect: ${v.items}${ours ? ` · ${ours}` : ''}${logged ? ' · written on the watch’s history' : ''}`, created: [row.id] };
      },
    },
    {
      key: 'acc-collect-edit',
      label: 'Edit',
      kinds: ['accCollect'],
      form: FORM,
      prefill: async (it) => ({ ...it.data, fromClientId: text(it.data.fromClientId) || (await idOfClientNamed(it.data.fromClient)) }),
      run: async ({ db, item, input, user }) => {
        const v = await values(db, input);
        const changed = accChanged({ items: item.data.items, notes: item.data.notes, who: item.data.fromClient }, { items: v.items, notes: v.notes, who: v.fromClient });
        await patchItem(db, item, { ...item.data, ...v }, user);
        if (changed) await recordAccessoryHistory(db, v.stockNumber, { changed: true, ...hist(v, item.data.photos || []) }, user);
        return { message: 'Entry changed' };
      },
    },
    {
      key: 'acc-collect-done',
      label: 'Mark collected',
      kinds: ['accCollect'],
      form: [{ key: 'extra', label: 'Note for the history', type: 'longtext', hint: 'optional — pictures of the handover go on the entry first (Add photos)' }],
      run: async ({ db, item, input, user }) => {
        const d = item.data;
        const sn = text(d.stockNumber);
        const items = text(d.items) || text(d.notes) || '(accessories)';
        const from = text(d.receivedFrom) || text(d.fromClient);
        const photos = Array.isArray(d.photos) ? d.photos : [];
        const row = await historyRow(db, sn);
        if (row) {
          const extra = text(input.extra, 500);
          const next = { ...row.data, movements: [movement({ destination: 'Accessories Received', notes: `Accessories received: ${items}${from ? ` from ${from}` : ''}${extra ? ` · ${extra}` : ''}`, moveType: 'accessories_received', photos }), ...(Array.isArray(row.data.movements) ? row.data.movements : [])] };
          if (items) {
            const existing = String(row.data.accessoriesPresent || '').split(',').map((s) => s.trim()).filter(Boolean);
            for (const a of items.split(',').map((s) => s.trim()).filter(Boolean)) if (!existing.includes(a)) existing.push(a);
            next.accessoriesPresent = existing.join(', ');
          }
          await patchItem(db, row, next, user);
        }
        await logActivity(db, `📦 Accessories received for Stock #${sn}: ${items}${from ? ` from ${from}` : ''}${photos.length ? ` (${plural(photos.length, 'photo')})` : ''}`, user);
        await softDelete(db, item.id, user);
        return { message: row ? `Collected — logged to Stock #${sn}'s history` : `Collected — Stock #${sn} has no stock row here, logged to the activity only`, open: '#/logistics/accessories' };
      },
    },
    {
      key: 'acc-collect-delete',
      label: 'Delete',
      kinds: ['accCollect'],
      danger: true,
      run: async ({ db, item, user }) => {
        await softDelete(db, item.id, user);
        await logActivity(db, `🗑️ To collect removed for Stock #${text(item.data.stockNumber)}: ${text(item.data.items)}`, user);
        return { message: 'Entry removed', open: '#/logistics/accessories' };
      },
    },
  ];
}

function giveActions() {
  const FORM = [
    { key: 'stockNumber', label: 'Stock number', type: 'stock', hint: 'our watch' },
    { key: 'items', label: 'What to give', type: 'text', required: true, hint: 'comma separated' },
    { key: 'toClientId', label: 'To client', type: 'client' },
    { key: 'inSafe', label: 'In our safe', type: 'bool' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
  ];
  const values = async (db, input) => {
    const items = text(input.items, 500);
    if (!items) throw bad('Say what is to be given');
    const c = await chosenClient(db, input.toClientId, { required: false });
    return { stockNumber: text(input.stockNumber, 100), items, toClient: c ? c.name : '', toClientId: c ? c.id : '', notes: text(input.notes, 2000), inSafe: input.inSafe === true || /^(true|yes|1|on)$/i.test(String(input.inSafe ?? '')) };
  };
  const hist = (v, photos) => ({ title: 'To give', destination: 'Pending — Give Accessories', moveType: 'accessories_pending_give', prep: 'to', items: v.items, who: v.toClient, notes: v.notes, photos });
  return [
    {
      key: 'acc-give-add',
      label: 'Add to give',
      kinds: null,
      page: 'accessories',
      form: FORM,
      run: async ({ db, input, user }) => {
        const v = await values(db, input);
        const row = await insertItem(db, 'accGive', { ...v, photos: [], inSafeAt: v.inSafe ? Date.now() : null }, user);
        const logged = await recordAccessoryHistory(db, v.stockNumber, hist(v, []), user);
        await logActivity(db, `📤 To give for Stock #${v.stockNumber}: ${v.items}${v.toClient ? ` to ${v.toClient}` : ''}${v.inSafe ? ' (in the safe)' : ''}`, user);
        const ours = await ourWatchWords(v.stockNumber);
        return { message: `To give: ${v.items}${ours ? ` · ${ours}` : ''}${logged ? ' · written on the watch’s history' : ''}`, created: [row.id] };
      },
    },
    {
      key: 'acc-give-edit',
      label: 'Edit',
      kinds: ['accGive'],
      form: FORM,
      prefill: async (it) => ({ ...it.data, toClientId: text(it.data.toClientId) || (await idOfClientNamed(it.data.toClient)) }),
      run: async ({ db, item, input, user }) => {
        const v = await values(db, input);
        const next = { ...item.data, ...v };
        // The day it went into the safe is stamped on the way in only (the app's rule).
        if (v.inSafe && !item.data.inSafe) next.inSafeAt = Date.now();
        if (!v.inSafe) next.inSafeAt = null;
        const changed = accChanged({ items: item.data.items, notes: item.data.notes, who: item.data.toClient }, { items: v.items, notes: v.notes, who: v.toClient });
        await patchItem(db, item, next, user);
        if (changed) await recordAccessoryHistory(db, v.stockNumber, { changed: true, ...hist(v, item.data.photos || []) }, user);
        return { message: 'Entry changed' };
      },
    },
    {
      key: 'acc-give-done',
      label: 'Mark given',
      kinds: ['accGive'],
      form: [{ key: 'extra', label: 'Note for the history', type: 'longtext', hint: 'optional — pictures of the handover go on the entry first (Add photos)' }],
      run: async ({ db, item, input, user }) => {
        const d = item.data;
        const sn = text(d.stockNumber);
        const items = text(d.items) || '(accessories)';
        const to = text(d.toClient);
        const photos = Array.isArray(d.photos) ? d.photos : [];
        const row = await historyRow(db, sn);
        if (row) {
          const extra = text(input.extra, 500);
          const next = { ...row.data, movements: [movement({ destination: 'Accessories Given to Client', notes: `Accessories given: ${items}${to ? ` to ${to}` : ''}${extra ? ` · ${extra}` : ''}`, moveType: 'accessories_given', photos }), ...(Array.isArray(row.data.movements) ? row.data.movements : [])] };
          if (items && row.data.accessoriesMissing !== undefined) {
            const given = items.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
            next.accessoriesMissing = String(row.data.accessoriesMissing || '').split(',').map((s) => s.trim()).filter(Boolean).filter((a) => !given.includes(a.toLowerCase())).join(', ');
          }
          await patchItem(db, row, next, user);
        }
        await logActivity(db, `📤 Accessories given for Stock #${sn}: ${items}${to ? ` to ${to}` : ''}${photos.length ? ` (${plural(photos.length, 'photo')})` : ''}`, user);
        await softDelete(db, item.id, user);
        return { message: row ? `Given — logged to Stock #${sn}'s history` : `Given — Stock #${sn} has no stock row here, logged to the activity only`, open: '#/logistics/accessories' };
      },
    },
    {
      key: 'acc-give-delete',
      label: 'Delete',
      kinds: ['accGive'],
      danger: true,
      run: async ({ db, item, user }) => {
        await softDelete(db, item.id, user);
        await logActivity(db, `🗑️ To give removed for Stock #${text(item.data.stockNumber)}: ${text(item.data.items)}`, user);
        return { message: 'Entry removed', open: '#/logistics/accessories' };
      },
    },
  ];
}

/* The logistics client of exactly this name, for a form opened on a record the app wrote with a name alone. */
async function idOfClientNamed(name) {
  const n = text(name).toLowerCase();
  if (!n) return '';
  const hit = [...(await clientsById()).values()].filter((c) => c.name.toLowerCase() === n);
  return hit.length === 1 ? hit[0].id : '';
}

/* Extra typed fields for the record pages' Add / Edit forms. */
export const FIELDS = {
  accGive: [{ key: 'inSafe', label: 'In our safe', type: 'bool' }],
  accCollect: [{ key: 'fromClientId', label: 'From client (id)', type: 'client' }],
};
