import { FIELD } from '../watches/fields.js';
import { logEvent } from '../watches/index.js';

/*
 * Writing what a source says into our record of a watch.
 *
 * Until the switch-over Chrono Key is the MASTER, so what it says replaces
 * what we hold — with one exception that matters more than the rule: a field
 * somebody EDITED here (watches.locked_fields) is never overwritten. A
 * correction typed into masterapp is a person's decision; undoing it silently
 * fifteen minutes later is the kind of thing that makes people stop trusting
 * a system.
 *
 * Two strengths of source:
 *   own   the source is the authority for these fields (Chrono Key's product
 *         list for the purchase and sale; the vault for B2B and B2C)
 *   fill  the source only fills a field that is still blank (Chrono Key's
 *         detail page for the spec; the vault for the spec)
 */

const blank = (v) =>
  v === null || v === undefined || v === '' || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length);

const canon = (v) => {
  if (v && typeof v === 'object') return JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));
  if (typeof v === 'number') return String(v);
  return v ?? '';
};

/* A currency is never CLEARED by a source that simply does not state one: it
   may have been worked out from another source, or typed in. */
const NEVER_CLEARED = new Set(['purchase_currency', 'sale_currency', 'purchase_price_eur', 'sale_price_eur']);

/**
 * @param db       a client inside a transaction
 * @param stockNo  the watch's stock number — the one key all sources share
 * @param parts    [{ fields, mode: 'own'|'fill' }] applied in order
 * @param source   'chronokey' | 'vault' (for the history and a new record's origin)
 * @param links    extra columns to set, not fields: { ck_id, ck_product_id, vault_id }
 * @returns {{ id, created, changed: string[] }}
 */
export async function applyToWatch(db, stockNo, parts, source, links = {}) {
  const { rows } = await db.query('SELECT * FROM watches WHERE stock_no = $1 FOR UPDATE', [stockNo]);
  const w = rows[0];

  if (!w) {
    const values = { stock_no: stockNo };
    for (const { fields } of parts) {
      for (const [k, v] of Object.entries(fields)) {
        if (FIELD[k] && k !== 'stock_no' && !blank(v) && values[k] === undefined) values[k] = v;
      }
    }
    values.status ||= 'in_stock';
    const cols = Object.keys(values);
    const linkCols = Object.keys(links).filter((k) => links[k] !== undefined && links[k] !== null);
    const all = [...cols, ...linkCols, 'origin'];
    const { rows: ins } = await db.query(
      `INSERT INTO watches(${all.join(', ')}) VALUES (${all.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      [...cols.map((k) => values[k]), ...linkCols.map((k) => links[k]), source]
    );
    await logEvent(db, ins[0].id, { source, action: 'create', changes: values });
    return { id: ins[0].id, created: true, changed: cols };
  }

  const next = {};
  for (const { fields, mode } of parts) {
    for (const [k, v] of Object.entries(fields)) {
      if (!FIELD[k] || k === 'stock_no') continue;
      if (w.locked_fields.includes(k)) continue;
      const current = next[k] !== undefined ? next[k] : w[k];
      if (mode === 'fill' && !blank(current)) continue;
      if (blank(v) && (mode === 'fill' || NEVER_CLEARED.has(k))) continue;
      if (canon(current) === canon(v)) continue;
      next[k] = v;
    }
  }

  const changes = {};
  for (const [k, v] of Object.entries(next)) if (canon(w[k]) !== canon(v)) changes[k] = [w[k], v];

  const linkSets = Object.entries(links).filter(([k, v]) => v !== undefined && v !== null && w[k] !== v);
  const keys = Object.keys(changes);
  if (!keys.length && !linkSets.length) return { id: w.id, created: false, changed: [] };

  const sets = [];
  const vals = [];
  for (const k of keys) {
    vals.push(next[k]);
    sets.push(`${k} = $${vals.length}`);
  }
  for (const [k, v] of linkSets) {
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (keys.length) sets.push('updated_at = now()');
  vals.push(w.id);
  await db.query(`UPDATE watches SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  if (keys.length) await logEvent(db, w.id, { source, action: 'sync', changes });
  return { id: w.id, created: false, changed: keys };
}
