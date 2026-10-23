import crypto from 'node:crypto';
import { pool, query } from '../../db/index.js';
import { config } from '../../config.js';
import { fetchState, getPhoto } from '../vault/sync.js';
import { startRun, finishRun, progressRun } from '../listimport.js';
import { GONE_LIMIT } from '../gone.js';
import { KIND, NEVER_COPIED, isSecret, stockOf } from '../../logistics/kinds.js';
import { happenedAt } from '../../logistics/situation.js';
import { savePhoto, saveDocument } from '../../storage/index.js';

/*
 * The logistics app (the puro-sync document) → logistics_items.
 *
 * Every list in the document is copied, record by record, into our own rows;
 * a list the app adds later is copied too, under its own name. Its settings
 * never are: they hold its passwords.
 *
 * The rules are the ones the Chrono Key and vault copies keep:
 *   - until the switch-over the logistics app is the master: what it says
 *     replaces what we hold — except a field somebody edited here (locked)
 *   - a record it drops is deleted here softly, and restored if it comes back;
 *     a person's deletion is never undone
 *   - a read where a list lost more than 3% (and more than ten) at once is a
 *     broken read, not a clear-out: nothing in that list is taken as deleted
 *   - read-only: nothing is ever written to the worker
 *
 * The pictures inside records (inline, base64 — 90% of the document's bytes)
 * are stored once each as files, and the record keeps "lgfile:<id>" in their
 * place. Pictures on the worker's /photos/ are copied as well, a hundred a
 * pass: the worker goes when the logistics app does.
 *
 * A record that has not changed since the last read (its hash) is skipped,
 * which is what lets this run every minute.
 */

const sha = (s, alg = 'sha256') => crypto.createHash(alg).update(s).digest('hex');

/* JSON with its keys in order, at every depth: Postgres' jsonb reorders keys, so a plain JSON.stringify would see changes that are not there. */
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

/* What a change looks like in the history: the value itself when short, a word when it is a picture list or a long text. */
export function brief(v) {
  if (v === undefined) return null;
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (Array.isArray(v)) return stable(v).length > 300 ? `${v.length} entr${v.length === 1 ? 'y' : 'ies'}` : v;
  if (v && typeof v === 'object') return stable(v).length > 300 ? '(details)' : v;
  return v;
}

const workerOrigin = () => {
  try {
    return new URL(config.vault.url).origin;
  } catch {
    return null;
  }
};

/* ── files ─────────────────────────────────────────────────────────── */

/** Stores a picture or a PDF once (by its bytes) and returns its logistics_files id. */
export async function storeFile(buffer, ref = null) {
  const hash = sha(buffer);
  const had = await query('SELECT id FROM logistics_files WHERE sha256 = $1', [hash]);
  if (had.rows[0]) {
    if (ref) await query('UPDATE logistics_files SET source_ref = COALESCE(source_ref, $2) WHERE id = $1', [had.rows[0].id, ref]);
    return had.rows[0].id;
  }
  const s = buffer.subarray(0, 5).toString('latin1') === '%PDF-' ? await saveDocument(buffer) : await savePhoto(buffer);
  const { rows } = await query(
    `INSERT INTO logistics_files(sha256, storage_key, thumb_key, content_type, bytes, source_ref) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (sha256) DO NOTHING RETURNING id`,
    [hash, s.storage_key, s.thumb_key || null, s.content_type, s.bytes, ref]
  );
  if (rows[0]) return rows[0].id;
  return (await query('SELECT id FROM logistics_files WHERE sha256 = $1', [hash])).rows[0].id;
}

const DATA_URI = /^data:([\w.+-]+\/[\w.+-]+)?(;[\w=.+-]+)*;base64,/i;

/**
 * The record as kept here: secrets left out at every depth, inline pictures
 * stored as files and replaced by "lgfile:<id>".
 */
async function keep(v, stats) {
  if (typeof v === 'string') {
    if (v.length > 200 && v.startsWith('data:')) {
      const m = v.match(DATA_URI);
      if (!m) return v;
      try {
        const id = await storeFile(Buffer.from(v.slice(m[0].length), 'base64'));
        stats.files += 1;
        return `lgfile:${id}`;
      } catch {
        stats.unreadableFiles = (stats.unreadableFiles || 0) + 1;
        return 'lgfile:unreadable';
      }
    }
    return v;
  }
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) out.push(await keep(x, stats));
    return out;
  }
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (isSecret(k)) continue;
      out[k] = await keep(x, stats);
    }
    return out;
  }
  return v;
}

