/*
 * Owner decisions — the logistics app's Owner Decision Center, its buttons
 * done here (asked 27 Oct 2026). Each action is the app's own function
 * (its index.html, the od* family), record for record:
 *
 *   od-decide    openOwnerDecisionEdit + saveOwnerDecisionEdit   the decision written by hand
 *   od-status    odCardMenu → odSetStatus                        any status
 *   od-start     the card's Start: odSetStatus(…, 'IN_EXECUTION')
 *   od-done      the card's Done:  odSetStatus(…, 'COMPLETED')
 *   od-assign    odAssignCollector     an execution group's collector
 *   od-arranged  odMarkArranged        an execution group → IN_EXECUTION
 *   od-brief     openOwnerBrief + odSendBrief, as "Mark as sent": the brief
 *                record and every watch in it SENT_TO_OWNER — the text is
 *                the app's odBriefText; the WhatsApp send itself is not here
 *   od-delete    a decision record deleted here (the app keeps them for ever)
 *   (Create Collection = odCreateCollection hands the group to the Delivery
 *    Planner: the inc-collect action, opened with the group ticked.)
 *
 * All of it goes through the app's one way of changing a decision, odSet:
 * the record is made the moment it is first needed (odCreate), every change
 * is appended to its events, never overwritten. The app signs every event
 * "manager" (it has one user); here it is the person signed in — an ERP
 * says who decided.
 *
 * Not here (the app's bot needs its WhatsApp and Claude keys, which
 * masterapp does not hold): sending the brief, the owner's voice notes
 * (VOICE_RECEIVED), their AI reading (AI_PROCESSING, aiInterpretation) and
 * the confirmation flow they feed. A status can still be set by hand.
 */
import { query } from '../../db/index.js';
import { insertItem, patchItem, softDelete, logActivity, text, dayOf, bad } from '../write.js';
import { page as decisionsPage, statusOf as pageStatusOf, changedSince, STATUS } from '../pages/ownerdecisions.js';
import { appId, byAppId, incLoc, incSup, incDest, isHistoric, oursNote } from './incoming.js';

/* The app's OD_STATUS and OD_ACTIONS. */
export const OD_STATUS = {
  DECISION_NEEDED: 'Decision Needed',
  SENT_TO_OWNER: 'Sent to Owner',
  VOICE_RECEIVED: 'Voice Received',
  AI_PROCESSING: 'AI Processing',
  NEEDS_CLARIFICATION: 'Needs Clarification',
  AWAITING_CONFIRMATION: 'Awaiting Confirmation',
  APPROVED: 'Approved',
  IN_EXECUTION: 'In Execution',
  HOLD: 'Hold',
  COMPLETED: 'Completed',
  NOT_ASKED: 'Not asked yet',
};
export const OD_ACTIONS = {
  COLLECT: 'Collect',
  SHIP: 'Ship',
  HAND_CARRY: 'Hand carry',
  HOLD: 'Hold',
  SELL_LOCAL: 'Sell locally',
  COMBINE: 'Combine with others',
  RETURN: 'Return',
  WAIT_FOR_BOX: 'Wait for box',
  WAIT_FOR_DOCUMENTS: 'Wait for documents',
  CHANGE_DESTINATION: 'Change destination',
  REVIEW_LATER: 'Review later',
  OTHER: 'Other',
};
const statusLabel = (s) => OD_STATUS[s] || OD_STATUS.DECISION_NEEDED;
const who = (user) => text(user?.name) || text(user?.email) || 'manager';

/* The app's odEvent: appended, never overwritten, the last hundred kept. */
function odEvent(d, type, payload) {
  if (!Array.isArray(d.events)) d.events = [];
  d.events.push({ ts: Date.now(), type, ...(payload || {}) });
  if (d.events.length > 100) d.events = d.events.slice(-100);
}

/**
 * The app's odSet (with odCreate inside it): the incoming's decision record,
 * made now if it has none, with `patch` written and an event of the change.
 * Returns the decision's row.
 */
