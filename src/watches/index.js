import { query, tx } from '../db/index.js';
import { FIELDS, FIELD, cleanValue, displayTitle, parseMoney } from './fields.js';
import { savePhoto, storage, fingerprint, dhashDistance, samePicture } from '../storage/index.js';
import { leftBlank } from '../import/productlist.js';
import { isPlaceholder } from '../import/chronokey/parse.js';

/*
 * Our record of every watch: reading it, and every way a person changes it.
 *
 * Every change is written to watch_events against the person who made it, in
 * the same transaction as the change itself — an ERP that cannot say who
 * moved a price is not one anyone can rely on.
 */

const notFound = () => Object.assign(new Error('No such watch'), { status: 404 });
const COLUMNS = FIELDS.map((f) => f.key);

/* ── reading ─────────────────────────────────────────────────────── */

const SORTS = {
  newest: 'w.stock_no_n DESC NULLS LAST, w.id DESC',
  oldest: 'w.stock_no_n ASC NULLS LAST, w.id ASC',
  updated: 'w.updated_at DESC',
  price_high: 'w.sort_price DESC NULLS LAST',
  price_low: 'w.sort_price ASC NULLS LAST',
  brand: 'lower(w.brand), lower(w.model), w.stock_no_n DESC NULLS LAST',
};

/**
 * A page of watches, with the counts the filters show.
 *
 * The counts are over everything the OTHER filters allow — "Dubai 36" is how
 * many Dubai watches the current status, brand and search would show — so a
 * pill never promises a number its tap does not give.
 */
