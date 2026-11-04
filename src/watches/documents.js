import { query, tx } from '../db/index.js';
import { saveDocument, storage } from '../storage/index.js';
import { logEvent } from './index.js';

/*
 * A watch's documents (4 Nov 2026): the invoice, the papers, a customs form,
 * a receipt — PDFs or pictures, kept with the watch. Stored as an expense's
 * payment copies are (saveDocument), served behind the sign-in, removed
 * softly, every change in the watch's history.
 */

export const MAX_DOCS = 30;
export const KINDS = ['invoice', 'papers', 'customs', 'receipt', 'other'];
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

export async function listDocuments(watchId) {
  const { rows } = await query(
    `SELECT d.id, d.name, d.kind, d.content_type, d.bytes, d.thumb_key IS NOT NULL AS has_thumb, d.created_at, u.name AS user_name
       FROM watch_documents d LEFT JOIN users u ON u.id = d.created_by
      WHERE d.watch_id = $1 AND d.deleted_at IS NULL ORDER BY d.created_at, d.id`,
    [Number(watchId) || 0]
  );
  return rows;
}

export async function addDocuments(watchId, files, user, kind = '') {
  const k = KINDS.includes(String(kind)) ? String(kind) : '';
  const { rows } = await query(
    `SELECT w.id, (SELECT count(*)::int FROM watch_documents d WHERE d.watch_id = w.id AND d.deleted_at IS NULL) AS n FROM watches w WHERE w.id = $1`,
    [Number(watchId) || 0]
  );
  if (!rows[0]) throw Object.assign(new Error('No such watch'), { status: 404 });
  if (rows[0].n + files.length > MAX_DOCS) throw bad(`A watch can hold ${MAX_DOCS} documents; this one has ${rows[0].n}`);
  // Every file is checked and stored before any row is written: a bad one fails the lot.
  const stored = [];
  for (const f of files) {
    try {
      stored.push({ ...(await saveDocument(f.buffer)), name: String(f.name || '').slice(0, 200) });
    } catch (err) {
      if (err.status === 415) throw Object.assign(new Error('A document must be a PDF or a picture (JPEG, PNG, WebP, GIF)'), { status: 415 });
      throw err;
    }
  }
  return tx(async (db) => {
    const ids = [];
    for (const s of stored) {
      const { rows: ins } = await db.query(
        `INSERT INTO watch_documents(watch_id, storage_key, thumb_key, content_type, bytes, name, kind, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [rows[0].id, s.storage_key, s.thumb_key, s.content_type, s.bytes, s.name, k, user?.id ?? null]
      );
      ids.push(ins[0].id);
    }
    await logEvent(db, rows[0].id, { userId: user?.id, action: 'document_add', changes: { names: stored.map((s) => s.name), kind: k } });
    return ids;
  });
}

export async function removeDocument(watchId, docId, user) {
  return tx(async (db) => {
    const { rows } = await db.query(
      'UPDATE watch_documents SET deleted_at = now() WHERE id = $1 AND watch_id = $2 AND deleted_at IS NULL RETURNING id, name',
      [Number(docId) || 0, Number(watchId) || 0]
    );
    if (!rows[0]) throw Object.assign(new Error('No such document'), { status: 404 });
    await logEvent(db, Number(watchId), { userId: user?.id, action: 'document_remove', changes: { name: rows[0].name } });
  });
}

/** The file itself, or its thumbnail when it has one. */
export async function documentFile(docId, { thumb = false } = {}) {
  const { rows } = await query('SELECT * FROM watch_documents WHERE id = $1 AND deleted_at IS NULL', [Number(docId) || 0]);
  const d = rows[0];
  if (!d) return null;
  const key = thumb && d.thumb_key ? d.thumb_key : d.storage_key;
  const buffer = await (await storage()).get(key);
  return buffer ? { buffer, type: thumb && d.thumb_key ? 'image/jpeg' : d.content_type, name: d.name } : null;
}
