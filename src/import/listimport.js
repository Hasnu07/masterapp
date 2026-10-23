import { pool, query } from '../db/index.js';
import { readList, parseCsv, looksLikeProductList } from './productlist.js';
import { applyToWatch } from './apply.js';
import { markGone, settleWatches } from './gone.js';

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
 * @param mirror  this is a COMPLETE live read of the grid: a watch it no
 *                longer lists is gone from Chrono Key (gone.js). Never for a
 *                CSV — an upload may be an old export.
 */
export async function importProductList(headers, rows, { via = 'csv', ckIds = {}, incoming = null, mirror = false } = {}) {
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

  // Without the incoming page (a CSV upload) "unsold" cannot tell the shelf
  // from on-its-way, so a watch we know to be incoming stays incoming.
  const knownIncoming = incoming
    ? null
    : new Set((await query("SELECT stock_no FROM watches WHERE status = 'incoming'")).rows.map((r) => r.stock_no));

  const client = await pool.connect();
  try {
    for (const row of list) {
      const f = row.fields;
      // Unsold and on Chrono Key's incoming page: on its way, not on the shelf.
      if (f.status === 'in_stock' && (incoming || knownIncoming).has(f.stock_no)) f.status = 'incoming';
      if (f.purchase_price && !f.purchase_currency) stats.currencyNotStated += 1;
      await client.query('BEGIN');
      try {
        const res = await applyToWatch(client, f.stock_no, [{ fields: f, mode: 'own' }], 'chronokey', {
          ck_product_id: f.ck_product_id ?? undefined,
          ck_id: ckIds[f.stock_no] ?? undefined,
        });
        await client.query(
          `INSERT INTO ck_records(stock_no, ck_product_id, ck_id, list_row, list_at, watch_id)
           VALUES ($1, $2, $3, $4, now(), $5)
           ON CONFLICT (stock_no) DO UPDATE SET ck_product_id = EXCLUDED.ck_product_id,
             ck_id = COALESCE(EXCLUDED.ck_id, ck_records.ck_id),
             list_row = EXCLUDED.list_row, list_at = now(), watch_id = EXCLUDED.watch_id`,
          [
            f.stock_no,
            f.ck_product_id ?? null,
            ckIds[f.stock_no] ?? null,
            JSON.stringify(row.others.length ? { ...row.raw, _repeated: row.others } : row.raw),
            res.id,
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
