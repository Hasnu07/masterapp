/*
 * Logistics Addresses: the logistics app's "Logistics Addresses" page (its
 * renderLogisticsAddresses) — the saved pickup and delivery locations a
 * pickup code is written against: a name, the full address, a note. The
 * app shows them as one table in the order they were saved. Here the same,
 * searchable, each saying how many pickup codes use it (by the app's
 * addressId, else the same words), and with a map link for one that reads
 * as a place — not for the e-mail addresses and web links people also keep
 * here. Adding, editing and deleting wait for the switch-over: a row opens
 * its record. No stock number lives here, so forStock has nothing to say.
 */
import { query } from '../../db/index.js';
import { text, iso } from '../shared.js';

/* What an "address" actually holds: a place, an e-mail (one or more, with nothing else), a web link, or just words. */
const URL_LINE = /^https?:\/\/\S+$/i;
const EMAIL_LINE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_LINE = /^\+?[\d\s()-]{7,}$/;
const LABELLED = /^(recipient|name|contact|tel|phone|mobile|email|e-mail|whatsapp)\s*:/i;
const lines = (s) =>
  text(s)
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
export function kindOfAddress(s) {
  const ls = lines(s);
  if (!ls.length) return 'text';
  if (ls.every((l) => URL_LINE.test(l))) return 'link';
  if (ls.some((l) => EMAIL_LINE.test(l)) && ls.every((l) => !/\s/.test(l))) return 'email';
  // A street line: digits with words around them, that is not a phone, an e-mail or a link.
  const street = (l) => /\d/.test(l) && /[A-Za-z]{3,}/.test(l) && !PHONE_LINE.test(l) && !EMAIL_LINE.test(l) && !URL_LINE.test(l) && !LABELLED.test(l);
  return ls.some(street) ? 'place' : 'text';
}

/* The map search for a place: its lines on one line, less the labelled ones ("Recipient:", "Phone:"), phone numbers, e-mails and links. */
export function mapUrl(address) {
  const ls = lines(address).filter((l) => !LABELLED.test(l) && !PHONE_LINE.test(l) && !EMAIL_LINE.test(l) && !URL_LINE.test(l) && !/^["“].*["”]/.test(l));
  if (!ls.length) return '';
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ls.join(', ').slice(0, 300))}`;
}

/** The page's data (GET /api/logistics/page/addresses). */
export async function page() {
  const [{ rows }, { rows: codes }] = await Promise.all([
    query("SELECT * FROM logistics_items WHERE kind = 'logisticsAddresses' AND deleted_at IS NULL ORDER BY id"),
    query("SELECT id, data FROM logistics_items WHERE kind = 'pickupCodes' AND deleted_at IS NULL ORDER BY id"),
  ]);
  const addresses = rows.map((r) => {
    const d = r.data || {};
    const address = text(d.address);
    const kind = kindOfAddress(address);
    const used = codes
      .filter((c) => (text(c.data?.addressId) && text(c.data?.addressId) === r.source_id) || (address && text(c.data?.address) === address))
      .map((c) => ({ id: c.id, code: text(c.data?.code), status: text(c.data?.status) || 'pending', date: text(c.data?.date) }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.id - a.id);
    return {
      id: r.id,
      name: text(d.name),
      address,
      notes: text(d.notes),
      kind,
      map_url: kind === 'place' ? mapUrl(address) : '',
      created_at: iso(d.createdAt),
      used_by: used,
      locked: (r.locked_fields || []).length > 0,
    };
  });
  // The app shows them as saved, oldest first.
  addresses.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.id - b.id);
  return { count: addresses.length, in_use: addresses.filter((a) => a.used_by.length).length, addresses };
}

/** An address names no watch. */
export function forStock() {
  return [];
}
