/*
 * The "plans" actions' buttons on the tabs drawn in logistics.js: Hand carry
 * (the app's tab-kashan) and Movement (tab-movement). Page-level actions
 * (New plan, Add trip) come from the catalog by themselves; here are the
 * buttons of each open plan (the app's plan bar: Add Stop, Parse & Add, AI
 * Flights, Optimise, Send to Movements, Complete, Clear, Delete), of each
 * watch waiting for a plan (Assign / Unassign), and of each trip card (Add
 * expense, Add leg, Add watch, Allowance → expenses, Complete, Delete).
 * Loaded after logistics.js: lgActBtn, hc and pdAllowance are its.
 */
'use strict';

/* The open plans' buttons — one row per plan, as the app's bar is for the plan shown. */
function hcPlanActs(data) {
  const plans = (data?.plans || []).filter((p) => !p.completed);
  if (!plans.length || !can('editor')) return '';
  return plans
    .map(
      (p) => `<div class="hc-plan-acts"><span class="count" style="margin:0">${esc(p.name)}’s plan</span>
        ${lgActBtn('plan-stop-add', p.id)}${lgActBtn('plan-assign', p.id)}${lgActBtn('plan-parse', p.id)}${lgActBtn('plan-flights', p.id)}${lgActBtn('plan-optimise', p.id)}
        ${lgActBtn('plan-send', p.id)}${lgActBtn('plan-complete', p.id)}${lgActBtn('plan-rename', p.id)}${lgActBtn('plan-clear', p.id)}${lgActBtn('plan-delete', p.id)}</div>`
    )
    .join('');
}
/* Drawn empty before the plans are read; logistics.js draws the bar again with them (lgActionBar('handcarry', r)). */
LG_ACTION_BARS.handcarry = (data) => (data ? hcPlanActs(data) : '');

/* A watch waiting for a plan: assign it to an open plan's stop, or take it off the plan it is on. */
LG_ROW_ACTIONS.handcarry = (x) => {
  if (!x || !can('editor')) return '';
  // A watch on a stop (handCarry() names its plan, leg and entry): off the stop, or the stop itself edited / removed.
  if (x.plan_id && x.leg_id && x.item_id) {
    const part = x.role === 'deliver' ? 'delivery' : x.role === 'collect' ? 'collection' : 'stock';
    return `<div class="lg-rowacts">${lgActBtn('plan-unassign', x.plan_id, { extra: { item: `${x.leg_id}|${part}|${x.item_id}` } })}${lgActBtn('plan-stop-edit', x.plan_id, { extra: { leg: x.leg_id } })}${lgActBtn('plan-stop-remove', x.plan_id, { extra: { leg: x.leg_id } })}</div>`;
  }
  if (!x.kind || !x.id) return '';
  const item = `${x.kind}:${x.id}`;
  if (x.on_plan) return `<div class="lg-rowacts">${lgActBtn('plan-unassign', x.on_plan.id, { extra: { item } })}</div>`;
  const plans = (hc.data?.plans || []).filter((p) => !p.completed);
  if (!plans.length) return '';
  return `<div class="lg-rowacts">${plans.map((p) => lgActBtn('plan-assign', p.id, { label: plans.length > 1 ? `Assign to ${p.name}’s plan` : 'Assign to stop', extra: { item } })).join('')}</div>`;
};

/*
 * The travel allowance as the console works it out (the app's tripAllowance,
 * by the browser's clock — pdAllowance in logistics.js), as lines for the
 * record: by place (days, the rate, the first day) and the lines added by
 * hand — what the app's addAllowanceToTripCosts writes.
 */
function mvAllowanceLines(t) {
  const a = pdAllowance(t);
  const byPlace = new Map();
  for (const d of a.days) {
    const k = String(d.place || '').toLowerCase();
    const row = byPlace.get(k) || {
      place: d.place,
      days: 0,
      rate: d.rate || 0,
      amount: 0,
      first: d.date,
    };
    row.days++;
    row.amount += d.amount;
    if (!row.rate && d.rate) row.rate = d.rate;
    if (d.date && (!row.first || d.date < row.first)) row.first = d.date;
    byPlace.set(k, row);
  }
  return {
    currency: a.currency,
    start: t.start || '',
    byPlace: [...byPlace.values()].map((r) => ({
      ...r,
      amount: Math.round(r.amount * 100) / 100,
    })),
    extra: (t.extra || []).map((x) => ({ label: x.label, amount: x.amount })),
    total: a.total,
  };
}

LG_ROW_ACTIONS.trips = (t) => {
  if (!t || !t.id || !can('editor')) return '';
  const done = t.status === 'completed';
  let allowance = '';
  try {
    const a = pdAllowance(t);
    if (a.days.length && !a.added)
      allowance = lgActBtn('trip-allowance-add', t.id, {
        extra: { lines: JSON.stringify(mvAllowanceLines(t)) },
      });
    else if (a.added) allowance = lgActBtn('trip-allowance-remove', t.id);
  } catch {
    allowance = '';
  }
  return `<div class="lg-rowacts">${lgActBtn('trip-cost-add', t.id)}${lgActBtn('trip-leg-add', t.id)}${lgActBtn('trip-stock-add', t.id)}${allowance}${done ? '' : lgActBtn('trip-complete', t.id)}${lgActBtn('trip-delete', t.id)}</div>`;
};
