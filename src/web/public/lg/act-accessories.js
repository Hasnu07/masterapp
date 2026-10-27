/*
 * The "accessories" actions' buttons on the tabs drawn in logistics.js —
 * Transactions, Accessories Management, In Safe — and the one upload control
 * every page of this domain uses for a record's pictures or documents (a
 * settlement's proof photos, a to-collect entry's pictures, a shipment
 * document's file): a file input posting multipart to
 * /api/logistics/items/<id>/files?field=<list>, the console's own headers.
 * The actions themselves live in src/logistics/actions/accessories.js.
 */
'use strict';

const lgRowActsWrap = (...btns) => {
  const html = btns.filter(Boolean).join('');
  return html ? `<div class="lg-rowacts">${html}</div>` : '';
};

/*
 * "Add photos" — a button that is a file input. `then: 'doc-attach'` makes
 * the uploaded file THE document's file (the app's record holds one fileUrl).
 */
function lgUploadCtl(id, field, label = 'Add photos', { multiple = true, then = '', accept = 'image/*,application/pdf' } = {}) {
  if (!can('editor')) return '';
  return `<label class="btn small lg-upload"><span>${esc(label)}</span><input type="file" data-upload="${esc(id)}" data-field="${esc(field)}"${then ? ` data-then="${esc(then)}"` : ''} accept="${esc(accept)}"${multiple ? ' multiple' : ''}></label>`;
}
document.getElementById('app').addEventListener('change', async (e) => {
  const inp = e.target.closest('input[type=file][data-upload]');
  if (!inp || !inp.files?.length) return;
  const files = [...inp.files];
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const wrap = inp.closest('label');
  wrap?.classList.add('busy');
  try {
    const r = await api(`/api/logistics/items/${encodeURIComponent(inp.dataset.upload)}/files?field=${encodeURIComponent(inp.dataset.field)}`, { method: 'POST', body: fd });
    if (inp.dataset.then === 'doc-attach' && r.files?.length) {
      const f = files[files.length - 1];
      await api(`/api/logistics/items/${encodeURIComponent(inp.dataset.upload)}/act/doc-attach`, { method: 'POST', body: { ref: r.files[r.files.length - 1], name: f.name, type: f.type } });
    }
    flash(`${r.added} file${r.added === 1 ? '' : 's'} added`);
    route();
  } catch (err) {
    flash(err.message, true);
    wrap?.classList.remove('busy');
    inp.value = '';
  }
});

/* The Accessories Management tab: the app's "+ New Transaction" sits there too (Add to collect / Add to give are the tab's own). */
LG_ACTION_BARS.accessories = () => lgActBtn('tx-new');

/* A transaction's row on the Transactions tab: settle, add an accessory, edit, delete. */
LG_ROW_ACTIONS.transactions = (t) => lgRowActsWrap(t.pending ? lgActBtn('tx-settle', t.id) : '', lgActBtn('tx-item-add', t.id), lgActBtn('tx-edit', t.id), lgActBtn('tx-delete', t.id));
/* A pending-item row on the Accessories tab (the transaction's id): settle, add an accessory. */
LG_ROW_ACTIONS.accessories = (x) => lgRowActsWrap(lgActBtn('tx-settle', x.id), lgActBtn('tx-item-add', x.id));
/* The Shipments tab's "Need to give and collect": a to-collect row (the accCollect record) and a to-give row (the accGive record). */
LG_ROW_ACTIONS['shipments-collect'] = (x) => lgRowActsWrap(lgActBtn('acc-collect-done', x.id), lgActBtn('acc-collect-edit', x.id), lgActBtn('acc-collect-delete', x.id));
LG_ROW_ACTIONS['shipments-give'] = (x) => lgRowActsWrap(lgActBtn('acc-give-done', x.id), lgActBtn('acc-give-edit', x.id), lgActBtn('acc-give-delete', x.id));
/* The In Safe tab's accessory rows (a to-give entry in the safe): mark given, edit — the safe's watch rows are another module's, kept. */
{
  const prev = LG_ROW_ACTIONS.safe;
  LG_ROW_ACTIONS.safe = (row) => (row.kind === 'accGive' ? lgRowActsWrap(lgActBtn('acc-give-done', row.id), lgActBtn('acc-give-edit', row.id)) : prev ? prev(row) : '');
}
