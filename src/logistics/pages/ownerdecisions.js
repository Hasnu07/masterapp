/*
 * Owner Decisions: the logistics app's "Owner Decision Center" (its tab
 * `ownerdecisions`: renderOwnerCenter and the od* family), read from our
 * copy of its records.
 *
 * The app's page is operational, not analytical: which incoming watches the
 * owner still has to rule on, what he has ruled, and what that means
 * somebody has to do. Its rules, as written there:
 *   - the incomings it looks at are the LIVE ones (odLiveIncomings): not
 *     arrived, not cancelled, not on a shipment, not taken into stock —
 *     there is nothing left to decide about a watch already in stock;
 *   - a decision is the incoming's `ownerDecisionId` → an ownerDecisions
 *     record; no record means DECISION_NEEDED, unless the incoming was only
 *     picked from Chrono Key (`fromFob`) — then NOT_ASKED (odStatusOf);
 *   - what was decided, in a line (odDescribe): the action, "with"
 *     collector, "→" destination, "review" / "until" a day; else the raw
 *     instruction's first sixty characters;
 *   - a review the owner deferred is due when `reviewAt` is today or past
 *     and the decision is not open or completed (odDueForReview);
 *   - a confirmed decision is stale when the incoming's destination changed
 *     after the owner named one, or a HOLD was put on a shipment
 *     (odChangedSince);
 *   - the execution queue: approved / in-execution watches by where they
 *     are → where they go, with who is collecting (odExecutionGroups);
 *   - consolidations: live incomings with a destination, grouped place →
 *     destination, more than one watch from more than one supplier
 *     (odConsolidations) — a suggestion only;
 *   - the brief to the owner (odBriefCandidates / odBriefText): what is
 *     new, what changed under a decision he made, what he asked to be
 *     reminded of — and, if ticked, what he was already sent.
 * The counters, sections (by status, then by supplier), the brief's text
 * and its options are worked out in the browser from this page's rows, as
 * in the app.
 *
 * What waits for the switch-over: sending the brief on WhatsApp, the voice
 * notes and their AI reading (the app's bot needs its WhatsApp and Claude
 * keys, which masterapp does not hold — and its settings are never copied,
 * so there is no bot status to show); writing a decision, assigning a
 * collector, Start / Done: each is the record's own page here. The brief
 * can be copied, as in the app.
 *
 * Every incoming's stock number is OUR watch, with its clients by Chrono
 * Key's ids; the typed supplier links as far as the logistics client of
 * that name does (linksByName).
 */
import { query } from '../../db/index.js';
import { oursByNumber, text, iso, dayOf, picturesOf } from '../shared.js';
import { linksByName } from '../clients.js';
import { lastLogisticsRead } from '../../import/logistics/sync.js';

/* Copied from src/logistics/index.js (asOf). */
async function asOf() {
  const { rows } = await query("SELECT finished_at AS at FROM import_runs WHERE source = 'logistics' AND ok ORDER BY started_at DESC LIMIT 1");
  const a = rows[0]?.at ? new Date(rows[0].at) : null;
  const b = lastLogisticsRead();
  return a && b ? (a > b ? a : b) : a || b;
}

/* The app's OD_STATUS: each status's words. */
export const STATUS = {
  DECISION_NEEDED: 'Decision needed',
  SENT_TO_OWNER: 'Sent to owner',
  VOICE_RECEIVED: 'Voice received',
  AI_PROCESSING: 'AI processing',
  NEEDS_CLARIFICATION: 'Needs clarification',
  AWAITING_CONFIRMATION: 'Awaiting confirmation',
  APPROVED: 'Approved',
  IN_EXECUTION: 'In execution',
  HOLD: 'Hold',
  COMPLETED: 'Completed',
  NOT_ASKED: 'Not asked yet',
};
/* The app's OD_ACTIONS (copied from src/logistics/index.js, OD_ACTIONS). */
const ACTIONS = {
  COLLECT: 'Collect', SHIP: 'Ship', HAND_CARRY: 'Hand carry', HOLD: 'Hold', SELL_LOCAL: 'Sell locally', COMBINE: 'Combine with others',
  RETURN: 'Return', WAIT_FOR_BOX: 'Wait for box', WAIT_FOR_DOCUMENTS: 'Wait for documents', CHANGE_DESTINATION: 'Change destination',
  REVIEW_LATER: 'Review later', OTHER: 'Other',
};
/* The app's OD_OPEN: a decision still with the owner. */
const OPEN = ['DECISION_NEEDED', 'SENT_TO_OWNER', 'VOICE_RECEIVED', 'AI_PROCESSING', 'NEEDS_CLARIFICATION', 'AWAITING_CONFIRMATION'];
const NO_LOC = 'Unknown location';
const NO_SUP = 'No client';

