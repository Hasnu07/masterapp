/*
 * Other Receiving Pics: the logistics app's "Other Receiving Pics" page
 * (`renderOtherReceivingPics`) — sets of pictures taken when something was
 * received that is not one of the stock lists' own photos: a client's
 * passport, a box of parts, a friend's watch. One entry = { id, clientName,
 * notes, photos: [...], createdAt }, newest first; the app shows the first
 * four pictures and "+n more", a click opens the picture full size.
 *
 * The pictures are our copies ("lgfile:<id>", served behind the sign-in).
 * The typed client name links through linksByName — to our client as far as
 * the logistics client of that name is linked, never by the name alone. A
 * stock number in the entry is OUR watch (the sync reads `stockNumber`).
 */
import { query } from '../../db/index.js';
import { text, iso, oursByNumber, photoPrefix } from '../shared.js';
import { linksByName } from '../clients.js';

/* Every picture in the entry we can serve, and how many could not be read. */
function photosOf(d) {
  const prefix = photoPrefix();
  const all = Array.isArray(d.photos) ? d.photos : [];
  const photos = all.filter((v) => typeof v === 'string' && (/^lgfile:\d+$/.test(v) || (prefix && v.startsWith(prefix))));
  return { photos, unreadable: all.filter((v) => v === 'lgfile:unreadable').length };
}

/** The page's data (GET /api/logistics/page/otherreceiving). */
export async function page() {
  const { rows } = await query("SELECT * FROM logistics_items WHERE kind = 'otherReceivingPics' AND deleted_at IS NULL ORDER BY id");
  const [links, ours] = await Promise.all([linksByName(rows.map((r) => text(r.data?.clientName))), oursByNumber(rows.flatMap((r) => r.stock_nos || []))]);
  const entries = rows
    .map((r) => {
      const d = r.data || {};
      const name = text(d.clientName);
      return {
        id: r.id,
        client_name: name,
        link: links.get(name) || null,
        notes: text(d.notes),
        ...photosOf(d),
        created_at: iso(d.createdAt) || iso(d.ts) || new Date(r.created_at).toISOString(),
        locked: (r.locked_fields || []).length > 0,
        stock_nos: r.stock_nos || [],
        watches: (r.stock_nos || []).map((s) => ours.get(s)).filter(Boolean),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
  return { entries, photos: entries.reduce((n, e) => n + e.photos.length, 0) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayWords = (isoDay) => {
  const m = String(isoDay || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
};

/** "Receiving pictures from Josh, 25 Aug 2026 (3 photos)" on the watch's card and page. */
export function forStock(stockNo, rows) {
  return rows
    .filter((r) => r.kind === 'otherReceivingPics')
    .map((r) => {
      const d = r.data || {};
      const { photos } = photosOf(d);
      const who = text(d.clientName);
      const day = dayWords(iso(d.createdAt) || iso(d.ts));
      return {
        text: `Receiving pictures${who ? ` from ${who}` : ''}${day ? `, ${day}` : ''}${photos.length ? ` (${photos.length} photo${photos.length === 1 ? '' : 's'})` : ''}`,
        link: `#/lg/${r.id}`,
        tone: '',
      };
    });
}
