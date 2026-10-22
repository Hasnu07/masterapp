import zlib from 'node:zlib';
import * as cheerio from 'cheerio';
import { pool, query } from '../../db/index.js';
import { config } from '../../config.js';
import { chronokey } from './client.js';
import {
  parseWatchDetail,
  detailFields,
  tableHeaders,
  gridRows,
  dataTableForm,
  stockNoOfLabel,
  assetPath,
} from './parse.js';
import { importProductList, startRun, finishRun, progressRun } from '../listimport.js';
import { applyToWatch } from '../apply.js';
import { addPhotos } from '../../watches/index.js';

/*
 * Keeping our copy in step with Chrono Key, until the switch-over.
 *
 *   list     the product grid — every purchase, one request — through the
 *            same reader as the CSV export; plus the incoming page, so a
 *            watch on its way says so
 *   details  each watch's own page: Chrono Key's euro figures, the Box /
 *            Papers ticks, and the PHOTOS, copied into our storage
 *
 * Read-only against Chrono Key throughout. It is somebody else's server, so
 * pages are fetched two at a time with a pause, and a first full copy of
 * ~1,700 pages takes a couple of hours rather than a couple of minutes.
 */

const PRODUCTS = { page: '/Stock/AllProducts', data: '/Stock/ProductsDataTable' };
const INCOMING = '/Stock/ToBeShippedList';
const GRID_ROWS = 2000;

/** Stock numbers on the incoming page. */
async function incomingStockNumbers() {
  const html = await chronokey().getListHtml(INCOMING, { pageSize: 200, pageNumber: 1 });
  const headers = tableHeaders(html);
  const at = headers.findIndex((h) => /stock\s*(no|number)/i.test(h));
  if (at === -1) return null;
  const $ = cheerio.load(html);
  const out = new Set();
  $('table').each((_, t) => {
    $(t)
      .find('tbody tr')
      .each((__, tr) => {
        const v = $(tr).find('td').eq(at).text().trim();
        if (/^\d+$/.test(v)) out.add(v);
      });
  });
  return out;
}

/**
 * The product grid, read into our watches.
 *
 * The page is fetched for its headings (they say which column is which, and
 * prove the session is alive), then its grid's data endpoint for the rows —
 * the page itself holds a header row and nothing else (InvoiceWEB found that
 * on the live site). A grid that answers anything but JSON with rows is an
 * ERROR, never an empty inventory.
 */
export async function syncList({ user } = {}) {
  const run = await startRun('chronokey', 'list', user);
  try {
    const pageHtml = await chronokey().getListHtml(PRODUCTS.page, { pageSize: 10, pageNumber: 1 });
    const headers = tableHeaders(pageHtml);
    if (!headers.length) throw new Error(`${PRODUCTS.page} carried no table headings — signed out, or redesigned`);

    const rows = [];
    let total = null;
    for (let call = 0; call < 6; call += 1) {
      const res = await chronokey().postForm(
        PRODUCTS.data,
        dataTableForm({ start: rows.length, length: GRID_ROWS, columns: headers.length })
      );
      let json;
      try {
        json = JSON.parse(res.body);
      } catch {
        throw new Error(
          `${PRODUCTS.data} answered ${res.status} ${res.type || ''}, not JSON: ${String(res.body || '')
            .replace(/\s+/g, ' ')
            .slice(0, 160)}`
        );
      }
      total ??= Number(json.recordsTotal ?? json.recordsFiltered) || null;
      const got = gridRows(json, headers);
      if (!got.length) break;
      rows.push(...got);
      if ((total && rows.length >= total) || got.length < GRID_ROWS) break;
    }
    if (!rows.length) throw new Error(`${PRODUCTS.data} answered with no rows${total ? ` (it says ${total})` : ''}`);

    // Object rows carry their own keys; array rows the page's headings.
    const gridHeaders = rows[0].headers;
    const ckIds = {};
    const stockAt = gridHeaders.findIndex((h) => /^\s*stock\s*(no|number)/i.test(h) || /^stockno$/i.test(h));
    for (const r of rows) if (r.ckId && stockAt !== -1) ckIds[String(r.values[stockAt]).trim()] = r.ckId;

    let incoming = null;
    try {
      incoming = await incomingStockNumbers();
    } catch (err) {
      console.warn(`[chronokey] incoming page not read: ${err.message}`);
    }

    const stats = await importProductList(
      gridHeaders,
      rows.map((r) => r.values),
      { via: 'grid', ckIds, incoming }
    );
    stats.gridTotal = total;
    stats.incoming = incoming ? incoming.size : null;
    await finishRun(run, { ok: true, stats });
    return stats;
  } catch (err) {
    await finishRun(run, { ok: false, error: err.message });
    throw err;
  }
}

