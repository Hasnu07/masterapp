/*
 * Watch Vault Activity: the logistics app's page of what the Watch vault
 * changed (`renderVaultActivity`) — the vault's notifications, newest first
 * — and, beside them, who holds which watch as the vault's own tracking
 * says (`vaultTracking`, written by the vault's "Tap to update location").
 *
 * A notification (`vaultNotifications`, the vault writes them, the app
 * approves them on sight — `renderVaultNotifications`): { id, ts, type:
 * 'location' | 'accessory' | 'price', loc: 'dubai' | 'london' | 'hk',
 * watchId (the stock row's id), stockNumber, brand, watchRef, status:
 * 'pending' | 'approved' | 'dismissed', and by type: from / to (location),
 * oldPresent / newPresent / oldMissing / newMissing (accessory),
 * old/newB2BPrice + currency, old/newB2CPrice + currency (price) }. What
 * each line says is worked out the app's way: a location "from → to", the
 * accessories marked present, removed from present and now missing, the
 * new B2B and B2C.
 *
 * The tracking map is keyed by the stock row's id: { status: 'In Office' |
 * 'In Home' | 'Gold Souk' | 'Out for Photography' | 'Out with Client' (and
 * the older 'Back in Vault'), holder, updatedAt }. The vault shows "Gold
 * Souk · <polisher>" instead whenever the stock row itself says the watch is
 * at polish (`getTrk`); so does this page. A key whose stock row the app no
 * longer lists is named through that row's last copy here, else through the
 * vault's own notifications about it.
 *
 * Stock → OUR watch and its clients, by Chrono Key's ids.
 */
import { query } from '../../db/index.js';
import { text, iso, dayOf, oursByNumber } from '../shared.js';
import { stockList } from '../kinds.js';

export const PLACE = { dubai: 'Dubai', london: 'London', hk: 'Hong Kong' };
const PLACE_OF_KIND = { dubaiStock: 'Dubai', londonStock: 'London', hkStock: 'Hong Kong', hkSituation: 'Hong Kong' };
const STOCK_KINDS = Object.keys(PLACE_OF_KIND);

/* Where the vault's status puts the watch: in the vault, at the souk, out for photos, out with a client. */
export function whereOf(status) {
  const s = text(status).toLowerCase();
  if (!s) return '';
  if (s.includes('client')) return 'client';
  if (s.includes('souk')) return 'souk';
  if (s.includes('photo')) return 'photo';
  if (s.includes('office') || s.includes('home') || s.includes('vault')) return 'vault';
  return '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/* A day in words for a fact — never a raw 2026-08-05. */
const dayWords = (v) => {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
};
const list = (s) => [...new Set(text(s).split(',').map((x) => x.trim()).filter(Boolean))];
const amount = (n, cur) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '' : `${cur || 'USD'} ${Number(n).toLocaleString('en-GB')}`);

/** What a notification says, the way the app's page reads it. */
export function detailOf(n) {
  const type = text(n.type);
  if (type === 'location') return { from: text(n.from) || '—', to: text(n.to) || '—' };
  if (type === 'accessory') {
    const oldP = text(n.oldPresent);
    const newP = text(n.newPresent);
    const oldM = text(n.oldMissing);
    return {
      // The app's own test: a name not found in the old string (as a substring, as it compares).
      added: list(newP).filter((s) => !oldP.includes(s)),
      removed: list(oldP).filter((s) => !newP.includes(s)),
      now_missing: list(n.newMissing).filter((s) => !oldM.includes(s)),
      present: list(newP),
      missing: list(n.newMissing),
    };
  }
  if (type === 'price') {
    return {
      b2b: amount(n.newB2BPrice, n.newB2BCurrency),
      b2b_was: amount(n.oldB2BPrice, n.oldB2BCurrency),
      b2c: amount(n.newB2CPrice, n.newB2CCurrency),
      b2c_was: amount(n.oldB2CPrice, n.oldB2CCurrency),
    };
  }
  return { text: text(n.text || n.message) };
}

