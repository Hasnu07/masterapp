/*
 * Gold Souk: the logistics app's "Gold Souk" page (its renderGoldSouk) —
 * shop / person visit tasks: who goes, what they take, the day, notes, the
 * pictures taken when the task was set and when it was done. The app shows
 * two tables, Open and Completed, with a count of each; here the same, plus
 * chips by person and by shop and a search (asked: "filters and grouping as
 * the app (open / done, by person, by shop)").
 *
 * A task names no stock number in a field of its own — "Stock # 1229
 * 5212A-001", "1229 - PP 5212", "Datejust and 1411 Daytona" are typed into
 * `taking`. So the numbers are read out of the words (stockNosIn): one
 * written "Stock # n" / "#n" is a stock number whatever we hold; a bare
 * 3–4 digit number is one only when it is OUR watch (5726, 5167 and 5811 are
 * Patek references, not stock). Then the rule every tab keeps: our watch and
 * its clients by Chrono Key's ids; the shop (a typed name — Sina Star, Asif,
 * Arsalan) through linksByName.
 */
import { query } from '../../db/index.js';
import { oursByNumber, text, iso, dayOf, photoPrefix } from '../shared.js';
import { linksByName } from '../clients.js';

/* ── stock numbers typed into words (shared with Pickup Codes and Driver Deliveries) ── */

const EXPLICIT = /(?:\bstock\s*(?:no\.?|number|#)?\s*:?\s*#?|#\s*)(\d{3,4})\b/gi;
// A bare number not glued to a reference ("5269R-001", "5712/1A"), a sum ("200+100=300", "100.000 aed") or a longer figure.
const BARE = /(?<![\w#/.,+=:-])(\d{3,4})(?![\w/.,+=:-])/g;

/** The stock numbers some words may name: `explicit` ("Stock # 1229") and `bare` (1229 alone — ours or not, to be checked). */
export function stockNosIn(...texts) {
  const explicit = [];
  const bare = [];
  for (const t of texts) {
    const s = text(t);
    if (!s) continue;
    for (const m of s.matchAll(EXPLICIT)) if (!explicit.includes(m[1])) explicit.push(m[1]);
    for (const m of s.matchAll(BARE)) if (!bare.includes(m[1]) && !explicit.includes(m[1])) bare.push(m[1]);
  }
  return { explicit, bare };
}

/** Our watches for every number these records' words may name, in one read. */
export async function oursInWords(wordsOf, rows) {
  const all = new Set();
  for (const r of rows) {
    const { explicit, bare } = stockNosIn(...wordsOf(r));
    explicit.forEach((n) => all.add(n));
    bare.forEach((n) => all.add(n));
  }
  return oursByNumber([...all]);
}

/** A record's stock numbers, each with our watch: the explicit ones always, a bare number only when it is ours. */
export function stocksOf(words, ours) {
  const { explicit, bare } = stockNosIn(...words);
  return [...explicit.map((no) => ({ no, watch: ours.get(no) || null })), ...bare.filter((no) => ours.has(no)).map((no) => ({ no, watch: ours.get(no) }))];
}

/*
 * A record's pictures: the ones masterapp holds (lgfile:<id>, or the
 * worker's /photos/, copied on first sight) are shown here; a picture the app
 * put elsewhere (its older Supabase bucket) is only a link, and only when it
 * is an https address.
 */
export function photoRefs(list) {
  const prefix = photoPrefix();
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    if (typeof v !== 'string') continue;
    if (/^lgfile:\d+$/.test(v) || (prefix && v.startsWith(prefix))) out.push({ file: v });
    else if (/^https:\/\/[^\s"'<>]+$/i.test(v)) out.push({ url: v });
  }
  return out;
}

/* ── the page ── */

const person = (links, name) => links.get(name) || null;

function taskOf(r, ours, links) {
  const d = r.data || {};
  const shop = text(d.shopName);
  const who = text(d.whoGoing);
  return {
    id: r.id,
    status: d.status === 'done' ? 'done' : 'open',
    date: dayOf(d.date) || dayOf(d.ts),
    shop,
    shop_link: person(links, shop),
    who,
    who_link: person(links, who),
    taking: text(d.taking),
    notes: text(d.notes),
    result_notes: text(d.resultNotes),
    completed_at: iso(d.completedAt),
    photos: photoRefs(d.photos),
    result_photos: photoRefs(d.resultPhotos),
    stocks: stocksOf([d.taking, d.notes, d.resultNotes], ours),
    locked: (r.locked_fields || []).length > 0,
    ts: Number(d.ts) || 0,
  };
}

const wordsOf = (r) => [r.data?.taking, r.data?.notes, r.data?.resultNotes];

/** The page's data (GET /api/logistics/page/goldsouk). */
export async function page() {
  const { rows } = await query("SELECT * FROM logistics_items WHERE kind = 'goldSoukTasks' AND deleted_at IS NULL ORDER BY id");
  const [ours, links] = await Promise.all([oursInWords(wordsOf, rows), linksByName(rows.flatMap((r) => [text(r.data?.shopName), text(r.data?.whoGoing)]))]);
  const tasks = rows.map((r) => taskOf(r, ours, links));
  // The app keeps the newest task first.
  const byNew = (a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.ts - a.ts || b.id - a.id;
  const open = tasks.filter((t) => t.status === 'open').sort(byNew);
  const done = tasks.filter((t) => t.status === 'done').sort(byNew);
  const count = (key) => {
    const m = new Map();
    for (const t of tasks) if (t[key]) m.set(t[key], (m.get(t[key]) || 0) + 1);
    return [...m].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  };
  return { counts: { open: open.length, done: done.length }, people: count('who'), shops: count('shop'), open, done };
}

/**
 * What this page knows about one watch: "Gold souk: <taking> with <who> (<status>)".
 * rows are the watch's logistics records; a task names its watch in words, so
 * the words are read again here in case the row's stock_nos did not carry it.
 */
export function forStock(stockNo, rows) {
  const out = [];
  for (const r of rows) {
    if (r.kind !== 'goldSoukTasks') continue;
    const d = r.data || {};
    const named = (r.stock_nos || []).includes(stockNo) || stockNosIn(...wordsOf(r)).explicit.includes(stockNo) || stockNosIn(...wordsOf(r)).bare.includes(stockNo);
    if (!named) continue;
    const done = d.status === 'done';
    const what = text(d.taking) || text(d.notes) || 'a task';
    const who = text(d.whoGoing);
    const shop = text(d.shopName);
    out.push({
      text: `Gold souk: ${what}${who ? ` with ${who}` : ''}${shop ? ` at ${shop}` : ''} (${done ? 'done' : 'open'})`,
      link: `#/lg/${r.id}`,
      tone: done ? 'good' : 'move',
    });
  }
  return out;
}
