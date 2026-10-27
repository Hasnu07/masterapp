/*
 * Other Receiving Pics: the logistics app's gallery of pictures taken when
 * something was received that is not a stock list's own photo — a passport,
 * a box of parts, a friend's watch. One card per entry, newest first, as the
 * app shows them: the client, the day, the notes, the first four pictures
 * and "+n more"; a picture opens full size here, and can be downloaded. The
 * typed client links as far as the name goes; a stock number in the entry
 * is our watch. Add / edit / delete are the app's own buttons, done here
 * (actions/records.js); the pictures go on the entry through the upload
 * control.
 */
'use strict';
const orp = { q: '', sort: 'new', open: new Set(), data: null };

LG_PAGES.otherreceiving = async function () {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('otherreceiving')}
    <p class="sub" style="margin:0 0 12px">Pictures taken on receiving something that is not a stock watch's own photo — a passport, parts, a client's piece. Add the entry, then its pictures.</p>
    ${lgActionBar('otherreceiving')}
    <div class="lg-toolbar orp-toolbar">
      <input class="q" type="search" id="orpq" placeholder="Client, notes, stock number…" value="${esc(orp.q)}" aria-label="Search the entries">
      <select id="orp-sort" aria-label="Order"><option value="new">Newest first</option><option value="old">Oldest first</option><option value="name">By client</option></select>
      <a class="btn" href="#/logistics/otherreceiving-all">All records</a>
    </div>
    <div class="count" id="orp-count">Reading the entries…</div>
    <div id="orp-out" class="orp-grid"></div>
    <dialog id="orp-light" class="orp-light" aria-label="Picture">
      <div class="orp-light-bar"><a id="orp-light-open" href="#" target="_blank" rel="noopener">Open full size</a><a id="orp-light-dl" href="#">Download</a><button type="button" class="btn small" id="orp-light-close">Close</button></div>
      <img id="orp-light-img" src="" alt="">
    </dialog>`;
  $('#orp-sort').value = orp.sort;
  let timer;
  $('#orpq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      orp.q = e.target.value;
      drawReceivingPics();
    }, 150);
  });
  $('#orp-sort').addEventListener('change', (e) => {
    orp.sort = e.target.value;
    drawReceivingPics();
  });
  const light = $('#orp-light');
  $('#orp-out').addEventListener('click', (e) => {
    const more = e.target.closest('button[data-more]');
    if (more) {
      orp.open.add(Number(more.dataset.more));
      drawReceivingPics();
      return;
    }
    const pic = e.target.closest('button[data-pic]');
    if (!pic) return;
    const ref = pic.dataset.pic;
    $('#orp-light-img').src = fileUrl(ref);
    $('#orp-light-open').href = fileUrl(ref);
    $('#orp-light-dl').href = `${fileUrl(ref)}${fileUrl(ref).includes('?') ? '&' : '?'}download=1`;
    light.showModal();
  });
  $('#orp-light-close').addEventListener('click', () => light.close());
  // A click on the dark edge, outside the picture, closes it too.
  light.addEventListener('click', (e) => {
    if (e.target === light) light.close();
  });
  light.addEventListener('close', () => ($('#orp-light-img').src = ''));
  lgOpenOnClick($('#orp-out'));
  let r;
  try {
    r = await api('/api/logistics/page/otherreceiving');
  } catch (err) {
    if (seq === lgPage && $('#orp-count')) $('#orp-count').textContent = `Could not read the entries: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#orp-out')) return;
  orp.data = r;
  drawReceivingPics();
};

const orpPic = (ref) => `<button type="button" class="orp-pic" data-pic="${esc(ref)}" title="Open the picture"><img src="${esc(fileUrl(ref, true))}" alt="" loading="lazy"></button>`;

function drawReceivingPics() {
  const r = orp.data;
  if (!r || !$('#orp-out')) return;
  const words = orp.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = r.entries
    .filter((x) => sfMatch(words, x.client_name, x.notes, ...x.stock_nos, ...x.watches.map((w) => w.title), x.link?.client_name))
    .sort((a, b) => (orp.sort === 'old' ? a.created_at.localeCompare(b.created_at) : orp.sort === 'name' ? a.client_name.localeCompare(b.client_name) || b.created_at.localeCompare(a.created_at) : b.created_at.localeCompare(a.created_at)));
  const n = list.length;
  $('#orp-count').textContent = `${n} entr${n === 1 ? 'y' : 'ies'}${n !== r.entries.length ? ` of ${r.entries.length}` : ''} · ${r.photos} picture${r.photos === 1 ? '' : 's'}`;
  if (!n) {
    $('#orp-out').innerHTML = `<p class="sub" style="grid-column:1/-1">${r.entries.length ? 'No entry matches.' : 'No receiving pictures yet.'}</p>`;
    return;
  }
  $('#orp-out').innerHTML = list
    .map((x) => {
      const all = orp.open.has(x.id);
      const pics = all ? x.photos : x.photos.slice(0, 4);
      const rest = x.photos.length - pics.length;
      return `<article class="panel orp-card" data-id="${x.id}" tabindex="0" role="link" aria-label="${esc(`${x.client_name || 'Entry'}, ${sfDay(x.created_at)}`)}">
        <div class="orp-head">
          <div><div class="orp-who">${x.client_name ? lgPerson(x.client_name, x.link) : '<span class="blank">No name written</span>'}${x.locked ? ' <span class="lock" title="Edited here">✎</span>' : ''}</div>
            <div class="count" style="margin:2px 0 0">${esc(sfDay(x.created_at))}</div></div>
          <div class="lg-rowacts" style="margin:0">${lgUploadCtl(x.id, 'photos', 'Add pictures', { accept: 'image/*' })}${lgActBtn('pic-edit', x.id, { cls: 'small' })}${lgActBtn('pic-delete', x.id, { cls: 'small' })}<a class="btn small" href="#/lg/${x.id}">Open record</a></div>
        </div>
        ${x.notes ? `<div class="orp-notes">${esc(x.notes)}</div>` : ''}
        ${
          x.watches.length
            ? `<div class="count" style="margin:0">${x.watches.map((w) => `<a href="#/watch/${w.id}">Our watch #${esc(w.stock_no)}</a> ${chip(w.status)}`).join(' · ')}</div>`
            : x.stock_nos.length
              ? `<div class="count" style="margin:0">Stock ${x.stock_nos.map((s) => `<b>#${esc(s)}</b>`).join(', ')} — not one of our watches</div>`
              : ''
        }
        ${
          pics.length
            ? `<div class="orp-pics">${pics.map(orpPic).join('')}${rest > 0 ? `<button type="button" class="orp-more" data-more="${x.id}">+${rest} more</button>` : ''}</div>`
            : '<div class="count" style="margin:0">No pictures</div>'
        }
        ${x.unreadable ? `<div class="count" style="margin:4px 0 0">${x.unreadable} picture${x.unreadable === 1 ? '' : 's'} could not be read</div>` : ''}
      </article>`;
    })
    .join('');
}