/* The app's odDescribe (copied from src/logistics/index.js, decisionWords). */
export const describe = (d) =>
  [d.action && (ACTIONS[d.action] || d.action), d.collector && `with ${d.collector}`, d.destination && `→ ${d.destination}`, d.reviewAt && `review ${d.reviewAt}`, d.holdUntil && `until ${d.holdUntil}`]
    .filter(Boolean)
    .join(' · ') || text(d.rawInstruction).slice(0, 60);

/* The app's incDestOf: inventoryDest is the firm answer, destination what was typed. */
const DEST = { london: 'London', dubai: 'Dubai', hk: 'Hong Kong' };
const destOf = (d) => DEST[d.inventoryDest] || text(d.destination);
/* The app's _incIsHistoric: finished physically, so nothing left to decide. */
const historic = (d) => d.status === 'arrived' || d.status === 'cancelled' || Boolean(d.shipmentId) || Boolean(d.inventoryId);
/* The app's odStatusOf. */
export const statusOf = (inc, od) => (od?.status ? od.status : inc.fromFob ? 'NOT_ASKED' : 'DECISION_NEEDED');
/* The app's odChangedSince: a decision made against facts that have since changed. */
export const changedSince = (inc, od) => {
  if (!od || !od.confirmedAt) return '';
  const dest = text(inc.destination);
  if (od.destination && dest && od.destination.toLowerCase() !== dest.toLowerCase()) return `destination changed to ${dest} after the owner said ${od.destination}`;
  if (od.action && ['APPROVED', 'IN_EXECUTION'].includes(od.status) && inc.shipmentId && od.action === 'HOLD') return 'it was put on a shipment after the owner asked to hold it';
  return '';
};
/* The app's odEventLabel. */
const eventLabel = (e) => {
  if (e.type === 'created') return 'Decision opened';
  if (e.type === 'sent_to_owner') return 'Sent to the owner';
  if (e.type === 'updated' && e.from && e.to && e.from.status !== e.to.status) return `${STATUS[e.from.status] || e.from.status} → ${STATUS[e.to.status] || e.to.status}`;
  if (e.text) return e.text;
  return 'Updated';
};

const todayUtc = () => new Date().toISOString().slice(0, 10);

/* A decision record as the page shows it. */
function decisionView(row, d) {
  return {
    id: row.id,
    status: text(d.status) || 'DECISION_NEEDED',
    status_label: STATUS[d.status] || text(d.status) || STATUS.DECISION_NEEDED,
    words: describe(d),
    action: text(d.action),
    action_label: d.action ? ACTIONS[d.action] || text(d.action) : '',
    destination: text(d.destination),
    collector: text(d.collector),
    review_at: text(d.reviewAt),
    hold_until: text(d.holdUntil),
    priority: text(d.priority),
    instruction: text(d.transcription || d.rawInstruction),
    reading: d.aiInterpretation ? (typeof d.aiInterpretation === 'string' ? d.aiInterpretation : JSON.stringify(d.aiInterpretation)) : '',
    has_voice: Boolean(text(d.voiceNoteUrl)),
    source: text(d.source),
    brief_id: text(d.briefId),
    requested_at: iso(d.requestedAt),
    confirmed_at: iso(d.confirmedAt),
    confirmed_by: text(d.confirmedBy),
    updated_at: iso(d.updatedAt) || iso(d.createdAt) || new Date(row.updated_at || row.created_at).toISOString(),
    events: (Array.isArray(d.events) ? d.events : [])
      .filter(Boolean)
      .map((e) => ({ at: iso(e.ts), label: eventLabel(e), by: text(e.by), source: text(e.source) }))
      .reverse(),
    locked: (row.locked_fields || []).length > 0,
  };
}