/** The worker's picture addresses a value holds. */
function workerUrls(v, prefix, acc = new Set()) {
  if (typeof v === 'string') {
    if (prefix && v.startsWith(prefix)) acc.add(v);
  } else if (Array.isArray(v)) v.forEach((x) => workerUrls(x, prefix, acc));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => workerUrls(x, prefix, acc));
  return acc;
}

/** The value with every address already copied replaced by its file. */
function localise(v, map) {
  if (typeof v === 'string') return map.has(v) ? `lgfile:${map.get(v)}` : v;
  if (Array.isArray(v)) return v.map((x) => localise(x, map));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, localise(x, map)]));
  return v;
}

async function copiedMap(urls) {
  if (!urls.length) return new Map();
  const { rows } = await query('SELECT source_ref, id FROM logistics_files WHERE source_ref = ANY($1)', [urls]);
  return new Map(rows.map((r) => [r.source_ref, r.id]));
}

/*
 * The worker's pictures our records still point at, copied a budget at a time
 * and swapped in. Not a change of the record — the same picture, kept here —
 * so no history entry and no lock.
 */
async function copyWorkerPhotos(stats) {
  const origin = workerOrigin();
  if (!origin) return;
  const prefix = `${origin}/photos/`;
  const { rows } = await query(
    "SELECT id, data FROM logistics_items WHERE data::text LIKE '%' || $1 || '%' ORDER BY updated_at DESC LIMIT 500",
    [prefix]
  );
  if (!rows.length) return;
  const wanted = [...new Set(rows.flatMap((r) => [...workerUrls(r.data, prefix)]))];
  const map = await copiedMap(wanted);
  let budget = config.logistics.photosPerPass;
  for (const url of wanted) {
    if (map.has(url) || budget <= 0) continue;
    budget -= 1;
    try {
      const buffer = await getPhoto(url);
      if (!buffer) continue;
      map.set(url, await storeFile(buffer, url));
      stats.photosCopied += 1;
    } catch (err) {
      console.warn(`[logistics] photo ${url}: ${err.message}`);
    }
  }
  for (const r of rows) {
    const next = localise(r.data, map);
    if (stable(next) !== stable(r.data)) await query('UPDATE logistics_items SET data = $2 WHERE id = $1', [r.id, next]);
  }
}

/* ── one record into ours ──────────────────────────────────────────── */

/**
 * Writes what the logistics app says into our item: new, or every field that
 * nobody locked here replaced — a field the app dropped is dropped too.
 */
async function applyItem(db, kind, sourceId, data, stockNos, stats, rowStock) {
  const { rows } = await db.query('SELECT * FROM logistics_items WHERE kind = $1 AND source_id = $2 FOR UPDATE', [kind, sourceId]);
  const it = rows[0];
  if (!it) {
    const { rows: ins } = await db.query(
      `INSERT INTO logistics_items(kind, source_id, data, stock_nos, happened_at, origin) VALUES ($1,$2,$3,$4,$5,'logistics') RETURNING id`,
      [kind, sourceId, data, stockNos, happenedAt(kind, data)]
    );
    await db.query("INSERT INTO logistics_events(item_id, source, action, changes) VALUES ($1,'logistics','create','{}')", [ins[0].id]);
    stats.created += 1;
    return ins[0].id;
  }

  const next = {};
  const changes = {};
  for (const k of new Set([...Object.keys(it.data), ...Object.keys(data)])) {
    if (it.locked_fields.includes(k)) {
      if (it.data[k] !== undefined) next[k] = it.data[k];
      continue;
    }
    if (data[k] === undefined) {
      if (it.data[k] !== undefined) changes[k] = [brief(it.data[k]), null];
      continue;
    }
    next[k] = data[k];
    if (stable(it.data[k]) !== stable(data[k])) changes[k] = [brief(it.data[k]), brief(data[k])];
  }
  // Locked stock numbers stay what the person typed; the rest follow the app.
  const stock = it.locked_fields.length ? stockOf(kind, next, rowStock) : stockNos;
  // Back after the sync deleted it: restored. A person's deletion stands.
  const back = it.source_gone_at !== null;
  const ours = back && it.deleted_at && +it.deleted_at === +it.source_gone_at;
  const keys = Object.keys(changes);
  const stockChanged = stable([...it.stock_nos].sort()) !== stable([...stock].sort());
  if (!keys.length && !stockChanged && !back) return it.id;

  await db.query(
    `UPDATE logistics_items SET data = $2, stock_nos = $3, happened_at = $5, updated_at = now(),
            deleted_at = CASE WHEN $4 THEN NULL ELSE deleted_at END, source_gone_at = NULL
      WHERE id = $1`,
    [it.id, next, stock, Boolean(ours), happenedAt(kind, next)]
  );
  if (keys.length) {
    await db.query("INSERT INTO logistics_events(item_id, source, action, changes) VALUES ($1,'logistics','sync',$2)", [it.id, changes]);
    stats.updated += 1;
  }
  if (ours) {
    await db.query("INSERT INTO logistics_events(item_id, source, action, changes) VALUES ($1,'logistics','restore',$2)", [it.id, { back: 'listed again' }]);
    stats.restored += 1;
  }
  return it.id;
}

