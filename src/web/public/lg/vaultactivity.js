/*
 * Watch Vault Activity: what the Watch vault changed (the app's own page —
 * its notifications newest first, each read the app's way: a location from
 * → to, the accessories marked present, removed and now missing, the new
 * B2B / B2C) and, beside them, who holds which watch as the vault's own
 * tracking says (in the office or at home, out with a client, at the Gold
 * Souk, out for photography). Every stock number is our watch with its
 * clients. Nothing here is a button: the vault writes, the app approves on
 * sight, masterapp copies.
 */
'use strict';
const va = { q: '', type: '', place: '', data: null };
const VA_TYPE = { location: 'Location', accessory: 'Accessories', price: 'Prices' };
const VA_WHERE = { vault: ['In the vault', 'lg-good'], client: ['Out with a client', 'lg-warn'], souk: ['At the Gold Souk', 'lg-warn'], photo: ['Out for photography', 'lg-blue'], '': ['Somewhere else', 'lg-muted'] };

LG_PAGES.vaultactivity = async function () {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('vaultactivity')}
    <p class="sub" style="margin:0 0 12px">Changes made in the Watch vault — a watch's place, its accessories, its prices — and who holds each watch now. Every stock number is our watch.</p>
    <div class="ov-tiles va-tiles" id="va-tiles"></div>
    <div class="lg-toolbar va-toolbar">
      <input class="q" type="search" id="vaq" placeholder="Stock number, brand, reference, a name, a place…" value="${esc(va.q)}" aria-label="Search the vault activity">
      <a class="btn" href="#/logistics/vaultactivity-all">All records</a>
    </div>
    <div class="lg-subtabs" id="va-types" role="group" aria-label="What changed"></div>
    <div class="lg-subtabs" id="va-places" role="group" aria-label="Place"></div>
    <div class="count" id="va-count">Reading the vault's activity…</div>
    <div id="va-out"></div>
    <section id="va-holders"></section>`;
  let timer;
  $('#vaq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      va.q = e.target.value;
      drawVaultActivity();
    }, 150);
  });
  $('#va-types').addEventListener('click', (e) => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    va.type = b.dataset.t;
    drawVaultActivity();
  });
  $('#va-places').addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    va.place = b.dataset.p;
    drawVaultActivity();
  });
  lgOpenOnClick($('#va-out'), $('#va-holders'));
  let r;
  try {
    r = await api('/api/logistics/page/vaultactivity');
  } catch (err) {
    if (seq === lgPage && $('#va-count')) $('#va-count').textContent = `Could not read the vault's activity: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#va-out')) return;
  va.data = r;
  if (va.type && !r.by_type.some((t) => t.type === va.type)) va.type = '';
  if (va.place && !r.by_place.some((p) => p.place === va.place)) va.place = '';
  drawVaultActivity();
};

const vaOurs = (x) =>
  x.watch
    ? `<a href="#/watch/${x.watch.id}"><b>#${esc(x.stock_no || x.watch.stock_no)}</b></a> ${chip(x.watch.status)}<div class="count" style="margin:2px 0 0">${esc(x.watch.title)}</div>${
        x.watch.bought_from ? `<div class="count" style="margin:0">Bought from <a href="#/client/${x.watch.bought_from.id}">${esc(x.watch.bought_from.name)}</a></div>` : ''
      }${x.watch.sold_to ? `<div class="count" style="margin:0">Sold to <a href="#/client/${x.watch.sold_to.id}">${esc(x.watch.sold_to.name)}</a></div>` : ''}`
    : x.stock_no
      ? `<b>#${esc(x.stock_no)}</b><div class="count" style="margin:2px 0 0">${esc([x.brand, x.reference && `Ref ${x.reference}`].filter(Boolean).join(' · ') || 'Not one of our watches')}</div>`
      : `<span class="blank">${esc([x.brand, x.reference && `Ref ${x.reference}`].filter(Boolean).join(' · ') || 'No stock number')}</span>`;

/* What changed, the app's reading of the notification, with its arrows and lists. */
function vaWhat(n) {
  const d = n.detail;
  if (n.type === 'location') return `<b>Location</b> <span class="va-from">${esc(d.from)}</span> → <b>${esc(d.to)}</b>`;
  if (n.type === 'accessory') {
    const parts = [
      d.added.length && `<span class="lg-tag good">Marked present: ${esc(d.added.join(', '))}</span>`,
      d.removed.length && `<span class="lg-tag">Removed from present: ${esc(d.removed.join(', '))}</span>`,
      d.now_missing.length && `<span class="lg-tag warn">Now missing: ${esc(d.now_missing.join(', '))}</span>`,
    ].filter(Boolean);
    return `<b>Accessories updated</b>${parts.length ? `<div class="va-tags">${parts.join('')}</div>` : ' <span class="count" style="margin:0">(no change to the lists)</span>'}`;
  }
  if (n.type === 'price') {
    const line = (label, now, was) => (now || was ? `<div>${label} ${now ? `<b>${esc(now)}</b>` : '<span class="blank">no new figure</span>'}${was ? ` <span class="count" style="margin:0">(was ${esc(was)})</span>` : ''}</div>` : '');
    const body = line('B2B', d.b2b, d.b2b_was) + line('B2C', d.b2c, d.b2c_was);
    return `<b>Price updated</b>${body || ' <span class="count" style="margin:0">(no figures stated)</span>'}`;
  }
  return esc(n.words);
}
const vaStatus = (s) => (s === 'approved' ? lgChip('applied') : s === 'pending' ? lgChip('pending') : s === 'dismissed' ? lgChip('dismissed') : s ? lgChip(s) : '');

