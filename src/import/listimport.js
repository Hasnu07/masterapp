import { pool, query } from '../db/index.js';
import { readList, parseCsv, looksLikeProductList } from './productlist.js';
import { applyToWatch } from './apply.js';
import { markGone, settleWatches, GONE_LIMIT } from './gone.js';

/*
 * Chrono Key's product list → our watches.
 *
 * Every row is kept as Chrono Key wrote it (ck_records.list_row) AND applied
 * to the watch with that stock number. The list is the authority for the
 * purchase and the sale until the switch-over, so its values replace ours —
 * except a field somebody edited here (see apply.js).
 */

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/**
 * A watch's status: where Chrono Key's own lists put it (chronokey/lists.js).
 *
 *   1. a sale on the grid → sold. First: 1708 and 1737 were sold before they
 *      arrived and are still on To-be-shipped.
 *   2. on To-be-shipped → incoming
 *   3. on the Inventory tab → in_stock
 *   4. on Returned consignments → returned (to the client: stock 1722)
 *   5. on none of them → other — only after TWO trusted reads in a row, so a
 *      watch caught moving between two lists keeps its status for a pass (a
 *      sale taken back while the pass reads included: the lists are read
 *      before the grid)
 *
 * Without a trusted read of the lists (a read that failed or looked cut
 * short, or a CSV upload) nothing is re-derived — doing so would put every
 * returned watch back on the shelf until the next good read. Only what the
 * grid itself proves moves a status: a sale (sold), a sale taken back (back
 * to the shelf, or to incoming when To-be-shipped lists it), and the
 * To-be-shipped page as before. A new watch gets that same rule.
 *
 * @param f         the grid row's fields: `status` 'sold' or 'in_stock' (a
 *                  sale or not), absent when the grid carries no sale columns
 * @param lists     a TRUSTED read of the lists, or null
 * @param incoming  the To-be-shipped stock numbers when that page was read, else null
 * @param held      the status we hold, undefined for a new watch
 * @param none      trusted reads in a row, this one included, with the watch on no list
 * @returns the status to write, or undefined to leave it
 */
export function listStatus(f, { lists = null, incoming = null, held, none = 0 } = {}) {
  if (!('status' in f)) return undefined;
  const s = f.stock_no;
  if (f.status === 'sold') return 'sold';
  if (lists) {
    if (lists.incoming.has(s)) return 'incoming';
    if (lists.inventory.has(s)) return 'in_stock';
    if (lists.returned.has(s)) return 'returned';
    if (none >= 2) return 'other';
    return held === undefined ? 'in_stock' : undefined;
  }
  const onWay = incoming ? incoming.has(s) : null;
  if (held === undefined || held === 'sold') return onWay ? 'incoming' : 'in_stock';
  if (held === 'in_stock' && onWay) return 'incoming';
  if (held === 'incoming' && onWay === false) return 'in_stock';
  return undefined;
}

/* What a trusted read says of one stock number, kept in ck_records.ck_lists. */
function listsOf(lists, stock, unsold, before) {
  const on = {};
  if (lists.inventory.has(stock)) on.inventory = lists.inventory.get(stock);
  if (lists.incoming.has(stock)) on.incoming = {};
  if (lists.returned.has(stock)) on.returned = { date: lists.returned.get(stock).date, ck_id: lists.returned.get(stock).ckId };
  on.none = unsold && !Object.keys(on).length ? (before?.none || 0) + 1 : 0;
  return on;
}

/**
 * Every watch's status for one pass, decided before anything is written.
 *
 * A pass that would move more statuses than GONE_LIMIT allows (as for
 * deletions) is taken for a broken read and refused: no status moves but
 * what the grid itself proves, and where the lists put each watch is not
 * kept. Unless the previous pass proposed the same change and was refused
 * too — a real change (a batch of returns, a stale copy catching up) reads
 * the same twice; a glitch does not. Without that, a real change would be
 * refused on every pass for ever, since what we hold never moves meanwhile.
 *
 * @param known     stock → {status, locked} for watches the grid listed
 *                  before this pass; any other is NEW to the grid (one the
 *                  vault made first included), so its status is decided afresh
 * @param before    stock → ck_lists at the last trusted read
 * @param previous  the moves a refused pass proposed last time, or null
 */
