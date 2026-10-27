/*
 * The Incoming tab's buttons (the logistics app's Incomings page, its
 * buttons done here — src/logistics/actions/incoming.js). The bar's
 * page-level actions (Add incoming, Import CSV + Template, Plan collections,
 * Pick from Chrono Key, Ask owner) are drawn from the catalog by
 * lgActionBar('incoming'); here, each row's buttons — the app's row menu —
 * and the picked-from-Chrono-Key rows'.
 */
'use strict';

LG_ACTION_BARS.incoming = () => (can('editor') ? '<span class="count lg-actnote">Mark arrived, receive, sale: the app then opens a WhatsApp message — not sent from here.</span>' : '');

/* The app's incRowMenu: what an active row can do, and a finished one. */
LG_ROW_ACTIONS.incoming = (row) => {
  if (!can('editor')) return '';
  const id = row.id;
  const small = (key, label) => lgActBtn(key, id, { label, cls: 'small' });
  const acts =
    row.list === 'history'
      ? [row.received_at || row.status === 'arrived' ? small('inc-date', 'Date received') : '', small('inc-cost', 'Add cost'), small('inc-edit', 'Edit'), small('inc-delete', 'Delete')]
      : [
          small('inc-arrive', 'Arrived'),
          small('inc-receive', 'Receive'),
          row.shipped ? '' : small('inc-ship', 'Ship'),
          small('inc-sold', 'Sold'),
          small('inc-cost', 'Cost'),
          small('od-decide', 'Owner decision'),
          small('inc-edit', 'Edit'),
          small('inc-cancel', 'Cancel'),
          small('inc-delete', 'Delete'),
        ];
  const html = acts.filter(Boolean).join('');
  // The app's row has a ••• menu: here a disclosure, closed until wanted, so the row stays a row.
  return html ? `<details class="lg-rowmenu"><summary class="btn small" aria-label="Actions for #${esc(row.stock_no || '')}">Actions</summary><div class="lg-rowacts">${html}</div></details>` : '';
};

/* The menu's summary opens the menu, not the row (the row opens its record on a click anywhere else in it). */
document.getElementById('app').addEventListener(
  'click',
  (e) => {
    if (e.target.closest('.lg-rowmenu > summary')) e.stopPropagation();
  },
  true
);

/* The "Picked from Chrono Key" rows: the app's ➕ Add and ✕ (wanted: lgRowActs('incoming-fob', x) in each row). */
LG_ROW_ACTIONS['incoming-fob'] = (row) => {
  if (!can('editor')) return '';
  return `<div class="lg-rowacts">${lgActBtn('inc-fob-send', row.id, { label: 'Send to Incomings', cls: 'small' })}${lgActBtn('inc-fob-drop', row.id, { label: 'Remove', cls: 'small' })}</div>`;
};
