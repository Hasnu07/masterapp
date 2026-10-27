/*
 * Sold Stocks: the logistics app's "Sold Stocks" page in the console's look
 * — delivered sales with the app's P&L: revenue, every cost that moving the
 * watch took (its costsForStock, line for line), profit and margin, over the
 * sales shown, as the app sums its filtered rows. Dollars are worked out at
 * the converter's rates (the app's fixed table is kept only as a check); a
 * currency with no rate falls back to the app's figure and says so.
 *
 * Every sale is our watch — sold on Chrono Key too: our sale price and the
 * client it was sold to (by id) sit beside the app's typed buyer, who links
 * as far as the name goes. A row opened in place shows what the app's
 * detail modal shows; the full watch history is the watch's own page. Ready
 * for delivery is the Shipments tab's. Set the delivery date, send to polish,
 * hold in the safe, cancel the sale, delete: in the app until the
 * switch-over — a row opens its record.
 */
'use strict';
const ss = { q: '', brand: '', source: '', from: '', to: '', open: null, data: null };
const SS_SOURCES = [
  ['', 'All sources'],
  ['london', 'London'],
  ['dubai', 'Dubai'],
  ['hk', 'Hong Kong'],
  ['incomings', 'Incomings'],
];
const SS_VIA = { in_person: 'by hand', shipment: 'by shipment', held_in_safe: 'held in our safe' };

