/*
 * The Dubai-side pages — Driver Deliveries, Pickup Codes, Logistics
 * Addresses, Gold Souk — the logistics app's workflows, done here (asked 27
 * Oct 2026). Each action does what the app's own function does, record for
 * record, read from its index.html:
 *
 *   dd-…    confirmDriver (give to driver), confirmDriverDeliver (mark
 *           delivered), deleteDriverDelivery; the app has no "returned"
 *           button — dd-return is ours, for the status kinds.js already
 *           names
 *   pc-…    savePickupCode (new / edit), pcSetPerson, the sent stamp the
 *           WhatsApp bridge writes (messageSentA / B — here "Mark as sent",
 *           the bridge is not available), completePickupCode,
 *           deletePickupCode; the code as generatePickupCode makes one
 *   addr-…  saveAddress (add / edit), deleteAddress
 *   gs-…    confirmGoldSouk (new / edit), confirmGoldSoukDone,
 *           deleteGoldSoukTask
 *
 * Photos (the driver's handover and proof pictures, a task's before and
 * result pictures) go through POST /api/logistics/items/:id/files?field=…,
 * which appends "lgfile:<id>" to the record's list — the pages offer it.
 * Our rule: a stock number is OUR watch — the message says which are not;
 * a driver, a shop, a person stay the typed names the app keeps.
 */
import { randomInt } from 'node:crypto';
import { insertItem, patchItem, softDelete, logActivity, listKind, text, dayOf, amountOf, bad } from '../write.js';
import { stockList } from '../kinds.js';
import { oursByNumber } from '../shared.js';
import * as DB from '../../db/index.js';

/* Which of these numbers are our watches, for the message. */
async function oursNote(nos) {
  const list = stockList(nos);
  if (!list.length) return '';
  const ours = await oursByNumber(list);
  const not = list.filter((n) => /^\d/.test(n) && !ours.get(n));
  return not.length ? ` · #${not.join(', #')} not one of our watches` : '';
}
const today = () => new Date().toISOString().slice(0, 10);
const timeOf = (v, label) => {
  const s = text(v, 10);
  if (s && !/^\d{1,2}:\d{2}$/.test(s)) throw bad(`${label}: "${s}" is not HH:MM`);
  return s;
};
const fmt = (n) => Number(n || 0).toLocaleString('en-GB');

/* ── driver deliveries ── */

const DD_MONEY_CURRENCIES = ['AED', 'USD', 'EUR', 'GBP', 'HKD', 'CHF'];

/* ── pickup codes ── */

/* generatePickupCode: ten characters out of A–Z and 0–9. */
const PC_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export function generatePickupCode() {
  let code = '';
  for (let i = 0; i < 10; i++) code += PC_CHARS[randomInt(PC_CHARS.length)];
  return code;
}
const addressChoice = async () => {
  const rows = await listKind(DB, 'logisticsAddresses');
  return {
    key: 'addressId',
    label: 'Address',
    type: 'choice',
    options: [
      { value: '', label: '— Select a saved address —' },
      ...rows.map((r) => ({
        value: text(r.source_id) || text(r.data?.id),
        label: text(r.data?.name) || 'Address',
      })),
    ],
    hint: 'a saved one from Logistics Addresses — written into the message for Person A',
  };
};
const PC_FIELDS = [
  { key: 'type', label: 'Type', type: 'enum', options: ['pickup', 'delivery'] },
  {
    key: 'code',
    label: 'Code',
    type: 'text',
    required: true,
    hint: 'made for you — change it if you must',
  },
  {
    key: 'messageA',
    label: 'Message for Person A (collector / sender)',
    type: 'longtext',
  },
  {
    key: 'messageB',
    label: 'Message for Person B (holder / receiver)',
    type: 'longtext',
  },
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'timeFrom', label: 'Time from', type: 'text', hint: 'HH:MM' },
  { key: 'timeTo', label: 'Time to', type: 'text', hint: 'HH:MM' },
  {
    key: 'personAName',
    label: 'Person A',
    type: 'text',
    hint: 'a name — the app picks a WhatsApp chat, which is not here',
  },
  { key: 'personBName', label: 'Person B', type: 'text' },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];
