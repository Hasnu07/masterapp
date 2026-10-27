/*
 * In Consignment: the logistics app's "In Consignment" page in the console's
 * look. Three lists, as the app's one table: our watches given to clients,
 * clients' watches we hold, and consignments still with their supplier
 * (incomings) — each row our watch (linked, with its clients by Chrono Key's
 * ids) and the person it is with, linked as far as the name goes. A return
 * date that has passed is overdue; one within a week is due soon — by this
 * computer's calendar, as the app does. Print / PDF prints the lists shown.
 * The app's buttons, done here (src/logistics/actions/sales.js): Our Watch
 * → Client and Client Watch → Us over the lists (a picker of London / Dubai
 * stock), and on each of our rows Move back, Mark sold, Edit, Delete; an
 * incoming on consignment has Mark sold. "Cost" (the app's allocated-cost
 * box) is read on the watch's own page, under What it cost.
 */
'use strict';
const cs = { q: '', section: '', data: null };

LG_PAGES.consignment = async function () {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('consignment')}
    <p class="sub cs-sub">Watches on consignment: ours with a client, a client's with us, and consignments still with their supplier. Each is linked to our stock and to the client it is with.</p>
    ${lgActionBar('consignment')}
    <div class="lg-toolbar cs-toolbar">
      <input class="q" type="search" id="cs-q" aria-label="Search consignments" placeholder="Stock number, brand, reference, who it is with…" value="${esc(cs.q)}">
      <button type="button" class="btn" id="cs-print">Print / PDF</button>
    </div>
    <div class="lg-subtabs cs-sections" id="cs-sections" role="group" aria-label="Which consignments"></div>
    <div class="count" id="cs-count">Reading what is on consignment…</div>
    <div id="cs-out" class="cs-out"></div>
    <p class="count cs-note">${can('editor') ? 'A row’s buttons: move it back, mark it sold (it goes to Ready for delivery), edit the consignment, delete. ' : ''}What a watch cost is on its own page, under What it cost. WhatsApp notices are not sent from here — the text is given to copy.</p>`;
  let timer;
  $('#cs-q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      cs.q = e.target.value;
      drawConsignment();
    }, 150);
  });
  $('#cs-sections').addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    cs.section = b.dataset.s;
    drawConsignment();
  });
  $('#cs-print').addEventListener('click', () => window.print());
  lgOpenOnClick($('#cs-out'));
  let r;
  try {
    r = await api('/api/logistics/page/consignment');
  } catch (err) {
    if (seq === lgPage && $('#cs-count')) $('#cs-count').textContent = `Could not read the consignments: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#cs-out')) return;
  cs.data = r;
  drawConsignment();
};

/* The return date against today: overdue, due within a week, or fine — the app's own rule. */
function csReturn(day) {
  if (!day) return null;
  const today = localDay();
  const week = localDay(Date.now() + 7 * 86_400_000);
  const d = String(day).slice(0, 10);
  return { day: d, state: d < today ? 'overdue' : d <= week ? 'soon' : 'ok' };
}
const csReturnCell = (day) => {
  const r = csReturn(day);
  if (!r) return '<span class="blank">—</span>';
  const words = r.state === 'overdue' ? 'Overdue · ' : r.state === 'soon' ? 'Due soon · ' : '';
  return `<span class="cs-ret ${r.state}">${esc(words + dayWords(r.day))}</span>`;
};
/* Our watch and our clients — by Chrono Key's ids, never the typed name. */
const csOurs = (w) => {
  const o = w.watch;
  if (!o) return '<span class="blank">Not one of our watches</span>';
  return [
    `<a href="#/watch/${o.id}">Our watch #${esc(o.stock_no)}</a> ${chip(o.status)}`,
    o.bought_from && `Bought from <a href="#/client/${o.bought_from.id}"><b>${esc(o.bought_from.name)}</b></a>`,
    o.sold_to && `Sold to <a href="#/client/${o.sold_to.id}"><b>${esc(o.sold_to.name)}</b></a>`,
  ]
    .filter(Boolean)
    .map((x) => `<div>${x}</div>`)
    .join('');
};
const csPic = (w) =>
  w.picture
    ? `<a href="${esc(fileUrl(w.picture))}" target="_blank" rel="noopener" class="cs-pic" title="${esc(`${w.photo_count} photo${w.photo_count === 1 ? '' : 's'}${w.before ? ' — taken before it went' : ''}`)}"><img src="${esc(fileUrl(w.picture, true))}" alt="" loading="lazy">${w.before ? '<span>Before</span>' : ''}</a>`
    : w.watch?.photo_id
      ? `<a href="#/watch/${w.watch.id}" class="cs-pic" title="Our photo of the watch"><img src="/api/photos/${w.watch.photo_id}?thumb=1" alt="" loading="lazy"></a>`
      : '<span class="blank">—</span>';
