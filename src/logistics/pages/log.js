/*
 * Activity: the logistics app's "Activity Log" page — the lines the app
 * writes as people work in it (`logActivity`: { id, text, type, ts }), its
 * last 200, newest first. The app shows them as a plain two-column table and
 * nothing else; its to-do items (`todoItems`) belong to its notepad, not to
 * this page, so they stay on the tab's plain lists.
 *
 * Our copy keeps a line the app has let fall off the end (`keepGone` in
 * kinds.js), so the page can hold more than 200.
 *
 * A stock number inside a line is OUR watch: the lines are free text, so the
 * numbers are picked out where the app's own wording puts them ("Dubai Stock
 * 1698 updated", "Received Stock 1698", "Added incoming 1760", "SOLD 1698 ·",
 * "Accessories given for Stock #1698", "1698 delivered to", "Polish done for
 * 1698", "3rd party shipment: Ferrari · 1601, 1602") — never a bare figure,
 * which is as often a price or a reference.
 */
import { query } from '../../db/index.js';
import { text, iso, oursByNumber } from '../shared.js';
import { stockNosInLine } from '../kinds.js';

// The reader of a line's stock numbers lives in kinds.js, so the sync's stock_nos and this page agree.
export { stockNosInLine } from '../kinds.js';

/** The page's data (GET /api/logistics/page/log). */
export async function page() {
  const { rows } = await query("SELECT * FROM logistics_items WHERE kind = 'activity' AND deleted_at IS NULL ORDER BY id");
  const lines = rows
    .map((r) => {
      const d = r.data || {};
      const line = text(d.text);
      return {
        id: r.id,
        ts: iso(d.ts) || new Date(r.created_at).toISOString(),
        text: line,
        type: text(d.type) || 'info',
        stock_nos: [...new Set([...(r.stock_nos || []), ...stockNosInLine(line)])],
      };
    })
    .sort((a, b) => b.ts.localeCompare(a.ts) || b.id - a.id);
  const ours = await oursByNumber(lines.flatMap((l) => l.stock_nos));
  return { lines, watches: Object.fromEntries(ours), app_keeps: 200 };
}

/**
 * The sync gives an activity line no stock numbers (its text is all it has),
 * so a watch's records never include one: nothing to say here until kinds.js
 * reads the lines the way stockNosInLine does.
 */
export function forStock() {
  return [];
}