/** One line of words for a notification (the watch page's facts, the search). */
export function wordsOf(n) {
  const d = detailOf(n);
  switch (text(n.type)) {
    case 'location':
      return `Location: ${d.from} → ${d.to}`;
    case 'accessory': {
      const parts = [d.added.length && `marked present: ${d.added.join(', ')}`, d.removed.length && `removed from present: ${d.removed.join(', ')}`, d.now_missing.length && `now missing: ${d.now_missing.join(', ')}`].filter(Boolean);
      return `Accessories updated${parts.length ? `: ${parts.join(' · ')}` : ''}`;
    }
    case 'price': {
      const parts = [d.b2b && `B2B ${d.b2b}`, d.b2c && `B2C ${d.b2c}`].filter(Boolean);
      return `Price updated${parts.length ? `: ${parts.join(' · ')}` : ''}`;
    }
    default:
      return d.text || text(n.type) || 'Vault update';
  }
}

/** The page's data (GET /api/logistics/page/vaultactivity). */
export async function page() {
  const [{ rows: notes }, { rows: track }] = await Promise.all([
    query("SELECT * FROM logistics_items WHERE kind = 'vaultNotifications' AND deleted_at IS NULL ORDER BY id"),
    query("SELECT * FROM logistics_items WHERE kind = 'vaultTracking' AND deleted_at IS NULL ORDER BY id"),
  ]);
  const keys = track.map((r) => text(r.source_id)).filter(Boolean);
  // The stock rows the keys name — a row a move or a sale left behind still says which watch it was.
  const { rows: stockRows } = keys.length
    ? await query('SELECT id, kind, source_id, data, deleted_at FROM logistics_items WHERE kind = ANY($1) AND source_id = ANY($2) ORDER BY (deleted_at IS NULL) DESC, id DESC', [STOCK_KINDS, keys])
    : { rows: [] };
  const rowOf = new Map();
  for (const r of stockRows) if (!rowOf.has(r.source_id)) rowOf.set(r.source_id, r);

  const sortedNotes = notes
    .map((r) => ({ r, d: r.data || {}, ms: Date.parse(iso(r.data?.ts) || '') || 0 }))
    .sort((a, b) => b.ms - a.ms || b.r.id - a.r.id);
  // The newest notification about each stock row: names a watch whose row is gone.
  const noteOf = new Map();
  for (const { d } of sortedNotes) if (text(d.watchId) && !noteOf.has(text(d.watchId))) noteOf.set(text(d.watchId), d);

  const allNos = [...notes.flatMap((r) => r.stock_nos || []), ...track.flatMap((r) => r.stock_nos || [])];
  for (const key of keys) {
    const row = rowOf.get(key);
    const n = noteOf.get(key);
    allNos.push(...stockList(row?.data?.stockNumber), ...stockList(n?.stockNumber));
  }
  const ours = await oursByNumber(allNos);
  const ourWatch = (nos) => nos.map((s) => ours.get(s)).find(Boolean) || null;

  const notifications = sortedNotes.map(({ r, d }) => {
    const stock = text(d.stockNumber);
    return {
      id: r.id,
      ts: iso(d.ts) || new Date(r.created_at).toISOString(),
      type: text(d.type) || 'other',
      status: text(d.status) || '',
      loc: text(d.loc),
      place: PLACE[text(d.loc)] || text(d.loc),
      stock_no: stock,
      brand: text(d.brand),
      reference: text(d.watchRef),
      watch: ourWatch([...(r.stock_nos || []), ...stockList(stock)]),
      detail: detailOf(d),
      words: wordsOf(d),
    };
  });

  const holders = track
    .map((r) => {
      const d = r.data || {};
      const key = text(r.source_id);
      const row = rowOf.get(key);
      const rd = row?.data || {};
      const n = noteOf.get(key);
      const stock = text(rd.stockNumber) || text(n?.stockNumber) || (r.stock_nos || [])[0] || '';
      // The vault's own rule (getTrk): a watch at polish shows as Gold Souk with its polisher, whatever the map says.
      const atPolish = row && !row.deleted_at && rd.polish && text(rd.polish.status) === 'at_polish';
      const status = atPolish ? 'Gold Souk' : text(d.status) || 'In Home';
      const holder = atPolish ? text(rd.polish.sentTo) : text(d.holder);
      return {
        id: r.id,
        key,
        status,
        where: whereOf(status),
        holder,
        from_polish: Boolean(atPolish),
        updated: dayOf(d.updatedAt) || dayOf(d.ts) || null,
        stock_no: stock,
        brand: text(rd.brand) || text(n?.brand),
        model: text(rd.watchModel || rd.model),
        reference: text(rd.watchReference || rd.reference) || text(n?.watchRef),
        place: row ? PLACE_OF_KIND[row.kind] : PLACE[text(n?.loc)] || '',
        row_id: row?.id || null,
        row_gone: row ? Boolean(row.deleted_at) : !!key,
        watch: ourWatch([...(r.stock_nos || []), ...stockList(stock)]),
      };
    })
    .sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')) || b.id - a.id);

  const count = (xs, key) => {
    const m = new Map();
    for (const x of xs) m.set(x[key], (m.get(x[key]) || 0) + 1);
    return [...m].map(([k, n]) => ({ [key]: k, n })).sort((a, b) => b.n - a.n);
  };
  return {
    notifications,
    holders,
    by_type: count(notifications, 'type'),
    by_place: count(notifications, 'place'),
    pending: notifications.filter((x) => x.status === 'pending').length,
    holders_by_where: count(holders, 'where'),
  };
}