export async function setDecision(db, incRow, patch, opts, user) {
  opts = opts || {};
  const inc = incRow.data;
  let row = inc.ownerDecisionId ? await byAppId(db, 'ownerDecisions', inc.ownerDecisionId) : null;
  const by = opts.by || who(user);
  if (!row) {
    const stamp = Date.now();
    const d = {
      incomingId: appId(incRow),
      stockNumber: text(inc.stockNumber),
      status: 'DECISION_NEEDED',
      action: '',
      destination: '',
      collector: '',
      shipmentGroup: '',
      holdUntil: '',
      reviewAt: '',
      priority: '',
      rawInstruction: '',
      voiceNoteUrl: '',
      transcription: '',
      aiInterpretation: null,
      requestedAt: null,
      respondedAt: null,
      confirmedAt: null,
      confirmedBy: '',
      source: 'APP',
      whatsappMessageId: '',
      briefId: '',
      events: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    odEvent(d, 'created', { by });
    row = await insertItem(db, 'ownerDecisions', d, user);
    await patchItem(db, incRow, { ...inc, ownerDecisionId: row.data.id }, user);
  }
  const d = { ...row.data, events: Array.isArray(row.data.events) ? [...row.data.events] : [] };
  const before = { status: d.status, action: d.action, destination: d.destination, collector: d.collector };
  for (const [k, v] of Object.entries(patch || {})) d[k] = v;
  d.stockNumber = text(inc.stockNumber) || d.stockNumber;
  d.updatedAt = Date.now();
  if (patch && patch.status) {
    if (patch.status === 'SENT_TO_OWNER' && !d.requestedAt) d.requestedAt = Date.now();
    if (patch.status === 'APPROVED') {
      d.confirmedAt = Date.now();
      d.confirmedBy = by;
      d.source = opts.source || d.source;
    }
  }
  odEvent(d, opts.type || 'updated', {
    by,
    source: opts.source || 'APP',
    from: before,
    to: { status: d.status, action: d.action, destination: d.destination, collector: d.collector },
    text: opts.note || '',
  });
  await patchItem(db, row, d, user);
  return row;
}

/* Reads outside a transaction (a form, a prefill) go to the pool, unlocked. */
const pool = { query };

/* The incoming an action is on: the record itself, or the one its decision names. */
async function incomingOf(db, item, { lock = true } = {}) {
  if (item.kind === 'incomings') return item;
  const inc = await byAppId(db, 'incomings', item.data.incomingId, { lock });
  if (!inc) throw bad('The incoming this decision was about is gone');
  return inc;
}
const liveDecisionOf = async (db, inc) => (inc.data.ownerDecisionId ? byAppId(db, 'ownerDecisions', inc.data.ownerDecisionId, { lock: false }) : null);
/* The app's odStatusOf. */
const statusOf = (inc, od) => (od?.data?.status ? od.data.status : inc.data.fromFob ? 'NOT_ASKED' : 'DECISION_NEEDED');

/* The app's odConflicts: what the record says against the instruction — said, never acted on. */
export async function conflicts(db, inc, od, newDest) {
  const d = inc.data;
  const out = [];
  const cur = incDest(d);
  if (newDest && cur && newDest.toLowerCase() !== cur.toLowerCase()) out.push(`Its destination is ${cur}; this says ${newDest}. Saving will not change the incoming — change that on the incoming.`);
  if (d.shipmentId) out.push('It is already on a shipment.');
  if (d.inventoryId) out.push('It has already been received into inventory.');
  if (d.status === 'arrived') out.push('It is already marked arrived.');
  if (d.status === 'cancelled') out.push('It is cancelled.');
  if (od?.data?.status === 'IN_EXECUTION') out.push('It is already being executed.');
  const sn = text(d.stockNumber);
  if (sn) {
    const { rows } = await db.query("SELECT 1 FROM logistics_items WHERE kind = 'soldStocks' AND deleted_at IS NULL AND btrim(data->>'stockNumber') = $1 LIMIT 1", [sn]);
    if (rows[0]) out.push('A watch with this stock number is already sold.');
  }
  return out;
}

/* The app's odExecutionGroups → odGroupItems: the live incomings approved / in execution in one group, locked. */
async function groupItems(db, q) {
  const [inc, od] = await Promise.all([
    db.query("SELECT * FROM logistics_items WHERE kind = 'incomings' AND deleted_at IS NULL ORDER BY id FOR UPDATE"),
    db.query("SELECT source_id, data FROM logistics_items WHERE kind = 'ownerDecisions' AND deleted_at IS NULL"),
  ]);
  const dec = new Map(od.rows.map((r) => [r.source_id || text(r.data?.id), r.data || {}]));
  const out = [];
  for (const r of inc.rows) {
    const d = r.data || {};
    if (isHistoric(d)) continue;
    const o = d.ownerDecisionId ? dec.get(String(d.ownerDecisionId)) : null;
    if (!o || !['APPROVED', 'IN_EXECUTION'].includes(o.status)) continue;
    const to = text(o.destination) || incDest(d) || 'Destination not set';
    if (incLoc(d) === text(q.from) && to === text(q.to) && text(o.collector) === text(q.collector)) out.push(r);
  }
  return out;
}

/* ── the brief to the owner (the app's odBriefCandidates / odBriefText) ── */

/* The app's INC_FLAGS, as the owner sees them on WhatsApp. */
const FLAGS = {
  switzerland: '🇨🇭', spain: '🇪🇸', italy: '🇮🇹', dubai: '🇦🇪', uae: '🇦🇪', 'united arab emirates': '🇦🇪', 'abu dhabi': '🇦🇪', germany: '🇩🇪', uk: '🇬🇧', 'united kingdom': '🇬🇧', england: '🇬🇧', london: '🇬🇧',
  france: '🇫🇷', paris: '🇫🇷', usa: '🇺🇸', 'united states': '🇺🇸', america: '🇺🇸', 'hong kong': '🇭🇰', hk: '🇭🇰', japan: '🇯🇵', singapore: '🇸🇬', china: '🇨🇳', netherlands: '🇳🇱', holland: '🇳🇱', belgium: '🇧🇪',
  austria: '🇦🇹', portugal: '🇵🇹', greece: '🇬🇷', turkey: '🇹🇷', qatar: '🇶🇦', 'saudi arabia': '🇸🇦', kuwait: '🇰🇼', bahrain: '🇧🇭', oman: '🇴🇲', india: '🇮🇳', pakistan: '🇵🇰', thailand: '🇹🇭',
  malaysia: '🇲🇾', australia: '🇦🇺', canada: '🇨🇦', poland: '🇵🇱', sweden: '🇸🇪', denmark: '🇩🇰', norway: '🇳🇴', finland: '🇫🇮', 'czech republic': '🇨🇿', romania: '🇷🇴', russia: '🇷🇺', monaco: '🇲🇨',
  luxembourg: '🇱🇺', ireland: '🇮🇪', israel: '🇮🇱', lebanon: '🇱🇧', egypt: '🇪🇬', morocco: '🇲🇦', 'south africa': '🇿🇦', brazil: '🇧🇷', mexico: '🇲🇽', korea: '🇰🇷', 'south korea': '🇰🇷', taiwan: '🇹🇼',
  vietnam: '🇻🇳', indonesia: '🇮🇩', philippines: '🇵🇭', 'new zealand': '🇳🇿', argentina: '🇦🇷', chile: '🇨🇱',
};
const flag = (name) => FLAGS[text(name).toLowerCase()] || '📍';
const SENT = ['SENT_TO_OWNER', 'VOICE_RECEIVED', 'AI_PROCESSING'];
const FIELD_KEYS = ['stock', 'ref', 'price', 'dest', 'notes', 'serial'];

/** The brief's options as the page sends them (data-q-…): pick by, which names, group by, the fields, ask again. */
export function briefOptions(q = {}) {
  const fields = q.fields === undefined ? { stock: true, ref: true, price: true, dest: true, notes: true, serial: false } : Object.fromEntries(FIELD_KEYS.map((k) => [k, text(q.fields).split(',').includes(k)]));
  return {
    pick: text(q.pick) === 'supplier' ? 'supplier' : 'location',
    picked: new Set(text(q.picked).split('|').map((s) => s.trim()).filter(Boolean)),
    group: text(q.group) === 'location' ? 'location' : 'supplier',
    includeSent: /^(1|true|yes)$/i.test(text(q.sent)),
    fields,
  };
}

/** The app's odBriefCandidates over the Owner Decisions page's rows: who the owner has a reason to look at, and why. */
export function briefCandidates(rows, opts) {
  const out = [];
  const add = (inc, why) => {
    if (!out.some((x) => x.inc.id === inc.id)) out.push({ inc, why });
  };
  rows.filter((i) => i.status === 'DECISION_NEEDED').forEach((i) => add(i, 'new'));
  rows.filter((i) => i.changed).forEach((i) => add(i, i.changed));
  rows.filter((i) => i.review_due).forEach((i) => add(i, 'review due'));
  if (opts.includeSent) rows.filter((i) => SENT.includes(i.status)).forEach((i) => add(i, 'asked before'));
  if (!opts.picked.size) return out;
  return out.filter((x) => opts.picked.has(opts.pick === 'supplier' ? x.inc.supplier : x.inc.location));
}

/** The app's odBriefText, line for line, over the page's rows. */
export function briefText(items, opts) {
  if (!items.length) return 'Nothing to ask about.';
  const f = opts.fields;
  const changed = items.filter((x) => x.why !== 'new');
  const keyOf = (x) => (opts.group === 'location' ? x.inc.location : x.inc.supplier);
  const groups = new Map();
  for (const x of items) {
    const k = keyOf(x);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const lines = ['📦 INCOMINGS — FOR YOUR DECISION', ''];
  const again = items.filter((x) => x.why === 'asked before').length;
  lines.push(`When you have a moment, could I please have your instructions on ${items.length} watch${items.length === 1 ? '' : 'es'}?`);
  if (again) lines.push(`${again === items.length ? 'These are ones' : `${again} of these are ones`} I sent before — sorry to ask again.`);
  if (changed.length) lines.push(`${changed.length} of ${changed.length === 1 ? 'them you have' : 'these you have'} seen before — something has changed since.`);
  lines.push('');
  for (const [name, rows] of ordered) {
    const loc = opts.group === 'location' ? name : rows[0].inc.location;
    const whoName = opts.group === 'location' ? '' : name;
    lines.push(`${flag(loc)} ${(whoName || loc).toUpperCase()}${whoName ? ` — ${loc.toUpperCase()}` : ''}`);
    lines.push(`${rows.length} watch${rows.length === 1 ? '' : 'es'}`);
    lines.push('');
    for (const { inc, why } of rows.slice(0, 4)) {
      const head = [f.stock && inc.stock_no ? `#${inc.stock_no}` : '', f.ref ? inc.reference || '' : ''].filter(Boolean).join('  ');
      if (head) lines.push(head);
      const sub = [];
      if (inc.brand) sub.push(inc.brand);
      if (f.serial && inc.serial) sub.push(`SN ${inc.serial}`);
      if (sub.length) lines.push(sub.join(' · '));
      if (f.price && inc.buy) lines.push(`Buy: ${inc.buy.currency || 'USD'} ${Number(inc.buy.amount).toLocaleString('en-US')}`);
      if (f.dest && inc.destination) lines.push(`Destination: ${inc.destination}`);
      if (f.notes && inc.notes) lines.push(`Note: ${String(inc.notes).slice(0, 70)}`);
      if (why === 'asked before') lines.push('↩ sent before');
      else if (why && why !== 'new') lines.push(`⚠ ${why}`);
      lines.push('');
    }
    if (rows.length > 4) {
      lines.push(`+${rows.length - 4} more watch${rows.length - 4 === 1 ? '' : 'es'}`);
      lines.push('');
    }
    // The app's odConsolidationFor: a suggestion, never an action.
    const byDest = new Map();
    for (const { inc } of rows) if (inc.destination) byDest.set(inc.destination, (byDest.get(inc.destination) || 0) + 1);
    let best = '';
    let n = 0;
    for (const [k, v] of byDest) if (v > n) [n, best] = [v, k];
    if (n > 1) {
      lines.push(`💡 ${n} of these share the same destination — ${best}. They may be able to travel together.`);
      lines.push('');
    }
  }
  lines.push('🎙 Whenever it suits you, please send a voice note with how you would like these handled. Thank you.');
  return lines.join('\n');
}

/*
 * The Owner Decisions page's rows, with the decisions written HERE read in:
 * the page finds a decision by the app's id (source_id), and one made here
 * has only its own (data.id). Until the page keys by `source_id || data.id`,
 * this reads those over — the same rules (statusOf, changedSince, review
 * due) on the same rows.
 */
async function pageRows() {
  const { rows, today } = await decisionsPage();
  const [inc, ours] = await Promise.all([
    query("SELECT id, data->>'ownerDecisionId' AS od FROM logistics_items WHERE kind = 'incomings' AND deleted_at IS NULL AND id = ANY($1)", [rows.map((r) => r.id)]),
    query("SELECT data FROM logistics_items WHERE kind = 'ownerDecisions' AND deleted_at IS NULL AND source_id IS NULL"),
  ]);
  const mine = new Map(ours.rows.map((r) => [text(r.data?.id), r.data || {}]));
  const odOf = new Map(inc.rows.map((r) => [r.id, r.od ? mine.get(String(r.od)) : null]));
  const OPEN = ['DECISION_NEEDED', 'SENT_TO_OWNER', 'VOICE_RECEIVED', 'AI_PROCESSING', 'NEEDS_CLARIFICATION', 'AWAITING_CONFIRMATION'];
  return rows.map((row) => {
    const od = odOf.get(row.id);
    if (!od || row.decision) return row;
    const status = pageStatusOf({ fromFob: row.from_fob }, od);
    return {
      ...row,
      status,
      status_label: STATUS[status] || status,
      changed: changedSince({ destination: row.destination, shipmentId: null }, od),
      review_due: Boolean(od.reviewAt && od.reviewAt <= today && !OPEN.includes(od.status) && od.status !== 'COMPLETED'),
    };
  });
}

async function briefNow(q) {
  const opts = briefOptions(q);
  const rows = await pageRows();
  const items = briefCandidates(rows, opts);
  return { opts, items, text: briefText(items, opts) };
}

/* ── the decision form (the app's ownerDecisionModal) ── */

const statusChoice = (more = {}) => ({ key: 'status', label: 'Status', type: 'choice', options: Object.entries(OD_STATUS).map(([value, label]) => ({ value, label })), ...more });
async function decideForm(item) {
  if (!item) return [];
  const inc = await incomingOf(pool, item, { lock: false });
  const od = await liveDecisionOf(pool, inc);
  const warn = await conflicts(pool, inc, od, text(od?.data?.destination) || incDest(inc.data));
  return [
    statusChoice({ hint: warn.length ? `⚠ ${warn.join(' ')}` : '' }),
    { key: 'action', label: 'What the owner wants done', type: 'choice', options: [{ value: '', label: '— no action yet —' }, ...Object.entries(OD_ACTIONS).map(([value, label]) => ({ value, label }))] },
    { key: 'destination', label: 'Destination', type: 'text' },
    { key: 'collector', label: 'Collector', type: 'text' },
    { key: 'reviewAt', label: 'Review on', type: 'date' },
    { key: 'rawInstruction', label: 'The owner’s instruction, in his words', type: 'longtext', hint: 'logged as entered here by you, never as the owner’s own confirmation' },
  ];
}

const STATUS_LINE = (status) => `🗂 Owner decision → ${statusLabel(status)}`;

export const ACTIONS = [
  {
    key: 'od-decide',
    label: 'Record decision',
    kinds: ['incomings', 'ownerDecisions'],
    form: decideForm,
    prefill: async (item) => {
      const inc = await incomingOf(pool, item, { lock: false });
      const od = await liveDecisionOf(pool, inc);
      const d = od?.data || {};
      return {
        status: text(d.status) || 'DECISION_NEEDED',
        action: text(d.action),
        destination: text(d.destination) || incDest(inc.data),
        collector: text(d.collector),
        reviewAt: text(d.reviewAt),
        rawInstruction: text(d.rawInstruction || d.transcription),
      };
    },
    run: async ({ db, item, input, user }) => {
      const inc = await incomingOf(db, item);
      const status = text(input.status, 40);
      if (!OD_STATUS[status]) throw bad(`Status: "${status}" is not one of ${Object.keys(OD_STATUS).join(', ')}`);
      const action = text(input.action, 40);
      if (action && !OD_ACTIONS[action]) throw bad(`Action: "${action}" is not one of ${Object.keys(OD_ACTIONS).join(', ')}`);
      const reviewAt = input.reviewAt ? dayOf(input.reviewAt, 'Review on', { blank: '' }) : '';
      const dest = text(input.destination, 100);
      const od = await liveDecisionOf(db, inc);
      const warn = await conflicts(db, inc, od, dest);
      const row = await setDecision(
        db,
        inc,
        { status, action, destination: dest, collector: text(input.collector, 100), reviewAt, rawInstruction: text(input.rawInstruction, 5000) },
        { source: 'APP', note: 'Entered in the app' },
        user
      );
      await logActivity(db, `🗂 Owner decision for #${text(inc.data.stockNumber) || '?'} → ${statusLabel(status)}`, user);
      return { message: `Decision recorded: ${statusLabel(status)}${warn.length ? ` · ⚠ ${warn.join(' ')}` : ''}${await oursNote(inc.data.stockNumber)}`, open: `#/lg/${row.id}` };
    },
  },
  {
    key: 'od-status',
    label: 'Set status',
    kinds: ['incomings', 'ownerDecisions'],
    form: [statusChoice()],
    prefill: async (item) => {
      const inc = await incomingOf(pool, item, { lock: false });
      return { status: statusOf(inc, await liveDecisionOf(pool, inc)) };
    },
    run: async ({ db, item, input, user }) => {
      const inc = await incomingOf(db, item);
      const status = text(input.status, 40);
      if (!OD_STATUS[status]) throw bad(`Status: "${status}" is not one of ${Object.keys(OD_STATUS).join(', ')}`);
      const row = await setDecision(db, inc, { status }, { note: 'Set in the app' }, user);
      await logActivity(db, STATUS_LINE(status), user);
      return { message: `Owner decision → ${statusLabel(status)}`, open: `#/lg/${row.id}` };
    },
  },
  {
    key: 'od-start',
    label: 'Start',
    kinds: ['incomings', 'ownerDecisions'],
    run: async ({ db, item, user }) => {
      const inc = await incomingOf(db, item);
      const st = statusOf(inc, await liveDecisionOf(db, inc));
      if (st !== 'APPROVED') throw bad(`Start is for an approved decision; this one is ${statusLabel(st)}`);
      const row = await setDecision(db, inc, { status: 'IN_EXECUTION' }, { note: 'Set in the app' }, user);
      await logActivity(db, STATUS_LINE('IN_EXECUTION'), user);
      return { message: 'In execution', open: `#/lg/${row.id}` };
    },
  },
  {
    key: 'od-done',
    label: 'Done',
    kinds: ['incomings', 'ownerDecisions'],
    run: async ({ db, item, user }) => {
      const inc = await incomingOf(db, item);
      const st = statusOf(inc, await liveDecisionOf(db, inc));
      if (st !== 'IN_EXECUTION') throw bad(`Done is for a decision in execution; this one is ${statusLabel(st)}`);
      const row = await setDecision(db, inc, { status: 'COMPLETED' }, { note: 'Set in the app' }, user);
      await logActivity(db, STATUS_LINE('COMPLETED'), user);
      return { message: 'Completed', open: `#/lg/${row.id}` };
    },
  },
  {
    key: 'od-assign',
    label: 'Assign collector',
    kinds: null,
    page: 'ownerdecisions',
    form: [{ key: 'collector', label: 'Who is collecting them', type: 'text', hint: 'blank clears the collector' }],
    prefill: async (item, ctx, q) => ({ collector: text(q.collector) }),
    run: async ({ db, input, user, query: q }) => {
      const items = await groupItems(db, q);
      if (!items.length) throw bad('Nothing approved in that group any more');
      const whoName = text(input.collector, 100);
      for (const r of items) await setDecision(db, r, { collector: whoName }, { note: 'Collector set in the app' }, user);
      await logActivity(db, `🚚 Collector ${whoName || '(cleared)'} for ${items.length} from ${text(q.from)}`, user);
      return { message: `Collector ${whoName || 'cleared'} for ${items.length} watch${items.length === 1 ? '' : 'es'} from ${text(q.from)}` };
    },
  },
  {
    key: 'od-arranged',
    label: 'Mark arranged',
    kinds: null,
    page: 'ownerdecisions',
    run: async ({ db, user, query: q }) => {
      const items = await groupItems(db, q);
      if (!items.length) throw bad('Nothing approved in that group any more');
      for (const r of items) await setDecision(db, r, { status: 'IN_EXECUTION' }, { note: 'Marked arranged' }, user);
      const n = items.length;
      await logActivity(db, `🚚 ${n} watch${n === 1 ? '' : 'es'} marked arranged (${text(q.from)} → ${text(q.to)})`, user);
      return { message: `${n} watch${n === 1 ? '' : 'es'} marked arranged` };
    },
  },
  {
    key: 'od-brief',
    label: 'Ask owner · mark brief as sent',
    kinds: null,
    page: 'incoming',
    form: async (item, ctx, q) => {
      const { items } = await briefNow(q);
      return [
        { key: 'to', label: 'Sent to (number or group)', type: 'text', hint: 'the app sends it to the owner’s WhatsApp; here you paste it there yourself, then mark it sent' },
        { key: 'text', label: 'The brief, as sent', type: 'longtext', hint: items.length ? `${items.length} watch${items.length === 1 ? '' : 'es'} will be marked Sent to Owner` : 'nothing to ask about' },
      ];
    },
    prefill: async (item, ctx, q) => ({ to: '', text: (await briefNow(q)).text }),
    run: async ({ db, input, user, query: q }) => {
      const { opts, items, text: built } = await briefNow(q);
      if (!items.length) throw bad('Nothing to ask about');
      const ids = items.map((x) => x.inc.id);
      const { rows } = await db.query("SELECT * FROM logistics_items WHERE kind = 'incomings' AND deleted_at IS NULL AND id = ANY($1) ORDER BY id FOR UPDATE", [ids]);
      const body = text(input.text, 20000) || built;
      const brief = await insertItem(db, 'ownerBriefs', { by: who(user), to: text(input.to, 100), group: opts.group, count: rows.length, text: body, incomingIds: rows.map((r) => appId(r)) }, user);
      for (const r of rows) await setDecision(db, r, { status: 'SENT_TO_OWNER', briefId: brief.data.id }, { type: 'sent_to_owner', source: 'WHATSAPP', note: 'Sent to the owner on WhatsApp' }, user);
      const n = rows.length;
      await logActivity(db, `🎙 Owner brief sent — ${n} watch${n === 1 ? '' : 'es'}`, user);
      return { message: `Brief marked as sent: ${n} watch${n === 1 ? '' : 'es'} now with the owner`, open: '#/logistics/ownerdecisions', created: [brief.id] };
    },
  },
  {
    key: 'od-delete',
    label: 'Delete decision',
    kinds: ['ownerDecisions'],
    danger: true,
    run: async ({ db, item, user }) => {
      const inc = await byAppId(db, 'incomings', item.data.incomingId);
      await softDelete(db, item.id, user);
      if (inc && text(inc.data.ownerDecisionId) === appId(item)) await patchItem(db, inc, { ...inc.data, ownerDecisionId: undefined }, user);
      await logActivity(db, `🗂 Owner decision for #${text(item.data.stockNumber) || '?'} deleted`, user);
      return { message: 'Decision deleted — the watch is back to Decision needed', open: '#/logistics/ownerdecisions' };
    },
  },
];

export const FIELDS = {};
