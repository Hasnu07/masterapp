/*
 * What every logistics page shares: the catalog's kinds, the logistics
 * clients by id, a few readers of the app's loosely typed values, and the
 * link from a stock number to OUR watch and its clients — the one rule every
 * tab keeps (asked, each time: "our rule of stock no and clients stays").
 */
import { query } from '../db/index.js';
import { displayTitle } from '../watches/fields.js';
import { clientName } from '../clients/index.js';
import { config } from '../config.js';
import { KIND } from './kinds.js';
import * as situation from './situation.js';

export const photoPrefix = () => {
  try {
    return `${new URL(config.vault.url).origin}/photos/`;
  } catch {
    return '';
  }
};

/* A kind the app added that this catalog does not know yet still has a page. */
export const kindOf = (key) =>
  KIND[key] || {
    key,
    label: String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()),
    group: 'log',
    summary: (d) => ({ title: String(d.title || d.name || d.description || d.text || d.id || key), date: d.ts || d.createdAt || d.date }),
  };

/*
 * A logistics client's id as records name it: the app's own, or — for one
 * added here, which has none — "ma-" and our row's id.
 */
export const CLIENT_ID = "COALESCE(source_id, 'ma-' || id)";

/* The logistics clients by id, for every summary that names one. */
export async function context() {
  const { rows } = await query(`SELECT ${CLIENT_ID} AS id, data->>'name' AS name FROM logistics_items WHERE kind = 'clients'`);
  const names = new Map(rows.map((r) => [r.id, r.name || '']));
  const client = (id) => (id ? names.get(String(id)) || '' : '');
  return { client, route: (d) => situation.route(d, client), stage: situation.stage };
}

export const text = (v) => (v === null || v === undefined || v === false ? '' : String(v).trim());
const TICK = /^(true|✓|✔|yes|y|x|1)$/i;
const UNTICKED = /^(false|no|n|0)$/i;
/* A tick field that may instead say where or why: '' when unticked, 'yes' for a bare tick, else its words. */
export const ticked = (v) => (UNTICKED.test(text(v)) ? '' : TICK.test(text(v)) ? 'yes' : text(v));
export const iso = (v) => {
  const t = situation.when(v);
  return t ? new Date(t).toISOString() : null;
};
/* A day as the app wrote it (YYYY-MM-DD stays itself — no time zone moves it); milliseconds become a moment. */
export const dayOf = (v) => (/^\d{4}-\d{2}-\d{2}/.test(text(v)) ? text(v).slice(0, 10) : iso(v));
export function picturesOf(d) {
  const prefix = photoPrefix();
  const all = (Array.isArray(d.photos) ? d.photos : []).filter((v) => typeof v === 'string' && (/^lgfile:\d+$/.test(v) || (prefix && v.startsWith(prefix))));
  return { picture: all[0] || null, photo_count: all.length };
}

/*
 * Our watch of a record's stock number, and the clients Chrono Key ties it to
 * — bought from, sold to — by id, never by a typed name: so a row on these
 * pages links to our stock and to our client in one go.
 */
export async function oursByStock(rows) {
  const byNo = await oursByNumber(rows.flatMap((r) => r.stock_nos || []));
  return (r) => (r.stock_nos || []).map((s) => byNo.get(s)).find(Boolean) || null;
}
export async function oursByNumber(list) {
  const nos = [...new Set(list)];
  if (!nos.length) return new Map();
  const person = (col) =>
    `(SELECT jsonb_build_object('id', c.id, 'forename', c.forename, 'surname', c.surname, 'nickname', c.nickname, 'company', c.company)
        FROM clients c WHERE c.id = w.${col} AND c.deleted_at IS NULL)`;
  const { rows: ours } = await query(
    `SELECT w.id, w.stock_no, w.brand, w.model, w.reference, w.serial, w.watch_date, w.status,
            (SELECT p.id FROM watch_photos p WHERE p.watch_id = w.id AND p.deleted_at IS NULL ORDER BY p.sort, p.id LIMIT 1) AS photo_id,
            ${person('purchased_from_client_id')} AS bought_from, ${person('sold_to_client_id')} AS sold_to
       FROM watches w WHERE w.stock_no = ANY($1) AND w.deleted_at IS NULL`,
    [nos]
  );
  const who = (c) => (c ? { id: c.id, name: clientName(c) } : null);
  return new Map(
    ours.map((w) => [
      w.stock_no,
      {
        id: w.id,
        stock_no: w.stock_no,
        title: displayTitle(w),
        brand: w.brand || '',
        model: w.model || '',
        reference: w.reference || '',
        serial: w.serial || '',
        watch_date: w.watch_date || '',
        status: w.status,
        photo_id: w.photo_id,
        bought_from: who(w.bought_from),
        sold_to: who(w.sold_to),
      },
    ])
  );
}

export const NOW_IN_PLACE = "COALESCE(data->>'status','') IN ('', 'current', 'consignment')";
