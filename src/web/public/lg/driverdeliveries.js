/*
 * Driver Deliveries: the logistics app's "Driver Deliveries" page — watches
 * handed to a driver to deliver and to collect money. Its three figures (out
 * with drivers, delivered, money collected in dollars), then Out with driver
 * and Delivered history, as the app lays them out. Every stock number is OUR
 * watch, with the client it was sold to; the driver and the person it went
 * to link as far as their names go. Giving to a driver, marking delivered
 * (and returned), the photos and deleting are the app's own workflows done
 * here (actions dd-…); the WhatsApp message is built as the app builds it,
 * to copy — its bridge is not here. A row opens its record.
 */
'use strict';
const dd = { q: '', data: null };

LG_PAGES.driverdeliveries = async function () {
  const seq = ++lgPage;
  dd.data = null;
  $('#app').innerHTML = `${lgHeader('driverdeliveries')}
    <p class="sub" style="margin:0 0 12px">Watches handed to a driver to deliver and to collect money. Each stock number is our watch, linked to the client it was sold to.</p>
    <div class="ov-tiles dd-tiles" id="dd-tiles" aria-live="polite"></div>
    ${lgActionBar('driverdeliveries')}
    <div class="lg-toolbar dd-toolbar">
      <input class="q" type="search" id="ddq" placeholder="Stock number, driver, destination, notes…" value="${esc(dd.q)}" aria-label="Search driver deliveries">
    </div>
    <div class="count" id="dd-count">Reading the driver deliveries…</div>
    <div id="dd-out"></div>
    <p class="count dd-wait">WhatsApp is not sent from here: "Copy WhatsApp text" gives the message as the app would send it. Open a row to edit its record. <a href="#/logistics/driverdeliveries-all">The records, as lists</a>.</p>`;
  let timer;
  $('#ddq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      dd.q = e.target.value;
      drawDriverDeliveries();
    }, 150);
  });
  lgOpenOnClick($('#dd-out'));
  let r;
  try {
    r = await api('/api/logistics/page/driverdeliveries');
  } catch (err) {
    if (seq === lgPage && $('#dd-count')) $('#dd-count').textContent = `Could not read the driver deliveries: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#dd-out')) return;
  dd.data = r;
  drawDriverDeliveries();
};

/* A stock number is digits ("1285", "1617."); "3Aug" or "DAV Links" is words. */
const ddIsNo = (s) => /^\d{2,}[a-z.]?$/i.test(s);
/* Each number as typed: our watch with its status and the client it was sold to (or bought from); words that are no watch stay words. */
function ddStocks(x) {
  if (!x.stocks.length) return `<span class="blank">${esc(x.stock_text && x.stock_text !== '-' ? x.stock_text : '—')}</span>`;
  return x.stocks
    .map((s) => {
      const o = s.watch;
      if (!o) return `<div class="lg-stock">${ddIsNo(s.no) ? `#${esc(s.no)} <span class="count" style="margin:0;font-weight:400">not one of ours</span>` : esc(s.no)}</div>`;
      return `<div class="dd-ours"><a href="#/watch/${o.id}" class="lg-stock">#${esc(o.stock_no)}</a> ${chip(o.status)}<div class="count" style="margin:2px 0 0">${esc(o.title || [o.brand, o.model].filter(Boolean).join(' '))}</div>${
        o.sold_to ? `<div class="count" style="margin:0">Sold to <a href="#/client/${o.sold_to.id}"><b>${esc(o.sold_to.name)}</b></a></div>` : o.bought_from ? `<div class="count" style="margin:0">Bought from <a href="#/client/${o.bought_from.id}"><b>${esc(o.bought_from.name)}</b></a></div>` : ''
      }</div>`;
    })
    .join('');
}
/* The pictures masterapp holds, as thumbnails; one the app kept elsewhere, as a link. */
function ddPhotos(list) {
  if (!list.length) return '<span class="blank">—</span>';
  return `<div class="dd-pics">${list
    .map((p, i) =>
      p.file
        ? `<a href="${esc(fileUrl(p.file))}" target="_blank" rel="noopener"><img src="${esc(fileUrl(p.file, true))}" alt="Photo ${i + 1}" loading="lazy"></a>`
        : `<a href="${esc(p.url)}" target="_blank" rel="noopener" class="dd-ext" title="On the logistics app's own storage">Photo ${i + 1} ↗</a>`
    )
    .join('')}</div>`;
}
const ddMoney = (m) => (m ? money(m.amount, m.currency || '') : '<span class="blank">—</span>');

function drawDriverDeliveries() {
  const r = dd.data;
  if (!r || !$('#dd-out')) return;
  const cur = Object.entries(r.money.by_currency);
  const usd = r.money.usd === null ? '—' : `$${Number(r.money.usd).toLocaleString('en-GB')}`;
  $('#dd-tiles').innerHTML = `
    <div class="panel ov-tile warn"><span class="ov-tile-label">Out with drivers</span><b>${r.counts.out}</b></div>
    <div class="panel ov-tile good"><span class="ov-tile-label">Delivered</span><b>${r.counts.delivered}</b></div>
    <div class="panel ov-tile"><span class="ov-tile-label">Money collected (USD)</span><b>${esc(usd)}</b><small>${
      cur.length
        ? `${cur.map(([c, a]) => money(a, c === 'OTHER' ? '' : c, { plain: true })).join(' · ')}${r.money.rates ? ` · at the converter's ${esc(r.money.rates.kind)} rates${r.money.rates.stale ? ' (not fresh)' : ''}` : ' · no rates yet'}${
            r.money.missing.length ? ` · no rate for ${esc(r.money.missing.join(', '))}` : ''
          }`
        : 'nothing collected yet'
    }</small></div>`;

  const words = dd.q.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (x) =>
    sfMatch(words, x.stock_text, ...x.stocks.map((s) => s.watch?.title || ''), x.driver, x.destination, x.notes, x.delivered_to, x.delivery_location, x.delivery_notes, x.money && `${x.money.currency} ${x.money.amount}`, x.date_given, x.delivered_date);
  const out = r.out.filter(match);
  const done = r.delivered.filter(match);
  $('#dd-count').textContent = words.length ? `${out.length + done.length} of ${r.out.length + r.delivered.length} deliveries match` : `${r.out.length} out with a driver · ${r.delivered.length} delivered`;

  const driver = (x) => `<span class="lg-tag">${lgPerson(x.driver, x.driver_link, '—')}</span>`;
  // The app's row buttons: ✅ Delivered, 📱 (the message), 🗑️ — and the photos, which its dialogs take.
  const outActs = (x) => `<div class="lg-rowacts">${lgActBtn('dd-deliver', x.id)}${lgActBtn('dd-return', x.id)}${lgFilesBtn(x.id, 'givenPhotos', 'Add handover photos')}${lgCopyBtn(ddWhatsAppText(x))}${lgActBtn('dd-delete', x.id)}</div>`;
  const doneActs = (x) => `<div class="lg-rowacts">${lgFilesBtn(x.id, 'deliveryPhotos', 'Add proof photos')}${lgCopyBtn(ddWhatsAppText(x))}${lgActBtn('dd-delete', x.id)}</div>`;
  const outRows = out.length
    ? `<div class="tscroll"><table class="list lg dd-table"><thead><tr><th>Stock</th><th>Driver</th><th>Given</th><th>Destination</th><th>Notes</th><th>Photos</th><th></th></tr></thead><tbody>${out
        .map(
          (x) => `<tr data-id="${x.id}" tabindex="0">
            <td>${ddStocks(x)}</td>
            <td>${driver(x)}${x.status_word !== 'out' ? ` ${lgChip(x.status_word)}` : ''}</td>
            <td style="white-space:nowrap">${esc(sfDay(x.date_given) || '—')}</td>
            <td>${lgPerson(x.destination, x.destination_link, '—')}</td>
            <td class="dd-notes">${esc(x.notes)}</td>
            <td>${ddPhotos(x.given_photos)}</td>
            <td class="dd-acts">${outActs(x)}</td>
          </tr>`
        )
        .join('')}</tbody></table></div>`
    : `<p class="sub" style="margin:0">${words.length ? 'Nothing out with a driver matches.' : 'Nothing is out with a driver.'}</p>`;
  const doneRows = done.length
    ? `<div class="tscroll"><table class="list lg dd-table"><thead><tr><th>Stock</th><th>Driver</th><th>Delivered to</th><th>Where</th><th>Delivered</th><th>Money collected</th><th>Photos</th><th></th></tr></thead><tbody>${done
        .map(
          (x) => `<tr data-id="${x.id}" tabindex="0">
            <td>${ddStocks(x)}${x.notes ? `<div class="count dd-notes" style="margin:4px 0 0">${esc(x.notes)}</div>` : ''}</td>
            <td>${driver(x)}</td>
            <td>${lgPerson(x.delivered_to, x.delivered_to_link, '—')}</td>
            <td>${esc(x.delivery_location || '—')}</td>
            <td style="white-space:nowrap">${esc(sfDay(x.delivered_date) || '—')}${x.date_given ? `<div class="count" style="margin:2px 0 0">given ${esc(sfDay(x.date_given))}</div>` : ''}</td>
            <td style="white-space:nowrap">${ddMoney(x.money)}${x.delivery_notes ? `<div class="count dd-notes" style="margin:2px 0 0;white-space:normal">${esc(x.delivery_notes)}</div>` : ''}</td>
            <td>${ddPhotos(x.delivery_photos)}${x.given_photos.length ? `<div class="count" style="margin:4px 0 0">at the handover</div>${ddPhotos(x.given_photos)}` : ''}</td>
            <td class="dd-acts">${doneActs(x)}</td>
          </tr>`
        )
        .join('')}</tbody></table></div>`
    : `<p class="sub" style="margin:0">${words.length ? 'No delivered one matches.' : 'No delivery completed yet.'}</p>`;
  $('#dd-out').innerHTML = `
    <section class="panel dd-panel warn"><h2 class="dd-h">Out with driver <span class="count" style="margin:0">${out.length}</span></h2>${outRows}</section>
    <section class="panel dd-panel good"><h2 class="dd-h">Delivered history <span class="count" style="margin:0">${done.length}</span></h2>${doneRows}</section>`;
}