/** The page's data (GET /api/logistics/page/ownerdecisions). */
export async function page() {
  const [incQ, odQ, briefQ] = await Promise.all([
    query("SELECT * FROM logistics_items WHERE kind = 'incomings' AND deleted_at IS NULL ORDER BY id"),
    query("SELECT * FROM logistics_items WHERE kind = 'ownerDecisions' AND deleted_at IS NULL ORDER BY id"),
    query("SELECT * FROM logistics_items WHERE kind = 'ownerBriefs' AND deleted_at IS NULL ORDER BY id"),
  ]);
  const decisions = new Map(odQ.rows.filter((r) => r.source_id).map((r) => [r.source_id, r]));
  const incBySource = new Map(incQ.rows.filter((r) => r.source_id).map((r) => [r.source_id, r]));
  const live = incQ.rows.filter((r) => !historic(r.data || {}));
  const [ours, people] = await Promise.all([
    oursByNumber([...live, ...odQ.rows].flatMap((r) => r.stock_nos || [])),
    linksByName(live.map((r) => r.data?.supplier)),
  ]);
  const today = todayUtc();

  const rows = live.map((r) => {
    const d = r.data || {};
    const odRow = d.ownerDecisionId ? decisions.get(String(d.ownerDecisionId)) : null;
    const od = odRow ? odRow.data || {} : null;
    const status = statusOf(d, od);
    const changed = changedSince(d, od);
    const reviewDue = Boolean(od && od.reviewAt && od.reviewAt <= today && !OPEN.includes(od.status) && od.status !== 'COMPLETED');
    const supplier = text(d.supplier);
    return {
      id: r.id,
      source_id: r.source_id,
      stock_no: text(d.stockNumber),
      brand: text(d.brand),
      reference: text(d.reference),
      serial: text(d.serial),
      supplier: supplier || NO_SUP,
      supplier_link: (supplier && people.get(supplier)) || null,
      location: text(d.location) || NO_LOC,
      destination: destOf(d),
      buy: d.buyPrice ? { amount: Number(d.buyPrice) || 0, currency: text(d.buyCurrency) || 'USD' } : null,
      notes: text(d.notes),
      eta: text(d.eta),
      inc_status: text(d.status) || 'pending',
      from_fob: Boolean(d.fromFob),
      status,
      status_label: STATUS[status] || status,
      decision: od ? decisionView(odRow, od) : null,
      words: od ? describe(od) : '',
      changed,
      review_due: reviewDue,
      created: Number(d.createdAt) || 0,
      ...picturesOf(d),
      watch: (r.stock_nos || []).map((s) => ours.get(s)).find(Boolean) || null,
    };
  });

  // The app's odExecutionGroups: approved / in execution, by place → destination and collector.
  const exec = new Map();
  for (const i of rows) {
    if (!['APPROVED', 'IN_EXECUTION'].includes(i.status)) continue;
    const to = i.decision?.destination || i.destination || 'Destination not set';
    const collector = i.decision?.collector || '';
    const key = `${i.location} → ${to}||${collector}`;
    if (!exec.has(key)) exec.set(key, { from: i.location, to, collector, items: [] });
    exec.get(key).items.push(i.id);
  }
  // The app's odConsolidations: same place, same destination, more than one supplier.
  const cons = new Map();
  for (const i of rows) {
    if (!i.destination) continue;
    const k = `${i.location} → ${i.destination}`;
    if (!cons.has(k)) cons.set(k, []);
    cons.get(k).push(i);
  }
  const consolidations = [...cons.entries()]
    .map(([route, items]) => ({ route, items: items.map((i) => i.id), suppliers: [...new Set(items.map((i) => i.supplier))] }))
    .filter((g) => g.items.length > 1 && g.suppliers.length > 1)
    .sort((a, b) => b.items.length - a.items.length);

  // Every decision record, live or not: the app shows only those a live incoming points at; the rest are kept and listed under them.
  const liveIds = new Set(rows.map((r) => r.id));
  const records = odQ.rows
    .map((r) => {
      const d = r.data || {};
      const inc = d.incomingId ? incBySource.get(String(d.incomingId)) : null;
      return {
        ...decisionView(r, d),
        stock_no: text(d.stockNumber),
        incoming_id: inc ? inc.id : null,
        incoming_live: Boolean(inc && liveIds.has(inc.id)),
        incoming_status: inc ? text(inc.data?.status) || 'pending' : '',
        watch: (r.stock_nos || []).map((s) => ours.get(s)).find(Boolean) || null,
      };
    })
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id);

  const briefs = briefQ.rows
    .map((r) => {
      const d = r.data || {};
      const ids = Array.isArray(d.incomingIds) ? d.incomingIds.map(String) : [];
      const to = text(d.to);
      return {
        id: r.id,
        at: iso(d.ts) || new Date(r.created_at).toISOString(),
        by: text(d.by),
        // The owner's number is personal: its last four digits say which it was.
        to: to ? (/@g\.us$/.test(to) ? 'the WhatsApp group' : `a number ending ${to.replace(/\D/g, '').slice(-4)}`) : '',
        group: text(d.group),
        count: Number(d.count) || ids.length,
        text: text(d.text),
        watches: ids.map((sid) => {
          const inc = incBySource.get(sid);
          return { incoming_id: inc ? inc.id : null, stock_no: inc ? text(inc.data?.stockNumber) : '', live: Boolean(inc && liveIds.has(inc.id)) };
        }),
      };
    })
    .sort((a, b) => b.at.localeCompare(a.at));

  return {
    as_of: await asOf(),
    today,
    rows,
    execution: [...exec.values()].sort((a, b) => b.items.length - a.items.length),
    consolidations,
    records,
    briefs,
    waits: 'Sending a brief on WhatsApp, the owner’s voice notes and their AI reading need the logistics app’s own keys, which masterapp does not hold — they wait for the switch-over. A decision, a collector or a status is written on the record’s page.',
  };
}

