import crypto from 'node:crypto';
import { pool, query, tx } from '../../db/index.js';
import { config } from '../../config.js';
import { fetchAccountsState, erpSessionCookie } from './client.js';
import { startRun, finishRun, progressRun } from '../listimport.js';
import { GONE_LIMIT } from '../gone.js';
import { isSecret } from '../../logistics/kinds.js';
import { stable, brief } from '../logistics/sync.js';
import { savePhoto, saveDocument, storage } from '../../storage/index.js';

/*
 * The accounts app (its /api/state) → accounts_items.
 *
 * Every collection the app keeps is copied, record by record, into our own
 * rows; a collection the app adds later is copied too, under its own name.
 * The rules are the ones the Chrono Key, vault and logistics copies keep:
 *   - until the switch-over the accounts app is the master: what it says
 *     replaces what we hold — except a field somebody edited here (locked)
 *   - a record it drops is deleted here softly, and restored if it comes back;
 *     a person's deletion is never undone
 *   - a read where a collection lost more than 3% (and more than ten) at once
 *     is a broken read, not a clear-out: nothing in it is taken as deleted
 *   - read-only: nothing is ever written to the app
 *
 * How a collection is kept:
 *   - a list of records with an `id` (entries, clients, invoices, quickSales,
 *     expenses, deskOps …) or a `code` (currencies): one row per record
 *   - anything else — a map (employeeCodes, commissionOverrides), a list of
 *     plain values (expenseCategories), a list without ids — ONE row, the
 *     whole value, under the id "*": still copied, never lost, not split
 *
 * A picture written inline into a record (older entries carry their invoice or
 * proof as base64) is stored once as a file and the record keeps
 * "acfile:<id>" in its place. The app's newer files live under its own
 * /uploads/ and stay references, shown through the ERP as they are.
 *
 * A record that has not changed since the last read (its hash) is skipped,
 * which is what lets the between-passes read run every minute.
 */

const sha = (s, alg = 'sha256') => crypto.createHash(alg).update(s).digest('hex');
/* Bump when stockNosOf / clientIdsOf / happenedAt change what they read, so the next pass rewrites every record once. */
const RULE = 1;

/* ── what a record names ──────────────────────────────────────────── */

