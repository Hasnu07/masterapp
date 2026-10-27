/*
 * The "stock" actions' buttons on the two tabs drawn in logistics.js — In
 * Safe and Checkout — and the helpers the stock-by-place pages
 * (lg/londonstock.js, shared by Dubai and HK) use for theirs: a row's
 * buttons in a .lg-rowacts strip, and the Polish dialog that reuses the one
 * polish endpoint (POST /api/logistics/items/:id/polish — the app's Send /
 * Done) rather than rebuilding it. The actions themselves live in
 * src/logistics/actions/stock.js.
 */
'use strict';

/* A row's buttons, in the strip every tab draws them in; nothing when the viewer may not act. */
const stRowActs = (...btns) => {
  const html = btns.filter(Boolean).join(' ');
  return html ? `<div class="lg-rowacts">${html}</div>` : '';
};

/* The app's Polish button: Send (who, from when, back when, the cost → a cost line) or Done (back on which day). */
function stPolishDialog(id, atPolish) {
  if (!can('editor')) return;
  const d = atPolish
    ? { label: 'Polish done', form: [{ key: 'returnedDate', label: 'Back on', type: 'date' }, { key: 'returnNotes', label: 'Notes', type: 'longtext' }], values: { returnedDate: localDay() } }
    : {
        label: 'Send to polish',
        form: [
          { key: 'sentTo', label: 'Sent to', type: 'text', required: true },
          { key: 'takenBy', label: 'Taken by', type: 'text' },
          { key: 'itemDescription', label: 'What goes', type: 'text', hint: 'blank = Full Watch' },
          { key: 'sentDate', label: 'Sent', type: 'date' },
          { key: 'expectedBack', label: 'Expected back', type: 'date' },
          { key: 'costAmount', label: 'Cost', type: 'money', currency: 'costCurrency' },
          { key: 'costCurrency', label: 'Cost currency', type: 'currency' },
          { key: 'notes', label: 'Notes', type: 'longtext' },
        ],
        values: { sentDate: localDay(), costCurrency: 'AED' },
      };
  lgDialog(d, async (input, dlg) => {
    try {
      await api(`/api/logistics/items/${id}/polish`, { method: 'POST', body: { action: atPolish ? 'done' : 'send', ...input } });
      dlg?.close();
      flash(atPolish ? 'Back from polish' : 'Sent to polish');
      route();
    } catch (err) {
      const e = dlg?.querySelector('.err');
      if (e) e.textContent = err.message;
      else flash(err.message, 'err');
    }
  });
}
const stPolishBtn = (row) => (can('editor') && row.status !== 'moved' ? `<button type="button" class="btn" data-polish="${row.polish ? 'done' : 'send'}" data-id="${row.id}">${row.polish ? 'Polish done' : 'Send to polish'}</button>` : '');
document.getElementById('app').addEventListener('click', (e) => {
  const b = e.target.closest('[data-polish]');
  if (!b) return;
  e.preventDefault();
  stPolishDialog(Number(b.dataset.id), b.dataset.polish === 'done');
});

/* A stock row's buttons, as the app's card has them: Move, Sold (cons-sold), Checkout, Consign / back (cons-*), Polish, the Vault switch, a note, Delete. */
function stStockRowActs(row, kind) {
  const safe = kind === 'safeStock';
  const consigns = kind === 'londonStock' || kind === 'dubaiStock';
  if (row.status === 'moved') return stRowActs(lgActBtn('stock-move-back', row.id), lgActBtn('stock-delete', row.id));
  return stRowActs(
    lgActBtn('stock-move', row.id, { cls: 'primary' }),
    safe ? lgActBtn('stock-safe-give', row.id) : '',
    safe ? '' : lgActBtn('cons-sold', row.id),
    safe ? '' : lgActBtn('stock-checkout', row.id),
    // Consignment is the sales domain's, for London and Dubai as the app's picker offers them.
    consigns ? (row.consignment ? lgActBtn('cons-edit', row.id) + ' ' + lgActBtn('cons-back', row.id) : lgActBtn('cons-consign', row.id)) : '',
    stPolishBtn(row),
    lgActBtn('stock-vault', row.id, { label: row.hidden_from_vault ? 'Show to Vault' : 'Hide from Vault' }),
    lgActBtn('stock-notes', row.id),
    row.watch ? `<a class="btn" href="#/watch/${row.watch.id}" title="What moving it cost, on our watch’s page">Cost</a>` : '',
    lgActBtn('stock-delete', row.id)
  );
}

/* In Safe: the toolbar's page actions come from the catalog (page 'safe'); a safe row gets the stock row's buttons. */
{
  const prev = LG_ROW_ACTIONS.safe;
  LG_ROW_ACTIONS.safe = (row) => (row.kind === 'safeStock' ? stStockRowActs({ ...row, status: row.status || 'current' }, 'safeStock') : prev ? prev(row) : '');
}
/* Checkout: the app's Return (the row goes back where it came from) and Delete. */
LG_ROW_ACTIONS.checkout = (row) => (row.kind === 'checkoutStock' ? stRowActs(lgActBtn('stock-checkout-return', row.id, { cls: 'primary' }), lgActBtn('stock-checkout-delete', row.id)) : '');