/* ── a list's records that are no longer there ─────────────────────── */

async function settleGone(db, kind, seen, stats) {
  const { rows } = await db.query(
    'SELECT source_id, item_id FROM logistics_records WHERE kind = $1 AND gone_at IS NULL AND NOT (source_id = ANY($2))',
    [kind, seen]
  );
  if (!rows.length) return;
  if (rows.length > GONE_LIMIT(seen.length)) {
    console.warn(`[logistics] ${kind}: ${rows.length} records missing from one read of ${seen.length} — not taken as deleted`);
    stats.refused[kind] = rows.length;
    return;
  }
  await db.query('UPDATE logistics_records SET gone_at = now() WHERE kind = $1 AND source_id = ANY($2)', [kind, rows.map((r) => r.source_id)]);
  const ids = rows.map((r) => r.item_id).filter(Boolean);
  if (!ids.length) return;
  const deleted = await db.query(
    `UPDATE logistics_items SET deleted_at = now(), source_gone_at = now(), updated_at = now()
      WHERE id = ANY($1) AND origin = 'logistics' AND deleted_at IS NULL AND source_gone_at IS NULL RETURNING id`,
    [ids]
  );
  // Deleted here by a person already: only noted, so its return does not undo the person.
  await db.query(
    "UPDATE logistics_items SET source_gone_at = now() WHERE id = ANY($1) AND origin = 'logistics' AND deleted_at IS NOT NULL AND source_gone_at IS NULL",
    [ids]
  );
  for (const { id } of deleted.rows) {
    await db.query("INSERT INTO logistics_events(item_id, source, action, changes) VALUES ($1,'logistics','delete',$2)", [
      id,
      { gone: 'no longer in the logistics app' },
    ]);
  }
  stats.gone += deleted.rowCount;
}

/* ── the pass ──────────────────────────────────────────────────────── */

/* The lists a trip's or a notification's row ids point into, for their stock numbers. */
const ROW_LISTS = ['londonStock', 'dubaiStock', 'hkStock', 'safeStock', 'hkSituation', 'incomings', 'soldStocks', 'readyForDelivery', 'checkoutStock'];

function rowIndex(state) {
  const byList = new Map();
  for (const list of ROW_LISTS) {
    const m = new Map();
    for (const r of Array.isArray(state[list]) ? state[list] : []) if (r?.id) m.set(String(r.id), r.stockNumber || '');
    byList.set(list, m);
  }
  return (list, id) => {
    const key = String(id ?? '');
    if (list !== '*') return byList.get(list)?.get(key) || '';
    for (const m of byList.values()) if (m.get(key)) return m.get(key);
    return '';
  };
}