const STOCK_NO = /^\d{1,6}[A-Za-z]?$/;
const splitNos = (v) =>
  String(v ?? '')
    .split(/[,;|/&\n]+|\band\b/i)
    .map((x) => x.trim().replace(/^#/, ''))
    .filter((x) => STOCK_NO.test(x));

/**
 * The stock numbers a record names: its `stock` (an entry, a quick sale, a
 * partner watch — one number, or several comma-separated on a settlement),
 * the stocks of its lines, its part-exchange rows, and on an expense the
 * "1385 | Client | Commission" the app writes itself.
 */
export function stockNosOf(kind, d) {
  const out = new Set();
  const take = (v) => splitNos(v).forEach((n) => out.add(n));
  if (!d || typeof d !== 'object') return [];
  for (const k of ['stock', 'stockNo', 'stockNumber']) if (d[k] != null && typeof d[k] !== 'object') take(d[k]);
  for (const k of ['lines', 'pxBuys', 'pxSells', 'items', 'watches', 'deals']) {
    if (!Array.isArray(d[k])) continue;
    for (const r of d[k]) {
      if (!r || typeof r !== 'object') continue;
      for (const f of ['stock', 'stockNo', 'stockNumber']) if (r[f] != null && typeof r[f] !== 'object') take(r[f]);
    }
  }
  if (kind === 'expenses' && typeof d.description === 'string') {
    const m = d.description.match(/^\s*#?(\d{1,6}[A-Za-z]?)\s*\|/);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/** The accounts clients a record names, by the app's own ids (CL-001 …). */
export function clientIdsOf(d) {
  const out = new Set();
  if (!d || typeof d !== 'object') return [];
  for (const k of ['clientId', 'counterClientId', 'fromClientId', 'toClientId', 'partnerClientId']) {
    const v = d[k];
    if (v != null && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) out.add(String(v).trim());
  }
  return [...out];
}

/** The record's own moment: its day (YYYY-MM-DD), else when the app made it. */
export function happenedAt(d) {
  if (!d || typeof d !== 'object') return null;
  for (const k of ['date', 'saleDate', 'paidAt', 'dueDate', '_createdAt', 'createdAt', 'ts']) {
    const v = d[k];
    if (v == null || v === '') continue;
    if (typeof v === 'number' && v > 1e11 && v < 4e12) return new Date(v).toISOString();
    const s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
      const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s);
      if (!Number.isNaN(t)) return new Date(t).toISOString();
    }
  }
  return null;
}

/* ── files ─────────────────────────────────────────────────────────── */

async function storeFile(buffer, ref = null) {
  const hash = sha(buffer);
  const had = await query('SELECT id FROM accounts_files WHERE sha256 = $1', [hash]);
  if (had.rows[0]) {
    if (ref) await query('UPDATE accounts_files SET source_ref = COALESCE(source_ref, $2) WHERE id = $1', [had.rows[0].id, ref]);
    return had.rows[0].id;
  }
  const s = buffer.subarray(0, 5).toString('latin1') === '%PDF-' ? await saveDocument(buffer) : await savePhoto(buffer);
  const { rows } = await query(
    `INSERT INTO accounts_files(sha256, storage_key, thumb_key, content_type, bytes, source_ref) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (sha256) DO NOTHING RETURNING id`,
    [hash, s.storage_key, s.thumb_key || null, s.content_type, s.bytes, ref]
  );
  if (rows[0]) return rows[0].id;
  return (await query('SELECT id FROM accounts_files WHERE sha256 = $1', [hash])).rows[0].id;
}

/** A copied file by its id ("acfile:<id>" in a record): its bytes and type, or its thumbnail. */
export async function fileById(id, { thumb = false } = {}) {
  const { rows } = await query('SELECT storage_key, thumb_key, content_type FROM accounts_files WHERE id = $1', [Number(id) || 0]);
  const f = rows[0];
  if (!f) return null;
  const key = thumb && f.thumb_key ? f.thumb_key : f.storage_key;
  const buffer = await (await storage()).get(key);
  return buffer ? { buffer, type: thumb && f.thumb_key ? 'image/jpeg' : f.content_type } : null;
}

const DATA_URI = /^data:([\w.+-]+\/[\w.+-]+)?(;[\w=.+-]+)*;base64,/i;

/** The record as kept here: secrets left out at any depth, inline pictures stored as files and replaced by "acfile:<id>". */
async function keep(v, stats) {
  if (typeof v === 'string') {
    if (v.length > 200 && v.startsWith('data:')) {
      const m = v.match(DATA_URI);
      if (!m) return v;
      try {
        const id = await storeFile(Buffer.from(v.slice(m[0].length), 'base64'));
        stats.files += 1;
        return `acfile:${id}`;
      } catch (err) {
        // Not a picture or a PDF this app can read: kept as such. Anything else fails the record, which is read again next pass.
        if (err.status !== 415) throw err;
        stats.unreadableFiles = (stats.unreadableFiles || 0) + 1;
        return 'acfile:unreadable';
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

/* ── the app's own uploads, copied here for the switch-over ────────── */

const UPLOAD = /^\/uploads\/[^\s"'<>]+$/;
function uploadRefs(v, acc = new Set()) {
  if (typeof v === 'string') {
    if (UPLOAD.test(v)) acc.add(v);
  } else if (Array.isArray(v)) v.forEach((x) => uploadRefs(x, acc));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => uploadRefs(x, acc));
  return acc;
}
function localise(v, map) {
  if (typeof v === 'string') return map.has(v) ? `acfile:${map.get(v)}` : v;
  if (Array.isArray(v)) return v.map((x) => localise(x, map));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, localise(x, map)]));
  return v;
}
async function copiedMap(refs) {
  if (!refs.length) return new Map();
  const { rows } = await query('SELECT source_ref, id FROM accounts_files WHERE source_ref = ANY($1)', [refs]);
  return new Map(rows.map((r) => [r.source_ref, r.id]));
}
const MAX_FILE = 50 * 1024 * 1024;
/* An address that gave nothing storable (a Word file, a dead link) is not asked for again for a day. */
const refused = new Map();
const REFUSED_FOR = 24 * 3600_000;

/** One of the app's uploads, with the ERP's own session: a picture or a PDF, or null. */
async function getUpload(ref, cookie) {
  const res = await fetch(`${config.accounts.appUrl}${ref}`, { headers: { Cookie: cookie }, redirect: 'manual', signal: AbortSignal.timeout(config.accounts.timeoutMs) });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !(type.startsWith('image/') || type.startsWith('application/pdf'))) {
    await res.arrayBuffer().catch(() => {});
    return null;
  }
  if (Number(res.headers.get('content-length')) > MAX_FILE) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body || []) {
    size += chunk.length;
    if (size > MAX_FILE) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/*
 * The uploads our records still point at (/uploads/<folder>/<file>: proofs,
 * invoices, ID documents), copied an allowance a pass, four at a time, and
 * swapped in as "acfile:<id>" — the same file, kept here, so the switch-over
 * does not lose them and the watch page shows them from our copy. Not a
 * change of the record: no history entry, no lock. The swap re-reads each
 * record under a lock, so a person's edit made meanwhile is kept.
 */
async function copyUploads(stats) {
  if (!config.accounts.configured || config.accounts.filesPerPass <= 0) return;
  const { rows } = await query("SELECT id, data FROM accounts_items WHERE deleted_at IS NULL AND data::text LIKE '%/uploads/%' ORDER BY updated_at DESC LIMIT 2000");
  if (!rows.length) return;
  const now = Date.now();
  const wanted = [...new Set(rows.flatMap((r) => [...uploadRefs(r.data)]))];
  const map = await copiedMap(wanted);
  const todo = wanted.filter((ref) => !map.has(ref) && now - (refused.get(ref) || 0) >= REFUSED_FOR).slice(0, config.accounts.filesPerPass);
  if (todo.length) {
    const cookie = await erpSessionCookie();
    if (!cookie) return;
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const ref = todo[next];
        next += 1;
        try {
          const buffer = await getUpload(ref, cookie);
          if (buffer) {
            map.set(ref, await storeFile(buffer, ref));
            stats.filesCopied += 1;
            continue;
          }
        } catch (err) {
          if (err.status !== 415) console.warn(`[accounts] upload ${ref}: ${err.message}`);
        }
        refused.set(ref, now);
        if (refused.size > 20_000) refused.clear();
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }
  for (const r of rows) {
    if (stable(localise(r.data, map)) === stable(r.data)) continue;
    await tx(async (db) => {
      const { rows: cur } = await db.query('SELECT data FROM accounts_items WHERE id = $1 FOR UPDATE', [r.id]);
      if (!cur[0]) return;
      const next = localise(cur[0].data, map);
      if (stable(next) !== stable(cur[0].data)) await db.query('UPDATE accounts_items SET data = $2 WHERE id = $1', [r.id, next]);
    });
  }
}

/* ── one record into ours ──────────────────────────────────────────── */

/**
 * Writes what the accounts app says into our item: new, or every field that
 * nobody locked here replaced — a field the app dropped is dropped too.
 */
async function applyItem(db, kind, sourceId, data, stats) {
  const { rows } = await db.query('SELECT * FROM accounts_items WHERE kind = $1 AND source_id = $2 FOR UPDATE', [kind, sourceId]);
  const it = rows[0];
  const whole = sourceId === '*';
  const nos = (d) => (whole ? [] : stockNosOf(kind, d));
  const cids = (d) => (whole ? [] : clientIdsOf(d));
  if (!it) {
    const { rows: ins } = await db.query(
      `INSERT INTO accounts_items(kind, source_id, data, stock_nos, client_ids, happened_at, origin) VALUES ($1,$2,$3,$4,$5,$6,'accounts') RETURNING id`,
      [kind, sourceId, data, nos(data), cids(data), happenedAt(data)]
    );
    await db.query("INSERT INTO accounts_events(item_id, source, action, changes) VALUES ($1,'accounts','create','{}')", [ins[0].id]);
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
  const stock = nos(next);
  const clientIds = cids(next);
  // Back after the sync deleted it: restored. A person's deletion stands.
  const back = it.source_gone_at !== null;
  const ours = back && it.deleted_at && +it.deleted_at === +it.source_gone_at;
  const keys = Object.keys(changes);
  const same = (a, b) => stable([...a].sort()) === stable([...b].sort());
  if (!keys.length && same(it.stock_nos, stock) && same(it.client_ids, clientIds) && !back) return it.id;
  await db.query(
    `UPDATE accounts_items SET data = $2, stock_nos = $3, client_ids = $4, happened_at = $6, updated_at = now(),
            deleted_at = CASE WHEN $5 THEN NULL ELSE deleted_at END, source_gone_at = NULL
      WHERE id = $1`,
    [it.id, next, stock, clientIds, Boolean(ours), happenedAt(next)]
  );
  if (keys.length) {
    await db.query("INSERT INTO accounts_events(item_id, source, action, changes) VALUES ($1,'accounts','sync',$2)", [it.id, changes]);
    stats.updated += 1;
  }
  if (ours) {
    await db.query("INSERT INTO accounts_events(item_id, source, action, changes) VALUES ($1,'accounts','restore',$2)", [it.id, { back: 'listed again' }]);
    stats.restored += 1;
  }
  return it.id;
}

/* ── a collection's records that are no longer there ───────────────── */

async function settleGone(db, kind, seen, stats) {
  const { rows } = await db.query('SELECT source_id, item_id FROM accounts_records WHERE kind = $1 AND gone_at IS NULL AND NOT (source_id = ANY($2))', [kind, seen]);
  if (!rows.length) return;
  if (rows.length > GONE_LIMIT(seen.length)) {
    console.warn(`[accounts] ${kind}: ${rows.length} records missing from one read of ${seen.length} — not taken as deleted`);
    stats.refused[kind] = rows.length;
    return;
  }
  await db.query('UPDATE accounts_records SET gone_at = now() WHERE kind = $1 AND source_id = ANY($2)', [kind, rows.map((r) => r.source_id)]);
  const ids = rows.map((r) => r.item_id).filter(Boolean);
  if (!ids.length) return;
  const deleted = await db.query(
    `UPDATE accounts_items SET deleted_at = now(), source_gone_at = now(), updated_at = now()
      WHERE id = ANY($1) AND origin = 'accounts' AND deleted_at IS NULL AND source_gone_at IS NULL RETURNING id`,
    [ids]
  );
  // Deleted here by a person already: only noted, so its return does not undo the person.
  await db.query("UPDATE accounts_items SET source_gone_at = now() WHERE id = ANY($1) AND origin = 'accounts' AND deleted_at IS NOT NULL AND source_gone_at IS NULL", [ids]);
  for (const { id } of deleted.rows) {
    await db.query("INSERT INTO accounts_events(item_id, source, action, changes) VALUES ($1,'accounts','delete',$2)", [id, { gone: 'no longer in the accounts app' }]);
  }
  stats.gone += deleted.rowCount;
}

/* ── the pass ──────────────────────────────────────────────────────── */

/** A collection's records: [[sourceId, record]], or one record "*" holding the whole value. */
export function recordsOf(value) {
  if (Array.isArray(value)) {
    const objs = value.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
    if (value.length && objs.length === value.length) {
      const has = (k) => value.every((r) => r[k] != null && String(r[k]).trim());
      const key = has('id') ? 'id' : has('code') ? 'code' : null;
      if (key) {
        // Two records with one id are two records here too: the second is "<id>~2".
        const used = new Map();
        return value.map((r) => {
          const id = String(r[key]).trim();
          const n = (used.get(id) || 0) + 1;
          used.set(id, n);
          return [n === 1 ? id : `${id}~${n}`, r];
        });
      }
    }
    return [['*', { value }]];
  }
  return [['*', { value: value ?? null }]];
}

/*
 * When our copy was last known to be current: the document read whole (even
 * by a pass that found nothing new), or, since, the minute check finding every
 * version number unchanged. A quiet accounts app is not a stale copy.
 */
let lastRead = null;
let lastSame = null;
export const lastAccountsRead = () => (lastRead && lastSame && lastSame > lastRead ? lastSame : lastRead);
export const noteAccountsUnchanged = () => {
  if (lastRead) lastSame = new Date();
};

const MAIN = ['entries', 'clients'];

/**
 * @param quiet  the between-passes read (a version number moved): no import_runs row
 * @param only   the collections to read, else all of them
 */
export async function syncAccounts({ user, quiet = false, only = null, state: given } = {}) {
  if (!config.accounts.configured) throw new Error('The accounts app is not configured — set ACCOUNTS_USERNAME and ACCOUNTS_PASSWORD');
  const run = quiet ? null : await startRun('accounts', only ? 'changed' : 'full', user);
  const stats = { records: 0, kinds: 0, created: 0, updated: 0, unchanged: 0, restored: 0, gone: 0, files: 0, filesCopied: 0, failed: 0, refused: {} };
  try {
    const state = given || (await fetchAccountsState(only));
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('The accounts app answered without its collections — not reading that as an empty app');
    if (!only && !MAIN.some((k) => Array.isArray(state[k]))) throw new Error('The accounts app answered without its ledger or its clients — not reading that as an empty app');
    const lists = Object.entries(state).filter(([k]) => !isSecret(k) && (!only || only.includes(k)));
    stats.kinds = lists.length;
    let written = 0;
    const client = await pool.connect();
    try {
      for (const [kind, value] of lists) {
        const records = recordsOf(value);
        const { rows: had } = await client.query('SELECT source_id, hash, gone_at, item_id FROM accounts_records WHERE kind = $1', [kind]);
        const known = new Map(had.map((r) => [r.source_id, r]));
        const seen = [];
        for (const [sourceId, listed] of records) {
          stats.records += 1;
          seen.push(sourceId);
          const hash = sha(`${JSON.stringify(listed)}#${RULE}`, 'sha1');
          const k = known.get(sourceId);
          if (k && k.hash === hash && !k.gone_at && k.item_id) {
            stats.unchanged += 1;
            continue;
          }
          // One record that cannot be kept is skipped and tried again next pass — it does not stop the rest. It stays "seen": never taken as gone.
          try {
            const data = await keep(listed, stats);
            await client.query('BEGIN');
            try {
              const itemId = await applyItem(client, kind, sourceId, data, stats);
              await client.query(
                `INSERT INTO accounts_records(kind, source_id, data, hash, fetched_at, gone_at, item_id) VALUES ($1,$2,$3,$4,now(),NULL,$5)
                 ON CONFLICT (kind, source_id) DO UPDATE SET data = EXCLUDED.data, hash = EXCLUDED.hash, fetched_at = now(), gone_at = NULL, item_id = EXCLUDED.item_id`,
                [kind, sourceId, data, hash, itemId]
              );
              await client.query('COMMIT');
            } catch (err) {
              await client.query('ROLLBACK').catch(() => {});
              throw err;
            }
          } catch (err) {
            stats.failed += 1;
            if ((stats.failures ||= []).length < 5) stats.failures.push(`${kind} ${sourceId}: ${err.message}`);
            console.warn(`[accounts] ${kind} ${sourceId} not kept: ${err.message}`);
            continue;
          }
          written += 1;
          if (run && written % 100 === 0) await progressRun(run, stats);
        }
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
    if (!only) {
      await copyUploads(stats);
      lastRead = new Date();
    }
    if (run) {
      // A pass that found nothing new leaves no run behind.
      const changed = stats.created + stats.updated + stats.restored + stats.gone + stats.filesCopied + stats.failed + Object.keys(stats.refused).length;
      if (!changed && !user) await query('DELETE FROM import_runs WHERE id = $1', [run]);
      else await finishRun(run, { ok: !stats.failed, stats });
    }
    return stats;
  } catch (err) {
    if (run) await finishRun(run, { ok: false, stats, error: err.message });
    throw err;
  }
}
