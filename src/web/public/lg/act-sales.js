/*
 * The "sales" actions' buttons on the tabs drawn in logistics.js
 * (LG_ROW_ACTIONS): the Shipments tab's Ready for delivery rows — the app's
 * Ship Now / Mark Delivered / Keep in Safe / Cancel on each. Drawn where the
 * tab calls lgRowActs('ready', { ...row, kind: 'readyForDelivery' }) with
 * the readyForDelivery record's id. The Sold Stocks, In Consignment and
 * Refinement pages draw their own buttons (lg/soldstocks.js, consignment.js,
 * refinement.js).
 */
'use strict';

LG_ROW_ACTIONS.ready = (row) =>
  !row?.id || !can('editor')
    ? ''
    : `<div class="lg-rowacts">${[
        row.shipment ? '' : lgActBtn('sale-ship', row.id, { cls: 'small' }),
        lgActBtn('sale-handover', row.id, { cls: 'small primary' }),
        lgActBtn('sale-safe', row.id, { cls: 'small' }),
        lgActBtn('sale-cancel', row.id, { cls: 'small' }),
      ].join('')}</div>`;