/** The document's lists: [kind, [[sourceId, record]]]. A map (vaultTracking) is a list keyed by its keys. */
function listsOf(state) {
  const out = [];
  for (const [kind, v] of Object.entries(state || {})) {
    if (NEVER_COPIED.has(kind) || isSecret(kind)) continue;
    if (Array.isArray(v)) {
      if (!v.some((r) => r && typeof r === 'object' && !Array.isArray(r))) {
        if (v.length) continue; // a list of plain values is not records
      }
      out.push([kind, v.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).map((r) => [r.id == null ? null : String(r.id), r])]);
    } else if (KIND[kind]?.map && v && typeof v === 'object') {
      out.push([kind, Object.entries(v).filter(([, r]) => r && typeof r === 'object').map(([k, r]) => [String(k), r])]);
    }
  }
  return out;
}

/* When the document was last read whole — even by a pass that found nothing new (and so kept no run). */
let lastRead = null;
export const lastLogisticsRead = () => lastRead;

const MAIN_LISTS = ['shipments', 'incomings', 'londonStock', 'dubaiStock', 'soldStocks', 'clients'];

export async function syncLogistics({ user, reuse = false, state: given } = {}) {
  if (!config.vault.configured) throw new Error('The logistics app is not configured (VAULT_URL)');
  const run = await startRun('logistics', 'full', user);
  const stats = { records: 0, kinds: 0, created: 0, updated: 0, unchanged: 0, restored: 0, gone: 0, noId: 0, files: 0, photosCopied: 0, refused: {} };
  try {
    const state = given || (await fetchState({ reuse }));
    if (!MAIN_LISTS.some((k) => Array.isArray(state?.[k]))) {
      throw new Error('The logistics app answered without its lists — not reading that as an empty app');
    }
    const rowStock = rowIndex(state);
    const lists = listsOf(state);
    stats.kinds = lists.length;
    const origin = workerOrigin();
    const prefix = origin ? `${origin}/photos/` : null;
    let written = 0;

    const client = await pool.connect();
    try {
      for (const [kind, records] of lists) {
        const { rows: had } = await client.query('SELECT source_id, hash, gone_at, item_id FROM logistics_records WHERE kind = $1', [kind]);
        const known = new Map(had.map((r) => [r.source_id, r]));
        const seen = [];
        for (const [sourceId, rec] of records) {
          if (!sourceId) {
            stats.noId += 1;
            continue;
          }
          stats.records += 1;
          seen.push(sourceId);
          const hash = sha(JSON.stringify(rec), 'sha1');
          const k = known.get(sourceId);
          if (k && k.hash === hash && !k.gone_at && k.item_id) {
            stats.unchanged += 1;
            continue;
          }
          const raw = await keep(rec, stats);
          const data = localise(raw, await copiedMap([...workerUrls(raw, prefix)]));
          const stockNos = stockOf(kind, KIND[kind]?.map ? { ...data, _key: sourceId } : data, rowStock);
          await client.query('BEGIN');
          try {
            const itemId = await applyItem(client, kind, sourceId, data, stockNos, stats, rowStock);
            await client.query(
              `INSERT INTO logistics_records(kind, source_id, data, hash, fetched_at, gone_at, item_id) VALUES ($1,$2,$3,$4,now(),NULL,$5)
               ON CONFLICT (kind, source_id) DO UPDATE SET data = EXCLUDED.data, hash = EXCLUDED.hash, fetched_at = now(),
                 gone_at = NULL, item_id = EXCLUDED.item_id`,
              [kind, sourceId, raw, hash, itemId]
            );
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw new Error(`${kind} ${sourceId}: ${err.message}`);
          }
          written += 1;
          if (written % 100 === 0) await progressRun(run, stats);
        }
        if (KIND[kind]?.keepGone || !seen.length) continue;
        await client.query('BEGIN');
        try {
          await settleGone(client, kind, seen, stats);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      }
    } finally {
      client.release();
    }
    await copyWorkerPhotos(stats);
    lastRead = new Date();
    // A pass that found nothing new leaves no run behind: every minute would be 1,440 rows a day of "nothing".
    const changed = stats.created + stats.updated + stats.restored + stats.gone + stats.photosCopied + Object.keys(stats.refused).length;
    if (!changed && !user) await query('DELETE FROM import_runs WHERE id = $1', [run]);
    else await finishRun(run, { ok: true, stats });
    return stats;
  } catch (err) {
    await finishRun(run, { ok: false, stats, error: err.message });
    throw err;
  }
}
