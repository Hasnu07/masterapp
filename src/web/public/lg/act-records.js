/*
 * The "records" actions' buttons on the tabs drawn in logistics.js. The
 * Clients tab's page-level buttons (Add client, Add company location) are
 * drawn by lgActionBar('contacts') from the catalog; a client row's edit /
 * delete are offered here for the day the tab calls lgRowActs per row (the
 * client's own page already shows them). The other pages of this domain —
 * Companies, Shipment Documents, Other Receiving Pics, Watch Vault Activity
 * — draw their own buttons (lg/<page>.js). The actions live in
 * src/logistics/actions/records.js.
 */
'use strict';

LG_ROW_ACTIONS.contacts = (c) => {
  const html = [lgActBtn('cl-edit', c.id), lgActBtn('cl-delete', c.id)].filter(Boolean).join('');
  return html ? `<div class="lg-rowacts">${html}</div>` : '';
};
