import { pool, query } from '../../db/index.js';
import { config } from '../../config.js';
import { applyToWatch } from '../apply.js';
import { addPhotos } from '../../watches/index.js';
import { parseMoney } from '../../watches/fields.js';
import { startRun, finishRun, progressRun } from '../listimport.js';

/*
 * The Watch vault (the puro-sync worker) → our watches.
 *
 * The vault and Chrono Key share stock numbering, and the same number is the
 * same watch — InvoiceWEB checked twelve numbers present in both against the
 * serial, twelve out of twelve. So the stock number is the join.
 *
 * What the vault is the authority for: B2B, B2C and Chrono24 prices. Everything else it
 * holds (dial, size, movement, accessories) only fills a field Chrono Key left
 * blank. A watch that is ONLY in the vault becomes a watch here too, with its
 * place and status from the list it sits in.
 *
 * Read-only: one GET of the state and one of the photo store. The vault's
 * storage is a document shared with the logistics app — writing to it is a
 * separate, careful piece of work and is not done here.
 */

const LISTS = [
  { key: 'dubaiStock', location: 'Dubai', status: 'in_stock', rank: 0 },
  { key: 'londonStock', location: 'UK', status: 'in_stock', rank: 0 },
  { key: 'hkStock', location: 'HK', status: 'in_stock', rank: 0 },
  { key: 'soldStocks', location: '', status: 'sold', rank: 1 },
  { key: 'incomings', location: '', status: 'incoming', rank: 2 },
];

const origin = () => {
  try {
    return new URL(config.vault.url).origin;
  } catch {
    return null;
  }
};

/* The worker's key goes to the worker's ORIGIN only — photo urls come out of
   records, and a key attached to whatever host one names would leak it. */
