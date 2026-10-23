import { query } from '../../db/index.js';
import { chronokey, ChronoKeyError } from './client.js';
import { inventoryCards, declaredInStock, listTableRows } from './parse.js';

/*
 * Where Chrono Key's own lists put each watch — the status of a watch.
 *
 * Asked for (23 Oct 2026): stock 1722 showed "In stock" here, but Chrono Key's
 * page said RETURNED TO CLIENT and its Inventory tab did not list it. The
 * product grid cannot tell the two apart: no sale, order type R, exactly like
 * a watch on the shelf. Checked against every watch that day — 72 we showed
 * as in stock or incoming that the tab did not — and Chrono Key's lists
 * explained every one:
 *
 *   Inventory tab        /stock/FilterInstock   134 — on the shelf ("Available";
 *                                               one "Checked Out", at a trade show)
 *   To be shipped        /Stock/ToBeShippedList  incoming (29), and two sold
 *                                               before they arrived (1708, 1737)
 *   Returned consignments /Stock/ReturnedConsignments  37 returned to their client
 *
 * The watch page's "Item Status" is NOT where a watch is: "Due Payment" is on
 * incoming watches and on one on the shelf (1590). So it is shown, never used.
 *
 * A read is trusted only when it proves it is whole: every list's table with
 * its headings; every Inventory card readable, none twice, fewer than the
 * page size asked for; the count equal to the one the Inventory page itself
 * declares (its script: itemCount < '134'); the Returned list not suddenly
 * empty after holding many. An untrusted read changes no status (listimport.js).
 *
 * The three lists are read back to back, To-be-shipped first, then the tab,
 * then the Returned list, and the grid AFTER them: a watch moving forward
 * between two reads is then caught on both lists, never on neither, and a
 * sale entered meanwhile is already on the grid.
 */

const INCOMING = '/Stock/ToBeShippedList';
const INVENTORY_PAGE = '/Stock/InstockPage';
const RETURNED = '/Stock/ReturnedConsignments';
export const INVENTORY_PAGE_SIZE = 1000;

/*
 * What the last read found, for the size checks — trusted or not. Measured
 * against the last TRUSTED read only, one refusal would repeat for ever: a
 * list that really did empty, or a real jump, would be compared with the
 * same old number on every pass. Against the last read, a real change is
 * accepted on the pass after, once it has been seen twice.
 */
async function lastRead() {
  const { rows } = await query(
    `SELECT stats->'lists' AS lists FROM import_runs
      WHERE source = 'chronokey' AND mode = 'list' AND finished_at IS NOT NULL AND stats ? 'lists'
      ORDER BY id DESC LIMIT 1`
  );
  return rows[0]?.lists || null;
}

/**
 * @returns {{incoming: Map|null, inventory: Map|null, returned: Map|null,
 *            declared: number|null, trusted: boolean, why: string[]}}
 *   Maps are stock number → what the list says of it.
 */
export async function readStockLists() {
  const ck = chronokey();
  const out = { incoming: null, inventory: null, returned: null, declared: null, trusted: false, why: [] };
  // Signed in once, outside the reads: a rejected sign-in stops the pass at
  // the first attempt — never one rejected password per list ("a failed
  // sign-in stops the run").
  if (!ck.loggedIn) await ck.login();
  const read = async (name, fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ChronoKeyError && (err.status === 401 || /login form/i.test(err.message))) throw err;
      out.why.push(`${name}: ${err.message}`);
      return null;
    }
  };

  out.incoming = await read('to be shipped', async () => {
    const rows = listTableRows(await ck.getListHtml(INCOMING, { pageSize: 500, pageNumber: 1 }));
    if (!rows) throw new Error('no table with a STOCK NUMBER column');
    return rows;
  });
  out.inventory = await read('inventory tab', async () => {
    const { cards, broken } = inventoryCards(await ck.getInventoryCards('', INVENTORY_PAGE_SIZE, 1, { filterBy: 'A' }));
    if (!cards.length) throw new Error('no cards');
    if (broken) throw new Error(`${broken} cards without a readable stock number`);
    if (cards.length >= INVENTORY_PAGE_SIZE) throw new Error(`a full page of ${cards.length}: may be cut short`);
    const map = new Map(cards.map((c) => [c.stock, { badge: c.badge, owner: c.owner, ck_id: c.ckId }]));
    if (map.size !== cards.length) throw new Error(`${cards.length - map.size} stock numbers twice`);
    return map;
  });
  out.returned = await read('returned consignments', async () => {
    const rows = listTableRows(await ck.getListHtml(RETURNED), { need: [/return\s*date/i] });
    if (!rows) throw new Error('no table with STOCK NUMBER and RETURN DATE columns');
    return rows;
  });
  out.declared = await read('inventory total', async () => declaredInStock(await ck.getListHtml(INVENTORY_PAGE)));

  if (out.incoming && out.inventory && out.returned) {
    const before = await lastRead();
    const n = out.inventory.size;
    if (out.declared !== null) {
      // A purchase or a sale between the two requests moves it by one or two.
      if (Math.abs(n - out.declared) > 2) out.why.push(`inventory tab: ${n} cards, the page declares ${out.declared}`);
    } else if (!before?.inventory) {
      out.why.push('inventory tab: the page declares no total, and there is no earlier read to compare with');
    } else if (Math.abs(n - before.inventory) > Math.max(10, before.inventory * 0.1)) {
      out.why.push(`inventory tab: ${n} cards, ${before.inventory} last time, and the page declares no total`);
    }
    // A table that comes back with its headings and no rows reads like "none" — after many, it is not believed at once.
    if (before?.returned >= 10 && out.returned.size === 0) out.why.push(`returned consignments: empty, after ${before.returned} last time`);
    if (before?.incoming >= 5 && out.incoming.size === 0) out.why.push(`to be shipped: empty, after ${before.incoming} last time`);
    out.trusted = out.why.length === 0;
  }
  return out;
}

/** A small summary of a read, kept on the run (and used by the next read's size checks). */
export const listsSummary = (l) => ({
  trusted: l.trusted,
  why: l.why,
  inventory: l.inventory?.size ?? null,
  declared: l.declared,
  incoming: l.incoming?.size ?? null,
  returned: l.returned?.size ?? null,
});