export async function listWatches(opts = {}) {
  const { q = '', status = '', location = '', brand = '', deleted = false, sort = 'newest' } = opts;
  const limit = Math.min(Math.max(Number(opts.limit) || 60, 1), 200);
  const offset = Math.max(Number(opts.offset) || 0, 0);

  const where = [deleted ? 'w.deleted_at IS NOT NULL' : 'w.deleted_at IS NULL'];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    where.push(sql.replaceAll('$?', `$${params.length}`));
  };

  const term = String(q).trim();
  if (term) {
    if (/^\d+$/.test(term)) {
      // A bare number is a stock number, exactly — "168" must not find 1686.
      // A reference or a serial that is all digits is still found by its start.
      add("(w.stock_no = $? OR w.reference ILIKE $?||'%' OR w.serial ILIKE $?||'%')", term);
    } else {
      for (const word of term.split(/\s+/).slice(0, 6)) {
        add(
          `(w.brand ILIKE '%'||$?||'%' OR w.model ILIKE '%'||$?||'%' OR w.reference ILIKE '%'||$?||'%'
            OR w.serial ILIKE '%'||$?||'%' OR w.title ILIKE '%'||$?||'%' OR w.dial ILIKE '%'||$?||'%'
            OR w.purchased_from ILIKE '%'||$?||'%' OR w.sold_to ILIKE '%'||$?||'%' OR w.notes ILIKE '%'||$?||'%'
            OR w.stock_no = $?)`,
          word
        );
      }
    }
  }

  const base = [...where];
  const baseParams = [...params];
  const facet = async (col, extra) => {
    const w = [...base];
    const p = [...baseParams];
    for (const [c, v] of extra) {
      p.push(v);
      w.push(`${c} = $${p.length}`);
    }
    const { rows } = await query(
      `SELECT ${col} AS k, count(*)::int AS n FROM watches w WHERE ${w.join(' AND ')} GROUP BY 1 ORDER BY 2 DESC`,
      p
    );
    return rows;
  };

  const f = { status: ['w.status', status], location: ['w.location', location], brand: ['w.brand', brand] };
  const others = (skip) => Object.entries(f).filter(([k, [, v]]) => k !== skip && v).map(([, cv]) => cv);

  const [byStatus, byLocation, byBrand] = await Promise.all([
    facet('w.status', others('status')),
    facet('w.location', others('location')),
    facet('w.brand', others('brand')),
  ]);

  for (const [col, v] of others(null)) add(`${col} = $?`, v);

  const order = SORTS[sort] || SORTS.newest;
  params.push(limit, offset);
  const { rows } = await query(
    `WITH w AS (
       SELECT w.*,
              NULLIF(regexp_replace(w.stock_no, '\\D', '', 'g'), '')::bigint AS stock_no_n,
              COALESCE(w.b2c_price, w.b2b_price, w.retail_price, w.sale_price) AS sort_price
         FROM watches w)
     SELECT w.*, count(*) OVER()::int AS total,
            (SELECT p.id FROM watch_photos p WHERE p.watch_id = w.id AND p.deleted_at IS NULL
              ORDER BY p.sort, p.id LIMIT 1) AS photo_id,
            (SELECT count(*)::int FROM watch_photos p WHERE p.watch_id = w.id AND p.deleted_at IS NULL) AS photo_count
       FROM w WHERE ${where.join(' AND ')}
      ORDER BY ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    total: rows[0]?.total ?? 0,
    watches: rows.map(summary),
    facets: { status: byStatus, location: byLocation, brand: byBrand.slice(0, 40) },
  };
}

const summary = (w) => ({
  id: w.id,
  stock_no: w.stock_no,
  title: displayTitle(w),
  brand: w.brand,
  model: w.model,
  reference: w.reference,
  serial: w.serial,
  watch_date: w.watch_date,
  location: w.location,
  status: w.status,
  box: w.box,
  papers: w.papers,
  b2b_price: w.b2b_price,
  b2b_currency: w.b2b_currency,
  b2c_price: w.b2c_price,
  b2c_currency: w.b2c_currency,
  sale_price: w.sale_price,
  sale_currency: w.sale_currency,
  photo_id: w.photo_id,
  photo_count: w.photo_count,
  origin: w.origin,
  deleted_at: w.deleted_at,
});

export async function getWatch(id) {
  const { rows } = await query('SELECT * FROM watches WHERE id = $1', [Number(id) || 0]);
  const w = rows[0];
  if (!w) throw notFound();

  const [photos, why] = await Promise.all([
    query(
      `SELECT id, caption, source, width, height, bytes, content_type, sort, created_at
         FROM watch_photos WHERE watch_id = $1 AND deleted_at IS NULL ORDER BY sort, id`,
      [w.id]
    ),
    statusWhy(w),
  ]);

  return { ...w, display_title: displayTitle(w), photos: photos.rows, status_why: why };
}

/*
 * Why a watch has its status, for its page: where Chrono Key's own lists put
 * it at the last trusted read, the Item Status on its Chrono Key page (shown,
 * never used — "Due Payment" is a payment, not a place), and, when Chrono Key
 * does not list it, the vault lists it is in and any Chrono Key watch with
 * the same serial (1528 / 1515, 1617. / 1617).
 */
async function statusWhy(w) {
  const [ck, vault] = await Promise.all([
    query(
      `SELECT ck_lists, lists_at, detail->>'status' AS item_status, detail_at, list_row IS NOT NULL AND gone_at IS NULL AS live
         FROM ck_records WHERE watch_id = $1`,
      [w.id]
    ),
    query('SELECT list FROM vault_records WHERE watch_id = $1 AND gone_at IS NULL ORDER BY list', [w.id]),
  ]);
  const c = ck.rows[0];
  const out = {
    ck: c ? { live: c.live, lists: c.ck_lists, at: c.lists_at, item_status: c.item_status, item_status_at: c.detail_at } : null,
    vault: vault.rows.map((r) => r.list),
    same_serial: [],
    locked: w.locked_fields.includes('status'),
  };
  // A serial that means something — not "xxxx", "-" or a placeholder of a few characters.
  if (!c?.live && /[0-9]/.test(w.serial) && w.serial.replace(/[^0-9a-z]/gi, '').length >= 5) {
    const { rows } = await query(
      `SELECT w.id, w.stock_no FROM watches w JOIN ck_records r ON r.watch_id = w.id AND r.list_row IS NOT NULL AND r.gone_at IS NULL
        WHERE w.id <> $1 AND w.deleted_at IS NULL AND lower(regexp_replace(w.serial, '\\s', '', 'g')) = lower(regexp_replace($2, '\\s', '', 'g'))`,
      [w.id, w.serial]
    );
    out.same_serial = rows;
  }
  return out;
}

/**
 * What this watch's REFERENCE has sold for, newest first, and which examples
 * are still in stock — the same answer InvoiceWEB's "What it has sold for"
 * gives, read from our own copy instead of Chrono Key's pages.
 *
 * Each sale carries Chrono Key's euro figure, the sale price as held, and the
 * vault's own sold figure (with its currency) beside them. A sale with no
 * figure anywhere is counted but not listed: "sold, price unknown" reads as a
 * free watch at a glance.
 */
export async function soldFor(id, limit = 10) {
  const { rows } = await query('SELECT id, reference FROM watches WHERE id = $1', [Number(id) || 0]);
  const w = rows[0];
  if (!w) throw notFound();
  const reference = w.reference.trim();
  if (!reference) return { reference, sold: [], soldTotal: 0, inStock: [] };

  const { rows: same } = await query(
    `SELECT w.id, w.stock_no, w.status, w.sale_date, w.sale_price, w.sale_currency, w.sale_price_eur,
            v.data->>'soldPrice' AS vault_price, v.data->>'soldCurrency' AS vault_currency, v.data->>'soldDate' AS vault_date
       FROM watches w
       LEFT JOIN LATERAL (
         SELECT data FROM vault_records r
          WHERE r.watch_id = w.id AND r.list = 'soldStocks'
          ORDER BY r.fetched_at DESC LIMIT 1
       ) v ON true
      WHERE lower(w.reference) = lower($1) AND w.deleted_at IS NULL`,
    [reference]
  );

  const vaultSold = (r) => {
    const n = parseMoney(r.vault_price);
    // Under 100 is the vault's placeholder (it writes 1), not a sale.
    return Number.isFinite(n) && n >= 100 && /^[A-Za-z]{3,4}$/.test(r.vault_currency || '')
      ? { price: n, currency: r.vault_currency.toUpperCase() }
      : null;
  };
  const sold = same
    .filter((r) => r.status === 'sold' || r.sale_date)
    .map((r) => ({
      id: r.id,
      stock_no: r.stock_no,
      self: r.id === w.id,
      date: r.sale_date || (/^\d{4}-\d{2}-\d{2}$/.test(r.vault_date || '') ? r.vault_date : null),
      eur: r.sale_price_eur,
      deal: r.sale_price === null ? null : { price: r.sale_price, currency: r.sale_currency },
      vault: vaultSold(r),
    }));
  const priced = sold
    .filter((s) => s.eur !== null || s.deal || s.vault)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || Number(b.stock_no) - Number(a.stock_no));

  return {
    reference,
    sold: priced.slice(0, limit),
    soldTotal: sold.length,
    inStock: same
      .filter((r) => r.status === 'in_stock' || r.status === 'reserved')
      .map((r) => ({ id: r.id, stock_no: r.stock_no, status: r.status, self: r.id === w.id }))
      .sort((a, b) => Number(a.stock_no) - Number(b.stock_no)),
  };
}

export async function watchEvents(id, limit = 200) {
  const { rows } = await query(
    `SELECT e.id, e.at, e.source, e.action, e.changes, u.name AS user_name, u.email AS user_email
       FROM watch_events e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.watch_id = $1 ORDER BY e.at DESC, e.id DESC LIMIT $2`,
    [Number(id) || 0, limit]
  );
  return rows;
}

/* ── changing ─────────────────────────────────────────────────────── */

export async function logEvent(db, watchId, { userId = null, source = 'user', action, changes = {} }) {
  await db.query('INSERT INTO watch_events(watch_id, user_id, source, action, changes) VALUES ($1,$2,$3,$4,$5)', [
    watchId,
    userId,
    source,
    action,
    JSON.stringify(changes),
  ]);
}

function cleanPatch(patch) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!FIELD[k]) continue; // ids, timestamps and the like are not the caller's to set
    out[k] = cleanValue(k, v);
  }
  return out;
}

function same(a, b) {
  // jsonb comes back with its keys in Postgres's order, not ours.
  const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  if (a && b && typeof a === 'object' && typeof b === 'object') return canon(a) === canon(b);
  return (a ?? '') === (b ?? '') || (a !== null && b !== null && String(a) === String(b));
}

export async function createWatch(data, user) {
  const values = cleanPatch(data);
  if (!values.status) values.status = 'in_stock';
  const keys = Object.keys(values);
  return tx(async (db) => {
    const { rows } = await db.query(
      `INSERT INTO watches(${keys.join(', ')}, origin) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}, 'manual')
       RETURNING id`,
      keys.map((k) => values[k])
    );
    const id = rows[0].id;
    await logEvent(db, id, { userId: user?.id, action: 'create', changes: values });
    return id;
  });
}

/**
 * Edits fields of a watch.
 *
 * A field changed here is LOCKED: the copy from Chrono Key and the vault will
 * not overwrite it on its next pass. Until the switch-over Chrono Key is the
 * master, but a correction typed here is somebody's decision and must not be
 * silently undone fifteen minutes later. `unlockField` hands a field back.
 */
export async function updateWatch(id, patch, user) {
  const values = cleanPatch(patch);
  return tx(async (db) => {
    const { rows } = await db.query('SELECT * FROM watches WHERE id = $1 FOR UPDATE', [Number(id) || 0]);
    const w = rows[0];
    if (!w) throw notFound();

    const changes = {};
    for (const [k, v] of Object.entries(values)) if (!same(w[k], v)) changes[k] = [w[k], v];
    if (!Object.keys(changes).length) return { changed: [] };

    const keys = Object.keys(changes);
    const locks = w.origin === 'manual' ? w.locked_fields : [...new Set([...w.locked_fields, ...keys])];
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    await db.query(
      `UPDATE watches SET ${sets.join(', ')}, locked_fields = $${keys.length + 1}, updated_at = now()
        WHERE id = $${keys.length + 2}`,
      [...keys.map((k) => values[k]), locks, w.id]
    );
    await logEvent(db, w.id, { userId: user?.id, action: 'update', changes });
    return { changed: keys };
  });
}

export async function unlockField(id, key, user) {
  if (!FIELD[key]) throw Object.assign(new Error(`Unknown field: ${key}`), { status: 400 });
  return tx(async (db) => {
    const { rows } = await db.query(
      `UPDATE watches SET locked_fields = array_remove(locked_fields, $1) WHERE id = $2
       RETURNING id, stock_no, ${key} AS value`,
      [key, Number(id) || 0]
    );
    if (!rows[0]) throw notFound();
    const changes = { field: key };
    /*
     * A spec field Chrono Key's list leaves EMPTY is never cleared by the list
     * (productlist.js, SPEC), so handing it back would otherwise leave the
     * typed value in place, no longer marked as typed here. It is cleared now
     * instead: Chrono Key has nothing for it, and the watch's page or the
     * vault fill it on their next pass if they have something.
     */
    const { rows: ck } = await db.query('SELECT list_row FROM ck_records WHERE stock_no = $1', [rows[0].stock_no]);
    if (ck[0]?.list_row && leftBlank(ck[0].list_row, key)) {
      const empty = cleanValue(key, null);
      if (!same(rows[0].value, empty)) {
        await db.query(`UPDATE watches SET ${key} = $1, updated_at = now() WHERE id = $2`, [empty, rows[0].id]);
        changes.cleared = rows[0].value;
      }
    }
    await logEvent(db, rows[0].id, { userId: user?.id, action: 'unlock', changes });
  });
}

export async function deleteWatch(id, user) {
  return tx(async (db) => {
    const { rows } = await db.query(
      'UPDATE watches SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id',
      [Number(id) || 0]
    );
    if (!rows[0]) throw notFound();
    await logEvent(db, rows[0].id, { userId: user?.id, action: 'delete' });
  });
}

export async function restoreWatch(id, user) {
  return tx(async (db) => {
    const { rows } = await db.query(
      'UPDATE watches SET deleted_at = NULL, updated_at = now() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id',
      [Number(id) || 0]
    );
    if (!rows[0]) throw notFound();
    await logEvent(db, rows[0].id, { userId: user?.id, action: 'restore' });
  });
}

/* ── photos ───────────────────────────────────────────────────────── */

export const MAX_PHOTOS = 40;

/**
 * Stores photos against a watch, after the ones it already has.
 * `files` is [{ buffer, name }]; one that is not a picture fails the whole
 * request before anything is stored, so a half-done upload never happens.
 */
/**
 * Adds photos to a watch.
 *
 * `skipDuplicates` (the syncs): a picture the watch already holds under
 * another address — or held and somebody removed — is not stored again. It
 * gets a row all the same, marked removed and pointing at the photo it
 * repeats, so the next pass knows its address and does not fetch it again.
 *
 * @returns {number[]} the ids of the photos now shown
 */
export async function addPhotos(id, files, user, { source = 'upload', sourceRefs = [], db: outer, skipDuplicates = false } = {}) {
  const watchId = Number(id) || 0;
  const run = async (db) => {
    const { rows } = await db.query(
      `SELECT w.id, (SELECT count(*)::int FROM watch_photos p WHERE p.watch_id = w.id AND p.deleted_at IS NULL) AS n,
              (SELECT COALESCE(max(sort), -1) FROM watch_photos p WHERE p.watch_id = w.id) AS last
         FROM watches w WHERE w.id = $1`,
      [watchId]
    );
    if (!rows[0]) throw notFound();
    if (source === 'upload' && rows[0].n + files.length > MAX_PHOTOS) {
      throw Object.assign(new Error(`A watch can hold ${MAX_PHOTOS} photos; this one has ${rows[0].n}`), {
        status: 400,
      });
    }

    const prints = [];
    for (const f of files) prints.push(await fingerprint(f.buffer));

    const ids = [];
    let sort = rows[0].last;
    for (let i = 0; i < files.length; i += 1) {
      const fp = prints[i];
      const dup = skipDuplicates ? await duplicateOf(db, watchId, files[i].buffer, fp) : null;
      const s = dup ? { storage_key: null, thumb_key: null } : await savePhoto(files[i].buffer);
      if (!dup) sort += 1;
      const { rows: r } = await db.query(
        `INSERT INTO watch_photos(watch_id, storage_key, thumb_key, content_type, bytes, width, height, sort, caption,
                                  source, source_ref, created_by, sha256, dhash, duplicate_of, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [
          watchId, s.storage_key, s.thumb_key, fp.content_type, fp.bytes, fp.width, fp.height, sort,
          String(files[i].caption || '').slice(0, 200), source, sourceRefs[i] ?? null, user?.id ?? null,
          fp.sha256, fp.dhash, dup, dup ? new Date() : null,
        ]
      );
      if (!dup) ids.push(r[0].id);
    }
    if (!ids.length) return ids;
    await db.query('UPDATE watches SET updated_at = now() WHERE id = $1', [watchId]);
    await logEvent(db, watchId, {
      userId: user?.id,
      source: source === 'upload' ? 'user' : source,
      action: 'photo_add',
      changes: { photos: ids, count: ids.length },
    });
    return ids;
  };
  return outer ? run(outer) : tx(run);
}