export function planStatuses(list, { lists = null, incoming = null, known = new Map(), before = new Map(), previous = null, via = 'grid', limit = GONE_LIMIT(list.length) } = {}) {
  const onLists = new Map();
  if (lists) {
    for (const { fields: f } of list) {
      if ('status' in f) onLists.set(f.stock_no, listsOf(lists, f.stock_no, f.status !== 'sold', before.get(f.stock_no)));
    }
  }
  const decide = (useLists) =>
    new Map(
      list.map(({ fields: f }) => {
        const k = known.get(f.stock_no);
        // A status a person set here is theirs: not even proposed (apply.js would not write it).
        if (k?.locked) return [f.stock_no, undefined];
        return [f.stock_no, listStatus(f, { lists: useLists ? lists : null, incoming, held: k?.status, none: onLists.get(f.stock_no)?.none || 0 })];
      })
    );
  const movesOf = (statuses) => {
    const out = [];
    for (const [s, st] of statuses) {
      const was = known.get(s)?.status;
      // To or from 'sold' is the grid's own say, not the lists'.
      if (st !== undefined && was !== undefined && st !== was && st !== 'sold' && was !== 'sold') out.push(`${s}:${was}→${st}`);
    }
    return out;
  };
  let statuses = decide(Boolean(lists));
  let statusFrom = lists ? 'lists' : via === 'csv' ? 'csv: statuses kept' : 'no trusted lists: statuses kept';
  let proposal = null;
  const moves = lists ? movesOf(statuses) : [];
  if (moves.length > limit) {
    const seen = new Set(previous || []);
    if (moves.filter((m) => seen.has(m)).length >= moves.length * 0.9) {
      statusFrom = `lists: ${moves.length} statuses moved — the same change on two reads in a row`;
    } else {
      statusFrom = `refused: ${moves.length} statuses would change at once`;
      proposal = moves;
      statuses = decide(false);
      onLists.clear();
    }
  }
  return { statuses, onLists, statusFrom, proposal };
}

/**
 * @param lists   a TRUSTED read of Chrono Key's lists (chronokey/lists.js), or null
 * @param mirror  this is a COMPLETE live read of the grid: a watch it no
 *                longer lists is gone from Chrono Key (gone.js). Never for a
 *                CSV — an upload may be an old export.
 */
