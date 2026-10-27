/*
 * The "movers" actions' buttons on the 3rd Party Movers tab (drawn in
 * logistics.js, which calls lgRowActs('movers', …) in a mover's row and in
 * a mover shipment's row): the app's ✏️ / 🗑️ on a mover; on a shipment its
 * 💚 (payable by us or not), ✏️, 🗑️, the modal's Payment and Status boxes
 * on their own, and the documents / photos controls (lgUploadCtl, in
 * act-shipping.js, loaded before this file). The page's + Add Mover,
 * + Add Shipment, Import CSV and the two templates come from the catalog by
 * themselves (page: 'movers').
 */
'use strict';

LG_ROW_ACTIONS.movers = (row) => {
  let b = [];
  if (row.kind === 'thirdPartyMovers') {
    b = [lgActBtn('tpm-mover-edit', row.id, { label: 'Edit', cls: 'small' }), lgActBtn('tpm-mover-delete', row.id, { label: 'Delete', cls: 'small' })];
  } else if (row.kind === 'thirdPartyShipments') {
    b = [
      lgActBtn('tpm-payment', row.id, { label: 'Payment', cls: 'small' }),
      lgActBtn('tpm-status', row.id, { label: 'Status', cls: 'small' }),
      lgActBtn('tpm-not-payable', row.id, { label: row.not_payable ? 'Payable by us' : 'Not payable by us', cls: 'small' }),
      lgActBtn('tpm-edit', row.id, { label: 'Edit', cls: 'small' }),
      lgActBtn('tpm-delete', row.id, { label: 'Delete', cls: 'small' }),
      lgUploadCtl(row.id, 'shippingDocuments', 'Add documents'),
      lgUploadCtl(row.id, 'photos', 'Add photos'),
    ];
  }
  const html = b.filter(Boolean).join('');
  return html ? `<div class="lg-rowacts">${html}</div>` : '';
};