function headersFor(url, extra = {}) {
  const h = { ...extra };
  try {
    if (config.vault.token && new URL(url).origin === origin()) h['X-Worker-Token'] = config.vault.token;
  } catch {
    // not a url
  }
  return h;
}

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), config.vault.timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: headersFor(url, { Accept: 'application/json' }) });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        config.vault.token
          ? 'The Watch vault rejected its key — VAULT_TOKEN no longer matches the worker’s WORKER_TOKEN'
          : 'The Watch vault needs its key — set VAULT_TOKEN (the worker’s WORKER_TOKEN)'
      );
    }
    if (!res.ok) throw new Error(`The Watch vault answered HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const text = (v) => {
  if (Array.isArray(v)) return v.filter(Boolean).join(', ');
  return v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim();
};

/* 0 and 1 are placeholders in the vault's data, not prices — it writes 1 on
   two thirds of its sold rows. */
const price = (v) => {
  const n = typeof v === 'number' ? v : parseMoney(v);
  return Number.isFinite(n) && n > 1 ? Math.round(n * 100) / 100 : null;
};

const isCode = (c) => /^[A-Za-z]{3,4}$/.test(String(c || '').trim());
const FINAL_ORDER = ['usd', 'eur', 'gbp', 'aed', 'hkd', 'chf'];

/**
 * A B2B or B2C price: the vault's FINAL CONFIRMED figure first (its Research
 * panel, one per currency — USD first), then the working price with its
 * currency. A currency field that is not a currency (b2cCurrency has been
 * used as a notes box) means no price, never a guessed one.
 */
function vaultPrice(w, kind) {
  const fin = w?.[`${kind}Final`];
  if (fin && typeof fin === 'object') {
    for (const c of FINAL_ORDER) {
      const n = price(fin[c]);
      if (n) return { price: n, currency: c.toUpperCase() };
    }
  }
  if (kind === 'b2b') {
    for (const c of ['usd', 'eur', 'gbp', 'hkd']) {
      const n = price(w[`b2b${c[0].toUpperCase()}${c.slice(1)}`]);
      if (n) return { price: n, currency: c.toUpperCase() };
    }
  }
  const n = price(w[`${kind}Price`]);
  const c = w[`${kind}Currency`];
  if (n && isCode(c)) return { price: n, currency: String(c).trim().toUpperCase() };
  return null;
}

/** Every photo on the record, best first, deduped, http(s) only. */
export const photosOf = (w) => [
  ...new Set(
    [...(w.photos || []), ...(w.receivingPhotos || []), ...(w.braceletPhotos || []), ...(w.vaultPhotos || [])].filter(
      (u) => typeof u === 'string' && /^https?:\/\//i.test(u)
    )
  ),
];

function fieldsOf(w, list) {
  const b2b = vaultPrice(w, 'b2b');
  const b2c = vaultPrice(w, 'b2c');
  const c24 = vaultPrice(w, 'b2chrono');
  const acc = text(w.accessoriesPresent);
  return {
    own: {
      b2b_price: b2b?.price ?? null,
      b2b_currency: b2b?.currency ?? '',
      b2c_price: b2c?.price ?? null,
      b2c_currency: b2c?.currency ?? '',
      chrono24_price: c24?.price ?? null,
      chrono24_currency: c24?.currency ?? '',
    },
    fill: {
      brand: text(w.brand),
      model: text(w.watchModel || w.model),
      reference: text(w.watchReference || w.reference),
      serial: text(w.watchSerial || w.serial),
      watch_date: text(w.watchDate),
      dial: text(w.dial),
      case_material: text(w.caseMaterial),
      case_size: text(w.caseDiameter),
      bezel: text(w.bezel),
      movement: text(w.movement || w.movements),
      accessories: acc,
      purchased_from: text(w.supplier),
      purchase_price: price(w.buyPrice),
      purchase_currency: price(w.buyPrice) && isCode(w.buyCurrency) ? String(w.buyCurrency).trim().toUpperCase() : '',
      location: list.location,
      status: list.status,
    },
  };
}

async function fetchState() {
  const json = await getJson(config.vault.url);
  const state = json?.data || json;
  let photoMap = {};
  try {
    const p = await getJson(new URL('/api/vault-photos', config.vault.url).href);
    const m = p?.data && typeof p.data === 'object' && !Array.isArray(p.data) ? p.data : p;
    if (m && typeof m === 'object' && !Array.isArray(m)) photoMap = m;
  } catch (err) {
    console.warn(`[vault] photo store not read: ${err.message}`);
  }
  for (const { key } of LISTS) {
    for (const w of Array.isArray(state?.[key]) ? state[key] : []) {
      const urls = photoMap[String(w?.id)];
      if (Array.isArray(urls)) w.vaultPhotos = urls;
    }
  }
  return state;
}

/**
 * Which of a stock number's vault records speaks for it: a current stock
 * record, then a sale, then an incoming that has not been cancelled.
 */
function primary(records) {
  const live = records.filter((r) => !(r.list.key === 'incomings' && /cancel/i.test(r.w.status || '')));
  const pool = (live.length ? live : records).filter(
    (r) => r.list.rank !== 0 || !r.w.status || r.w.status === 'current'
  );
  return (pool.length ? pool : records).sort((a, b) => a.list.rank - b.list.rank)[0];
}

async function copyPhotos(watchId, urls) {
  if (!urls.length) return 0;
  const { rows } = await query("SELECT source_ref FROM watch_photos WHERE watch_id = $1 AND source = 'vault'", [watchId]);
  const have = new Set(rows.map((r) => r.source_ref));
  let copied = 0;
  for (const url of urls.slice(0, 30)) {
    if (have.has(url)) continue;
    try {
      const res = await fetch(url, { headers: headersFor(url) });
      const type = res.headers.get('content-type') || '';
      if (!res.ok || !type.startsWith('image/')) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      // The same picture under another url, or already copied from Chrono
      // Key, is recorded and not shown twice.
      const ids = await addPhotos(watchId, [{ buffer }], null, { source: 'vault', sourceRefs: [url], skipDuplicates: true });
      copied += ids.length;
    } catch (err) {
      if (err.code !== '23505') console.warn(`[vault] photo ${url}: ${err.message}`);
    }
  }
  return copied;
}

export async function syncVault({ user, photos = true } = {}) {
  if (!config.vault.configured) throw new Error('The Watch vault is not configured (VAULT_URL)');
  const run = await startRun('vault', 'full', user);
  const stats = { records: 0, stockNumbers: 0, created: 0, updated: 0, unchanged: 0, noStockNumber: 0, photos: 0 };
  try {
    const state = await fetchState();
    if (!LISTS.some((l) => Array.isArray(state?.[l.key]))) {
      throw new Error('The vault answered without any of its stock lists — not reading that as an empty vault');
    }

    const byStock = new Map();
    const client = await pool.connect();
    try {
      for (const list of LISTS) {
        for (const w of state[list.key] || []) {
          if (!w || !w.id) continue;
          stats.records += 1;
          const stockNo = text(w.stockNumber).replace(/^#/, '');
          await client.query(
            `INSERT INTO vault_records(vault_id, list, stock_no, data, fetched_at) VALUES ($1,$2,$3,$4,now())
             ON CONFLICT (vault_id) DO UPDATE SET list = EXCLUDED.list, stock_no = EXCLUDED.stock_no,
               data = EXCLUDED.data, fetched_at = now()`,
            [String(w.id), list.key, stockNo || null, JSON.stringify(w)]
          );
          if (!stockNo) {
            stats.noStockNumber += 1;
            continue;
          }
          if (!byStock.has(stockNo)) byStock.set(stockNo, []);
          byStock.get(stockNo).push({ w, list });
        }
      }
      stats.stockNumbers = byStock.size;

      for (const [stockNo, records] of byStock) {
        const p = primary(records);
        // A cancelled order the vault still lists is not a watch we have:
        // it updates a watch we already hold, but never creates one.
        if (p.list.key === 'incomings' && /cancel/i.test(p.w.status || '')) {
          const { rows: had } = await client.query('SELECT 1 FROM watches WHERE stock_no = $1', [stockNo]);
          if (!had.length) {
            stats.cancelledSkipped = (stats.cancelledSkipped || 0) + 1;
            continue;
          }
        }
        const { own, fill } = fieldsOf(p.w, p.list);
        await client.query('BEGIN');
        try {
          // On a watch Chrono Key knows, the vault's place and status only
          // fill blanks: Chrono Key is the master until the switch-over.
          const res = await applyToWatch(
            client,
            stockNo,
            [
              { fields: own, mode: 'own' },
              { fields: fill, mode: 'fill' },
            ],
            'vault',
            { vault_id: String(p.w.id) }
          );
          await client.query('UPDATE vault_records SET watch_id = $1 WHERE stock_no = $2', [res.id, stockNo]);
          await client.query('COMMIT');
          if (res.created) stats.created += 1;
          else if (res.changed.length) stats.updated += 1;
          else stats.unchanged += 1;
          if (photos) {
            const urls = [...new Set(records.flatMap((r) => photosOf(r.w)))];
            stats.photos += await copyPhotos(res.id, urls);
          }
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw new Error(`stock ${stockNo}: ${err.message}`);
        }
        if ((stats.created + stats.updated + stats.unchanged) % 25 === 0) await progressRun(run, stats);
      }
    } finally {
      client.release();
    }
    await finishRun(run, { ok: true, stats });
    return stats;
  } catch (err) {
    await finishRun(run, { ok: false, stats, error: err.message });
    throw err;
  }
}
