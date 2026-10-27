/*
 * Logistics Addresses: the logistics app's "Logistics Addresses" page — the
 * saved pickup and delivery locations a pickup code is written against. The
 * app's one table (name, address, notes), searchable here, each row saying
 * which pickup codes use it, with a map link for one that reads as a place.
 * Add, edit and delete are the app's own workflows done here (actions
 * addr-…); a row opens its record.
 */
'use strict';
const la = { q: '', data: null };

LG_PAGES.addresses = async function () {
  const seq = ++lgPage;
  la.data = null;
  $('#app').innerHTML = `${lgHeader('addresses')}
    <p class="sub" style="margin:0 0 12px">Saved pickup and delivery locations — the address a pickup code sends to Person A.</p>
    ${lgActionBar('addresses')}
    <div class="lg-toolbar la-toolbar">
      <input class="q" type="search" id="laq" placeholder="Name, address, notes…" value="${esc(la.q)}" aria-label="Search addresses">
    </div>
    <div class="count" id="la-count">Reading the addresses…</div>
    <div id="la-out"></div>
    <p class="count la-wait">An address a pickup code uses is written into that code's message when the code is made. Open a row to see its record. <a href="#/logistics/addresses-all">The records, as lists</a>.</p>`;
  let timer;
  $('#laq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      la.q = e.target.value;
      drawAddresses();
    }, 150);
  });
  lgOpenOnClick($('#la-out'));
  let r;
  try {
    r = await api('/api/logistics/page/addresses');
  } catch (err) {
    if (seq === lgPage && $('#la-count')) $('#la-count').textContent = `Could not read the addresses: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#la-out')) return;
  la.data = r;
  drawAddresses();
};

const laKindWords = { place: '', email: 'E-mail', link: 'Web link', text: 'Words' };
/* The address as written; a web link opens on its own. */
const laAddress = (a) =>
  a.kind === 'link'
    ? a.address
        .split(/\n/)
        .filter(Boolean)
        .map((l) => `<a href="${esc(l.trim())}" target="_blank" rel="noopener">${esc(l.trim())}</a>`)
        .join('<br>')
    : esc(a.address);
const laUsed = (a) =>
  a.used_by.length
    ? a.used_by.map((u) => `<a href="#/lg/${u.id}" class="la-code" title="${esc(`${u.status}${u.date ? `, ${u.date}` : ''}`)}">${esc(u.code || 'code')}</a>${u.status === 'completed' ? ' <span class="count" style="margin:0">done</span>' : ''}`).join('<br>')
    : '<span class="blank">none</span>';

function drawAddresses() {
  const r = la.data;
  if (!r || !$('#la-out')) return;
  const words = la.q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = r.addresses.filter((a) => sfMatch(words, a.name, a.address, a.notes, ...a.used_by.map((u) => u.code)));
  $('#la-count').textContent = `${rows.length} address${rows.length === 1 ? '' : 'es'}${words.length ? ` of ${r.count}` : ''} · ${r.in_use} used by a pickup code`;
  if (!rows.length) {
    $('#la-out').innerHTML = `<p class="sub">${words.length ? 'No address matches.' : 'No address saved yet.'}</p>`;
    return;
  }
  $('#la-out').innerHTML = `<div class="panel la-panel"><table class="list lg la-table"><thead><tr><th>Name</th><th>Address</th><th>Notes</th><th>Pickup codes</th><th>Map</th><th></th></tr></thead><tbody>${rows
    .map(
      (a) => `<tr data-id="${a.id}" tabindex="0">
        <td data-k="Name"><b>${esc(a.name || '—')}</b>${laKindWords[a.kind] ? `<div class="count" style="margin:2px 0 0">${laKindWords[a.kind]}</div>` : ''}${a.locked ? '<div><span class="chip lg-muted">edited here</span></div>' : ''}</td>
        <td data-k="Address" class="la-addr">${laAddress(a)}</td>
        <td data-k="Notes" class="la-notes">${a.notes ? esc(a.notes) : '<span class="blank">—</span>'}</td>
        <td data-k="Pickup codes">${laUsed(a)}</td>
        <td data-k="Map">${a.map_url ? `<a href="${esc(a.map_url)}" target="_blank" rel="noopener" class="la-map">Open map ↗</a>` : '<span class="blank">—</span>'}</td>
        <td data-k="Actions" class="la-acts"><div class="lg-rowacts">${lgActBtn('addr-edit', a.id)}${lgActBtn('addr-delete', a.id)}</div></td>
      </tr>`
    )
    .join('')}</tbody></table></div>`;
}
