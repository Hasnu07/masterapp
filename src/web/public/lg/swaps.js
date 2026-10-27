/*
 * Swaps: the logistics app's "Swaps" page in the console's look — a swap
 * settles one "I owe" item against one "they owe" item (an accessory taken
 * from one watch given with another). Each swap: the give side's reference
 * and accessory ↔ the receive side's, the notes, the time. Each side's stock
 * number is our watch with its clients; its client linked as the logistics
 * client is. New swap and delete change the app's records: they wait for the
 * switch-over.
 */
'use strict';
(() => {
  const ours = (s) => {
    const o = s.watch;
    if (!o) return '';
    return [
      `<a href="#/watch/${o.id}">Our watch #${esc(o.stock_no)}</a> ${chip(o.status)}`,
      o.bought_from && `bought from <a href="#/client/${o.bought_from.id}"><b>${esc(o.bought_from.name)}</b></a>`,
      o.sold_to && `sold to <a href="#/client/${o.sold_to.id}"><b>${esc(o.sold_to.name)}</b></a>`,
    ]
      .filter(Boolean)
      .join(' · ');
  };
  /* One side of the swap: the transaction's reference and the accessory, as the app writes "<ref> <accessory>"; '?' when the app no longer has it. */
  const side = (s, what) =>
    !s
      ? `<div class="swp-side"><b class="swp-what">${what}</b><span class="blank">? — transaction no longer in the app</span></div>`
      : `<div class="swp-side"><b class="swp-what">${what}</b>
          <div><a href="#/lg/${s.id}"><b>${esc(s.reference || s.stock_no || 'Transaction')}</b></a> ${s.accessory ? `<span class="lg-tag">${esc(s.qty > 1 ? `${s.accessory} × ${s.qty}` : s.accessory)}</span>` : '<span class="blank">? item no longer on it</span>'}</div>
          <div class="count" style="margin:0">${[s.type === 'sold' ? 'Sold' : s.type === 'bought' ? 'Bought' : '', s.brand, s.client ? `client ${lgPerson(s.client.name, s.client)}${s.client.country ? ` (${esc(s.client.country)})` : ''}` : ''].filter(Boolean).join(' · ') || '—'}</div>
          ${ours(s) ? `<div class="count" style="margin:0">${ours(s)}</div>` : ''}
        </div>`;

  LG_PAGES.swaps = async function () {
    const seq = ++lgPage;
    $('#app').innerHTML = `${lgHeader('swaps')}
      <p class="sub" style="margin:0 0 4px">A swap settles one "we owe" item against one "they owe" item — useful when an accessory taken from one watch is given with another.</p>
      <p class="count" style="margin:0 0 12px">New swap and delete change the logistics app's records: they wait for the switch-over. Each side opens its transaction.</p>
      <div class="count" id="swp-count">Reading the swaps…</div>
      <div id="swp-out" class="swp-list"></div>`;
    let r;
    try {
      r = await api('/api/logistics/page/swaps');
    } catch (err) {
      if (seq === lgPage && $('#swp-count')) $('#swp-count').textContent = `Could not read the swaps: ${err.message}`;
      return;
    }
    if (seq !== lgPage || !$('#swp-out')) return;
    const n = r.swaps.length;
    $('#swp-count').textContent = `${n} swap${n === 1 ? '' : 's'}`;
    if (!n) {
      $('#swp-out').innerHTML = '<div class="panel"><p class="sub" style="margin:0">No swaps yet.</p></div>';
      return;
    }
    $('#swp-out').innerHTML = r.swaps
      .map(
        (s) => `<article class="panel swp-row">
          <div class="swp-head"><span class="chip reserved">Swap</span><span class="count" style="margin:0">${esc(fmtWhen(s.at) || '—')}</span></div>
          <div class="swp-sides">${side(s.give, 'We gave')}<span class="swp-arrow" aria-hidden="true">↔</span>${side(s.receive, 'We received')}</div>
          ${s.notes ? `<div class="count swp-notes">${esc(s.notes)}</div>` : ''}
          <div class="count" style="margin:0"><a href="#/lg/${s.id}">Open the swap's record</a></div>
        </article>`
      )
      .join('');
  };
})();
