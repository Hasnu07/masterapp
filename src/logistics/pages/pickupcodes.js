/*
 * Pickup Codes: the logistics app's "Pickup Codes" page (its
 * renderPickupCodes) — a secret code sent to two WhatsApp chats: Person A,
 * the collector / sender, gets the message with the address and the code;
 * Person B, the holder / receiver, gets the other message and the same code.
 * The collector shows the code to receive the item. The app shows three
 * figures (pending, completed, total) and a card per code: the code, its
 * type (pickup / delivery), its status, both messages, the address, the day
 * and time window, each person and whether their message went.
 *
 * The two message texts are built here exactly as the app builds them
 * (buildPickupMessage), so they can be copied — sending them, generating a
 * new code, assigning a chat, marking done and deleting change records or
 * send messages through the app's WhatsApp bridge: they wait for the
 * switch-over, and a card opens its record.
 *
 * The address is the saved one (Logistics Addresses) by the app's addressId
 * — read live, so a corrected address shows corrected — else the words the
 * code kept. A stock number typed into a message or the notes ("Stock #
 * 1229", or a bare number that is our watch) links to OUR watch and its
 * clients, the rule every tab keeps. A person here is a WhatsApp chat, not
 * a client: shown by name, never linked by it.
 */
import { query } from '../../db/index.js';
import { text, iso, dayOf } from '../shared.js';
import { oursInWords, stocksOf, stockNosIn } from './goldsouk.js';

/* The app's own words for the day (en-GB, "28 September 2026") and the time window. */
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDay = (v) => {
  const m = text(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${LONG_MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}` : text(v) || '—';
};
const timeWindow = (d) => (text(d.timeFrom) ? (text(d.timeTo) ? `${text(d.timeFrom)} - ${text(d.timeTo)}` : text(d.timeFrom)) : '');

/** The message for Person A (collector) or B (holder), word for word as the app sends it. */
export function messageFor(d, who, address) {
  const isPickup = d.type !== 'delivery';
  const time = timeWindow(d);
  let message;
  if (who === 'A') {
    message = text(d.messageA) || (isPickup ? 'Please collect item' : 'Please deliver item');
    if (address) message += `\n${address}`;
    if (time) message += `\n\n⏰ Time: ${time}`;
  } else {
    message = text(d.messageB) || (isPickup ? 'Someone is coming to collect' : 'Expecting a delivery');
    if (time) message += `\n\n⏰ Time: ${time}`;
  }
  message += `\n📅 Date: ${longDay(d.date)}`;
  message += `\n\n🔑 Pickup code: ${text(d.code)}`;
  return message;
}

/* A moment the app wrote in full ("2026-09-28T10:31:36.949Z") keeps its time; a day or milliseconds read as everywhere. */
const moment = (v) => (/^\d{4}-\d{2}-\d{2}T/.test(text(v)) && Number.isFinite(Date.parse(text(v))) ? new Date(Date.parse(text(v))).toISOString() : iso(v));

const personOf = (p) => (p && typeof p === 'object' && text(p.name) ? { name: text(p.name), group: /@g\.us$/.test(text(p.id)) } : null);
const wordsOf = (r) => [r.data?.messageA, r.data?.messageB, r.data?.notes];
const stocksIn = (r) => stockNosIn(...wordsOf(r));

/** The page's data (GET /api/logistics/page/pickupcodes). */
export async function page() {
  const [{ rows }, { rows: addrRows }] = await Promise.all([
    query("SELECT * FROM logistics_items WHERE kind = 'pickupCodes' AND deleted_at IS NULL ORDER BY id"),
    query("SELECT id, source_id, data FROM logistics_items WHERE kind = 'logisticsAddresses' AND deleted_at IS NULL"),
  ]);
  const addresses = new Map(addrRows.map((a) => [a.source_id, { id: a.id, name: text(a.data?.name), address: text(a.data?.address), notes: text(a.data?.notes) }]));
  const ours = await oursInWords(wordsOf, rows);
  const codes = rows
    .map((r) => {
      const d = r.data || {};
      const saved = text(d.addressId) ? addresses.get(text(d.addressId)) : null;
      const address = saved
        ? { ...saved, saved: true }
        : text(d.address) || text(d.addressName)
          ? { id: null, name: text(d.addressName), address: text(d.address), notes: '', saved: false }
          : null;
      const status = d.status === 'completed' ? 'completed' : d.status === 'pending' || !text(d.status) ? 'pending' : 'cancelled';
      return {
        id: r.id,
        code: text(d.code),
        type: d.type === 'delivery' ? 'delivery' : 'pickup',
        status,
        status_word: text(d.status),
        date: dayOf(d.date),
        time_from: text(d.timeFrom),
        time_to: text(d.timeTo),
        message_a: text(d.messageA),
        message_b: text(d.messageB),
        address,
        person_a: personOf(d.personA),
        person_b: personOf(d.personB),
        sent_a: iso(d.messageSentA),
        sent_b: iso(d.messageSentB),
        notes: text(d.notes),
        created_at: moment(d.createdAt),
        completed_at: moment(d.completedAt),
        text_a: messageFor(d, 'A', address?.address || ''),
        text_b: messageFor(d, 'B', ''),
        stocks: stocksOf(wordsOf(r), ours),
        locked: (r.locked_fields || []).length > 0,
      };
    })
    // The app keeps the newest code first.
    .sort((a, b) => String(b.created_at || b.date || '').localeCompare(String(a.created_at || a.date || '')) || b.id - a.id);
  return {
    counts: {
      pending: codes.filter((c) => c.status === 'pending').length,
      completed: codes.filter((c) => c.status === 'completed').length,
      total: codes.length,
    },
    codes,
  };
}

/** What this page knows about one watch: "Pickup code <code> for <person A> at <address>". */
export function forStock(stockNo, rows) {
  const out = [];
  for (const r of rows) {
    if (r.kind !== 'pickupCodes') continue;
    const d = r.data || {};
    const inWords = () => {
      const { explicit, bare } = stocksIn(r);
      return explicit.includes(stockNo) || bare.includes(stockNo);
    };
    if (!(r.stock_nos || []).includes(stockNo) && !inWords()) continue;
    const who = personOf(d.personA)?.name;
    const where = text(d.addressName) || text(d.address).split('\n')[0];
    const done = d.status === 'completed';
    out.push({
      text: `${d.type === 'delivery' ? 'Delivery' : 'Pickup'} code ${text(d.code) || '?'}${who ? ` for ${who}` : ''}${where ? ` at ${where}` : ''}${done ? ' (completed)' : d.status && d.status !== 'pending' ? ` (${text(d.status)})` : ''}`,
      link: `#/lg/${r.id}`,
      tone: done ? 'good' : 'move',
    });
  }
  return out;
}