/* The form's values as savePickupCode reads them; the address copied from the saved one, as the app does. */
async function pickupData(db, input) {
  const type = text(input.type, 10) === 'delivery' ? 'delivery' : 'pickup';
  const code = text(input.code, 40);
  const messageA = text(input.messageA, 2000);
  const messageB = text(input.messageB, 2000);
  if (!code) throw bad('Enter a code');
  if (!messageA && !messageB) throw bad('Enter at least one message (for Person A or B)');
  const addressId = text(input.addressId, 60);
  let addrRec = null;
  if (addressId) {
    addrRec = (await listKind(db, 'logisticsAddresses', "COALESCE(source_id, data->>'id') = $2", [addressId]))[0]?.data || null;
    if (!addrRec) throw bad('No such saved address');
  }
  return {
    type,
    code,
    messageA,
    messageB,
    addressId,
    address: addrRec ? text(addrRec.address, 2000) : '',
    addressName: addrRec ? text(addrRec.name, 200) : '',
    date: dayOf(input.date, 'Date', { blank: '' }),
    timeFrom: timeOf(input.timeFrom, 'Time from'),
    timeTo: timeOf(input.timeTo, 'Time to'),
    notes: text(input.notes, 2000),
    personAName: text(input.personAName, 200),
    personBName: text(input.personBName, 200),
  };
}
/* A person as the app keeps one: a chat id and a name — here the name alone. */
const personOf = (name, had) => (name ? { id: text(had?.id), name } : null);
const personWord = (who) => (who === 'B' ? 'B' : 'A');

/* ── addresses ── */

const ADDR_FIELDS = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'address', label: 'Address', type: 'longtext', required: true },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];
function addressData(input) {
  const name = text(input.name, 200);
  const address = text(input.address, 4000);
  if (!name) throw bad('Enter a name');
  if (!address) throw bad('Enter the address');
  return { name, address, notes: text(input.notes, 2000) };
}

/* ── gold souk ── */

const GS_FIELDS = [
  { key: 'shopName', label: 'Shop / person', type: 'text', required: true },
  { key: 'whoGoing', label: 'Who is going', type: 'text', required: true },
  { key: 'date', label: 'Date', type: 'date' },
  {
    key: 'taking',
    label: 'Taking',
    type: 'longtext',
    hint: 'a stock number written here ("Stock # 1229") is our watch',
  },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];
function taskData(input) {
  const shopName = text(input.shopName, 200);
  const whoGoing = text(input.whoGoing, 200);
  if (!shopName) throw bad('Shop name / person is required.');
  if (!whoGoing) throw bad('Enter who is going.');
  return {
    shopName,
    whoGoing,
    date: dayOf(input.date, 'Date'),
    taking: text(input.taking, 2000),
    notes: text(input.notes, 2000),
  };
}