const csStock = (w) => (/\d/.test(w.stock_no) ? `#${w.stock_no}` : w.stock_no || '—');

/* The app's buttons on one of our rows on consignment, done here. */
const csActs = (w) =>
  can('editor') ? `<div class="lg-rowacts">${[lgActBtn('cons-back', w.id, { cls: 'small' }), lgActBtn('cons-sold', w.id, { cls: 'small' }), lgActBtn('cons-edit', w.id, { cls: 'small' }), lgActBtn('cons-delete', w.id, { cls: 'small' })].join('')}</div>` : '';

const CS_SECTIONS = [
  ['', 'All'],
  ['to_client', 'Our watches with clients'],
  ['from_client', "Clients' watches with us"],
  ['incoming', 'Still with the supplier'],
  ['overdue', 'Overdue'],
];

function drawConsignment() {
  const r = cs.data;
  if (!r || !$('#cs-out')) return;
  const words = cs.q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (w) => sfMatch(words, w.stock_no, w.brand, w.model, w.reference, w.serial, w.with, w.supplier, w.accessories, w.notes, w.location, w.place, w.watch?.bought_from?.name, w.watch?.sold_to?.name);
  const overdue = (w) => csReturn(w.return_by)?.state === 'overdue';
  const groups = [
    { key: 'to_client', title: 'Our watches given to clients', rows: r.to_client, explain: 'Our watch · the client holds it.' },
    { key: 'from_client', title: 'Clients’ watches we hold', rows: r.from_client, explain: 'Their watch · we hold it.' },
    { key: 'incoming', title: 'Incoming consignments — the supplier holds the watch', rows: r.incoming, explain: '' },
  ];
  const counts = {
    '': r.to_client.length + r.from_client.length + r.incoming.length,
    to_client: r.to_client.length,
    from_client: r.from_client.length,
    incoming: r.incoming.length,
    overdue: [...r.to_client, ...r.from_client].filter(overdue).length,
  };
  $('#cs-sections').innerHTML = CS_SECTIONS.filter(([k]) => k !== 'overdue' || counts.overdue)
    .map(([k, label]) => `<button type="button" class="pill${k === cs.section ? ' on' : ''}" data-s="${k}" aria-pressed="${k === cs.section}">${esc(label)}<b>${counts[k]}</b></button>`)
    .join('');
  const shown = groups
    .map((g) => ({ ...g, rows: g.rows.filter((w) => (cs.section === 'overdue' ? overdue(w) : !cs.section || cs.section === g.key) && matches(w)) }))
    .filter((g) => g.rows.length);
  const n = shown.reduce((a, g) => a + g.rows.length, 0);
  $('#cs-count').textContent = `${n} watch${n === 1 ? '' : 'es'}${words.length || cs.section ? ` of ${counts['']}` : ''} on consignment${counts.overdue ? ` · ${counts.overdue} overdue` : ''}`;
  if (!n) {
    $('#cs-out').innerHTML = `<div class="panel"><p class="ov-empty" style="border:0;padding:4px 0">${words.length || cs.section ? 'No consignment matches.' : 'No watches on consignment right now.'}</p></div>`;
    return;
  }
  const owned = (w) => `<tr data-id="${w.id}" tabindex="0" class="cs-row ${w.direction}${overdue(w) ? ' cs-overdue' : ''}">
      <td style="white-space:nowrap"><span class="lg-stock">${esc(csStock(w))}</span><div class="count" style="margin:2px 0 0">${esc(w.place)}</div></td>
      <td><a href="#/lg/${w.id}"><b>${esc([w.brand, w.model].filter(Boolean).join(' ') || 'Watch')}</b></a>${w.reference || w.serial ? `<div class="count" style="margin:2px 0 0">${esc([w.reference && `Ref ${w.reference}`, w.serial && `Serial ${w.serial}`].filter(Boolean).join(' · '))}</div>` : ''}</td>
      <td><span class="lg-tag ${w.direction === 'from_client' ? 'good' : 'warn'}">${w.direction === 'from_client' ? 'Client → us' : 'Us → client'}</span></td>
      <td>${w.with ? `<b>${lgPerson(w.with, w.with_link)}</b>` : '<span class="blank">not written</span>'}${w.date ? `<div class="count" style="margin:2px 0 0">${esc(`${w.direction === 'from_client' ? 'received' : 'sent'} ${dayWords(w.date)}`)}</div>` : ''}</td>
      <td class="cs-acc">${w.accessories ? esc(w.accessories) : '<span class="blank">—</span>'}</td>
      <td style="white-space:nowrap">${w.date ? esc(dayWords(w.date)) : '<span class="blank">—</span>'}</td>
      <td style="white-space:nowrap">${csReturnCell(w.return_by)}</td>
      <td class="cs-notes">${esc(w.notes)}</td>
      <td>${csPic(w)}</td>
      <td>${csOurs(w)}</td>
      <td class="cs-acts">${csActs(w)}</td>
    </tr>`;
  const incoming = (w) => `<tr data-id="${w.id}" tabindex="0" class="cs-row incoming">
      <td style="white-space:nowrap"><span class="lg-stock">${esc(csStock(w))}</span><div class="count" style="margin:2px 0 0">Incoming${w.location ? ` · ${esc(w.location)}` : ''}</div></td>
      <td><a href="#/lg/${w.id}"><b>${esc([w.brand, w.reference].filter(Boolean).join(' ') || 'Incoming watch')}</b></a>${w.serial ? `<div class="count" style="margin:2px 0 0">Serial ${esc(w.serial)}</div>` : ''}</td>
      <td><span class="lg-tag moving">Supplier holds it</span></td>
      <td>${w.supplier ? `<b>${lgPerson(w.supplier, w.supplier_link)}</b>` : '<span class="blank">not written</span>'}</td>
      <td class="cs-acc">${w.accessories ? esc(w.accessories) : '<span class="blank">—</span>'}</td>
      <td style="white-space:nowrap">${w.eta ? esc(`expected ${dayWords(w.eta)}`) : '<span class="blank">—</span>'}</td>
      <td><span class="blank">—</span></td>
      <td class="cs-notes">${esc(w.notes)}</td>
      <td>${csPic(w)}</td>
      <td>${csOurs(w)}</td>
      <td class="cs-acts">${can('editor') ? `<div class="lg-rowacts">${lgActBtn('cons-sold', w.id, { cls: 'small' })}</div>` : ''}</td>
    </tr>`;
  $('#cs-out').innerHTML = shown
    .map(
      (g) => `<section class="panel cs-group ${g.key}">
        ${ovHead(g.title, g.rows.length, null, '', 'h2')}
        ${g.explain ? ovExplain(g.explain) : ''}
        <div class="tscroll"><table class="list lg cs-table"><thead><tr>
          <th>Stock</th><th>Watch</th><th>Direction</th><th>${g.key === 'incoming' ? 'Supplier' : g.key === 'from_client' ? 'Owner' : 'With'}</th><th>Accessories</th><th>${g.key === 'incoming' ? 'Expected' : g.key === 'from_client' ? 'Received' : 'Sent'}</th><th>Return by</th><th>Notes</th><th>Photos</th><th>Ours · client</th><th></th>
        </tr></thead><tbody>${g.rows.map(g.key === 'incoming' ? incoming : owned).join('')}</tbody></table></div>
      </section>`
    )
    .join('');
}
