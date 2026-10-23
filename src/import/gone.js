/*
 * What a source DROPS, mirrored here until the switch-over (asked for 23 Oct
 * 2026: "whatever changes there will be here also").
 *
 * Two steps, both inside the caller's transaction:
 *
 *   markGone   the raw records the source no longer lists get `gone_at`;
 *              the ones it lists again lose it
 *   settle…    our records with no live raw record left are DELETED, softly,
 *              with deleted_at = source_gone_at, so the sync can tell its own
 *              deletion from a person's — and restores only its own when the
 *              record comes back
 *
 * Never undone or repeated: a deletion made here by a person, and a record a
 * person restored after the sync removed it (source_gone_at stays set, so it
 * is not deleted twice). Photos are never deleted for a source dropping them.
 *
 * And never on a read that looks wrong: if more than 3% (and more than ten)
 * of what we hold vanished at once, that is a broken or partial read, not a
 * clear-out — nothing is marked and the run says so.
 */

export const GONE_LIMIT = (listed) => Math.max(10, Math.ceil(listed * 0.03));

/**
 * @param table   ck_records | vault_records | ck_clients | ck_expenses
 * @param key     its key column
 * @param seen    every key the source listed on this (complete) read
 * @returns {{gone: number, back: number, refused: number}}
 */
export async function markGone(db, table, key, seen) {
  const keys = [...new Set([...seen].map(String))];
  if (!keys.length) return { gone: 0, back: 0, refused: -1 }; // a read listing nothing is never a clear-out
  const back =await db.query(`UPDATE ${table} SET gone_at = NULL WHERE gone_at IS NOT NULL AND ${key}::text = ANY($1)`, [keys]);
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE gone_at IS NULL AND NOT (${key}::text = ANY($1))`, [
    keys,
  ]);
  const missing = rows[0].n;
  if (missing > GONE_LIMIT(keys.length)) {
    console.warn(`[sync] ${table}: ${missing} records missing from one read of ${keys.length} — not taken as deleted`);
    return { gone: 0, back: back.rowCount, refused: missing };
  }
  if (missing) await db.query(`UPDATE ${table} SET gone_at = now() WHERE gone_at IS NULL AND NOT (${key}::text = ANY($1))`, [keys]);
  return { gone: missing, back: back.rowCount, refused: 0 };
}

/*
 * Our records against what is still live in their sources.
 *   table   watches | clients | expenses
 *   events  its history table, and the column naming the record there
 *   present SQL true while some source still lists the record (alias `x`)
 *   keep    SQL true for a record never to delete even when gone (alias `x`)
 */
async function settle(db, { table, events, fk, present, keep = 'false', source, why }) {
  const deleted = await db.query(
    `UPDATE ${table} x SET deleted_at = now(), source_gone_at = now(), updated_at = now()
      WHERE x.origin <> 'manual' AND x.source_gone_at IS NULL AND x.deleted_at IS NULL AND NOT (${present}) AND NOT (${keep})
      RETURNING x.id`
  );
  // Deleted here by a person already: only noted, so a return does not undo the person.
  await db.query(
    `UPDATE ${table} x SET source_gone_at = now()
      WHERE x.origin <> 'manual' AND x.source_gone_at IS NULL AND x.deleted_at IS NOT NULL AND NOT (${present})`
  );
  const { rows: returning } = await db.query(
    `SELECT x.id, x.deleted_at = x.source_gone_at AS ours FROM ${table} x WHERE x.source_gone_at IS NOT NULL AND (${present})`
  );
  const restored = returning.filter((r) => r.ours).map((r) => r.id);
  if (returning.length) {
    await db.query(
      `UPDATE ${table} SET deleted_at = CASE WHEN deleted_at = source_gone_at THEN NULL ELSE deleted_at END,
              source_gone_at = NULL, updated_at = now() WHERE id = ANY($1)`,
      [returning.map((r) => r.id)]
    );
  }
  for (const { id } of deleted.rows) {
    await db.query(`INSERT INTO ${events}(${fk}, source, action, changes) VALUES ($1, $2, 'delete', $3)`, [id, source, { gone: why }]);
  }
  for (const id of restored) {
    await db.query(`INSERT INTO ${events}(${fk}, source, action, changes) VALUES ($1, $2, 'restore', $3)`, [
      id,
      source,
      { back: 'listed again' },
    ]);
  }
  return { deleted: deleted.rowCount, restored: restored.length };
}

/** A watch is live while Chrono Key's list or the vault still holds it. */
export const settleWatches = (db) =>
  settle(db, {
    table: 'watches',
    events: 'watch_events',
    fk: 'watch_id',
    source: 'chronokey',
    why: 'no longer on Chrono Key or in the vault',
    present: `EXISTS (SELECT 1 FROM ck_records r WHERE r.watch_id = x.id AND r.gone_at IS NULL)
              OR EXISTS (SELECT 1 FROM vault_records v WHERE v.watch_id = x.id AND v.gone_at IS NULL)`,
  });

/* A client a watch still names is kept, whatever the list says. */
export const settleClients = (db) =>
  settle(db, {
    table: 'clients',
    events: 'client_events',
    fk: 'client_id',
    source: 'chronokey',
    why: "no longer on Chrono Key's client list",
    present: 'EXISTS (SELECT 1 FROM ck_clients r WHERE r.client_id = x.id AND r.gone_at IS NULL)',
    keep: `EXISTS (SELECT 1 FROM watches w WHERE (w.purchased_from_client_id = x.id OR w.sold_to_client_id = x.id) AND w.deleted_at IS NULL)`,
  });

export const settleExpenses = (db) =>
  settle(db, {
    table: 'expenses',
    events: 'expense_events',
    fk: 'expense_id',
    source: 'chronokey',
    why: "no longer on Chrono Key's expense list",
    present: 'EXISTS (SELECT 1 FROM ck_expenses r WHERE r.expense_id = x.id AND r.gone_at IS NULL)',
  });