const TONE = { DECISION_NEEDED: 'warn', SENT_TO_OWNER: 'warn', VOICE_RECEIVED: 'warn', AI_PROCESSING: 'warn', NEEDS_CLARIFICATION: 'warn', AWAITING_CONFIRMATION: 'warn', APPROVED: 'move', IN_EXECUTION: 'move', HOLD: 'warn', COMPLETED: 'good', NOT_ASKED: '' };

/**
 * What this page knows about one watch, for its Inventory card and its page:
 * "Owner: <what was decided>, <status>" — for a watch still incoming (the
 * app's live incomings). A watch already arrived or in stock has nothing
 * left to decide, as in the app; a decision record whose incoming is gone
 * still says what it said.
 */
export function forStock(stockNo, rows) {
  const sn = String(stockNo).trim();
  const incs = rows.filter((r) => r.kind === 'incomings' && text(r.data?.stockNumber) === sn);
  const ods = rows.filter((r) => r.kind === 'ownerDecisions');
  const live = incs.filter((r) => !historic(r.data || {}));
  const out = [];
  const seen = new Set();
  const line = (inc, od) => {
    const status = statusOf(inc || {}, od);
    if (status === 'NOT_ASKED') return;
    const words = od ? describe(od) : '';
    out.push({ text: `Owner: ${words ? `${words}, ${(STATUS[status] || status).toLowerCase()}` : STATUS[status] || status}`, link: '#/logistics/ownerdecisions', tone: TONE[status] ?? '' });
  };
  for (const r of live) {
    const d = r.data || {};
    const odRow = d.ownerDecisionId ? ods.find((o) => o.source_id === String(d.ownerDecisionId)) : null;
    if (odRow) seen.add(odRow.id);
    line(d, odRow ? odRow.data || {} : null);
  }
  // A decision with no live incoming behind it (the incoming arrived, or is gone): its last word, once it has one.
  if (!live.length) {
    for (const o of ods) {
      if (seen.has(o.id) || incs.some((r) => r.data?.ownerDecisionId === o.source_id && historic(r.data || {}))) continue;
      line(null, o.data || {});
    }
  }
  return out;
}
