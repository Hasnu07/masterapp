/*
 * Refinement: the logistics app's "Refinement" page (its renderRefinement,
 * allPolishStockRows and renderExtPolish), read from our copy of its records.
 *
 * Polish lives on the stock row itself (read from the app's code —
 * confirmSendPolish / confirmPolishDone): `needPolish` flags a watch; a
 * `polish` object is the one at the polisher now — `status` at_polish,
 * `sentTo`, `takenBy`, `itemDescription` (Full Watch, Links, Bracelet …),
 * `sentDate`, `expectedBack`, `costAmount` + `costCurrency`, `notes`,
 * `sentPhotos`, `createdAt`; when it comes back the object moves into the
 * row's `polishHistory` with `returnedDate`, `returnNotes`, `donePhotos`,
 * and needPolish is cleared. The app gathers London, Dubai, HK and safe rows
 * in place, and Ready-for-delivery / Sold rows flagged or at polish; the
 * history from London, Dubai, HK, Sold, Ready and Incomings rows, one line
 * per polish id. `externalPolish` is its own list — client or other
 * watches, not our stock: `description`, `sentTo`, `sentDate`,
 * `expectedBack`, `cost` + `costCurrency`, `notes`, `photos`, `status`
 * (done or not), `returnDate`, `returnNotes`, `returnPhotos`, sometimes a
 * `stockNumber`.
 *
 * Two things differ from the app on purpose: a row on consignment that is
 * at the polisher is shown at polish (the app hides any row whose status is
 * not 'current' — 00000 was at polish and invisible), and Dubai's corner
 * reads the Dubai flags (inOffice / inSafe), where the app reads London's.
 * The spend is in dollars at the converter's rates, not the app's fixed
 * table; each currency's own total is given too.
 *
 * Send to polish and Back from polish are the one record change allowed
 * here already: POST /api/logistics/items/:id/polish (polishAction), the
 * Overview's buttons. An external polish is added, finished, edited or
 * deleted in the app until the switch-over: its row opens its record.
 */
import { query } from '../../db/index.js';
import { oursByNumber, text, dayOf, picturesOf, photoPrefix, NOW_IN_PLACE } from '../shared.js';
import * as situation from '../situation.js';
import { linksByName } from '../clients.js';
import { getRates } from '../../rates/index.js';

const PLACE_ROWS = ['londonStock', 'dubaiStock', 'hkStock', 'safeStock'];
const SALE_ROWS = ['readyForDelivery', 'soldStocks'];
const LABEL = { londonStock: 'London', dubaiStock: 'Dubai', hkStock: 'Hong Kong', safeStock: 'Safe', readyForDelivery: 'Ready for delivery', soldStocks: 'Sold', incomings: 'Incoming' };

/* The pictures a list holds that this app can serve (copied, or still on the worker). */
function pics(list) {
  const prefix = photoPrefix();
  return (Array.isArray(list) ? list : []).filter((v) => typeof v === 'string' && (/^lgfile:\d+$/.test(v) || (prefix && v.startsWith(prefix))));
}
const atPolish = (d) => (d?.polish && typeof d.polish === 'object' && d.polish.status !== 'done' ? d.polish : null);
const flagged = (d) => d?.needPolish === true || text(d?.needPolish) === 'true';
const amount = (v) => (v === null || v === undefined || v === '' ? 0 : Number(String(v).replace(/,/g, '')) || 0);
const cost = (a, cur) => ({ amount: Math.round(amount(a) * 100) / 100, currency: text(cur).toUpperCase() });

/* Where the row is: London's Mayfair or NCL, Dubai's office or safe, else the place. */
const where = (kind, d) =>
  kind === 'londonStock'
    ? d.inMayfair ? 'Mayfair' : d.inNcl ? 'NCL' : 'London'
    : kind === 'dubaiStock'
      ? d.inOffice ? 'Dubai office' : d.inSafe ? 'Dubai safe' : 'Dubai'
      : LABEL[kind] || kind;

/*
 * The converter's rates, with a cap on the wait (copied from ratesSoon in
 * src/logistics/index.js, which is not exported).
 */