/** Fingerprints for photos stored before they were taken (read once, then kept). */
async function fillFingerprints(db, photos) {
  const s = await storage();
  for (const p of photos) {
    if (p.sha256 || !p.storage_key) continue;
    const buffer = await s.get(p.storage_key);
    if (!buffer) continue;
    Object.assign(p, await fingerprint(buffer));
    await db.query('UPDATE watch_photos SET sha256 = $1, dhash = $2 WHERE id = $3', [p.sha256, p.dhash, p.id]);
  }
}

/**
 * The photo among `photos` that this picture repeats — the same bytes, or
 * the same picture only saved again (storage/index.js, samePicture) — or null.
 * Points past a recorded duplicate to the photo it repeats.
 */
async function sameAs(photos, buffer, fp) {
  const root = (p) => p.duplicate_of || p.id;
  const exact = photos.find((p) => p.sha256 && p.sha256 === fp.sha256);
  if (exact) return root(exact);
  const s = await storage();
  for (const p of photos) {
    if (!p.storage_key || !p.dhash || p.width !== fp.width || p.height !== fp.height) continue;
    if (dhashDistance(p.dhash, fp.dhash) > 8) continue; // not even a candidate
    const other = await s.get(p.storage_key);
    if (other && (await samePicture(buffer, other))) return root(p);
  }
  return null;
}

