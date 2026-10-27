/*
 * The Owner Decisions buttons (the logistics app's Owner Decision Center,
 * its buttons done here — src/logistics/actions/decisions.js), drawn by
 * lg/ownerdecisions.js where the app has them: a card's Start / Done /
 * Decision / status, an execution group's Create collection / Assign
 * collector / Mark arranged, the brief drawer's Mark as sent. The actions
 * take the INCOMING's id (the app's odSet does: the decision record is made
 * the moment it is first needed).
 */
'use strict';

/* The app's OwnerDecisionCard buttons: Start when approved, Done when in execution, Decision, and the ••• menu's statuses. */
function lgOdCardActs(i) {
  if (!can('editor')) return '';
  const small = (key, label) => lgActBtn(key, i.id, { label, cls: 'small' });
  return [i.status === 'APPROVED' ? small('od-start', 'Start') : '', i.status === 'IN_EXECUTION' ? small('od-done', 'Done') : '', small('od-decide', 'Decision'), small('od-status', 'Status')].filter(Boolean).join('');
}

/* The app's execution-queue buttons on a group (place → destination, collector). */
function lgOdGroupActs(g) {
  if (!can('editor')) return '';
  const extra = { from: g.from, to: g.to, collector: g.collector || '' };
  return `<div class="lg-rowacts od-route-acts">${lgActBtn('inc-collect', null, { label: 'Create collection', cls: 'primary', extra })}${lgActBtn('od-assign', null, { label: g.collector ? 'Change collector' : 'Assign collector', extra })}${lgActBtn('od-arranged', null, { label: 'Mark arranged', extra })}</div>`;
}

/* The brief drawer's send, as "Mark as sent": the brief's options go with it so the server builds the same text. */
function lgOdBriefSentBtn(brief, n) {
  if (!can('editor') || !n) return '';
  const extra = {
    pick: brief.pick,
    picked: [...brief.picked].join('|'),
    group: brief.group,
    fields: Object.entries(brief.fields)
      .filter(([, on]) => on)
      .map(([k]) => k)
      .join(','),
    sent: brief.includeSent ? '1' : '0',
  };
  return lgActBtn('od-brief', null, { label: 'Mark as sent', extra });
}