LG_PAGES.soldstocks = async function () {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('soldstocks')}
    <p class="sub">Delivered sales as the logistics app keeps them, with what moving each watch cost and what was left. Each is our watch, linked with the client it was sold to.</p>
    <div class="ov-tiles ss-tiles" id="ss-tiles"></div>
    <div class="ss-filters">
      <input class="q" type="search" id="ss-q" aria-label="Search sales" placeholder="Stock number, brand, model, buyer…" value="${esc(ss.q)}">
      <select id="ss-brand" aria-label="Brand"><option value="">All brands</option></select>
      <select id="ss-source" aria-label="Sold from">${SS_SOURCES.map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select>
      <label class="ss-date">From<input type="date" id="ss-from" value="${esc(ss.from)}"></label>
      <label class="ss-date">To<input type="date" id="ss-to" value="${esc(ss.to)}"></label>
      <button type="button" class="btn" id="ss-export">Export</button>
    </div>
    <div class="count" id="ss-count">Reading the sales…</div>
    <div id="ss-out"></div>
    <p class="count" id="ss-ready"></p>
    <p class="count">Setting the delivery date, sending to polish, holding in the safe, cancelling or deleting a sale is done in the logistics app until the switch-over — a row opens its sale; the record is one link further.</p>`;
  $('#ss-source').value = ss.source;
  let timer;
  $('#ss-q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      ss.q = e.target.value;
      drawSold();
    }, 150);
  });
  for (const [id, key] of [
    ['ss-brand', 'brand'],
    ['ss-source', 'source'],
    ['ss-from', 'from'],
    ['ss-to', 'to'],
  ]) {
    $(`#${id}`).addEventListener('change', (e) => {
      ss[key] = e.target.value;
      drawSold();
    });
  }
  $('#ss-export').addEventListener('click', ssExport);
  // A row opens its sale in place; a link inside goes where it says.
  const toggle = (e) => {
    const at = e.target.closest('tr[data-sale]');
    if (!at || e.target.closest('a, button')) return;
    if (e.type === 'keydown') {
      if (e.target !== at || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
    }
    ss.open = ss.open === at.dataset.sale ? null : at.dataset.sale;
    drawSold();
  };
  $('#ss-out').addEventListener('click', toggle);
  $('#ss-out').addEventListener('keydown', toggle);
  let r;
  try {
    r = await api('/api/logistics/page/soldstocks');
  } catch (err) {
    if (seq === lgPage && $('#ss-count')) $('#ss-count').textContent = `Could not read the sales: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#ss-out')) return;
  ss.data = r;
  const brands = [...new Set(r.rows.map((s) => s.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  $('#ss-brand').innerHTML = `<option value="">All brands</option>${brands.map((b) => `<option value="${esc(b)}"${b === ss.brand ? ' selected' : ''}>${esc(b)}</option>`).join('')}`;
  if (ss.brand && !brands.includes(ss.brand)) ss.brand = '';
  $('#ss-ready').innerHTML = r.ready_for_delivery
    ? `${r.ready_for_delivery} sold watch${r.ready_for_delivery === 1 ? '' : 'es'} still waiting for delivery — <a href="#/logistics/shipments">on the Shipments tab, under Ready for delivery</a>.`
    : 'Nothing sold is waiting for delivery.';
  drawSold();
};

/* An amount in dollars at the converter's rates; null when the currency has no rate. */
const ssUsd = (amount, cur) => {
  const t = ss.data?.rates?.table;
  if (!t || !t[cur] || !t.USD) return null;
  return (Number(amount) / t[cur]) * t.USD;
};
const ssDollars = (n) => `$${Number(n).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
/* A sale's figures: revenue (the app's own dollar figure when ours has no rate), its costs, what is left. */
function ssFigures(s) {
  let rev = ssUsd(s.price, s.currency);
  let appRate = false;
  if (rev === null) {
    rev = s.price_usd_app;
    appRate = true;
  }
  let cost = 0;
  const missing = new Set();
  for (const c of s.costs) {
    const u = ssUsd(c.amount, c.currency);
    if (u === null) missing.add(c.currency);
    else cost += u;
  }
  const profit = rev - cost;
  return { rev, cost, profit, margin: rev > 0 ? (profit / rev) * 100 : 0, appRate, missing: [...missing] };
}
function ssRows() {
  const r = ss.data;
  const words = ss.q.toLowerCase().split(/\s+/).filter(Boolean);
  return r.rows
    .filter((s) => !ss.brand || s.brand === ss.brand)
    .filter((s) => !ss.source || s.origin_key === ss.source)
    .filter((s) => !ss.from || (s.sold_date || '') >= ss.from)
    .filter((s) => !ss.to || (s.sold_date || '') <= ss.to)
    .filter((s) => sfMatch(words, s.stock_no, s.brand, s.model, s.reference, s.serial, s.buyer, s.notes, s.sold_from, s.watch?.sold_to?.name))
    .sort((a, b) => String(b.sold_date).localeCompare(String(a.sold_date)) || b.id - a.id);
}
const ssStock = (s) => (/\d/.test(s.stock_no) ? `#${s.stock_no}` : s.stock_no || '—');
const ssDelivered = (s) =>
  s.delivered_at ? `${esc(sfDay(s.delivered_at))}${s.delivered_via ? `<div class="count" style="margin:2px 0 0">${esc(SS_VIA[s.delivered_via] || s.delivered_via.replace(/_/g, ' '))}</div>` : ''}` : '<span class="blank">date not set</span>';
/* Our sale of the same watch on Chrono Key — by the stock number, our client by its id. */
const ssOurs = (s) => {
  const o = s.watch;
  if (!o) return '<span class="blank">Not one of our watches</span>';
  return [
    `<a href="#/watch/${o.id}">Our watch #${esc(o.stock_no)}</a> ${chip(o.status)}`,
    o.sale_price !== null && `Sold for <b>${money(o.sale_price, o.sale_currency)}</b>${o.sale_date ? ` on ${esc(dayWords(o.sale_date))}` : ''} on Chrono Key`,
    o.sold_to && `Sold to <a href="#/client/${o.sold_to.id}"><b>${esc(o.sold_to.name)}</b></a>`,
    o.bought_from && `Bought from <a href="#/client/${o.bought_from.id}"><b>${esc(o.bought_from.name)}</b></a>`,
  ]
    .filter(Boolean)
    .map((x) => `<div>${x}</div>`)
    .join('');
};

function drawSold() {
  const r = ss.data;
  if (!r || !$('#ss-out')) return;
  const rows = ssRows();
  const figs = new Map(rows.map((s) => [s.id, ssFigures(s)]));
  let rev = 0;
  let cost = 0;
  const byCur = {};
  const missing = new Set();
  let appRate = 0;
  for (const s of rows) {
    const f = figs.get(s.id);
    rev += f.rev;
    cost += f.cost;
    if (f.appRate) appRate += 1;
    f.missing.forEach((c) => missing.add(c));
    if (s.currency) byCur[s.currency] = (byCur[s.currency] || 0) + s.price;
  }
  const profit = rev - cost;
  const margin = rev > 0 ? (profit / rev) * 100 : 0;
  const rate = r.rates ? `${r.rates.kind} rates${r.rates.stale ? ' (not fresh)' : ''}` : 'no rates';
  const each = Object.entries(byCur)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => money(n, c))
    .join(' · ');
  $('#ss-tiles').innerHTML = `
    <div class="ov-tile good"><span class="ov-tile-label">Revenue</span><b>${ssDollars(rev)}</b><small>${rows.length} sale${rows.length === 1 ? '' : 's'} · ${esc(rate)}${appRate ? ` · ${appRate} at the app's rate` : ''}</small></div>
    <div class="ov-tile warn"><span class="ov-tile-label">Costs</span><b>${ssDollars(cost)}</b><small>${missing.size ? `no rate for ${esc([...missing].join(', '))} — left out` : 'moving, shipping, trips, purchases'}</small></div>
    <div class="ov-tile ${profit >= 0 ? 'good' : 'bad'}"><span class="ov-tile-label">${profit >= 0 ? 'Profit' : 'Loss'}</span><b>${ssDollars(profit)}</b><small>revenue less costs</small></div>
    <div class="ov-tile ${profit >= 0 ? 'good' : 'bad'}"><span class="ov-tile-label">Margin</span><b>${margin.toFixed(1)}%</b><small>of the revenue</small></div>`;
  const n = rows.length;
  const filtered = ss.q || ss.brand || ss.source || ss.from || ss.to;
  $('#ss-count').innerHTML = `${n} sale${n === 1 ? '' : 's'}${filtered ? ` of ${r.rows.length}` : ''}, newest first${each ? ` · sold for ${each}` : ''}`;
  if (!n) {
    $('#ss-out').innerHTML = `<div class="panel"><p class="ov-empty" style="border:0;padding:4px 0">${filtered ? 'No sale matches.' : 'No delivered sales in the logistics app yet.'}</p></div>`;
    return;
  }
  const row = (s) => {
    const f = figs.get(s.id);
    const open = ss.open === String(s.id);
    return `<tr data-sale="${s.id}" tabindex="0" class="ss-row${open ? ' on' : ''}" aria-expanded="${open}">
      <td class="ss-pic-cell">${s.picture ? `<img src="${esc(fileUrl(s.picture, true))}" alt="" loading="lazy">` : s.watch?.photo_id ? `<img src="/api/photos/${s.watch.photo_id}?thumb=1" alt="" loading="lazy">` : ''}</td>
      <td style="white-space:nowrap">${esc(dayWords(s.sold_date) || '—')}</td>
      <td style="white-space:nowrap">${ssDelivered(s)}</td>
      <td style="white-space:nowrap"><span class="lg-stock">${esc(ssStock(s))}</span></td>
      <td><b>${esc([s.brand, s.model].filter(Boolean).join(' ') || 'Watch')}</b>${s.reference ? `<div class="count" style="margin:2px 0 0">${esc(s.reference)}</div>` : ''}</td>
      <td>${esc(s.origin || '—')}</td>
      <td>${s.buyer ? lgPerson(s.buyer, s.buyer_link) : '<span class="blank">not written</span>'}${s.watch?.sold_to ? `<div class="count" style="margin:2px 0 0">our client <a href="#/client/${s.watch.sold_to.id}">${esc(s.watch.sold_to.name)}</a></div>` : ''}</td>
      <td class="num"><b>${money(s.price, s.currency || null)}</b>${s.currency !== 'USD' ? `<div class="count" style="margin:2px 0 0">${ssDollars(f.rev)}${f.appRate ? '*' : ''}</div>` : ''}</td>
      <td class="num">${f.cost ? ssDollars(f.cost) : '<span class="blank">—</span>'}</td>
      <td class="num ss-pl ${f.profit >= 0 ? 'good' : 'bad'}">${ssDollars(f.profit)}</td>
      <td class="ss-pl ${f.profit >= 0 ? 'good' : 'bad'}">${f.margin.toFixed(1)}%</td>
    </tr>${open ? `<tr class="ss-detail"><td colspan="11">${ssDetail(s, f)}</td></tr>` : ''}`;
  };
  $('#ss-out').innerHTML = `<div class="panel tscroll" style="padding:0"><table class="list lg ss-table"><thead><tr>
      <th></th><th>Sold</th><th>Delivered</th><th>Stock</th><th>Watch</th><th>From</th><th>Buyer</th><th class="num">Sold for</th><th class="num">Cost (USD)</th><th class="num">P&amp;L (USD)</th><th>Margin</th>
    </tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>`;
  // The table scrolls sideways; a sale opened under its row stays as wide as the window, not the table.
  const box = $('#ss-out .tscroll');
  if (box) box.style.setProperty('--ss-w', `${box.clientWidth - 2}px`);
  if (ss.open) $('.ss-detail')?.scrollIntoView({ block: 'nearest' });
}

/* A sale opened: what the app's detail modal shows, in the console's look. */
const SS_SOURCE_ORDER = ['Purchase', 'Shipment', 'Logistic cost', 'Trip (shared)'];
function ssDetail(s, f) {
  const tag = (list, cls) => list.map((a) => `<span class="lg-tag ${cls}">${esc(a)}</span>`).join(' ');
  const c = s.condition;
  const condition = c.watch_date || c.place || c.need_polish || c.present.length || c.missing.length;
  const bySource = {};
  for (const line of s.costs) (bySource[line.source] ||= []).push(line);
  const sources = Object.keys(bySource).sort((a, b) => SS_SOURCE_ORDER.indexOf(a) - SS_SOURCE_ORDER.indexOf(b));
  const sum = (lines) => lines.reduce((a, l) => a + (ssUsd(l.amount, l.currency) || 0), 0);
  const photos = [s.photos.sale && `${s.photos.sale} at the sale`, s.photos.before && `${s.photos.before} before`, s.photos.delivery && `${s.photos.delivery} at delivery`].filter(Boolean).join(' · ');
  return `<div class="ss-d">
    <div class="ss-d-head">
      <div>
        <div class="ss-d-title">${esc(ssStock(s))} · ${esc([s.brand, s.model].filter(Boolean).join(' '))}</div>
        <div class="count" style="margin:2px 0 0">${esc([s.reference && `Ref ${s.reference}`, s.serial && `Serial ${s.serial}`, s.watch_date && `Watch date ${s.watch_date}`].filter(Boolean).join(' · '))}</div>
        <div style="margin-top:4px">Sold from <b>${esc(s.sold_from || s.origin || '—')}</b>${s.buyer ? ` to <b>${lgPerson(s.buyer, s.buyer_link)}</b>` : ''} on ${esc(dayWords(s.sold_date) || '—')}${
          s.delivered_at ? ` · delivered ${esc(SS_VIA[s.delivered_via] || '')} ${esc(sfDay(s.delivered_at))}` : ' · <span class="ov-warn-text">delivery date not set</span>'
        }${s.shipment_item_id ? ` · <a href="#/lg/${s.shipment_item_id}">its shipment</a>` : ''}</div>
        ${s.delivery_notes ? `<div class="count" style="margin:2px 0 0">Delivery: ${esc(s.delivery_notes)}</div>` : ''}
      </div>
      <div class="ss-d-price"><span class="count" style="margin:0">Sold for</span><b>${money(s.price, s.currency || null)}</b>${s.currency !== 'USD' ? `<span class="count" style="margin:0">${ssDollars(f.rev)}${f.appRate ? ' at the app’s own rate' : ''}</span>` : ''}</div>
    </div>
    <div class="ss-d-ours">${ssOurs(s)}</div>
    ${
      condition
        ? `<div class="ss-d-box"><h3>Watch condition at sale</h3><div class="ss-d-cond">${[
            c.watch_date && `<span>Watch date <b>${esc(c.watch_date)}</b></span>`,
            c.place && `<span>Was in <b>${esc(c.place)}</b></span>`,
            c.need_polish && '<span class="lg-tag warn">Needed polish</span>',
          ]
            .filter(Boolean)
            .join('')}</div>
          ${c.present.length ? `<div class="ss-d-acc"><span class="count" style="margin:0">With it</span> ${tag(c.present, 'good')}</div>` : ''}
          ${c.missing.length ? `<div class="ss-d-acc"><span class="count" style="margin:0">Missing</span> ${tag(c.missing, 'problem')}</div>` : ''}</div>`
        : ''
    }
    <div class="ov-tiles ss-tiles ss-d-tiles">
      <div class="ov-tile good"><span class="ov-tile-label">Revenue</span><b>${ssDollars(f.rev)}</b></div>
      <div class="ov-tile warn"><span class="ov-tile-label">Costs</span><b>${ssDollars(f.cost)}</b>${f.missing.length ? `<small>no rate for ${esc(f.missing.join(', '))}</small>` : ''}</div>
      <div class="ov-tile ${f.profit >= 0 ? 'good' : 'bad'}"><span class="ov-tile-label">${f.profit >= 0 ? 'Profit' : 'Loss'}</span><b>${ssDollars(f.profit)}</b></div>
      <div class="ov-tile ${f.profit >= 0 ? 'good' : 'bad'}"><span class="ov-tile-label">Margin</span><b>${f.margin.toFixed(1)}%</b></div>
    </div>
    <h3>Cost breakdown</h3>
    ${
      sources.length
        ? sources
            .map(
              (src) => `<div class="ss-d-src"><div class="ss-d-src-head"><span>${esc(src)} <span class="count" style="margin:0">· ${bySource[src].length} line${bySource[src].length === 1 ? '' : 's'}</span></span><b>${ssDollars(sum(bySource[src]))}</b></div>
            <div class="tscroll"><table class="list ss-costs"><thead><tr><th>Date</th><th>What</th><th>Details</th><th class="num">Amount</th><th class="num">USD</th></tr></thead><tbody>${bySource[src]
              .map((l) => {
                const u = ssUsd(l.amount, l.currency);
                return `<tr><td style="white-space:nowrap">${esc(dayWords(l.date) || '—')}</td><td>${esc(l.title || '—')}</td><td class="count" style="margin:0">${esc(l.detail || '')}</td><td class="num">${money(l.amount, l.currency)}</td><td class="num">${u === null ? '<span class="blank">no rate</span>' : ssDollars(u)}</td></tr>`;
              })
              .join('')}</tbody></table></div></div>`
            )
            .join('')
        : '<p class="ov-empty" style="border:0;padding:0 0 8px">No costs linked to this watch yet.</p>'
    }
    ${s.notes ? `<div class="ss-d-box"><b>Sale notes:</b> ${esc(s.notes)}</div>` : ''}
    <div class="ss-d-foot">
      ${photos ? `<span class="count" style="margin:0">Photos: ${esc(photos)}${s.picture ? ` — <a href="${esc(fileUrl(s.picture))}" target="_blank" rel="noopener">open the first</a>` : ''}</span>` : ''}
      ${s.watch ? `<a href="#/watch/${s.watch.id}">Full watch history — its page</a>` : ''}
      <a href="#/lg/${s.id}">Open the sale record</a>
    </div>
  </div>`;
}

/* The sales shown, as a spreadsheet file (comma-separated — Excel opens it). */
function ssExport() {
  if (!ss.data) return;
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['Sold date', 'Delivered', 'Delivered via', 'Stock #', 'Brand', 'Model', 'Reference', 'Serial', 'Sold from', 'Buyer (logistics app)', 'Our client (Chrono Key)', 'Sold for', 'Currency', 'Sold (USD)', 'Our sale price (Chrono Key)', 'Cost (USD)', 'P&L (USD)', 'Margin %', 'Sale notes'];
  const lines = ssRows().map((s) => {
    const f = ssFigures(s);
    return [
      s.sold_date,
      s.delivered_at ? sfDay(s.delivered_at) : '',
      SS_VIA[s.delivered_via] || s.delivered_via,
      s.stock_no,
      s.brand,
      s.model,
      s.reference,
      s.serial,
      s.origin,
      s.buyer,
      s.watch?.sold_to?.name || '',
      s.price,
      s.currency,
      f.rev.toFixed(2),
      s.watch?.sale_price !== null && s.watch?.sale_price !== undefined ? `${s.watch.sale_currency || ''} ${s.watch.sale_price}`.trim() : '',
      f.cost.toFixed(2),
      f.profit.toFixed(2),
      f.margin.toFixed(1),
      s.notes,
    ]
      .map(cell)
      .join(',');
  });
  const blob = new Blob([`﻿${[head.join(','), ...lines].join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `sold-stocks-${localDay()}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  flash('Saved the sales shown as a spreadsheet file.');
}
