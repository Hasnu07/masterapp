/*
 * The logistics app's workflows, done here (asked 27 Oct 2026: "all the
 * features in the logistic side in the erp system to do entries"). Each
 * domain module exports ACTIONS, a list of:
 *
 *   {
 *     key:    'move'                      unique across modules
 *     label:  'Move'                      the button's words (a verb first)
 *     kinds:  ['londonStock', …]          records it applies to — or null for
 *                                         a page-level action (Add Row, Import CSV, Ask Owner)
 *     page:   'londonstock'               the tab a page-level action sits on (optional)
 *     danger: true                        drawn as a destructive button (optional)
 *     ai:     true                        needs the AI key (shown greyed without one)
 *     form:   [fields] | async (item, ctx) => [fields]
 *             a field: { key, label, type, options?, currency?, hint?, required? }
 *             types as kinds.js (text, longtext, number, money, currency, date,
 *             when, enum, bool, stock, client) plus 'csv' (a file's text) and
 *             'choice' with options [{ value, label }]
 *     prefill: async (item, ctx) => values           what the form opens with (optional)
 *     run:    async ({ db, item, input, user, ctx }) => { message, open?, created?: [ids] }
 *             inside ONE transaction; db is the transaction client; use write.js
 *     template: () => csvText                        for an import's CSV template (optional)
 *   }
 *
 * The console draws the buttons from the catalog (meta.logistics.actions),
 * opens the form the GET gives it, posts the input, and shows the message.
 * Every write goes through write.js: a changed field on the app's copy is
 * locked against the sync, every record gets its event, and the activity
 * log gets a line as the app would write one.
 */
import { tx } from '../../db/index.js';
import { context } from '../shared.js';
import { loadItem, bad, notFound, addFields } from '../write.js';
import { aiReady } from '../ai.js';
import * as stock from './stock.js';
import * as sales from './sales.js';
import * as incoming from './incoming.js';
import * as shipping from './shipping.js';
import * as movers from './movers.js';
import * as plans from './plans.js';
import * as decisions from './decisions.js';
import * as accessories from './accessories.js';
import * as dubai from './dubai.js';
import * as records from './records.js';
import * as costs from './costs.js';

const MODULES = { stock, sales, incoming, shipping, movers, plans, decisions, accessories, dubai, records, costs };

// No prototype: the key comes from the request.
export const ACTIONS = Object.assign(Object.create(null));
for (const [mod, m] of Object.entries(MODULES)) {
  for (const a of m.ACTIONS || []) {
    if (ACTIONS[a.key]) throw new Error(`Two logistics actions are called ${a.key} (${mod} and ${ACTIONS[a.key].module})`);
    ACTIONS[a.key] = { ...a, module: mod };
  }
}

/* Extra typed fields a module gives a kind's Add / Edit form (merged into the catalog's kinds). */
export const EXTRA_FIELDS = Object.create(null);
for (const m of Object.values(MODULES)) {
  for (const [kind, fields] of Object.entries(m.FIELDS || {})) EXTRA_FIELDS[kind] = [...(EXTRA_FIELDS[kind] || []), ...fields];
}
// …and the forms' checks (write.js clean) and the catalog's kinds know them too.
addFields(EXTRA_FIELDS);

/** What the console needs to draw the buttons: never the code. */
export function catalog() {
  return Object.values(ACTIONS).map((a) => ({
    key: a.key,
    label: a.label,
    kinds: a.kinds || null,
    page: a.page || '',
    danger: Boolean(a.danger),
    ai: Boolean(a.ai),
    ai_ready: a.ai ? aiReady() : true,
    has_form: Boolean(a.form),
    has_template: typeof a.template === 'function',
  }));
}

const find = (key) => {
  const a = ACTIONS[key];
  if (!a) throw Object.assign(new Error('No such logistics action'), { status: 404 });
  return a;
};

/** The form to show, with what it opens with (GET …/act/:key). */
export async function describe(key, itemId = null, query = {}) {
  const a = find(key);
  const ctx = await context();
  const item = itemId ? await tx((db) => loadItem(db, itemId)) : null;
  if (item && a.kinds && !a.kinds.includes(item.kind)) throw bad(`${a.label} does not apply to a ${item.kind} record`);
  if (!item && a.kinds) throw notFound();
  const form = typeof a.form === 'function' ? await a.form(item, ctx, query) : a.form || [];
  const values = a.prefill ? await a.prefill(item, ctx, query) : {};
  return { key: a.key, label: a.label, form, values, ai: Boolean(a.ai), ai_ready: a.ai ? aiReady() : true };
}

/** Runs the action, in one transaction (POST …/act/:key). */
export async function run(key, itemId, input, user, query = {}) {
  const a = find(key);
  if (a.ai && !aiReady()) throw Object.assign(new Error('No AI key: set ANTHROPIC_API_KEY to use this'), { status: 409 });
  const ctx = await context();
  return tx(async (db) => {
    const item = itemId ? await loadItem(db, itemId) : null;
    if (item && a.kinds && !a.kinds.includes(item.kind)) throw bad(`${a.label} does not apply to a ${item.kind} record`);
    if (!item && a.kinds) throw notFound();
    const out = (await a.run({ db, item, input: input || {}, user, ctx, query })) || {};
    return { message: out.message || `${a.label}: done`, open: out.open || null, created: out.created || [], data: out.data ?? null };
  });
}

/** A CSV template for an import action. */
export function template(key) {
  const a = find(key);
  if (typeof a.template !== 'function') throw notFound();
  return a.template();
}
