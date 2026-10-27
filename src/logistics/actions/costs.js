/*
 * Logistic Cost actions — the app's "+ Add Cost" (openLogisticCostModal /
 * saveLogisticCost) and the ✏️ / 🗑️ of a line (deleteLogisticCost), done
 * here. The app's form links a line to a Live Shipment ("-- standalone cost,
 * no linked shipment --" else one of them): the line then carries the
 * shipment's id (shipmentId) and both its client ids, and what the form left
 * blank — the stock numbers, from, to, the date — is taken from the shipment,
 * as the app's onLogCostShipmentChange fills them in. A line written for a
 * mover shipment, a trip or a polish carries that record's id instead
 * (thirdPartyShipmentId / tripId / polishId), so the ledger and the record
 * agree on where the money went. The rest of the app's page (print, filters)
 * is read-only and already on the tab.
 */
import { query } from '../../db/index.js';
import { insertItem, patchItem, softDelete, logActivity, listKind, text, dayOf, amountOf, currencyOf, bad, localToday } from '../write.js';
import { clientsOf, byAppId, sideName, splitStockList } from './shipping.js';

/* The app's shipment dropdown: every live shipment, newest first — "stocks · from → to · date". */
async function shipmentChoices(db = { query }) {
  const clients = await clientsOf(db);
  const ships = (await listKind(db, 'shipments')).sort((a, b) => text(b.data.date).localeCompare(text(a.data.date)));
  return [
    { value: '', label: '-- standalone cost, no linked shipment --' },
    ...ships.map((s) => {
      const d = s.data;
      const stocks = splitStockList(d.stockNumber).join(', ') || text(d.items).slice(0, 30);
      return { value: text(d.id), label: `${stocks} · ${sideName(clients.get(text(d.fromClientId)), '', '?')} → ${sideName(clients.get(text(d.toClientId)), '', '?')} · ${text(d.date)}` };
    }),
  ];
}

const costForm = async () => [
  { key: 'title', label: 'What for', type: 'text', required: true },
  { key: 'shipmentId', label: 'Linked shipment', type: 'choice', options: await shipmentChoices() },
  { key: 'stockNumber', label: 'Stock numbers', type: 'stock', hint: 'comma separated — each is our watch when we hold it; blank takes the shipment’s' },
  { key: 'fromName', label: 'From', type: 'text' },
  { key: 'toName', label: 'To', type: 'text' },
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'amount', label: 'Amount', type: 'money', currency: 'currency', required: true },
  { key: 'currency', label: 'Currency', type: 'currency' },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];

/** A cost line as the app's saveLogisticCost writes one; `extra` for the id of what it stands for. */
export function costLine(input, extra = {}) {
  const title = text(input.title, 200);
  if (!title) throw bad('Title is required');
  const amount = amountOf(input.amount, 'Amount');
  if (!amount) throw bad('Amount is required');
  return {
    title,
    shipmentId: text(input.shipmentId, 80) || null,
    stockNumber: text(input.stockNumber, 500),
    fromName: text(input.fromName, 200),
    toName: text(input.toName, 200),
    date: dayOf(input.date, 'Date'),
    currency: currencyOf(input.currency, 'USD'),
    amount,
    notes: text(input.notes, 2000),
    ...extra,
  };
}

/* The linked shipment's ids on the line, and its stock numbers / from / to / date where the form left them blank. */
async function withShipment(db, line, input) {
  if (!line.shipmentId) return line;
  const ship = await byAppId(db, 'shipments', line.shipmentId);
  if (!ship) throw bad('Linked shipment: no live shipment with that id');
  const d = ship.data;
  const clients = await clientsOf(db);
  const fromName = sideName(clients.get(text(d.fromClientId)), '', '');
  const toName = sideName(clients.get(text(d.toClientId)), '', '');
  const out = { ...line, fromClientId: d.fromClientId, toClientId: d.toClientId };
  if (!text(input.stockNumber)) out.stockNumber = splitStockList(d.stockNumber).join(', ');
  if (!text(input.fromName)) out.fromName = fromName;
  if (!text(input.toName)) out.toName = toName;
  if (!text(input.date)) out.date = d.date || localToday();
  return out;
}

export const ACTIONS = [
  {
    key: 'cost-add',
    label: 'Add cost',
    kinds: null,
    page: 'costs',
    form: costForm,
    prefill: async () => ({ currency: 'USD', date: localToday() }),
    run: async ({ db, input, user }) => {
      const line = await withShipment(db, costLine(input), input);
      const row = await insertItem(db, 'logisticCosts', line, user);
      await logActivity(db, `💰 Added logistic cost: ${line.title} · ${line.currency} ${line.amount}`, user);
      return { message: `Cost saved: ${line.currency} ${line.amount.toLocaleString('en-GB')}`, created: [row.id] };
    },
  },
  {
    key: 'cost-edit',
    label: 'Edit cost',
    kinds: ['logisticCosts'],
    form: costForm,
    prefill: async (it) => ({ ...it.data, shipmentId: it.data.shipmentId || '' }),
    run: async ({ db, item, input, user }) => {
      const line = await withShipment(db, costLine(input), input);
      await patchItem(db, item, { ...item.data, ...line }, user);
      await logActivity(db, `Updated logistic cost: ${line.title} · ${line.currency} ${line.amount}`, user);
      return { message: 'Cost saved' };
    },
  },
  {
    key: 'cost-delete',
    label: 'Delete cost',
    kinds: ['logisticCosts'],
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      await logActivity(db, 'Deleted logistic cost', user);
      return { message: `Deleted logistic cost ${text(item.data.currency)} ${Number(item.data.amount) || 0}`, open: '#/logistics/costs' };
    },
  },
];

export const FIELDS = {
  logisticCosts: [
    { key: 'shipmentId', label: 'Live shipment (id)', type: 'text' },
    { key: 'thirdPartyShipmentId', label: 'Mover shipment (id)', type: 'text' },
  ],
};
