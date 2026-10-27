/*
 * Refinement: the logistics app's "Refinement" page in the console's look —
 * polish tracking across all stock. Its four figures (need polish, at polish
 * now, polishes completed, spend — in dollars at the converter's rates, not
 * the app's fixed table), then Currently at polish, every watch in stock
 * with Send to polish (sold and ready-for-delivery watches join when
 * searched for, as the app), the polish history, and external watches
 * (clients' or others', not our stock). Every stock number is our watch,
 * linked with its clients; the polisher's typed name links as far as it goes.
 *
 * Send to polish and Back from polish post to POST /api/logistics/items/:id/
 * polish (the Overview's endpoint). An external watch's polish — add, mark
 * done, edit, delete — is the app's buttons done here
 * (src/logistics/actions/sales.js, ref-*).
 */
'use strict';
const rf = { q: '', data: null, form: null, seq: 0 };

LG_PAGES.refinement = async function () {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('refinement')}
    <p class="sub">Polish tracking across all stock: who has each watch, since when, what it cost, and what came back. Each watch is ours, linked with its clients.</p>
    <div class="ov-tiles rf-tiles" id="rf-tiles"></div>
    <div id="rf-root">
      <section class="panel rf-sec blue" id="rf-at"><div class="ov-skel"></div></section>
      <section class="panel rf-sec warn" id="rf-stock">
        <div class="rf-sec-head">${ovHead('All stock — send to polish', null, null, '', 'h2')}
          <input class="q" type="search" id="rf-q" aria-label="Search stock" placeholder="Stock number, brand, reference, serial…" value="${esc(rf.q)}"></div>
        ${ovExplain('Watches in London, Dubai, Hong Kong and the safe. Search to find a sold watch or one waiting for delivery too.')}
        <div id="rf-form"></div>
        <div id="rf-grid"><div class="ov-skel"></div></div>
      </section>
      <section class="panel rf-sec good" id="rf-hist"><div class="ov-skel"></div></section>
      <section class="panel rf-sec purple" id="rf-ext"><div class="ov-skel"></div></section>
    </div>`;
  let timer;
  $('#rf-q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      rf.q = e.target.value;
      drawRefinementGrid();
    }, 150);
  });
  $('#rf-root').addEventListener('click', (e) => {
    const send = e.target.closest('[data-psend]');
    const done = e.target.closest('[data-pdone]');
    if (send) rfPolishForm('send', Number(send.dataset.psend), send.dataset.item || 'Full Watch');
    else if (done) rfPolishForm('done', Number(done.dataset.pdone));
  });
  await loadRefinement(seq);
};

async function loadRefinement(seq = lgPage) {
  let r;
  try {
    r = await api('/api/logistics/page/refinement');
  } catch (err) {
    if (seq === lgPage && $('#rf-at')) $('#rf-at').innerHTML = `<p class="ov-empty" style="border:0">Could not read the polish records: ${esc(err.message)}</p>`;
    return;
  }
  if (seq !== lgPage || !$('#rf-root')) return;
  rf.data = r;
  drawRefinement();
}

/* An amount in dollars at the converter's rates; null when the currency has no rate. */
const rfUsd = (amount, cur) => {
  const t = rf.data?.rates?.table;
  if (!t || !t[cur] || !t.USD) return null;
  return (Number(amount) / t[cur]) * t.USD;
};
const rfDollars = (n) => `$${Math.round(Number(n)).toLocaleString('en-GB')}`;
const rfStock = (s) => (/\d/.test(s.stock_no) ? `#${s.stock_no}` : s.stock_no || '—');
const rfWatch = (s) => esc([s.brand, s.model].filter(Boolean).join(' ') || 'Watch');
/* Our watch and our clients — by Chrono Key's ids. */
const rfOurs = (s) => {
  const o = s.watch;
  if (!o) return '<span class="blank">Not one of our watches</span>';
  return [
    `<a href="#/watch/${o.id}">Our watch #${esc(o.stock_no)}</a> ${chip(o.status)}`,
    o.bought_from && `from <a href="#/client/${o.bought_from.id}">${esc(o.bought_from.name)}</a>`,
    o.sold_to && `sold to <a href="#/client/${o.sold_to.id}">${esc(o.sold_to.name)}</a>`,
  ]
    .filter(Boolean)
    .join(' · ');
};
const rfCost = (c) => (c && c.amount > 0 ? money(c.amount, c.currency || null) : '<span class="blank">—</span>');
const rfBack = (day) => {
  if (!day) return '<span class="blank">—</span>';
  const overdue = String(day).slice(0, 10) < localDay();
  return `<span class="${overdue ? 'rf-overdue' : ''}">${esc(dayWords(day))}${overdue ? ' · overdue' : ''}</span>`;
};
const rfPhotos = (n, picture) => (n ? (picture ? `<a href="${esc(fileUrl(picture))}" target="_blank" rel="noopener">${n} photo${n === 1 ? '' : 's'}</a>` : `${n} photo${n === 1 ? '' : 's'}`) : '<span class="blank">—</span>');
const rfPerson = (p) => (p?.name ? lgPerson(p.name, p.link) : '<span class="blank">not written</span>');

