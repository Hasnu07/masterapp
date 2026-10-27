/*
 * Accessory History: the logistics app's "Accessory Transaction History" in
 * the console's look — every transaction, newest first, with its full
 * settlement timeline: what was given, what was collected, when, and the
 * proof photos. Filtered by client as the app, searched too. The stock
 * number is our watch with its clients; the client as the logistics app's
 * id, linked to ours as that client is. Settle, add / change / remove an
 * accessory, edit, delete and undo a settlement are the app's own buttons,
 * done here (actions/accessories.js); proof photos go on a settlement
 * through the upload control.
 */
'use strict';
(() => {
  const hi = { client: '', q: '', data: null };
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const itemWords = (it) => esc(it.qty > 1 ? `${it.accessory} × ${it.qty}` : it.accessory);
  const typeChip = (t) => (t.type === 'sold' ? '<span class="chip sold">Sold</span>' : t.type === 'bought' ? '<span class="chip in_stock">Bought</span>' : `<span class="chip other">${esc(t.type || 'Transaction')}</span>`);
  const client = (t) => (t.client ? lgPerson(t.client.name, t.client) + (t.client.country ? ` <span class="count" style="margin:0">(${esc(t.client.country)})</span>` : '') : '<span class="blank">client not listed</span>');
  const ours = (t) => {
    const o = t.watch;
    if (!o) return '<span class="blank">Not one of our watches</span>';
    return [
      `<a href="#/watch/${o.id}">Our watch #${esc(o.stock_no)}</a> ${chip(o.status)}`,
      o.bought_from && `Bought from <a href="#/client/${o.bought_from.id}"><b>${esc(o.bought_from.name)}</b></a>`,
      o.sold_to && `Sold to <a href="#/client/${o.sold_to.id}"><b>${esc(o.sold_to.name)}</b></a>`,
    ]
      .filter(Boolean)
      .join(' · ');
  };

  LG_PAGES.history = async function () {
    const seq = ++lgPage;
    $('#app').innerHTML = `${lgHeader('history')}
      <p class="sub" style="margin:0 0 12px">Every accessory transaction with its full settlement timeline — what was given, what was collected, when, and the proof photos. Each is linked to our watch and its clients.</p>
      ${can('editor') ? `<div class="lg-actbar">${lgActBtn('tx-new')}${lgActBtn('swap-new')}</div>` : ''}
      <div class="lg-toolbar hi-toolbar">
        <input class="q" type="search" id="hi-q" placeholder="Stock number, reference, brand, client, accessory…" value="${esc(hi.q)}" aria-label="Search">
        <select id="hi-client" aria-label="Client"><option value="">All clients</option></select>
      </div>
      <div class="count" id="hi-count">Reading the history…</div>
      <div id="hi-out" class="hi-list"></div>`;
    let timer;
    $('#hi-q').addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        hi.q = e.target.value;
        draw();
      }, 150);
    });
    $('#hi-client').addEventListener('change', (e) => {
      hi.client = e.target.value;
      draw();
    });
    let r;
    try {
      r = await api('/api/logistics/page/history');
    } catch (err) {
      if (seq === lgPage && $('#hi-count')) $('#hi-count').textContent = `Could not read the history: ${err.message}`;
      return;
    }
    if (seq !== lgPage || !$('#hi-out')) return;
    hi.data = r;
    $('#hi-client').innerHTML = `<option value="">All clients</option>${r.clients.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.country ? ` (${esc(c.country)})` : ''}</option>`).join('')}`;
    if (!r.clients.some((c) => c.id === hi.client)) hi.client = '';
    $('#hi-client').value = hi.client;
    draw();
  };

  function draw() {
    const r = hi.data;
    if (!r || !$('#hi-out')) return;
    const words = hi.q.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = r.transactions.filter(
      (t) =>
        (!hi.client || t.client_id === hi.client) &&
        sfMatch(words, t.stock_no, t.reference, t.brand, t.notes, t.client?.name, t.client?.client_name, t.client?.country, ...t.items.map((it) => it.accessory), t.watch?.bought_from?.name, t.watch?.sold_to?.name)
    );
    const n = rows.length;
    const pending = rows.reduce((s, t) => s + t.pending, 0);
    const settlements = rows.reduce((s, t) => s + t.settlements.length, 0);
    $('#hi-count').textContent = `${plural(n, 'transaction')}${n < r.transactions.length ? ` of ${r.transactions.length}` : ''} · ${plural(pending, 'item')} pending · ${plural(settlements, 'settlement')}`;
    if (!n) {
      $('#hi-out').innerHTML = `<div class="panel"><p class="sub" style="margin:0">${r.transactions.length ? 'No transaction matches.' : 'No transactions yet.'}</p></div>`;
      return;
    }
    $('#hi-out').innerHTML = rows.map(txCard).join('');
  }

  /* One transaction, folded: the app's <details> — the summary line, then the pending items, the settlement timeline and the notes. */
  function txCard(t) {
    const pending = t.items.filter((it) => it.status === 'pending');
    const owe = t.type === 'sold' ? 'We owe the client' : 'The client owes us';
    return `<details class="panel hi-tx">
      <summary>
        <span class="hi-sum">${typeChip(t)}${/\d/.test(t.stock_no) ? `<span class="lg-stock">#${esc(t.stock_no)}</span>` : `<span>${esc(t.stock_no || '—')}</span>`}${
          t.reference && t.reference !== t.stock_no ? `<span class="count" style="margin:0">Ref ${esc(t.reference)}</span>` : ''
        }${t.brand ? `<span class="lg-tag">${esc(t.brand)}</span>` : ''}<span class="hi-client">${client(t)}</span></span>
        <span class="count hi-when">${esc(sfDay(t.date) || '—')} · ${t.pending} pending · ${t.done} settled</span>
      </summary>
      <div class="hi-body">
        <div class="hi-ours">${ours(t)}</div>
        <div class="lg-rowacts hi-open">${pending.length ? lgActBtn('tx-settle', t.id) : ''}${lgActBtn('tx-item-add', t.id)}${pending.length ? lgActBtn('tx-item-edit', t.id) + lgActBtn('tx-item-remove', t.id) : ''}${lgActBtn('tx-edit', t.id)}${lgActBtn('tx-delete', t.id)}<a class="btn small" href="#/lg/${t.id}">Open the record</a></div>
        ${
          pending.length
            ? `<div class="hi-pending"><b>${owe} (pending)</b><span class="lg-ov" style="margin:0">${pending.map((it) => `<span class="lg-tag warn">${itemWords(it)}</span>`).join('')}</span></div>`
            : ''
        }
        ${
          t.settlements.length
            ? `<div class="hi-timeline"><div class="count hi-tl-h">Settlement timeline</div>${t.settlements
                .map(
                  (s) => `<div class="hi-settle ${s.direction}">
                    <div class="hi-settle-head"><b>${s.direction === 'give' ? 'Delivered' : 'Received'}</b><span class="count" style="margin:0">${esc(fmtWhen(s.at) || '—')}</span></div>
                    <span class="lg-ov" style="margin:0">${s.items.map((x) => `<span class="lg-tag">${esc(x)}</span>`).join('') || '<span class="blank">items no longer on the transaction</span>'}</span>
                    ${s.notes ? `<div class="count" style="margin:6px 0 0">${esc(s.notes)}</div>` : ''}
                    <div class="lg-rowacts">${lgUploadCtl(s.id, 'photos', s.direction === 'give' ? 'Add delivery photos' : 'Add receiving photos')}${lgActBtn('tx-settle-undo', s.id, { label: 'Undo' })}</div>
                    ${
                      s.pictures.length
                        ? `<div class="hi-photos">${s.pictures.map((p) => `<a href="${esc(fileUrl(p, false))}" target="_blank" rel="noopener"><img loading="lazy" src="${esc(fileUrl(p, true))}" alt="Proof photo"></a>`).join('')}</div>`
                        : ''
                    }
                  </div>`
                )
                .join('')}</div>`
            : ''
        }
        ${t.notes ? `<div class="count hi-notes">${esc(t.notes)}</div>` : ''}
      </div>
    </details>`;
  }
})();