/* "Vault: out with Josh (Dubai)" — where the vault says the watch is, on the watch's card and page. */
function holderFact(status, holder, place, when) {
  const where = whereOf(status);
  const words =
    where === 'client'
      ? `out with ${holder || 'a client'}`
      : where === 'souk'
        ? `at the Gold Souk${holder ? ` with ${holder}` : ''}`
        : where === 'photo'
          ? `out for photography${holder ? ` (${holder})` : ''}`
          : where === 'vault'
            ? `${text(status).toLowerCase() === 'in home' ? 'at home' : 'in the office'}${holder ? ` (${holder})` : ''}`
            : `${status}${holder ? ` · ${holder}` : ''}`;
  return {
    text: `Vault: ${words}${place ? ` (${place})` : ''}${when ? `, ${when}` : ''}`,
    link: '#/logistics/vaultactivity',
    tone: where === 'client' || where === 'souk' ? 'warn' : where === 'photo' ? 'move' : where === 'vault' ? 'good' : '',
  };
}

/**
 * What the vault says about one watch: who holds it (the tracking map),
 * else its last location notification.
 */
export function forStock(stockNo, rows) {
  const track = rows.filter((r) => r.kind === 'vaultTracking').sort((a, b) => String(b.data?.updatedAt || '').localeCompare(String(a.data?.updatedAt || '')) || b.id - a.id)[0];
  if (track) {
    const d = track.data || {};
    // The row the key names is among this watch's own records when it is still listed.
    const row = rows.find((r) => PLACE_OF_KIND[r.kind] && text(r.source_id) === text(track.source_id));
    const atPolish = row && row.data?.polish && text(row.data.polish.status) === 'at_polish';
    return [holderFact(atPolish ? 'Gold Souk' : d.status, atPolish ? text(row.data.polish.sentTo) : text(d.holder), row ? PLACE_OF_KIND[row.kind] : '', dayWords(dayOf(d.updatedAt)))];
  }
  const note = rows
    .filter((r) => r.kind === 'vaultNotifications' && text(r.data?.type) === 'location')
    .sort((a, b) => (Number(b.data?.ts) || 0) - (Number(a.data?.ts) || 0))[0];
  if (!note) return [];
  const to = text(note.data.to);
  const [status, holder] = to.split(' · ').map((s) => s.trim());
  return [holderFact(status, holder || '', PLACE[text(note.data.loc)] || '', dayWords(iso(note.data.ts)))];
}
