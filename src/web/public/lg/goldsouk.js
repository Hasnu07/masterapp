/*
 * Gold Souk: the logistics app's "Gold Souk" page — shop / person visit
 * tasks: who goes, what they take, the day, notes, the pictures. Its two
 * figures (open, completed) and its two tables, Open tasks and Completed,
 * as the app lays them out — with chips by person and by shop and a search
 * on top. A stock number typed into a task ("Stock # 1229", or a bare number
 * that is our watch) is OUR watch with its clients; the shop and the person
 * link as far as their names go. "Copy" copies every task as the app's own
 * text. Adding, editing, marking done, the WhatsApp message and deleting
 * wait for the switch-over: a row opens its record.
 */
'use strict';
const gs = { q: '', who: '', shop: '', data: null };

LG_PAGES.goldsouk = async function () {
  const seq = ++lgPage;
  gs.data = null;
  $('#app').innerHTML = `${lgHeader('goldsouk')}
    <p class="sub" style="margin:0 0 12px">Shop and person visits in the gold souk: who goes, what they take, what came of it. A stock number in a task is our watch.</p>
    <div class="ov-tiles gs-tiles" id="gs-tiles" aria-live="polite"></div>
    <div class="lg-toolbar gs-toolbar">
      <input class="q" type="search" id="gsq" placeholder="Shop, person, what they take, notes, stock number…" value="${esc(gs.q)}" aria-label="Search gold souk tasks">
      <select id="gs-shop" aria-label="Shop or person visited"><option value="">Every shop</option></select>
      <button type="button" class="btn" id="gs-copy" title="Copy every task, open and completed, as the logistics app writes them">Copy all tasks</button>
    </div>
    <div class="lg-subtabs" id="gs-who" role="group" aria-label="Who is going"></div>
    <div class="count" id="gs-count">Reading the gold souk tasks…</div>
    <div id="gs-out"></div>
    <p class="count gs-wait">A new task, editing, marking done, the WhatsApp message and deleting change the logistics app's records: they wait for the switch-over. Open a row to edit its record here. <a href="#/logistics/goldsouk-all">The records, as lists</a>.</p>`;
  let timer;
  $('#gsq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      gs.q = e.target.value;
      drawGoldSouk();
    }, 150);
  });
  $('#gs-shop').addEventListener('change', (e) => {
    gs.shop = e.target.value;
    drawGoldSouk();
  });
  $('#gs-who').addEventListener('click', (e) => {
    const b = e.target.closest('[data-w]');
    if (!b) return;
    gs.who = b.dataset.w;
    drawGoldSouk();
  });
  $('#gs-copy').addEventListener('click', () => {
    if (!gs.data) return;
    const b = $('#gs-copy');
    navigator.clipboard?.writeText(gsText(gs.data)).then(
      () => {
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = 'Copy all tasks'), 1500);
      },
      () => flash('Could not copy.', true)
    );
  });
  lgOpenOnClick($('#gs-out'));
  let r;
  try {
    r = await api('/api/logistics/page/goldsouk');
  } catch (err) {
    if (seq === lgPage && $('#gs-count')) $('#gs-count').textContent = `Could not read the gold souk tasks: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#gs-out')) return;
  gs.data = r;
  if (gs.shop && !r.shops.some((s) => s.name === gs.shop)) gs.shop = '';
  if (gs.who && !r.people.some((p) => p.name === gs.who)) gs.who = '';
  $('#gs-shop').innerHTML = `<option value="">Every shop</option>${r.shops.map((s) => `<option value="${esc(s.name)}">${esc(s.name)} (${s.n})</option>`).join('')}`;
  $('#gs-shop').value = gs.shop;
  drawGoldSouk();
};

/* Every task as the app's "Copy" writes it (its buildGoldSoukText), open then completed. */
function gsText(r) {
  const line = (t) => {
    let s = `• ${t.shop || '?'} — going: ${t.who || '?'}`;
    if (t.taking) s += `\n   Taking: ${t.taking}`;
    if (t.date) s += `\n   Date: ${t.date}`;
    if (t.notes) s += `\n   Note: ${t.notes}`;
    if (t.status === 'done' && t.result_notes) s += `\n   Result: ${t.result_notes}`;
    return s;
  };
  let out = '🏅 GOLD SOUK TASKS\n';
  out += `\n📋 OPEN (${r.open.length}):\n` + (r.open.length ? r.open.map(line).join('\n') : '  none');
  out += `\n\n✅ COMPLETED (${r.done.length}):\n` + (r.done.length ? r.done.map(line).join('\n') : '  none');
  return out.trim();
}

/* Our watch for a number typed into the task, with its clients. */
const gsStocks = (t) =>
  t.stocks.length
    ? `<div class="gs-stocks">${t.stocks
        .map((s) => {
          const o = s.watch;
          if (!o) return `<span class="lg-stock">#${esc(s.no)}</span> <span class="count" style="margin:0">not one of ours</span>`;
          return `<span><a href="#/watch/${o.id}" class="lg-stock">#${esc(o.stock_no)}</a> ${chip(o.status)} ${esc(o.title || '')}${
            o.sold_to ? ` · sold to <a href="#/client/${o.sold_to.id}">${esc(o.sold_to.name)}</a>` : o.bought_from ? ` · bought from <a href="#/client/${o.bought_from.id}">${esc(o.bought_from.name)}</a>` : ''
          }</span>`;
        })
        .join('<br>')}</div>`
    : '';
/* The pictures masterapp holds, as thumbnails; one the app kept elsewhere, as a link. */
function gsPhotos(list, label) {
  if (!list.length) return '';
  return `<div class="gs-pics">${label ? `<span class="count" style="margin:0">${label}</span>` : ''}${list
    .map((p, i) =>
      p.file
        ? `<a href="${esc(fileUrl(p.file))}" target="_blank" rel="noopener"><img src="${esc(fileUrl(p.file, true))}" alt="Photo ${i + 1}" loading="lazy"></a>`
        : `<a href="${esc(p.url)}" target="_blank" rel="noopener" title="On the logistics app's own storage">Photo ${i + 1} ↗</a>`
    )
    .join('')}</div>`;
}

function drawGoldSouk() {
  const r = gs.data;
  if (!r || !$('#gs-out')) return;
  $('#gs-tiles').innerHTML = `
    <div class="panel ov-tile warn"><span class="ov-tile-label">Open tasks</span><b>${r.counts.open}</b></div>
    <div class="panel ov-tile good"><span class="ov-tile-label">Completed</span><b>${r.counts.done}</b></div>`;
  $('#gs-who').innerHTML = [{ name: '', n: r.counts.open + r.counts.done }, ...r.people]
    .map((p) => `<button type="button" class="pill${p.name === gs.who ? ' on' : ''}" data-w="${esc(p.name)}" aria-pressed="${p.name === gs.who}">${esc(p.name || 'Everyone')}<b>${p.n}</b></button>`)
    .join('');

  const words = gs.q.toLowerCase().split(/\s+/).filter(Boolean);
  const keep = (t) =>
    (!gs.who || t.who === gs.who) &&
    (!gs.shop || t.shop === gs.shop) &&
    sfMatch(words, t.shop, t.who, t.taking, t.notes, t.result_notes, t.date, ...t.stocks.map((s) => `${s.no} ${s.watch?.title || ''}`));
  const open = r.open.filter(keep);
  const done = r.done.filter(keep);
  const narrowed = words.length || gs.who || gs.shop;
  $('#gs-count').textContent = `${open.length} open · ${done.length} completed${narrowed ? ` of ${r.counts.open + r.counts.done}` : ''}`;

  const who = (t) => `<span class="lg-tag">${lgPerson(t.who, t.who_link, '—')}</span>`;
  const shop = (t) => `<b>${lgPerson(t.shop, t.shop_link, '—')}</b>`;
  const openRows = open.length
    ? `<div class="tscroll"><table class="list lg gs-table"><thead><tr><th>Date</th><th>Shop / person</th><th>Who is going</th><th>Taking</th><th>Notes</th><th>Photos</th></tr></thead><tbody>${open
        .map(
          (t) => `<tr data-id="${t.id}" tabindex="0">
            <td style="white-space:nowrap">${esc(sfDay(t.date) || '—')}</td>
            <td>${shop(t)}</td>
            <td>${who(t)}</td>
            <td class="gs-taking">${esc(t.taking || '—')}${gsStocks(t)}</td>
            <td class="gs-notes">${esc(t.notes)}</td>
            <td>${gsPhotos(t.photos, '') || '<span class="blank">—</span>'}</td>
          </tr>`
        )
        .join('')}</tbody></table></div>`
    : `<p class="sub" style="margin:0">${narrowed ? 'No open task matches.' : 'No open task.'}</p>`;
  const doneRows = done.length
    ? `<div class="tscroll"><table class="list lg gs-table"><thead><tr><th>Date</th><th>Shop / person</th><th>Who went</th><th>Took</th><th>Result</th><th>Photos</th></tr></thead><tbody>${done
        .map(
          (t) => `<tr data-id="${t.id}" tabindex="0">
            <td style="white-space:nowrap">${esc(sfDay(t.date) || '—')}${t.completed_at ? `<div class="count" style="margin:2px 0 0">done ${esc(sfDay(t.completed_at))}</div>` : ''}</td>
            <td>${shop(t)}</td>
            <td>${who(t)}</td>
            <td class="gs-taking">${esc(t.taking || '—')}${gsStocks(t)}${t.notes ? `<div class="count gs-notes" style="margin:4px 0 0">${esc(t.notes)}</div>` : ''}</td>
            <td class="gs-notes">${esc(t.result_notes)}</td>
            <td>${gsPhotos(t.photos, t.result_photos.length ? 'before' : '')}${gsPhotos(t.result_photos, t.photos.length ? 'result' : '')}${!t.photos.length && !t.result_photos.length ? '<span class="blank">—</span>' : ''}</td>
          </tr>`
        )
        .join('')}</tbody></table></div>`
    : `<p class="sub" style="margin:0">${narrowed ? 'No completed task matches.' : 'No task completed yet.'}</p>`;
  $('#gs-out').innerHTML = `
    <section class="panel gs-panel warn"><h2 class="gs-h">Open tasks <span class="count" style="margin:0">${open.length}</span></h2>${openRows}</section>
    <section class="panel gs-panel good"><h2 class="gs-h">Completed <span class="count" style="margin:0">${done.length}</span></h2>${doneRows}</section>`;
}
