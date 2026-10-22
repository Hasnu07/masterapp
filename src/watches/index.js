import { query, tx } from '../db/index.js';
import { FIELDS, FIELD, cleanValue, displayTitle } from './fields.js';
import { savePhoto, storage } from '../storage/index.js';

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

  const [photos, ck, vault] = await Promise.all([
    query(
      `SELECT id, caption, source, width, height, bytes, content_type, sort, created_at
         FROM watch_photos WHERE watch_id = $1 AND deleted_at IS NULL ORDER BY sort, id`,
      [w.id]
    ),
    query('SELECT ck_id, stock_no, detail, list_row, detail_at AS fetched_at FROM ck_records WHERE watch_id = $1', [w.id]),
    query('SELECT vault_id, list, data, fetched_at FROM vault_records WHERE watch_id = $1', [w.id]),
  ]);

  return {
    ...w,
    display_title: displayTitle(w),
    photos: photos.rows,
    sources: {
      // What Chrono Key and the vault hold for it, shown beside our record so a
      // difference can be seen. Photo urls are left out: they are copied.
      chronokey: ck.rows.map((r) => ({
        ck_id: r.ck_id,
        fetched_at: r.fetched_at,
        title: r.detail?.title || '',
        status: r.detail?.status || '',
        category: r.detail?.category || '',
        currencyNote: r.detail?.currencyNote || '',
        tags: r.detail?.tags || {},
        sections: r.detail?.sections || {},
      })),
      vault: vault.rows.map((r) => ({
        vault_id: r.vault_id,
        list: r.list,
        fetched_at: r.fetched_at,
        data: stripPhotoUrls(r.data),
      })),
    },
  };
}

function stripPhotoUrls(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (/photos?$/i.test(k) || typeof v === 'string' && v.startsWith('data:')) continue;
    out[k] = v;
  }
  return out;
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
      'UPDATE watches SET locked_fields = array_remove(locked_fields, $1) WHERE id = $2 RETURNING id',
      [key, Number(id) || 0]
    );
    if (!rows[0]) throw notFound();
    await logEvent(db, rows[0].id, { userId: user?.id, action: 'unlock', changes: { field: key } });
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
export async function addPhotos(id, files, user, { source = 'upload', sourceRefs = [], db: outer } = {}) {
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

    const saved = [];
    for (const f of files) saved.push(await savePhoto(f.buffer));

    const ids = [];
    let sort = rows[0].last;
    for (let i = 0; i < saved.length; i += 1) {
      const s = saved[i];
      sort += 1;
      const { rows: r } = await db.query(
        `INSERT INTO watch_photos(watch_id, storage_key, thumb_key, content_type, bytes, width, height, sort, caption,
                                  source, source_ref, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [
          watchId, s.storage_key, s.thumb_key, s.content_type, s.bytes, s.width, s.height, sort,
          String(files[i].caption || '').slice(0, 200), source, sourceRefs[i] ?? null, user?.id ?? null,
        ]
      );
      ids.push(r[0].id);
    }
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
  if (!p) return null;
  const key = thumb && p.thumb_key ? p.thumb_key : p.storage_key;
  const buffer = await (await storage()).get(key);
  if (!buffer) return null;
  return { buffer, type: thumb && p.thumb_key ? 'image/jpeg' : p.content_type };
}

export { COLUMNS };