let lastRates = null;
async function ratesSoon(waitMs = 1500) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(lastRates && { ...lastRates, stale: true }), waitMs);
    timer.unref?.();
  });
  const fresh = getRates().then(
    (r) => (lastRates = r),
    () => lastRates && { ...lastRates, stale: true }
  );
  try {
    return await Promise.race([fresh, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The page's data (GET /api/logistics/page/refinement). */
export async function page() {
  const { rows } = await query(
    `SELECT * FROM logistics_items
      WHERE deleted_at IS NULL AND (
            (kind IN ('londonStock','dubaiStock','hkStock','safeStock') AND ${NOW_IN_PLACE})
         OR kind IN ('readyForDelivery','soldStocks','externalPolish')
         OR (kind IN ('londonStock','dubaiStock','hkStock','incomings') AND data ? 'polishHistory'))
      ORDER BY id`
  );
  const names = [];
  for (const r of rows) {
    const d = r.data || {};
    if (r.kind === 'externalPolish') names.push(text(d.sentTo));
    else {
      if (atPolish(d)) names.push(text(d.polish.sentTo));
      for (const h of Array.isArray(d.polishHistory) ? d.polishHistory : []) names.push(text(h?.sentTo));
    }
  }
  // An external polish often names our watch only in its description ("1417"): a bare number there is looked up too.
  const extNo = (d) => text(d.stockNumber) || (/^\d{3,5}$/.test(text(d.description)) ? text(d.description) : '');
  const [ours, people, r] = await Promise.all([
    oursByNumber([...rows.flatMap((x) => x.stock_nos || []), ...rows.filter((x) => x.kind === 'externalPolish').map((x) => extNo(x.data || {}))].filter(Boolean)),
    linksByName(names.filter(Boolean)),
    ratesSoon(),
  ]);
  const watchOf = (row) => (row.stock_nos || []).map((s) => ours.get(s)).find(Boolean) || null;
  const person = (name) => ({ name, link: (name && people.get(name)) || null });
  const currencies = new Set(['USD']);

  const stock = [];
  const at_polish = [];
  const history = [];
  const seenPolish = new Set();
  const inPlace = (r) => PLACE_ROWS.includes(r.kind) && /^(|current|consignment)$/.test(text(r.data?.status));
  for (const x of rows) {
    const d = x.data || {};
    if (x.kind === 'externalPolish') continue;
    const stockNo = text(d.stockNumber);
    const p = atPolish(d);
    const hist = Array.isArray(d.polishHistory) ? d.polishHistory.filter((h) => h && typeof h === 'object') : [];
    const base = {
      id: x.id,
      kind: x.kind,
      place: where(x.kind, d),
      stock_no: stockNo,
      brand: text(d.brand),
      model: text(d.watchModel || d.description),
      reference: text(d.watchReference || d.reference),
      serial: text(d.watchSerial || d.serial),
      watch: watchOf(x),
    };
    const polishRow = inPlace(x) || SALE_ROWS.includes(x.kind);
    if (polishRow) {
      // The app's grid: every row in place; a sold or ready row joins it only when flagged or at polish, or when searched for.
      const own = picturesOf(d);
      stock.push({
        ...base,
        on_consignment: text(d.status) === 'consignment',
        from: text(d.from || d.supplier),
        buyer: text(d.soldToBuyer),
        notes: text(d.notes),
        picture: own.picture,
        photo_count: own.photo_count,
        state: p ? 'at_polish' : flagged(d) ? 'flagged' : '',
        polish: p ? { sent_to: text(p.sentTo), sent_date: dayOf(p.sentDate) || '' } : null,
        history_n: hist.length,
        can_polish: true,
      });
      if (p) {
        const c = cost(p.costAmount, p.costCurrency);
        if (c.amount > 0 && c.currency) currencies.add(c.currency);
        const before = pics(p.sentPhotos);
        at_polish.push({
          ...base,
          polish_id: text(p.id),
          item: text(p.itemDescription) || 'Full Watch',
          sent_to: person(text(p.sentTo)),
          taken_by: text(p.takenBy),
          sent_date: dayOf(p.sentDate) || '',
          expected_back: dayOf(p.expectedBack) || '',
          cost: c,
          notes: text(p.notes),
          before_n: before.length,
          picture: before[0] || null,
          created_at: Number(p.createdAt) || situation.when(p.sentDate) || 0,
        });
      }
    }
    // History: the app reads London, Dubai, HK, Sold, Ready and Incomings rows, one line per polish id.
    if (['londonStock', 'dubaiStock', 'hkStock', 'incomings'].includes(x.kind) || SALE_ROWS.includes(x.kind)) {
      for (const h of hist) {
        const key = text(h.id) || `${x.id}:${text(h.sentDate)}:${text(h.returnedDate)}`;
        if (seenPolish.has(key)) continue;
        seenPolish.add(key);
        const c = cost(h.costAmount, h.costCurrency);
        if (c.amount > 0 && c.currency) currencies.add(c.currency);
        history.push({
          ...base,
          polish_id: text(h.id),
          item: text(h.itemDescription) || 'Full Watch',
          sent_to: person(text(h.sentTo)),
          taken_by: text(h.takenBy),
          sent_date: dayOf(h.sentDate) || '',
          returned_date: dayOf(h.returnedDate) || '',
          cost: c,
          before_n: pics(h.sentPhotos).length,
          after_n: pics(h.donePhotos).length,
          notes: text(h.returnNotes || h.notes),
        });
      }
    }
  }
  at_polish.sort((a, b) => b.created_at - a.created_at || b.id - a.id);
  history.sort((a, b) => String(b.returned_date).localeCompare(String(a.returned_date)) || b.id - a.id);

  const external = rows
    .filter((x) => x.kind === 'externalPolish')
    .map((x) => {
      const d = x.data || {};
      // The app writes the cost as `cost`; the catalog's field is costAmount — either is read.
      const c = cost(d.cost ?? d.costAmount, d.costCurrency);
      const before = pics(d.photos);
      const after = pics(d.returnPhotos);
      return {
        id: x.id,
        description: text(d.description),
        stock_no: extNo(d),
        sent_to: person(text(d.sentTo)),
        sent_date: dayOf(d.sentDate) || '',
        expected_back: dayOf(d.expectedBack) || '',
        return_date: dayOf(d.returnDate) || '',
        cost: c,
        notes: text(d.notes),
        return_notes: text(d.returnNotes),
        before_n: before.length,
        after_n: after.length,
        picture: before[0] || after[0] || null,
        done: text(d.status) === 'done',
        created_at: Number(d.createdAt) || situation.when(d.sentDate) || 0,
        watch: watchOf(x) || ours.get(extNo(d)) || null,
      };
    })
    .sort((a, b) => b.created_at - a.created_at || b.id - a.id);

  return {
    at_polish,
    stock,
    history,
    external: { active: external.filter((e) => !e.done), done: external.filter((e) => e.done) },
    rates: r ? { kind: r.kind, stale: Boolean(r.stale), table: Object.fromEntries([...currencies].filter((c) => r.rates[c]).map((c) => [c, r.rates[c]])) } : null,
  };
}

/* Today on the business's calendar (Dubai), as the app compares an expected-back date with the day. */
const today = () => new Date(Date.now() + 4 * 3600_000).toISOString().slice(0, 10);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayWords = (v) => {
  const s = dayOf(v) || '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}` : '';
};

/**
 * What this page knows about one watch: "At polish with X since …" (overdue
 * when expected back and not), "Needs polish", or its last polish "Polished,
 * back on …"; an external polish record naming the number too.
 */
export function forStock(stockNo, rows, ctx) {
  const link = '#/logistics/refinement';
  const live = (rows || []).filter((r) => r.kind !== 'externalPolish' && (SALE_ROWS.includes(r.kind) || (PLACE_ROWS.includes(r.kind) && /^(|current|consignment)$/.test(text(r.data?.status)))));
  const out = [];
  const at = live.map((r) => atPolish(r.data)).find(Boolean);
  if (at) {
    const back = dayOf(at.expectedBack);
    const overdue = Boolean(back && back.slice(0, 10) < today());
    const item = text(at.itemDescription);
    out.push({
      text: [
        `At polish with ${text(at.sentTo) || 'the polisher'}${at.sentDate ? ` since ${dayWords(at.sentDate)}` : ''}`,
        item && !/^full watch$/i.test(item) && `the ${item.toLowerCase()}`,
        back && `${overdue ? 'was expected back' : 'expected back'} ${dayWords(back)}`,
      ]
        .filter(Boolean)
        .join(' · '),
      link,
      tone: overdue ? 'bad' : 'warn',
    });
  } else if (live.some((r) => flagged(r.data))) {
    out.push({ text: 'Needs polish', link, tone: 'warn' });
  } else {
    const hist = live
      .flatMap((r) => (Array.isArray(r.data?.polishHistory) ? r.data.polishHistory : []))
      .filter((h) => h && typeof h === 'object')
      .sort((a, b) => String(dayOf(b.returnedDate) || '').localeCompare(String(dayOf(a.returnedDate) || '')));
    if (hist[0]) {
      const h = hist[0];
      out.push({ text: `Polished${h.sentTo ? ` by ${text(h.sentTo)}` : ''}${h.returnedDate ? `, back on ${dayWords(h.returnedDate)}` : ''}${hist.length > 1 ? ` · ${hist.length} polishes` : ''}`, link, tone: 'good' });
    }
  }
  for (const r of (rows || []).filter((x) => x.kind === 'externalPolish' && text(x.data?.status) !== 'done')) {
    const d = r.data || {};
    out.push({ text: `At polish with ${text(d.sentTo) || 'the polisher'}${d.sentDate ? ` since ${dayWords(d.sentDate)}` : ''} (external polish record)`, link, tone: 'warn' });
  }
  return out;
}
