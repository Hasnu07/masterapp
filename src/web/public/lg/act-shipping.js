/*
 * The "shipping" actions' buttons on the Shipments tab (drawn in
 * logistics.js, which calls lgRowActs('shipments', …) on each card): the
 * app's card buttons and its "•••" menu — Add tracking / Mark shipped (the
 * one the app shows out in the open, by what the shipment needs), Mark
 * delivered, Edit, Mark pending, Cancel, Delete — and the document control
 * the app's modal has (shipping documents; delivery photos once delivered),
 * which posts to /api/logistics/items/:id/files?field=…. The page-level
 * "+ New Shipment" comes from the catalog by itself (page: 'shipments').
 * Tracking with the carrier stays as it is: read-only.
 */
'use strict';

/* The file control for a record's pictures / documents is lgUploadCtl in act-accessories.js (one for every tab). */

LG_ROW_ACTIONS.shipments = (row) => {
  // A sale waiting for delivery (when the tab hands those rows here): the app's "Create shipment" from Ready-for-delivery.
  if (row.kind === 'readyForDelivery') {
    const b = lgActBtn('ship-add', null, { label: 'Create shipment', cls: 'small', extra: { ready: row.id } });
    return b ? `<div class="lg-rowacts">${b}</div>` : '';
  }
  if (row.kind !== 'shipments') return '';
  const key = row.stage?.key || row.status || '';
  const status = row.status || '';
  const done = status === 'delivered' || status === 'cancelled' || key === 'delivered';
  const b = [];
  if (key === 'no_tracking' && !done) b.push(lgActBtn('ship-edit', row.id, { label: 'Add tracking', cls: 'primary small' }));
  if (!done && status === 'pending') b.push(lgActBtn('ship-shipped', row.id, { label: 'Mark shipped', cls: key === 'no_tracking' ? 'small' : 'primary small' }));
  if (!done) b.push(lgActBtn('ship-deliver', row.id, { cls: 'small' }));
  b.push(lgActBtn('ship-edit', row.id, { label: row.cost ? 'Edit' : 'Edit · add cost', cls: 'small' }));
  if (!done && status !== 'pending') b.push(lgActBtn('ship-pending', row.id, { cls: 'small' }));
  if (!done) b.push(lgActBtn('ship-cancel', row.id, { label: 'Cancel shipment', cls: 'small' }));
  b.push(lgActBtn('ship-delete', row.id, { cls: 'small' }));
  b.push(lgUploadCtl(row.id, 'shippingDocuments', 'Add documents'));
  if (status === 'delivered' || key === 'delivered') b.push(lgUploadCtl(row.id, 'deliveryPhotos', 'Add delivery photos'));
  const html = b.filter(Boolean).join('');
  return html ? `<div class="lg-rowacts">${html}</div>` : '';
};
