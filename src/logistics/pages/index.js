/*
 * The logistics app's pages, one module each — the tabs added 27 Oct 2026
 * ("all these tabs … keep each page how it is in the logistic app"). Each
 * module reads our copy of the app's records and keeps the one rule every
 * tab keeps: a stock number is OUR watch, linked with its clients by id.
 *
 *   page()                      the tab's data, GET /api/logistics/page/:name
 *   forStock(stockNo, rows, ctx) what the page knows about one watch, for its
 *                               Inventory card and its page (factsFor below)
 */
import { query } from '../../db/index.js';
import { context } from '../shared.js';
import * as ownerdecisions from './ownerdecisions.js';
import * as hkstock from './hkstock.js';
import * as vaultactivity from './vaultactivity.js';
import * as otherreceiving from './otherreceiving.js';
import * as history from './history.js';
import * as costs from './costs.js';
import * as routeoptimizer from './routeoptimizer.js';
import * as consignment from './consignment.js';
import * as londonstock from './londonstock.js';
import * as dubaistock from './dubaistock.js';
import * as refinement from './refinement.js';
import * as missingacc from './missingacc.js';
import * as soldstocks from './soldstocks.js';
import * as driverdeliveries from './driverdeliveries.js';
import * as pickupcodes from './pickupcodes.js';
import * as addresses from './addresses.js';
import * as goldsouk from './goldsouk.js';
import * as companies from './companies.js';
import * as shipmentdocs from './shipmentdocs.js';
import * as swaps from './swaps.js';
import * as log from './log.js';

// No prototype: the name comes from the request.
export const PAGES = Object.assign(Object.create(null), { ownerdecisions, hkstock, vaultactivity, otherreceiving, history, costs, routeoptimizer, consignment, londonstock, dubaistock, refinement, missingacc, soldstocks, driverdeliveries, pickupcodes, addresses, goldsouk, companies, shipmentdocs, swaps, log });

export async function page(name) {
  const p = PAGES[name];
  if (!p?.page) throw Object.assign(new Error('No such logistics page'), { status: 404 });
  return p.page();
}

/**
 * Every page's facts about each of these stock numbers, in one read:
 * Map(stockNo → [{ page, text, link, tone }]). The Inventory card and the
 * watch page show them, so a watch says where the logistics app has it —
 * on consignment, at polish, with a driver, its pickup code — without
 * opening each tab.
 */
export async function factsFor(stockNos) {
  const nos = [...new Set((stockNos || []).filter(Boolean))];
  const out = new Map();
  if (!nos.length) return out;
  const [{ rows }, ctx] = await Promise.all([
    query('SELECT * FROM logistics_items WHERE deleted_at IS NULL AND stock_nos && $1::text[] ORDER BY id', [nos]),
    context(),
  ]);
  for (const no of nos) {
    const mine = rows.filter((r) => (r.stock_nos || []).includes(no));
    if (!mine.length) continue;
    const facts = [];
    for (const [name, p] of Object.entries(PAGES)) {
      if (typeof p.forStock !== 'function') continue;
      let got = [];
      try {
        got = p.forStock(no, mine, ctx) || [];
      } catch {
        got = [];
      }
      // Two pages that say the same thing (the place's row and Refinement both know it is at polish) say it once.
      for (const f of got) if (f && f.text && !facts.some((x) => x.text === String(f.text))) facts.push({ page: name, text: String(f.text), link: f.link || `#/logistics/${name}`, tone: f.tone || '' });
    }
    if (facts.length) out.set(no, facts);
  }
  return out;
}