/** Every photo the watch has had — removed ones too: a removed picture must not come back under another address. */
async function duplicateOf(db, watchId, buffer, fp) {
  const { rows } = await db.query(
    'SELECT id, storage_key, sha256, dhash, width, height, duplicate_of FROM watch_photos WHERE watch_id = $1 ORDER BY id',
    [watchId]
  );
  await fillFingerprints(db, rows);
  return sameAs(rows, buffer, fp);
}

/**
 * Hides the repeats among the photos a watch SHOWS — copies made before the
 * syncs recognised them. The first in the watch's order stays; each repeat is
 * marked removed as a duplicate of it, its file kept, so nothing is lost and
 * the next sync does not copy it back.
 *
 * @returns {{watches: number, hidden: number}}
 */
export async function tidyDuplicatePhotos({ onProgress } = {}) {
  const stats = { watches: 0, hidden: 0, placeholders: 0 };

  // Chrono Key's "no image" graphic, copied as a photo before the copy knew
  // it (chronokey/parse.js, isPlaceholder): hidden, the row kept so it is
  // never fetched again.
  const { rows: fakes } = await query(
    "SELECT id, watch_id, source_ref FROM watch_photos WHERE source = 'chronokey' AND deleted_at IS NULL"
  );
  for (const p of fakes.filter((x) => isPlaceholder(x.source_ref))) {
    await tx(async (db) => {
      await db.query('UPDATE watch_photos SET deleted_at = now() WHERE id = $1', [p.id]);
      await db.query('UPDATE watches SET updated_at = now() WHERE id = $1', [p.watch_id]);
      await logEvent(db, p.watch_id, { source: 'masterapp', action: 'photo_remove', changes: { photos: [p.id], placeholder: true } });
    });
    stats.placeholders += 1;
  }

  const { rows: list } = await query(
    'SELECT watch_id FROM watch_photos WHERE deleted_at IS NULL GROUP BY watch_id HAVING count(*) > 1 ORDER BY watch_id'
  );
  const s = await storage();
  for (const { watch_id: watchId } of list) {
    await tx(async (db) => {
      const { rows } = await db.query(
        `SELECT id, storage_key, sha256, dhash, width, height, duplicate_of, source FROM watch_photos
          WHERE watch_id = $1 AND deleted_at IS NULL ORDER BY sort, id FOR UPDATE`,
        [watchId]
      );
      await fillFingerprints(db, rows);
      const kept = [];
      const hidden = [];
      for (const p of rows) {
        const buffer = p.storage_key && (await s.get(p.storage_key));
        const dup = buffer && kept.length ? await sameAs(kept, buffer, p) : null;
        if (!dup) {
          kept.push(p);
          continue;
        }
        await db.query('UPDATE watch_photos SET deleted_at = now(), duplicate_of = $1 WHERE id = $2', [dup, p.id]);
        hidden.push(p.id);
      }
      if (hidden.length) {
        await db.query('UPDATE watches SET updated_at = now() WHERE id = $1', [watchId]);
        await logEvent(db, watchId, { source: 'masterapp', action: 'photo_remove', changes: { photos: hidden, duplicates: true } });
        stats.watches += 1;
        stats.hidden += hidden.length;
      }
    });
    onProgress?.(stats);
  }
  return stats;
}

