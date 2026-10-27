/*
 * The "dubai" actions' helpers for the Driver Deliveries, Pickup Codes,
 * Logistics Addresses and Gold Souk pages (lg/<page>.js draws its own
 * buttons with lgActBtn): adding pictures to a record through the files
 * route, and the WhatsApp texts the app builds (openDdWhatsApp,
 * openGsWhatsApp) — the bridge is not here, so they are copied. Loaded after
 * logistics.js and the pages: $, api, esc, flash and route are theirs.
 */
'use strict';

/* A button that picks pictures (or PDFs) and adds them to the record's named list — "lgfile:<id>" each, as the sync keeps the app's. */
const lgFilesBtn = (id, field, label) =>
  can('editor') ? `<label class="btn small lg-upl">${esc(label)}<input type="file" multiple accept="image/*,application/pdf" data-upl="${id}" data-field="${esc(field)}"></label>` : '';
document.getElementById('app').addEventListener('change', async (e) => {
  const input = e.target.closest('input[data-upl]');
  if (!input || !input.files?.length) return;
  const fd = new FormData();
  for (const f of input.files) fd.append('files', f);
  const lab = input.closest('label');
  const was = lab?.firstChild?.textContent;
  if (lab?.firstChild) lab.firstChild.textContent = 'Adding…';
  try {
    const r = await api(`/api/logistics/items/${input.dataset.upl}/files?field=${encodeURIComponent(input.dataset.field)}`, { method: 'POST', body: fd });
    flash(`${r.added} picture${r.added === 1 ? '' : 's'} added`);
    route();
  } catch (err) {
    flash(err.message, true);
    if (lab?.firstChild && was) lab.firstChild.textContent = was;
  }
});

/* A button that copies a text the app would have sent by WhatsApp. */
const lgCopyBtn = (text, label = 'Copy WhatsApp text') => `<button type="button" class="btn small" data-wa="${esc(text)}">${esc(label)}</button>`;
document.getElementById('app').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-wa]');
  if (!b) return;
  const was = b.textContent;
  navigator.clipboard?.writeText(b.dataset.wa).then(
    () => {
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = was), 1500);
    },
    () => flash('Could not copy — open the record and copy by hand.', true)
  );
});

/* The app's openDdWhatsApp: the message for a watch out with a driver, or delivered. */
function ddWhatsAppText(x) {
  const delivered = x.status === 'delivered';
  let msg = delivered ? '✅ Driver Delivery Confirmation\n' : '🛵 Watch Out with Driver\n';
  msg += `📦 Stock: ${x.stock_text}`;
  if (x.driver) msg += `\n👤 Driver: ${x.driver}`;
  if (x.date_given) msg += `\n📅 Date given: ${x.date_given}`;
  if (delivered) {
    if (x.delivered_date) msg += `\n✅ Delivered: ${x.delivered_date}`;
    if (x.delivered_to) msg += `\n👤 Delivered to: ${x.delivered_to}`;
    if (x.delivery_location) msg += `\n📍 Location: ${x.delivery_location}`;
    if (x.money) msg += `\n💰 Money collected: ${x.money.currency} ${Number(x.money.amount).toLocaleString()}`;
    if (x.delivery_notes) msg += `\n📝 Notes: ${x.delivery_notes}`;
  } else {
    if (x.destination) msg += `\n📍 Destination: ${x.destination}`;
    if (x.notes) msg += `\n📝 Notes: ${x.notes}`;
  }
  const photos = delivered ? x.delivery_photos : x.given_photos;
  if (photos.length) msg += `\n📸 ${photos.length} photo${photos.length > 1 ? 's' : ''} will follow`;
  return msg;
}

/* The app's openGsWhatsApp: the message for a gold souk task. */
function gsWhatsAppText(t) {
  let msg = '🏅 Gold Souk Delivery\n';
  msg += `📦 Shop: ${t.shop}`;
  if (t.who) msg += `\n👤 Delivered by: ${t.who}`;
  if (t.date) msg += `\n📅 Date: ${t.date}`;
  if (t.taking) msg += `\n📋 Took: ${t.taking}`;
  const notes = t.result_notes || t.notes;
  if (notes) msg += `\n📝 Notes: ${notes}`;
  const n = t.result_photos.length + t.photos.length;
  if (n) msg += `\n📸 ${n} photo${n > 1 ? 's' : ''} will follow`;
  return msg;
}