export const ACTIONS = [
  /* ── Driver Deliveries ── */
  {
    key: 'dd-give',
    label: 'Give to driver',
    kinds: null,
    page: 'driverdeliveries',
    form: [
      { key: 'driverName', label: 'Driver', type: 'text', required: true },
      { key: 'dateGiven', label: 'Date given', type: 'date' },
      {
        key: 'stockNumbers',
        label: 'Stock numbers',
        type: 'stock',
        required: true,
        hint: 'comma separated — each is our watch; add the handover photos on the record after',
      },
      { key: 'destination', label: 'Destination', type: 'text' },
      { key: 'notes', label: 'Notes', type: 'longtext' },
    ],
    prefill: async () => ({ dateGiven: today() }),
    run: async ({ db, input, user }) => {
      const driverName = text(input.driverName, 200);
      const stocks = text(input.stockNumbers, 500);
      if (!driverName) throw bad('Driver name is required.');
      if (!stocks) throw bad('Enter at least one stock #.');
      const destination = text(input.destination, 300);
      const rec = {
        driverName,
        dateGiven: dayOf(input.dateGiven, 'Date given'),
        stockNumbers: stocks,
        destination,
        notes: text(input.notes, 2000),
        givenPhotos: [],
        status: 'out',
        deliveryPhotos: [],
      };
      const row = await insertItem(db, 'driverDeliveries', rec, user);
      await logActivity(db, `🛵 Gave ${stocks} to driver ${driverName}${destination ? ' → ' + destination : ''}`, user);
      return {
        message: `🛵 Recorded — out with driver${await oursNote(stocks)}`,
        open: `#/lg/${row.id}`,
        created: [row.id],
      };
    },
  },
  {
    key: 'dd-deliver',
    label: 'Mark delivered',
    kinds: ['driverDeliveries'],
    form: [
      { key: 'deliveredTo', label: 'Delivered to', type: 'text' },
      { key: 'deliveryLocation', label: 'Location', type: 'text' },
      { key: 'deliveredDate', label: 'Delivered on', type: 'date' },
      {
        key: 'moneyCurrency',
        label: 'Money currency',
        type: 'enum',
        options: DD_MONEY_CURRENCIES,
      },
      {
        key: 'moneyCollected',
        label: 'Money collected',
        type: 'money',
        currency: 'moneyCurrency',
      },
      {
        key: 'deliveryNotes',
        label: 'Delivery notes',
        type: 'text',
        hint: 'e.g. paid cash in full, partial deposit; add the proof photos on the record after',
      },
    ],
    prefill: async (it) => ({
      deliveredTo: it.data.destination || '',
      deliveryLocation: it.data.destination || '',
      deliveredDate: today(),
      moneyCurrency: 'AED',
    }),
    run: async ({ db, item, input, user }) => {
      const d = item.data;
      if (d.status === 'delivered') throw bad('Already marked delivered');
      const moneyCurrency = text(input.moneyCurrency, 4).toUpperCase() || 'AED';
      if (!DD_MONEY_CURRENCIES.includes(moneyCurrency)) throw bad(`Money currency: one of ${DD_MONEY_CURRENCIES.join(', ')}`);
      const moneyCollected = amountOf(input.moneyCollected, 'Money collected');
      const next = {
        ...d,
        status: 'delivered',
        deliveredTo: text(input.deliveredTo, 300),
        deliveryLocation: text(input.deliveryLocation, 300),
        deliveredDate: dayOf(input.deliveredDate, 'Delivered on'),
        moneyCurrency,
        moneyCollected,
        deliveryNotes: text(input.deliveryNotes, 2000),
        deliveryPhotos: Array.isArray(d.deliveryPhotos) ? d.deliveryPhotos : [],
      };
      await patchItem(db, item, next, user);
      await logActivity(db, `✅ Driver ${text(d.driverName)} delivered ${text(d.stockNumbers)}${moneyCollected > 0 ? ` · collected ${moneyCurrency} ${moneyCollected}` : ''}`, user);
      return {
        message: `✅ Marked delivered${moneyCollected > 0 ? ` · ${moneyCurrency} ${fmt(moneyCollected)} collected` : ''}`,
      };
    },
  },
  {
    // Not a button of the app's: the status kinds.js names, for a watch the driver brought back.
    key: 'dd-return',
    label: 'Mark returned',
    kinds: ['driverDeliveries'],
    form: [
      { key: 'returnedDate', label: 'Returned on', type: 'date' },
      { key: 'returnNotes', label: 'Notes', type: 'text' },
    ],
    prefill: async () => ({ returnedDate: today() }),
    run: async ({ db, item, input, user }) => {
      const d = item.data;
      if (d.status === 'delivered') throw bad('Already delivered — not returned');
      await patchItem(
        db,
        item,
        {
          ...d,
          status: 'returned',
          returnedDate: dayOf(input.returnedDate, 'Returned on'),
          returnNotes: text(input.returnNotes, 2000),
        },
        user
      );
      await logActivity(db, `↩️ Driver ${text(d.driverName)} returned ${text(d.stockNumbers)}`, user);
      return { message: 'Marked returned' };
    },
  },
  {
    key: 'dd-delete',
    label: 'Delete delivery',
    kinds: ['driverDeliveries'],
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      return { message: 'Deleted', open: '#/logistics/driverdeliveries' };
    },
  },

  /* ── Pickup Codes ── */
  {
    key: 'pc-new',
    label: 'New code',
    kinds: null,
    page: 'pickupcodes',
    form: async () => [PC_FIELDS[0], PC_FIELDS[1], PC_FIELDS[2], PC_FIELDS[3], await addressChoice(), ...PC_FIELDS.slice(4)],
    prefill: async () => ({
      type: 'pickup',
      code: generatePickupCode(),
      date: today(),
    }),
    run: async ({ db, input, user }) => {
      const v = await pickupData(db, input);
      const rec = {
        type: v.type,
        code: v.code,
        messageA: v.messageA,
        messageB: v.messageB,
        addressId: v.addressId,
        address: v.address,
        addressName: v.addressName,
        date: v.date,
        timeFrom: v.timeFrom,
        timeTo: v.timeTo,
        personA: personOf(v.personAName),
        personB: personOf(v.personBName),
        messageSentA: null,
        messageSentB: null,
        status: 'pending',
        notes: v.notes,
        createdAt: new Date().toISOString(),
      };
      const row = await insertItem(db, 'pickupCodes', rec, user);
      await logActivity(db, '🔐 New ' + v.type + ' code: ' + v.code + ' — ' + (v.messageA || v.messageB), user);
      const nos = [v.messageA, v.messageB, v.notes].flatMap((s) => [...String(s).matchAll(/(?:\bstock\s*(?:no\.?|number|#)?\s*:?\s*#?|#\s*)(\d{3,4})\b/gi)].map((m) => m[1]));
      return {
        message: `Code ${v.code} saved — the messages are on its card, ready to copy; mark each as sent once it went${await oursNote(nos.join(', '))}`,
        open: `#/lg/${row.id}`,
        created: [row.id],
      };
    },
  },
  {
    key: 'pc-edit',
    label: 'Edit code',
    kinds: ['pickupCodes'],
    form: async () => [PC_FIELDS[0], PC_FIELDS[1], PC_FIELDS[2], PC_FIELDS[3], await addressChoice(), ...PC_FIELDS.slice(4)],
    prefill: async (it) => {
      const d = it.data;
      return {
        type: d.type || 'pickup',
        code: d.code,
        messageA: d.messageA,
        messageB: d.messageB,
        addressId: d.addressId || '',
        date: d.date,
        timeFrom: d.timeFrom,
        timeTo: d.timeTo,
        personAName: d.personA?.name || '',
        personBName: d.personB?.name || '',
        notes: d.notes,
      };
    },
    run: async ({ db, item, input, user }) => {
      const v = await pickupData(db, input);
      const d = item.data;
      const next = {
        ...d,
        type: v.type,
        code: v.code,
        messageA: v.messageA,
        messageB: v.messageB,
        addressId: v.addressId,
        address: v.address,
        addressName: v.addressName,
        date: v.date,
        timeFrom: v.timeFrom,
        timeTo: v.timeTo,
        notes: v.notes,
      };
      // As the app: a person is set when named, and kept when the name is left blank.
      if (v.personAName) next.personA = personOf(v.personAName, d.personA);
      if (v.personBName) next.personB = personOf(v.personBName, d.personB);
      await patchItem(db, item, next, user);
      return { message: `Code ${v.code} saved` };
    },
  },
  {
    key: 'pc-person',
    label: 'Set person',
    kinds: ['pickupCodes'],
    form: [
      { key: 'who', label: 'Which person', type: 'enum', options: ['A', 'B'] },
      {
        key: 'name',
        label: 'Name',
        type: 'text',
        hint: 'blank clears them — the app picks a WhatsApp chat, which is not here',
      },
    ],
    prefill: async (it, ctx, query) => ({
      who: personWord(query.who),
      name: it.data[`person${personWord(query.who)}`]?.name || '',
    }),
    run: async ({ db, item, input, user }) => {
      const who = personWord(input.who);
      const name = text(input.name, 200);
      await patchItem(
        db,
        item,
        {
          ...item.data,
          [`person${who}`]: personOf(name, item.data[`person${who}`]),
        },
        user
      );
      return {
        message: name ? `Person ${who}: ${name}` : `Person ${who} cleared`,
      };
    },
  },
  {
    key: 'pc-sent',
    label: 'Mark as sent',
    kinds: ['pickupCodes'],
    form: [
      {
        key: 'who',
        label: 'Sent to',
        type: 'enum',
        options: ['A', 'B'],
        hint: 'the message as the app would send it is on the card — copy it, send it, then mark it here',
      },
    ],
    prefill: async (it, ctx, query) => ({ who: personWord(query.who) }),
    run: async ({ db, item, input, user }) => {
      const who = personWord(input.who);
      const d = item.data;
      await patchItem(db, item, { ...d, [`messageSent${who}`]: Date.now() }, user);
      await logActivity(db, `📱 Pickup code ${text(d.code)} message sent to Person ${who}${d[`person${who}`]?.name ? ` (${text(d[`person${who}`].name)})` : ''}`, user);
      return { message: `Marked sent to Person ${who}` };
    },
  },
  {
    key: 'pc-done',
    label: 'Mark done',
    kinds: ['pickupCodes'],
    run: async ({ db, item, user }) => {
      const d = item.data;
      if (d.status === 'completed') throw bad('Already completed');
      await patchItem(db, item, { ...d, status: 'completed', completedAt: new Date().toISOString() }, user);
      // The app's line reads "pc.description", a field no code has: the message stands in for it.
      await logActivity(db, '✅ Pickup code completed: ' + text(d.code) + ' — ' + (text(d.messageA) || text(d.messageB)), user);
      return { message: 'Marked as completed ✓' };
    },
  },
  {
    key: 'pc-delete',
    label: 'Delete code',
    kinds: ['pickupCodes'],
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      return {
        message: `Code ${text(item.data.code)} deleted`,
        open: '#/logistics/pickupcodes',
      };
    },
  },

  /* ── Logistics Addresses ── */
  {
    key: 'addr-add',
    label: 'Add address',
    kinds: null,
    page: 'addresses',
    form: ADDR_FIELDS,
    run: async ({ db, input, user }) => {
      const v = addressData(input);
      const row = await insertItem(db, 'logisticsAddresses', { ...v, createdAt: new Date().toISOString() }, user);
      await logActivity(db, '📍 New logistics address: ' + v.name, user);
      return { message: 'Address saved ✓', created: [row.id] };
    },
  },
  {
    key: 'addr-edit',
    label: 'Edit address',
    kinds: ['logisticsAddresses'],
    form: ADDR_FIELDS,
    prefill: async (it) => ({
      name: it.data.name,
      address: it.data.address,
      notes: it.data.notes,
    }),
    run: async ({ db, item, input, user }) => {
      const v = addressData(input);
      await patchItem(db, item, { ...item.data, ...v }, user);
      return { message: 'Address saved ✓' };
    },
  },
  {
    key: 'addr-delete',
    label: 'Delete address',
    kinds: ['logisticsAddresses'],
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      return {
        message: `"${text(item.data.name)}" deleted`,
        open: '#/logistics/addresses',
      };
    },
  },

  /* ── Gold Souk ── */
  {
    key: 'gs-new',
    label: 'New task',
    kinds: null,
    page: 'goldsouk',
    form: GS_FIELDS,
    prefill: async () => ({ date: today() }),
    run: async ({ db, input, user }) => {
      const v = taskData(input);
      const row = await insertItem(
        db,
        'goldSoukTasks',
        {
          ...v,
          photos: [],
          status: 'pending',
          resultPhotos: [],
          ts: Date.now(),
        },
        user
      );
      await logActivity(db, `🏅 Gold Souk task: ${v.whoGoing} → ${v.shopName}${v.taking ? ' · taking ' + v.taking : ''}`, user);
      return {
        message: `🏅 Task added${await oursNote(stockNosInWords(v.taking, v.notes))}`,
        open: `#/lg/${row.id}`,
        created: [row.id],
      };
    },
  },
  {
    key: 'gs-edit',
    label: 'Edit task',
    kinds: ['goldSoukTasks'],
    form: GS_FIELDS,
    prefill: async (it) => ({
      shopName: it.data.shopName,
      whoGoing: it.data.whoGoing,
      date: it.data.date,
      taking: it.data.taking,
      notes: it.data.notes,
    }),
    run: async ({ db, item, input, user }) => {
      const v = taskData(input);
      await patchItem(db, item, { ...item.data, ...v }, user);
      await logActivity(db, `✏️ Gold Souk task edited: ${v.whoGoing} → ${v.shopName}`, user);
      return { message: '🏅 Task updated' };
    },
  },
  {
    key: 'gs-done',
    label: 'Mark done',
    kinds: ['goldSoukTasks'],
    form: [
      {
        key: 'resultNotes',
        label: 'Result',
        type: 'longtext',
        hint: 'add the result photos on the record after',
      },
    ],
    run: async ({ db, item, input, user }) => {
      const d = item.data;
      if (d.status === 'done') throw bad('Already done');
      await patchItem(
        db,
        item,
        {
          ...d,
          status: 'done',
          completedAt: Date.now(),
          resultNotes: text(input.resultNotes, 2000),
          resultPhotos: Array.isArray(d.resultPhotos) ? d.resultPhotos : [],
        },
        user
      );
      await logActivity(db, `✅ Gold Souk task done: ${text(d.whoGoing)} → ${text(d.shopName)}`, user);
      return { message: '✅ Task completed' };
    },
  },
  {
    key: 'gs-delete',
    label: 'Delete task',
    kinds: ['goldSoukTasks'],
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      return { message: 'Deleted', open: '#/logistics/goldsouk' };
    },
  },
];

/* "Stock # 1229" written into words — the explicit form, as the pages read it. */
function stockNosInWords(...texts) {
  const out = [];
  for (const t of texts) for (const m of String(t || '').matchAll(/(?:\bstock\s*(?:no\.?|number|#)?\s*:?\s*#?|#\s*)(\d{3,4})\b/gi)) if (!out.includes(m[1])) out.push(m[1]);
  return out.join(', ');
}

/* Extra typed fields for the records' own Edit forms: what the app's dialogs type that kinds.js does not. */
export const FIELDS = {
  driverDeliveries: [
    { key: 'deliveredTo', label: 'Delivered to', type: 'text' },
    { key: 'deliveryLocation', label: 'Delivery location', type: 'text' },
    { key: 'deliveredDate', label: 'Delivered on', type: 'date' },
    {
      key: 'moneyCollected',
      label: 'Money collected',
      type: 'money',
      currency: 'moneyCurrency',
    },
    { key: 'moneyCurrency', label: 'Money currency', type: 'currency' },
    { key: 'deliveryNotes', label: 'Delivery notes', type: 'longtext' },
  ],
  pickupCodes: [
    {
      key: 'type',
      label: 'Type',
      type: 'enum',
      options: ['pickup', 'delivery'],
    },
    { key: 'code', label: 'Code', type: 'text' },
    { key: 'messageA', label: 'Message for A', type: 'longtext' },
    { key: 'messageB', label: 'Message for B', type: 'longtext' },
    { key: 'addressName', label: 'Address name', type: 'text' },
    { key: 'address', label: 'Address', type: 'longtext' },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'timeFrom', label: 'Time from', type: 'text' },
    { key: 'timeTo', label: 'Time to', type: 'text' },
    {
      key: 'status',
      label: 'Status',
      type: 'enum',
      options: ['pending', 'completed', 'cancelled'],
    },
    { key: 'notes', label: 'Notes', type: 'longtext' },
  ],
  logisticsAddresses: [
    { key: 'name', label: 'Name', type: 'text' },
    { key: 'address', label: 'Address', type: 'longtext' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
  ],
  goldSoukTasks: [
    { key: 'shopName', label: 'Shop / person', type: 'text' },
    { key: 'whoGoing', label: 'Who is going', type: 'text' },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'taking', label: 'Taking', type: 'longtext' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
    {
      key: 'status',
      label: 'Status',
      type: 'enum',
      options: ['pending', 'done'],
    },
    { key: 'resultNotes', label: 'Result', type: 'longtext' },
  ],
};