export async function removePhoto(watchId, photoId, user) {
  return tx(async (db) => {
    // Kept as a row, marked removed: a photo copied from Chrono Key must not
    // come back on the next sync, and that row is what remembers it.
    const { rows } = await db.query(
      `UPDATE watch_photos SET deleted_at = now() WHERE id = $1 AND watch_id = $2 AND deleted_at IS NULL RETURNING id`,
      [Number(photoId) || 0, Number(watchId) || 0]
    );
    if (!rows[0]) throw Object.assign(new Error('No such photo'), { status: 404 });
    await db.query('UPDATE watches SET updated_at = now() WHERE id = $1', [Number(watchId)]);
    await logEvent(db, Number(watchId), { userId: user?.id, action: 'photo_remove', changes: { photo: rows[0].id } });
  });
}

/** Puts the photos in the order given; the first is the one the grid shows. */
export async function orderPhotos(watchId, ids, user) {
  const want = (Array.isArray(ids) ? ids : []).map(Number);
  return tx(async (db) => {
    const { rows } = await db.query(
      'SELECT id FROM watch_photos WHERE watch_id = $1 AND deleted_at IS NULL ORDER BY sort, id',
      [Number(watchId) || 0]
    );
    const have = rows.map((r) => r.id);
    if (want.length !== have.length || !want.every((x) => have.includes(x))) {
      throw Object.assign(new Error('The order must list every photo of this watch exactly once'), { status: 400 });
    }
    for (let i = 0; i < want.length; i += 1) {
      await db.query('UPDATE watch_photos SET sort = $1 WHERE id = $2', [i, want[i]]);
    }
    await db.query('UPDATE watches SET updated_at = now() WHERE id = $1', [Number(watchId)]);
    await logEvent(db, Number(watchId), { userId: user?.id, action: 'photo_order', changes: { order: want } });
  });
}

export async function captionPhoto(watchId, photoId, caption, user) {
  const { rowCount } = await query(
    'UPDATE watch_photos SET caption = $1 WHERE id = $2 AND watch_id = $3 AND deleted_at IS NULL',
    [String(caption || '').slice(0, 200), Number(photoId) || 0, Number(watchId) || 0]
  );
  if (!rowCount) throw Object.assign(new Error('No such photo'), { status: 404 });
}

/** The stored bytes of a photo (or its thumbnail), looked up by id — never by a path from a request. */
export async function photoFile(photoId, { thumb = false } = {}) {
  const { rows } = await query(
    'SELECT storage_key, thumb_key, content_type FROM watch_photos WHERE id = $1',
    [Number(photoId) || 0]
  );
  const p = rows[0];
  // A recorded duplicate has no file of its own.
  if (!p?.storage_key) return null;
  const key = thumb && p.thumb_key ? p.thumb_key : p.storage_key;
  const buffer = await (await storage()).get(key);
  if (!buffer) return null;
  return { buffer, type: thumb && p.thumb_key ? 'image/jpeg' : p.content_type };
}

export { COLUMNS };