export async function importProductList(headers, rows, { via = 'csv', ckIds = {}, incoming = null, lists = null, mirror = false } = {}) {
  if (!looksLikeProductList(headers)) {
    throw bad(
      `This does not look like Chrono Key's product list — no Stock No / brand columns. Columns found: ${headers
        .slice(0, 12)
        .join(', ')}`
    );
  }
  const { rows: list, skipped } = readList(headers, rows);
  const stats = {
    via,
    rows: rows.length,
    records: list.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    noStockNumber: skipped.length,
    repeatedRows: list.filter((r) => r.others.length).map((r) => r.fields.stock_no),
    currencyNotStated: 0,
  };

  // The status of every watch, decided before anything is written (planStatuses).
  const known = new Map(
    (
      await query(
        `SELECT w.stock_no, w.status, 'status' = ANY(w.locked_fields) AS locked
           FROM watches w JOIN ck_records r ON r.stock_no = w.stock_no AND r.list_row IS NOT NULL`
      )
    ).rows.map((r) => [r.stock_no, { status: r.status, locked: r.locked }])
  );
  const before = new Map((await query('SELECT stock_no, ck_lists FROM ck_records')).rows.map((r) => [r.stock_no, r.ck_lists]));
  const previous =
    via === 'grid'
      ? (
          await query(
            `SELECT stats->'statusProposal' AS p FROM import_runs
              WHERE source = 'chronokey' AND mode = 'list' AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`
          )
        ).rows[0]?.p || null
      : null;
  const plan = planStatuses(list, { lists, incoming, known, before, previous, via });
  const { statuses, onLists } = plan;
  stats.statusFrom = plan.statusFrom;
  if (plan.proposal) {
    console.warn(`[sync] ${plan.statusFrom} in one read of ${list.length} — not taken unless the next read proposes the same`);
    stats.statusProposal = plan.proposal;
  }
  stats.statusMoves = {};

  const client = await pool.connect();
  try {
    for (const row of list) {
      const f = row.fields;
      const st = statuses.get(f.stock_no);
      if (st === undefined) delete f.status;
      else {
        f.status = st;
        const was = known.get(f.stock_no)?.status;
        if (was !== undefined && was !== st) stats.statusMoves[`${was}→${st}`] = (stats.statusMoves[`${was}→${st}`] || 0) + 1;
      }
      if (f.purchase_price && !f.purchase_currency) stats.currencyNotStated += 1;
      await client.query('BEGIN');
      try {
        const res = await applyToWatch(client, f.stock_no, [{ fields: f, mode: 'own' }], 'chronokey', {
          ck_product_id: f.ck_product_id ?? undefined,
          ck_id: ckIds[f.stock_no] ?? undefined,
        });
        // Where the lists put it — only from a trusted read; otherwise the last one's stands.
        const on = onLists.get(f.stock_no) || null;
        await client.query(
          `INSERT INTO ck_records(stock_no, ck_product_id, ck_id, list_row, list_at, watch_id, ck_lists, lists_at)
           VALUES ($1, $2, $3, $4, now(), $5, $6, CASE WHEN $6::jsonb IS NULL THEN NULL ELSE now() END)
           ON CONFLICT (stock_no) DO UPDATE SET ck_product_id = EXCLUDED.ck_product_id,
             ck_id = COALESCE(EXCLUDED.ck_id, ck_records.ck_id),
             list_row = EXCLUDED.list_row, list_at = now(), watch_id = EXCLUDED.watch_id,
             ck_lists = COALESCE(EXCLUDED.ck_lists, ck_records.ck_lists),
             lists_at = COALESCE(EXCLUDED.lists_at, ck_records.lists_at)`,
          [
            f.stock_no,
            f.ck_product_id ?? null,
            ckIds[f.stock_no] ?? null,
            JSON.stringify(row.others.length ? { ...row.raw, _repeated: row.others } : row.raw),
            res.id,
            on ? JSON.stringify(on) : null,
          ]
        );
        await client.query('COMMIT');
        if (res.created) stats.created += 1;
        else if (res.changed.length) stats.updated += 1;
        else stats.unchanged += 1;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`stock ${f.stock_no}: ${err.message}`);
      }
    }
    if (mirror) {
      await client.query('BEGIN');
      try {
        stats.goneFromList = await markGone(client, 'ck_records', 'stock_no', list.map((r) => r.fields.stock_no));
        stats.watchesGone = await settleWatches(client);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
  } finally {
    client.release();
  }
  return stats;
}

/** A CSV exported from Chrono Key's product list, as uploaded. */
export async function importProductCsv(text, { user } = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw bad('That file has no rows');
  const run = await startRun('chronokey', 'csv', user);
  try {
    const stats = await importProductList(rows[0], rows.slice(1), { via: 'csv' });
    await finishRun(run, { ok: true, stats });
    return stats;
  } catch (err) {
    await finishRun(run, { ok: false, error: err.message });
    throw err;
  }
}

export async function startRun(source, mode, user) {
  const { rows } = await query('INSERT INTO import_runs(source, mode, started_by) VALUES ($1,$2,$3) RETURNING id', [
    source,
    mode,
    user?.id ?? null,
  ]);
  return rows[0].id;
}

export async function finishRun(id, { ok, stats = {}, error = null }) {
  await query('UPDATE import_runs SET finished_at = now(), ok = $1, stats = $2, error = $3 WHERE id = $4', [
    ok,
    JSON.stringify(stats),
    error,
    id,
  ]);
}

export async function progressRun(id, stats) {
  await query('UPDATE import_runs SET stats = $1 WHERE id = $2', [JSON.stringify(stats), id]);
}