function drawRefinement() {
  const r = rf.data;
  if (!r || !$('#rf-root')) return;
  const editor = can('editor');
  const flagged = r.stock.filter((s) => s.state === 'flagged');
  // Spend: the polishes at the polisher now and the ones completed — the app's own sum, in dollars at the converter's rates.
  let spend = 0;
  const byCur = {};
  const missing = new Set();
  for (const p of [...r.at_polish, ...r.history]) {
    if (!(p.cost?.amount > 0)) continue;
    byCur[p.cost.currency || '?'] = (byCur[p.cost.currency || '?'] || 0) + p.cost.amount;
    const u = rfUsd(p.cost.amount, p.cost.currency);
    if (u === null) missing.add(p.cost.currency || '?');
    else spend += u;
  }
  const each = Object.entries(byCur)
    .map(([c, n]) => money(n, c === '?' ? null : c))
    .join(' · ');
  $('#rf-tiles').innerHTML = `
    <div class="ov-tile warn"><span class="ov-tile-label">Need polish</span><b>${flagged.length}</b><small>flagged, not sent yet</small></div>
    <div class="ov-tile blue"><span class="ov-tile-label">At polish now</span><b>${r.at_polish.length}</b><small>with a polisher</small></div>
    <div class="ov-tile good"><span class="ov-tile-label">Polishes completed</span><b>${r.history.length}</b><small>came back</small></div>
    <div class="ov-tile"><span class="ov-tile-label">Polish spend</span><b>${rfDollars(spend)}</b><small>${each ? esc(each) : 'nothing charged yet'}${missing.size ? ` · no rate for ${esc([...missing].join(', '))}` : ''}${r.rates?.stale ? ' · rates not fresh' : ''}</small></div>`;

  // Currently at polish.
  $('#rf-at').innerHTML =
    ovHead('Currently at polish', r.at_polish.length, null, '', 'h2') +
    (r.at_polish.length
      ? `<div class="tscroll"><table class="list lg rf-table"><thead><tr><th>Stock</th><th>Watch</th><th>Item</th><th>Location</th><th>Sent to</th><th>Taken by</th><th>Sent</th><th>Expected back</th><th>Cost</th><th>Photos</th><th>Ours · client</th><th></th></tr></thead><tbody>${r.at_polish
          .map(
            (p) => `<tr data-id="${p.id}" tabindex="0">
            <td style="white-space:nowrap"><span class="lg-stock">${esc(rfStock(p))}</span></td>
            <td><a href="#/lg/${p.id}"><b>${rfWatch(p)}</b></a>${p.reference ? `<div class="count" style="margin:2px 0 0">${esc(p.reference)}</div>` : ''}${p.notes ? `<div class="count" style="margin:2px 0 0">${esc(p.notes)}</div>` : ''}</td>
            <td><b>${esc(p.item)}</b></td>
            <td>${esc(p.place)}</td>
            <td>${rfPerson(p.sent_to)}</td>
            <td>${esc(p.taken_by || '—')}</td>
            <td style="white-space:nowrap">${esc(dayWords(p.sent_date) || '—')}</td>
            <td style="white-space:nowrap">${rfBack(p.expected_back)}</td>
            <td style="white-space:nowrap">${rfCost(p.cost)}</td>
            <td>${rfPhotos(p.before_n, p.picture)}</td>
            <td>${rfOurs(p)}</td>
            <td>${editor ? `<button type="button" class="btn small" data-pdone="${p.id}">Back from polish</button>` : ''}</td>
          </tr>`
          )
          .join('')}</tbody></table></div>`
      : '<p class="ov-empty">Nothing at polish right now.</p>');
  lgOpenOnClick($('#rf-at'));
  if (rf.form && !r.stock.some((s) => s.id === rf.form.id) && !r.at_polish.some((s) => s.id === rf.form.id)) rf.form = null;
  drawRefinementGrid();

  // Polish history.
  $('#rf-hist').innerHTML =
    ovHead('Polish history', r.history.length, null, '', 'h2') +
    (r.history.length
      ? `<div class="tscroll"><table class="list lg rf-table"><thead><tr><th>Stock</th><th>Watch</th><th>Item</th><th>Sent to</th><th>Taken by</th><th>Sent</th><th>Returned</th><th>Cost</th><th>Before</th><th>After</th><th>Notes</th><th>Ours · client</th></tr></thead><tbody>${r.history
          .map(
            (h) => `<tr data-id="${h.id}" tabindex="0">
            <td style="white-space:nowrap"><span class="lg-stock">${esc(rfStock(h))}</span><div class="count" style="margin:2px 0 0">${esc(h.place)}</div></td>
            <td><a href="#/lg/${h.id}"><b>${rfWatch(h)}</b></a>${h.reference ? `<div class="count" style="margin:2px 0 0">${esc(h.reference)}</div>` : ''}</td>
            <td><b>${esc(h.item)}</b></td>
            <td>${rfPerson(h.sent_to)}</td>
            <td>${esc(h.taken_by || '—')}</td>
            <td style="white-space:nowrap">${esc(dayWords(h.sent_date) || '—')}</td>
            <td style="white-space:nowrap">${esc(dayWords(h.returned_date) || '—')}</td>
            <td style="white-space:nowrap">${rfCost(h.cost)}</td>
            <td>${h.before_n || '<span class="blank">—</span>'}</td>
            <td>${h.after_n || '<span class="blank">—</span>'}</td>
            <td class="rf-notes">${esc(h.notes)}</td>
            <td>${rfOurs(h)}</td>
          </tr>`
          )
          .join('')}</tbody></table></div>`
      : '<p class="ov-empty">No completed polishes yet.</p>');
  lgOpenOnClick($('#rf-hist'));

  // External watches at polish — not our stock.
  const ext = r.external;
  const extRow = (e, done) => `<tr data-id="${e.id}" tabindex="0">
      <td><a href="#/lg/${e.id}"><b>${esc(e.description || 'Watch')}</b></a>${e.watch ? `<div class="count" style="margin:2px 0 0">${esc(e.watch.reference || e.watch.title)}</div>` : ''}${e.notes ? `<div class="count" style="margin:2px 0 0">${esc(e.notes)}</div>` : ''}</td>
      <td>${rfPerson(e.sent_to)}</td>
      <td style="white-space:nowrap">${esc(dayWords(e.sent_date) || '—')}</td>
      <td style="white-space:nowrap">${done ? esc(dayWords(e.return_date) || '—') : rfBack(e.expected_back)}</td>
      <td style="white-space:nowrap">${rfCost(e.cost)}</td>
      <td>${rfPhotos(e.before_n + e.after_n, e.picture)}</td>
      ${done ? `<td class="rf-notes">${esc(e.return_notes)}</td>` : ''}
      <td>${e.watch ? rfOurs(e) : e.stock_no ? `<span class="blank">#${esc(e.stock_no)} is not one of our watches</span>` : '<span class="blank">Not our stock</span>'}</td>
      <td class="rf-acts">${editor ? `<div class="lg-rowacts">${(done ? [lgActBtn('ref-delete', e.id, { cls: 'small' })] : [lgActBtn('ref-done', e.id, { cls: 'small primary' }), lgActBtn('ref-edit', e.id, { cls: 'small' }), lgActBtn('ref-delete', e.id, { cls: 'small' })]).join('')}</div>` : ''}</td>
    </tr>`;
  $('#rf-ext').innerHTML =
    ovHead('External watches at polish', ext.active.length, null, '', 'h2') +
    ovExplain('Clients’ or other watches sent for polish — not our stock. A bare stock number as the watch is ours. No cost line is written for these (the app writes none).') +
    lgActionBar('refinement') +
    (ext.active.length
      ? `<div class="tscroll"><table class="list lg rf-table"><thead><tr><th>Watch</th><th>Sent to</th><th>Sent</th><th>Expected back</th><th>Cost</th><th>Photos</th><th>Ours</th><th></th></tr></thead><tbody>${ext.active.map((e) => extRow(e, false)).join('')}</tbody></table></div>`
      : '<p class="ov-empty">No external watches at polish right now.</p>') +
    (ext.done.length
      ? `<h3 style="margin-top:14px">External polish history <span class="ov-n">${ext.done.length}</span></h3><div class="tscroll"><table class="list lg rf-table"><thead><tr><th>Watch</th><th>Sent to</th><th>Sent</th><th>Returned</th><th>Cost</th><th>Photos</th><th>Notes</th><th>Ours</th><th></th></tr></thead><tbody>${ext.done.map((e) => extRow(e, true)).join('')}</tbody></table></div>`
      : '');
  lgOpenOnClick($('#rf-ext'));
}

/* The app's card grid: every watch in place; sold and ready-for-delivery ones only when searched for. */
function drawRefinementGrid() {
  const r = rf.data;
  const host = $('#rf-grid');
  if (!r || !host) return;
  const editor = can('editor');
  const words = rf.q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = words.length
    ? r.stock.filter((s) => sfMatch(words, s.stock_no, s.brand, s.model, s.reference, s.serial, s.from, s.buyer, s.notes, s.place, s.watch?.bought_from?.name, s.watch?.sold_to?.name))
    : r.stock.filter((s) => s.kind !== 'soldStocks' && s.kind !== 'readyForDelivery');
  const n = rows.length;
  $('#rf-stock .ov-n')?.remove();
  $('#rf-stock .ov-h').insertAdjacentHTML('beforeend', `<span class="ov-n">${n}</span>`);
  if (!n) {
    host.innerHTML = `<p class="ov-empty">${words.length ? 'No watch matches.' : 'No stock in place.'}</p>`;
    return;
  }
  host.innerHTML = `<div class="rf-cards">${rows
    .map(
      (s) => `<article class="rf-card${s.state ? ` ${s.state}` : ''}">
        <div class="rf-card-pic">${s.picture ? `<img src="${esc(fileUrl(s.picture, true))}" alt="" loading="lazy">` : s.watch?.photo_id ? `<img src="/api/photos/${s.watch.photo_id}?thumb=1" alt="" loading="lazy">` : '<span>No photo</span>'}</div>
        <div class="rf-card-body">
          <div class="rf-card-tags"><span class="lg-stock">${esc(rfStock(s))}</span><span class="lg-tag">${esc(s.place)}</span>${s.on_consignment ? '<span class="lg-tag warn">On consignment</span>' : ''}${
            s.state === 'at_polish' ? `<span class="lg-tag warn">At polish${s.polish?.sent_to ? ` · ${esc(s.polish.sent_to)}` : ''}</span>` : s.state === 'flagged' ? '<span class="lg-tag warn">Needs polish</span>' : ''
          }</div>
          <a class="rf-card-title" href="#/lg/${s.id}">${rfWatch(s)}</a>
          ${s.reference ? `<div class="count" style="margin:0">${esc(s.reference)}</div>` : ''}
          <div class="count rf-card-ours" style="margin:0">${rfOurs(s)}</div>
          ${s.history_n ? `<div class="count" style="margin:0">${s.history_n} polish${s.history_n === 1 ? '' : 'es'} completed</div>` : ''}
          ${
            editor && s.can_polish
              ? `<div class="rf-card-acts">${
                  s.state === 'at_polish'
                    ? `<button type="button" class="btn small primary" data-pdone="${s.id}">Back from polish</button>`
                    : `<button type="button" class="btn small" data-psend="${s.id}" data-item="Full Watch">Send to polish</button><button type="button" class="btn small" data-psend="${s.id}" data-item="Links">Send the links</button>`
                }</div>`
              : ''
          }
        </div>
      </article>`
    )
    .join('')}</div>`;
}

/* Send to polish / Back from polish — the Overview's form, the one record change allowed here (polishAction). */
function rfPolishForm(action, id, preset = 'Full Watch') {
  const r = rf.data;
  const row = r.stock.find((s) => s.id === id) || r.at_polish.find((s) => s.id === id);
  if (!row) return;
  rf.form = { action, id };
  const host = $('#rf-form');
  const today = localDay();
  const title = `${rfStock(row)} · ${[row.brand, row.model].filter(Boolean).join(' ') || 'Watch'}`;
  const items = ['Full Watch', 'Links', 'Bracelet', 'Case', 'Clasp', 'Bezel', 'Other'];
  host.innerHTML =
    action === 'send'
      ? `<form class="ov-form" id="rf-pform"><span class="ov-form-title">Send to polish: ${esc(title)}</span>
          <div class="form-grid" style="margin-top:8px">
            <label>Polisher *<input type="text" name="sentTo" required></label>
            <label>Taken by<input type="text" name="takenBy"></label>
            <label>What goes<select name="itemDescription">${items.map((i) => `<option value="${esc(i)}"${i === preset ? ' selected' : ''}>${esc(i === 'Links' ? 'Links (bracelet links)' : i)}</option>`).join('')}</select></label>
            <label>Sent on<input type="date" name="sentDate" value="${today}"></label>
            <label>Expected back<input type="date" name="expectedBack"></label>
            <label>Cost<span class="row" style="flex-wrap:nowrap"><input type="text" inputmode="decimal" name="costAmount" placeholder="350"><input type="text" name="costCurrency" value="AED" maxlength="4" style="width:80px" aria-label="Currency"></span></label>
            <label class="wide">Notes<textarea name="notes" rows="2"></textarea></label>
          </div>
          <div class="err" id="rf-perr"></div>
          <div class="row"><button class="btn primary">Send to polish</button><button type="button" class="btn" id="rf-pcancel">Cancel</button></div></form>`
      : `<form class="ov-form" id="rf-pform"><span class="ov-form-title">Back from polish: ${esc(title)}</span> <span class="count">with ${esc(row.polish?.sent_to || row.sent_to?.name || 'the polisher')}${row.polish?.sent_date || row.sent_date ? ` since ${esc(dayWords(row.polish?.sent_date || row.sent_date))}` : ''}</span>
          <div class="form-grid" style="margin-top:8px">
            <label>Back on<input type="date" name="returnedDate" value="${today}"></label>
            <label class="wide">Notes<textarea name="returnNotes" rows="2"></textarea></label>
          </div>
          <div class="err" id="rf-perr"></div>
          <div class="row"><button class="btn primary">Save — back from polish</button><button type="button" class="btn" id="rf-pcancel">Cancel</button></div></form>`;
  host.scrollIntoView({ block: 'nearest' });
  $('#rf-pform input[type=text], #rf-pform input[type=date]')?.focus();
  $('#rf-pcancel').addEventListener('click', () => {
    rf.form = null;
    host.innerHTML = '';
  });
  $('#rf-pform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button.primary');
    if (button.disabled) return;
    button.disabled = true;
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      const res = await api(`/api/logistics/items/${id}/polish`, { method: 'POST', body: { action, ...body } });
      flash(action === 'send' ? `Sent to polish${res.cost ? ' — its cost is in Logistics costs' : ''}` : 'Back from polish — back in stock');
      rf.form = null;
      host.innerHTML = '';
      await loadRefinement();
    } catch (err) {
      button.disabled = false;
      if ($('#rf-perr')) $('#rf-perr').textContent = err.message;
    }
  });
}