/* ── each watch's own page ────────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Chrono Key's purchase id for a stock number, via its search. Exactly one, or none. */
async function resolveId(stockNo) {
  const hits = await chronokey().searchProducts(stockNo);
  const exact = hits.filter((h) => stockNoOfLabel(h.value) === String(stockNo));
  return exact.length === 1 ? Number(exact[0].id) : null;
}

/**
 * One watch's detail page: stored, applied, and its photos copied.
 * @returns {{ photos: number, changed: string[] }}
 */
export async function syncDetail(stockNo) {
  const { rows } = await query('SELECT * FROM ck_records WHERE stock_no = $1', [stockNo]);
  let rec = rows[0];
  let ckId = rec?.ck_id || null;
  if (!ckId) ckId = await resolveId(stockNo);
  if (!ckId) {
    await query(
      `INSERT INTO ck_records(stock_no, error, detail_at) VALUES ($1, $2, now())
       ON CONFLICT (stock_no) DO UPDATE SET error = EXCLUDED.error, detail_at = now()`,
      [stockNo, 'Chrono Key search did not name exactly one watch with this stock number']
    );
    return { photos: 0, changed: [], unresolved: true };
  }

  const html = await chronokey().getWatchDetailHtml(ckId);
  const d = parseWatchDetail(html, ckId);
  if (!d.title && !Object.keys(d.sections).length) {
    throw new Error(`the detail page for ${stockNo} (id ${ckId}) had no watch on it`);
  }
  const f = detailFields(d);
  // The page must be the watch asked for — the search can match a serial.
  if (f.stock_no && f.stock_no !== String(stockNo)) {
    throw new Error(`id ${ckId} is stock ${f.stock_no}, not ${stockNo}`);
  }

  const own = { purchase_price_eur: f.purchase_price_eur, sale_price_eur: f.sale_price_eur };
  const fill = { ...f };
  delete fill.stock_no;
  delete fill.purchase_price_eur;
  delete fill.sale_price_eur;

  const client = await pool.connect();
  let res;
  try {
    await client.query('BEGIN');
    // A figure equal to Chrono Key's own euro figure was a deal in euros.
    // Only then is a blank currency filled; anything else stays not-stated.
    const cur = (await client.query('SELECT purchase_price, sale_price FROM watches WHERE stock_no = $1', [stockNo]))
      .rows[0];
    if (cur?.purchase_price && f.purchase_price_eur && Math.abs(cur.purchase_price - f.purchase_price_eur) < 1) {
      fill.purchase_currency = 'EUR';
    }
    if (cur?.sale_price && f.sale_price_eur && Math.abs(cur.sale_price - f.sale_price_eur) < 1) {
      fill.sale_currency = 'EUR';
    }
    res = await applyToWatch(
      client,
      String(stockNo),
      [
        { fields: own, mode: 'own' },
        { fields: fill, mode: 'fill' },
      ],
      'chronokey',
      { ck_id: ckId }
    );
    await client.query(
      `INSERT INTO ck_records(stock_no, ck_id, detail, html, detail_at, error, watch_id)
       VALUES ($1,$2,$3,$4,now(),NULL,$5)
       ON CONFLICT (stock_no) DO UPDATE SET ck_id = EXCLUDED.ck_id, detail = EXCLUDED.detail, html = EXCLUDED.html,
         detail_at = now(), error = NULL, watch_id = EXCLUDED.watch_id`,
      [String(stockNo), ckId, JSON.stringify(d), zlib.gzipSync(html), res.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const photos = await copyPhotos(res.id, d.images);
  await query('UPDATE ck_records SET photos_at = now() WHERE stock_no = $1', [String(stockNo)]);
  return { photos, changed: res.changed };
}

/**
 * Copies a watch's Chrono Key photos that we do not hold yet.
 *
 * "Hold" includes photos REMOVED here: the row is kept with deleted_at set,
 * so a photo somebody took off a watch in masterapp does not come back on the
 * next sync. One that will not download is skipped, not fatal.
 */
async function copyPhotos(watchId, images) {
  if (!images?.length) return 0;
  const { rows } = await query(
    "SELECT source_ref FROM watch_photos WHERE watch_id = $1 AND source = 'chronokey'",
    [watchId]
  );
  const have = new Set(rows.map((r) => r.source_ref));
  let copied = 0;
  for (const img of images) {
    if (have.has(img.path) || !assetPath(img.path)) continue;
    try {
      const r = await chronokey().getImage(img.path);
      const type = String(r.headers['content-type'] || '');
      if (r.status !== 200 || !type.startsWith('image/') || !r.buffer?.length) continue;
      // The gallery lists some pictures twice under two names, and the vault
      // may hold them already: those are recorded, not shown again.
      const ids = await addPhotos(watchId, [{ buffer: r.buffer, caption: img.caption }], null, {
        source: 'chronokey',
        sourceRefs: [img.path],
        skipDuplicates: true,
      });
      copied += ids.length;
    } catch (err) {
      if (err.code === '23505') continue; // copied meanwhile by another pass
      console.warn(`[chronokey] photo ${img.path} for watch ${watchId}: ${err.message}`);
    }
  }
  return copied;
}

/**
 * Detail pages for the watches that need one.
 *
 *   new     never read — the first copy, and each new purchase after it
 *   active  not sold, or sold in the last 30 days: the ones that still change.
 *           The daily pass. A watch that sold last March has finished changing,
 *           and re-reading 1,500 of them a day would be 1,500 pages of somebody
 *           else's server for nothing.
 *   full    everything, oldest read first — on request only
 *
 * Resumable by construction: each page is stored as it is read, so a run that
 * stops (a deploy, a timeout) is simply carried on by the next one.
 */
export async function syncDetails({ mode = 'new', limit = Infinity, user, onProgress } = {}) {
  const run = await startRun('chronokey', `details-${mode}`, user);
  const where = {
    full: 'TRUE',
    active: `detail_at IS NULL OR stock_no IN (SELECT stock_no FROM watches
               WHERE status <> 'sold' OR sale_date > now() - interval '30 days')`,
    new: 'detail_at IS NULL',
  }[mode];
  if (!where) throw new Error(`unknown mode ${mode}`);
  const { rows } = await query(
    `SELECT stock_no FROM ck_records WHERE ${where}
      ORDER BY detail_at NULLS FIRST, NULLIF(regexp_replace(stock_no, '\\D', '', 'g'), '')::bigint DESC NULLS LAST`
  );
  const todo = rows.map((r) => r.stock_no).slice(0, Number.isFinite(limit) ? limit : undefined);
  const stats = { mode, todo: todo.length, done: 0, photos: 0, unresolved: 0, failed: 0, errors: [] };

  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const stockNo = todo[next];
      next += 1;
      try {
        const r = await syncDetail(stockNo);
        stats.photos += r.photos;
        if (r.unresolved) stats.unresolved += 1;
      } catch (err) {
        stats.failed += 1;
        if (stats.errors.length < 20) stats.errors.push(`${stockNo}: ${err.message}`);
        await query('UPDATE ck_records SET error = $2, detail_at = now() WHERE stock_no = $1', [stockNo, err.message]);
        // A sign-in that fails will fail for every page: stop rather than
        // spend the next two thousand requests proving it.
        if (err.status === 401) throw err;
      }
      stats.done += 1;
      if (stats.done % 10 === 0) {
        await progressRun(run, stats);
        onProgress?.(stats);
      }
      await sleep(config.sync.pauseMs);
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, config.sync.concurrency) }, worker));
    await finishRun(run, { ok: stats.failed === 0, stats });
    return stats;
  } catch (err) {
    await finishRun(run, { ok: false, stats, error: err.message });
    throw err;
  }
}
