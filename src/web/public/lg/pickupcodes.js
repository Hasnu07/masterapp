/*
 * Pickup Codes: the logistics app's "Pickup Codes" page — a secret code sent
 * to two WhatsApp chats; the collector shows it to receive the item. Its
 * three figures (pending, completed, total) and a card per code, as the app
 * lays it out: the code, pickup or delivery, its status, the message for
 * Person A with the address, the message for Person B, the day and time, who
 * each person is and whether their message went. The two messages, built
 * word for word as the app sends them, can be copied. A new code, its
 * people, marking a message sent, done, edit and delete are the app's own
 * workflows done here (actions pc-…); sending by WhatsApp is not — its
 * bridge is not here, so a message is copied and marked as sent. A card
 * opens its record.
 */
'use strict';
const pc = { q: '', status: '', data: null };

LG_PAGES.pickupcodes = async function () {
  const seq = ++lgPage;
  pc.data = null;
  $('#app').innerHTML = `${lgHeader('pickupcodes')}
    <p class="sub" style="margin:0 0 12px">A secret code for a handover: Person A (the collector or sender) gets the address and the code, Person B (the holder or receiver) gets the same code — the collector shows it to receive the item.</p>
    <div class="ov-tiles pc-tiles" id="pc-tiles" aria-live="polite"></div>
    ${lgActionBar('pickupcodes')}
    <div class="lg-toolbar pc-toolbar">
      <input class="q" type="search" id="pcq" placeholder="Code, message, address, person, stock number…" value="${esc(pc.q)}" aria-label="Search pickup codes">
    </div>
    <div class="lg-subtabs" id="pc-status" role="group" aria-label="Status"></div>
    <div class="count" id="pc-count">Reading the pickup codes…</div>
    <div id="pc-out"></div>
    <p class="count pc-wait">WhatsApp is not sent from here: copy a message, send it yourself, then "Mark sent" records it as the app would. A person is a name here — the app's chat list is not available. Open a card to edit its record. <a href="#/logistics/pickupcodes-all">The records, as lists</a>.</p>`;
  let timer;
  $('#pcq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      pc.q = e.target.value;
      drawPickupCodes();
    }, 150);
  });
  $('#pc-status').addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    pc.status = b.dataset.s;
    drawPickupCodes();
  });
  // Copy a message as the app would send it; a card opens its record.
  $('#pc-out').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-copy]');
    if (!b || !pc.data) return;
    const c = pc.data.codes.find((x) => String(x.id) === b.dataset.id);
    if (!c) return;
    const textOf = b.dataset.copy === 'A' ? c.text_a : c.text_b;
    const was = b.textContent;
    navigator.clipboard?.writeText(textOf).then(
      () => {
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = was), 1500);
      },
      () => flash('Could not copy — select the message and copy it by hand.', true)
    );
  });
  lgOpenOnClick($('#pc-out'));
  let r;
  try {
    r = await api('/api/logistics/page/pickupcodes');
  } catch (err) {
    if (seq === lgPage && $('#pc-count')) $('#pc-count').textContent = `Could not read the pickup codes: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#pc-out')) return;
  pc.data = r;
  drawPickupCodes();
};

const pcStatusWords = { pending: 'Pending', completed: 'Completed', cancelled: 'Cancelled' };
const pcSent = (iso) => (iso ? `sent ${esc(sfDay(iso))}` : '<span class="blank">not sent</span>');
const pcPerson = (p) => (p ? `<b>${esc(p.name)}</b>${p.group ? ' <span class="chip lg-muted">group</span>' : ''}` : '<span class="blank">not set</span>');
/* Our watch for a number typed into the messages, with the client it was sold to. */
const pcStocks = (c) =>
  c.stocks.length
    ? `<div class="pc-stocks">${c.stocks
        .map((s) => {
          const o = s.watch;
          if (!o) return `<span class="lg-stock">#${esc(s.no)}</span> <span class="count" style="margin:0">not one of ours</span>`;
          return `<span><a href="#/watch/${o.id}" class="lg-stock">#${esc(o.stock_no)}</a> ${chip(o.status)} ${esc(o.title || '')}${
            o.sold_to ? ` · sold to <a href="#/client/${o.sold_to.id}">${esc(o.sold_to.name)}</a>` : o.bought_from ? ` · bought from <a href="#/client/${o.bought_from.id}">${esc(o.bought_from.name)}</a>` : ''
          }</span>`;
        })
        .join('<br>')}</div>`
    : '';

function drawPickupCodes() {
  const r = pc.data;
  if (!r || !$('#pc-out')) return;
  $('#pc-tiles').innerHTML = `
    <div class="panel ov-tile warn"><span class="ov-tile-label">Pending</span><b>${r.counts.pending}</b></div>
    <div class="panel ov-tile good"><span class="ov-tile-label">Completed</span><b>${r.counts.completed}</b></div>
    <div class="panel ov-tile"><span class="ov-tile-label">Total</span><b>${r.counts.total}</b></div>`;
  const statuses = ['pending', 'completed', 'cancelled'].filter((s) => r.codes.some((c) => c.status === s));
  $('#pc-status').innerHTML = [['', 'All', r.codes.length], ...statuses.map((s) => [s, pcStatusWords[s], r.codes.filter((c) => c.status === s).length])]
    .map(([s, label, n]) => `<button type="button" class="pill${pc.status === s ? ' on' : ''}" data-s="${s}" aria-pressed="${pc.status === s}">${label}<b>${n}</b></button>`)
    .join('');

  const words = pc.q.toLowerCase().split(/\s+/).filter(Boolean);
  const codes = r.codes
    .filter((c) => !pc.status || c.status === pc.status)
    .filter((c) => sfMatch(words, c.code, c.type, c.message_a, c.message_b, c.address?.name, c.address?.address, c.person_a?.name, c.person_b?.name, c.notes, c.date, ...c.stocks.map((s) => `${s.no} ${s.watch?.title || ''}`)));
  $('#pc-count').textContent = `${codes.length} code${codes.length === 1 ? '' : 's'}${words.length || pc.status ? ` of ${r.codes.length}` : ''}`;
  if (!codes.length) {
    $('#pc-out').innerHTML = `<p class="sub">${words.length || pc.status ? 'No pickup code matches.' : 'No pickup code yet.'}</p>`;
    return;
  }
  $('#pc-out').innerHTML = codes
    .map(
      (c) => `<article class="panel pc-card ${esc(c.status)}" data-id="${c.id}" tabindex="0" role="link" aria-label="${esc(`${c.type} code ${c.code}, ${pcStatusWords[c.status] || c.status}`)}">
        <div class="pc-top">
          <span class="pc-code">${esc(c.code || '—')}</span>
          <span class="chip ${c.type === 'delivery' ? 'lg-warn' : 'lg-blue'}">${c.type === 'delivery' ? 'Delivery' : 'Pickup'}</span>
          ${lgChip(c.status === 'cancelled' && c.status_word ? c.status_word : c.status)}
          ${c.locked ? '<span class="chip lg-muted" title="A field edited here — the app does not change it">edited here</span>' : ''}
        </div>
        <div class="pc-msgs">
          <div class="pc-msg a">
            <div class="pc-who">Person A — collector / sender · ${pcPerson(c.person_a)} · ${pcSent(c.sent_a)}</div>
            <div class="pc-body">${c.message_a ? esc(c.message_a) : '<span class="blank">no message written</span>'}</div>
            ${c.address ? `<div class="pc-addr">${c.address.name ? `<b>${esc(c.address.name)}</b><br>` : ''}${esc(c.address.address)}${c.address.saved ? '' : ' <span class="count" style="margin:0">(as the code kept it — not a saved address)</span>'}</div>` : ''}
            <div class="lg-rowacts"><button type="button" class="btn small" data-copy="A" data-id="${c.id}">Copy message for A</button>${lgActBtn('pc-sent', c.id, { label: c.sent_a ? 'Sent again to A' : 'Mark sent to A', extra: { who: 'A' } })}${lgActBtn('pc-person', c.id, { label: c.person_a ? 'Change A' : 'Set person A', extra: { who: 'A' } })}</div>
          </div>
          <div class="pc-msg b">
            <div class="pc-who">Person B — holder / receiver · ${pcPerson(c.person_b)} · ${pcSent(c.sent_b)}</div>
            <div class="pc-body">${c.message_b ? esc(c.message_b) : '<span class="blank">no message written</span>'}</div>
            <div class="lg-rowacts"><button type="button" class="btn small" data-copy="B" data-id="${c.id}">Copy message for B</button>${lgActBtn('pc-sent', c.id, { label: c.sent_b ? 'Sent again to B' : 'Mark sent to B', extra: { who: 'B' } })}${lgActBtn('pc-person', c.id, { label: c.person_b ? 'Change B' : 'Set person B', extra: { who: 'B' } })}</div>
          </div>
        </div>
        <div class="pc-meta">${esc([c.date ? sfDay(c.date) : 'no date', c.time_from && (c.time_to ? `${c.time_from} – ${c.time_to}` : c.time_from)].filter(Boolean).join(' · '))}${
          c.completed_at ? ` · completed ${esc(sfDay(c.completed_at))}` : ''
        }${c.created_at ? ` · made ${esc(sfDay(c.created_at))}` : ''}</div>
        ${c.notes ? `<div class="pc-notes">${esc(c.notes)}</div>` : ''}
        ${pcStocks(c)}
        <div class="lg-rowacts pc-acts">${c.status === 'pending' ? lgActBtn('pc-done', c.id, { cls: 'primary' }) : ''}${lgActBtn('pc-edit', c.id)}${lgActBtn('pc-delete', c.id)}</div>
      </article>`
    )
    .join('');
}