function drawVaultActivity() {
  const r = va.data;
  if (!r || !$('#va-out')) return;
  const where = (k) => r.holders_by_where.find((x) => x.where === k)?.n || 0;
  $('#va-tiles').innerHTML = [
    ['', r.notifications.length, 'Vault changes', 'notified by the vault'],
    [r.pending ? 'warn' : '', r.pending, 'Waiting', 'not yet applied in the app'],
    ['warn', where('client'), 'Out with a client', 'by the vault\'s tracking'],
    ['warn', where('souk'), 'At the Gold Souk', 'polish or repair'],
    ['good', where('vault'), 'In the vault', 'office or home'],
  ]
    .map(([tone, n, label, small]) => `<div class="ov-tile ${tone}"><span class="ov-tile-label">${esc(label)}</span><b>${n}</b><small>${esc(small)}</small></div>`)
    .join('');
  $('#va-types').innerHTML = [{ type: '', n: r.notifications.length }, ...r.by_type]
    .map((t) => `<button type="button" class="pill${t.type === va.type ? ' on' : ''}" data-t="${esc(t.type)}" aria-pressed="${t.type === va.type}">${esc(t.type ? VA_TYPE[t.type] || t.type : 'All changes')}<b>${t.n}</b></button>`)
    .join('');
  $('#va-places').innerHTML =
    r.by_place.length > 1
      ? [{ place: '', n: r.notifications.length }, ...r.by_place].map((p) => `<button type="button" class="pill${p.place === va.place ? ' on' : ''}" data-p="${esc(p.place)}" aria-pressed="${p.place === va.place}">${esc(p.place || 'Every place')}<b>${p.n}</b></button>`).join('')
      : '';
  const words = va.q.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (x) => sfMatch(words, x.stock_no, x.brand, x.reference, x.place, x.holder, x.status, x.words, x.watch?.title, x.watch?.bought_from?.name, x.watch?.sold_to?.name);
  const notes = r.notifications.filter((n) => (!va.type || n.type === va.type) && (!va.place || n.place === va.place) && match(n));
  const n = notes.length;
  $('#va-count').textContent = `${n} change${n === 1 ? '' : 's'}${n !== r.notifications.length ? ` of ${r.notifications.length}` : ''} from the Watch vault, newest first`;
  $('#va-out').innerHTML = n
    ? `<div class="panel tscroll" style="padding:0"><table class="list lg va-table"><thead><tr><th>When</th><th>Watch</th><th>What changed</th><th>Place</th><th>In the app</th></tr></thead><tbody>${notes
        .map(
          (x) => `<tr data-id="${x.id}" tabindex="0">
            <td style="white-space:nowrap">${esc(fmtWhen(x.ts))}</td>
            <td>${vaOurs(x)}</td>
            <td>${vaWhat(x)}</td>
            <td>${esc(x.place || '—')}</td>
            <td>${vaStatus(x.status)}</td>
          </tr>`
        )
        .join('')}</tbody></table></div>`
    : `<p class="sub">${r.notifications.length ? 'No change matches.' : 'No Watch vault activity yet. Changes made in the Watch vault — a watch\'s place, accessories, prices — will appear here.'}</p>`;

  const holders = r.holders.filter((h) => (!va.place || h.place === va.place) && match(h));
  const since = (h) => (h.updated ? dayWords(h.updated) : '');
  $('#va-holders').innerHTML = `<h3 class="va-h">Who holds which watch <span class="count" style="margin:0;font-weight:400">${holders.length}${holders.length !== r.holders.length ? ` of ${r.holders.length}` : ''} · the vault's own tracking</span></h3>${
    holders.length
      ? `<div class="panel tscroll" style="padding:0"><table class="list lg va-table"><thead><tr><th>Watch</th><th>Where</th><th>With</th><th>Since</th><th>Place</th></tr></thead><tbody>${holders
          .map(
            (h) => `<tr data-id="${h.id}" tabindex="0">
              <td>${vaOurs(h)}${h.row_gone ? '<div class="count" style="margin:2px 0 0">No longer on the app\'s stock lists</div>' : ''}</td>
              <td><span class="chip ${VA_WHERE[h.where]?.[1] || 'lg-muted'}">${esc(h.status)}</span>${h.from_polish ? '<div class="count" style="margin:2px 0 0">At polish, as the stock row says</div>' : ''}</td>
              <td>${h.holder ? `<b>${esc(h.holder)}</b>` : '<span class="blank">—</span>'}</td>
              <td style="white-space:nowrap">${esc(since(h))}</td>
              <td>${esc(h.place || '—')}</td>
            </tr>`
          )
          .join('')}</tbody></table></div>`
      : `<p class="sub">${r.holders.length ? 'No watch matches.' : 'The vault has not recorded who holds any watch yet.'}</p>`
  }`;
}
