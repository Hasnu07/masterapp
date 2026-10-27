/*
 * Owner Decisions: the logistics app's "Owner Decision Center" (asked 27
 * Oct 2026, "all these tabs … keep each page how it is"): what the owner
 * has ruled on, what he has not, and what that means somebody has to do.
 * Its counters, "worth knowing", the possible consolidations, the execution
 * queue (approved watches by place → destination and collector), the
 * decisions by status and supplier with each one's instruction and
 * history, and the brief to the owner — composed as the app composes it,
 * with its options, to copy. Then every decision record and every brief
 * sent. Every watch is ours, with its clients; the supplier links as far
 * as the logistics client does. Sending on WhatsApp, voice notes and their
 * AI reading wait for the switch-over; a decision is written on the record.
 */
'use strict';
const odState = { open: new Set(), brief: { pick: 'location', picked: new Set(), group: 'supplier', includeSent: false, fields: { stock: true, ref: true, price: true, dest: true, notes: true, serial: false } }, data: null };

/* The app's OD_SECTIONS, in its order. */
const OD_SECTIONS = [
  ['need', 'Needs owner decision', (i) => i.status === 'DECISION_NEEDED'],
  ['sent', 'Awaiting owner response', (i) => ['SENT_TO_OWNER', 'VOICE_RECEIVED', 'AI_PROCESSING'].includes(i.status)],
  ['clarify', 'Needs clarification', (i) => ['NEEDS_CLARIFICATION', 'AWAITING_CONFIRMATION'].includes(i.status)],
  ['approved', 'Approved — ready to execute', (i) => i.status === 'APPROVED'],
  ['hold', 'On hold', (i) => i.status === 'HOLD'],
  ['exec', 'In execution', (i) => i.status === 'IN_EXECUTION'],
  ['done', 'Recently completed', (i) => i.status === 'COMPLETED'],
];
const OD_TONE = { DECISION_NEEDED: 'lg-bad', SENT_TO_OWNER: 'lg-warn', VOICE_RECEIVED: 'lg-warn', AI_PROCESSING: 'lg-warn', NEEDS_CLARIFICATION: 'lg-warn', AWAITING_CONFIRMATION: 'lg-blue', APPROVED: 'lg-good', IN_EXECUTION: 'lg-blue', HOLD: 'lg-muted', COMPLETED: 'lg-good', NOT_ASKED: 'lg-muted' };
const odChip = (i) => `<span class="chip ${OD_TONE[i.status] || 'lg-muted'}">${esc(i.status_label || i.status)}</span>`;
const OD_NO_SUP = 'No client';
const OD_NO_LOC = 'Unknown location';
/* The app's incGroupBy + incSortGroups: by count, then name; the unknown last. */
function odGroups(rows, key, unknown) {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].sort((a, b) => (a[0] === unknown ? 1 : b[0] === unknown ? -1 : b[1].length - a[1].length || a[0].localeCompare(b[0])));
}
/* The app's flags in the brief it sends — the message as the owner reads it on WhatsApp. */
const OD_FLAGS = {
  switzerland: '🇨🇭', spain: '🇪🇸', italy: '🇮🇹', dubai: '🇦🇪', uae: '🇦🇪', 'united arab emirates': '🇦🇪', 'abu dhabi': '🇦🇪', germany: '🇩🇪', uk: '🇬🇧', 'united kingdom': '🇬🇧', england: '🇬🇧', london: '🇬🇧',
  france: '🇫🇷', paris: '🇫🇷', usa: '🇺🇸', 'united states': '🇺🇸', america: '🇺🇸', 'hong kong': '🇭🇰', hk: '🇭🇰', japan: '🇯🇵', singapore: '🇸🇬', china: '🇨🇳', netherlands: '🇳🇱', holland: '🇳🇱', belgium: '🇧🇪',
  austria: '🇦🇹', portugal: '🇵🇹', greece: '🇬🇷', turkey: '🇹🇷', qatar: '🇶🇦', 'saudi arabia': '🇸🇦', kuwait: '🇰🇼', bahrain: '🇧🇭', oman: '🇴🇲', india: '🇮🇳', pakistan: '🇵🇰', thailand: '🇹🇭',
  malaysia: '🇲🇾', australia: '🇦🇺', canada: '🇨🇦', poland: '🇵🇱', sweden: '🇸🇪', denmark: '🇩🇰', norway: '🇳🇴', finland: '🇫🇮', 'czech republic': '🇨🇿', romania: '🇷🇴', russia: '🇷🇺', monaco: '🇲🇨',
  luxembourg: '🇱🇺', ireland: '🇮🇪', israel: '🇮🇱', lebanon: '🇱🇧', egypt: '🇪🇬', morocco: '🇲🇦', 'south africa': '🇿🇦', brazil: '🇧🇷', mexico: '🇲🇽', korea: '🇰🇷', 'south korea': '🇰🇷', taiwan: '🇹🇼',
  vietnam: '🇻🇳', indonesia: '🇮🇩', philippines: '🇵🇭', 'new zealand': '🇳🇿', argentina: '🇦🇷', chile: '🇨🇱',
};
const odFlag = (name) => OD_FLAGS[String(name || '').trim().toLowerCase()] || '📍';

LG_PAGES.ownerdecisions = async function () {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('ownerdecisions')}
    <p class="sub" style="margin:0 0 12px">What the owner has ruled on, what he has not, and what that means somebody has to do. <span class="od-waits" id="od-waits"></span></p>
    <div class="od-tiles" id="od-tiles"></div>
    <div id="od-notes"></div>
    <div id="od-cons"></div>
    <h2 class="sf-h od-sec-h">Execution queue</h2>
    <div id="od-exec"></div>
    <details class="panel od-brief" id="od-brief-box"><summary><h2 class="sf-h">Prepare a brief for the owner</h2><span class="count" style="margin:0" id="od-brief-n"></span></summary><div id="od-brief"></div></details>
    <h2 class="sf-h od-sec-h">Decisions</h2>
    <div class="count" id="od-count">Reading the decisions…</div>
    <div id="od-sections"></div>
    <h2 class="sf-h od-sec-h">Every decision record</h2>
    <p class="count" style="margin:0 0 8px">The app's page shows a decision only while its watch is still incoming; the records are all kept here.</p>
    <div id="od-records"></div>
    <h2 class="sf-h od-sec-h">Briefs sent to the owner</h2>
    <div id="od-briefs"></div>`;
  $('#od-sections').addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle]');
    if (!t || e.target.closest('a')) return;
    const id = Number(t.dataset.toggle);
    if (odState.open.has(id)) odState.open.delete(id);
    else odState.open.add(id);
    odDrawSections();
  });
  $('#od-sections').addEventListener('keydown', (e) => {
    const t = e.target.closest('[data-toggle]');
    if (!t || e.target !== t || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    t.click();
  });
  $('#od-brief').addEventListener('click', (e) => {
    const b = odState.brief;
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      b.pick = pick.dataset.pick;
      b.picked = new Set();
      odDrawBrief();
      return;
    }
    const group = e.target.closest('[data-group]');
    if (group) {
      b.group = group.dataset.group;
      odDrawBrief();
      return;
    }
    if (e.target.closest('#od-copy')) {
      const text = odBriefText(odBriefCandidates());
      navigator.clipboard?.writeText(text).then(
        () => flash('Brief copied'),
        () => flash('Could not copy', true)
      );
    }
  });
  $('#od-brief').addEventListener('change', (e) => {
    const b = odState.brief;
    const t = e.target;
    if (t.dataset.name !== undefined) {
      if (b.picked.has(t.dataset.name)) b.picked.delete(t.dataset.name);
      else b.picked.add(t.dataset.name);
    } else if (t.dataset.field) b.fields[t.dataset.field] = t.checked;
    else if (t.id === 'od-sent') b.includeSent = t.checked;
    else return;
    odDrawBrief();
  });
  lgOpenOnClick($('#od-records'));
  let r;
  try {
    r = await api('/api/logistics/page/ownerdecisions');
  } catch (err) {
    if (seq === lgPage && $('#od-count')) $('#od-count').textContent = `Could not read the decisions: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#od-sections')) return;
  odState.data = r;
  $('#od-waits').textContent = r.waits;
  odDrawCenter();
};

const odOurs = (i) => {
  const o = i.watch;
  if (!o) return '<span class="blank">Not one of our watches yet</span>';
  return `<a href="#/watch/${o.id}">Our watch #${esc(o.stock_no)}</a> ${chip(o.status)}${o.bought_from ? ` · bought from <a href="#/client/${o.bought_from.id}">${esc(o.bought_from.name)}</a>` : ''}${
    o.sold_to ? ` · sold to <a href="#/client/${o.sold_to.id}">${esc(o.sold_to.name)}</a>` : ''
  }`;
};
const odPrice = (i) => (i.buy ? money(i.buy.amount, i.buy.currency) : '');
const odTitle = (i) => esc([i.brand, i.reference].filter(Boolean).join(' ') || '—');

function odDrawCenter() {
  const r = odState.data;
  if (!r || !$('#od-sections')) return;
  const rows = r.rows;
  const c = {};
  for (const i of rows) c[i.status] = (c[i.status] || 0) + 1;
  const tiles = [
    ['Decision needed', c.DECISION_NEEDED || 0, 'bad'],
    ['Sent to owner', (c.SENT_TO_OWNER || 0) + (c.VOICE_RECEIVED || 0) + (c.AI_PROCESSING || 0), 'warn'],
    ['Awaiting / unclear', (c.AWAITING_CONFIRMATION || 0) + (c.NEEDS_CLARIFICATION || 0), 'warn'],
    ['Approved', c.APPROVED || 0, 'good'],
    ['On hold', c.HOLD || 0, ''],
    ['In execution', c.IN_EXECUTION || 0, 'blue'],
  ];
  $('#od-tiles').innerHTML = tiles.map(([label, n, tone]) => `<div class="od-tile ${tone}${n ? '' : ' zero'}"><b>${n}</b><span>${esc(label)}</span></div>`).join('');
  lgSetCount?.('ownerdecisions', c.DECISION_NEEDED || 0);

  // Worth knowing, as the app says it.
  const due = rows.filter((i) => i.review_due).length;
  const stale = rows.filter((i) => i.changed).length;
  const noDest = rows.filter((i) => !i.destination && i.status === 'DECISION_NEEDED').length;
  const notes = [
    due && `${due} deferred review${due === 1 ? '' : 's'} due now`,
    stale && `${stale} approved decision${stale === 1 ? '' : 's'} changed since the owner ruled`,
    noDest && `${noDest} ha${noDest === 1 ? 's' : 've'} no destination set`,
    r.consolidations.length && `${r.consolidations.length} possible consolidation${r.consolidations.length === 1 ? '' : 's'}`,
  ].filter(Boolean);
  $('#od-notes').innerHTML = notes.length ? `<div class="panel inc-attn"><b class="od-attn-l">Worth knowing</b>${notes.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : '';

  const byId = new Map(rows.map((i) => [i.id, i]));
  $('#od-cons').innerHTML = r.consolidations
    .slice(0, 5)
    .map(
      (g) => `<div class="panel od-cons"><div><b>${esc(g.route)}</b> — ${g.items.length} watches across ${g.suppliers.length} suppliers could travel together: ${g.suppliers.map(esc).join(', ')}.</div>
        <div class="count" style="margin:4px 0 0">${g.items.map((id) => byId.get(id)).filter(Boolean).map((i) => `<a href="#/lg/${i.id}">#${esc(i.stock_no || '—')}</a>`).join(', ')} · A suggestion only — the owner decides whether they go together.</div></div>`
    )
    .join('');

  // The execution queue: the app's groups, its Create collection / Assign collector / Mark arranged on the record here.
  $('#od-exec').innerHTML = r.execution.length
    ? r.execution
        .map((g) => {
          const items = g.items.map((id) => byId.get(id)).filter(Boolean);
          return `<section class="panel od-route">
            <div class="shp-sec-h"><div><b class="od-route-t">${esc(g.from)} → ${esc(g.to)}</b><div class="count" style="margin:2px 0 0">${g.collector ? `Collector: <b>${esc(g.collector)}</b>` : 'No collector assigned'}</div></div><span class="count" style="margin:0">${items.length} watch${items.length === 1 ? '' : 'es'}</span></div>
            ${odGroups(items, (i) => i.supplier, OD_NO_SUP)
              .map(([sup, list]) => `<div class="od-route-sup">${lgPerson(sup, list[0].supplier_link)}</div>${list.map((i) => `<div class="od-route-w"><span>${odTitle(i)} <span class="lg-stock">#${esc(i.stock_no || '—')}</span></span><span class="count" style="margin:0">${odOurs(i)}</span>${i.decision?.instruction ? `<div class="od-quote">“${esc(i.decision.instruction.slice(0, 120))}”</div>` : ''}</div>`).join('')}`)
              .join('')}
            ${lgOdGroupActs(g) || '<p class="count" style="margin:8px 0 0">Create a collection, assign a collector, mark arranged: an editor can, from here.</p>'}
          </section>`;
        })
        .join('')
    : '<p class="count" style="margin:0 0 12px">Nothing approved to execute yet.</p>';

  odDrawBrief();
  odDrawSections();

  // Every decision record, live or not.
  $('#od-records').innerHTML = r.records.length
    ? `<div class="panel tscroll" style="padding:0"><table class="list lg"><thead><tr><th>Stock · our watch</th><th>Status</th><th>What was decided</th><th>Its incoming</th><th>Last change</th></tr></thead><tbody>${r.records
        .map(
          (d) => `<tr data-id="${d.id}" tabindex="0">
            <td><span class="lg-stock">#${esc(d.stock_no || '—')}</span><div class="count" style="margin:2px 0 0">${odOurs(d)}</div></td>
            <td>${odChip(d)}${d.locked ? ' <span class="chip lg-muted">edited here</span>' : ''}</td>
            <td><a href="#/lg/${d.id}">${esc(d.words || (d.instruction ? d.instruction.slice(0, 60) : 'Nothing written yet'))}</a></td>
            <td>${d.incoming_id ? `<a href="#/lg/${d.incoming_id}">${d.incoming_live ? 'still incoming' : esc(d.incoming_status || 'done')}</a>` : '<span class="blank">gone</span>'}</td>
            <td class="count" style="margin:0;white-space:nowrap">${esc(fmtWhen(d.updated_at))}</td>
          </tr>`
        )
        .join('')}</tbody></table></div>`
    : '<p class="count" style="margin:0">No decision records yet.</p>';

  $('#od-briefs').innerHTML = r.briefs.length
    ? r.briefs
        .map(
          (b) => `<details class="panel od-sent"><summary><b>${esc(fmtWhen(b.at))}</b> · ${b.count} watch${b.count === 1 ? '' : 'es'}, by ${esc(b.group || 'supplier')}${b.to ? `, to ${esc(b.to)}` : ''}${
            b.by ? ` · sent by ${esc(b.by)}` : ''
          }<span class="count" style="margin:0 0 0 8px">${b.watches.map((w) => (w.incoming_id ? `<a href="#/lg/${w.incoming_id}">#${esc(w.stock_no || '?')}</a>` : '<span class="blank">gone</span>')).join(' ')}</span></summary><pre class="od-pre" data-nofx>${esc(b.text)}</pre><a class="count" href="#/lg/${b.id}">Open the record</a></details>`
        )
        .join('')
    : '<p class="count" style="margin:0">No brief has been sent yet.</p>';
}

function odDrawSections() {
  const r = odState.data;
  if (!r || !$('#od-sections')) return;
  const rows = r.rows;
  $('#od-count').textContent = `${rows.length} incoming watch${rows.length === 1 ? '' : 'es'} the owner can still rule on${r.as_of ? ` · the logistics app as read ${fmtWhen(r.as_of)}` : ''}`;
  const html = OD_SECTIONS.map(([key, title, test]) => {
    const items = rows.filter(test);
    if (!items.length) return '';
    return `<section class="od-sec od-${key}"><h3 class="od-sec-t">${esc(title)}<span class="count" style="margin:0 0 0 8px">${items.length}</span></h3>${odGroups(items, (i) => i.supplier, OD_NO_SUP)
      .map(
        ([sup, list]) => `<div class="panel od-sup"><div class="od-sup-h">${lgPerson(sup, list[0].supplier_link)}<span class="count" style="margin:0">${esc(list[0].location)} · ${list.length}</span></div>${list.map(odCard).join('')}</div>`
      )
      .join('')}</section>`;
  }).join('');
  $('#od-sections').innerHTML = html || '<div class="panel"><p class="sub" style="margin:0">No incoming watches to decide on.</p></div>';
}

function odCard(i) {
  const open = odState.open.has(i.id);
  const d = i.decision;
  return `<article class="od-card${open ? ' open' : ''}">
    <div class="od-top" data-toggle="${i.id}" tabindex="0" role="button" aria-expanded="${open}">
      <div class="od-ph">${i.picture ? `<img loading="lazy" decoding="async" src="${esc(fileUrl(i.picture, true))}" alt="">` : ''}</div>
      <div class="od-main">
        <div><span class="lg-stock">#${esc(i.stock_no || '—')}</span> ${odChip(i)}${i.review_due ? ' <span class="chip lg-warn">Review due</span>' : ''}</div>
        <div class="od-title"><a href="#/lg/${i.id}">${odTitle(i)}</a></div>
        <div class="count" style="margin:0">${lgPerson(i.supplier, i.supplier_link)} · ${esc(i.location)}${i.destination ? ` <b>→ ${esc(i.destination)}</b>` : ''}${i.eta ? ` · expected ${esc(dayWords(i.eta))}` : ''}</div>
        <div class="count" style="margin:0">${odOurs(i)}</div>
      </div>
      <div class="od-mid">
        ${i.words ? `<div class="od-instr">${esc(i.words)}</div>` : ''}
        ${odPrice(i) ? `<div class="od-price">${odPrice(i)}</div>` : ''}
        ${i.changed ? `<div class="od-warn">${esc(i.changed)}</div>` : ''}
      </div>
      <div class="od-acts">${lgOdCardActs(i)}<a class="btn small" href="#/lg/${d ? d.id : i.id}">${d ? 'Open decision' : 'Open incoming'}</a></div>
    </div>
    ${open ? odPanel(i) : ''}
  </article>`;
}

/* The app's OwnerInstructionPanel: the instruction in the owner's words, how it was read, and everything since. */
function odPanel(i) {
  const d = i.decision;
  if (!d) return `<div class="od-body"><p class="count" style="margin:0">No decision has been recorded for this watch yet. ${i.status === 'DECISION_NEEDED' ? 'It goes in the next brief to the owner.' : ''} ${can('editor') ? 'Decision writes one.' : ''}</p></div>`;
  return `<div class="od-body">
    ${d.instruction ? `<div class="od-l">Owner instruction</div><p class="od-quote">${esc(d.instruction)}</p>${d.has_voice ? '<p class="count" style="margin:0 0 8px">A voice note is on the record; it plays in the logistics app.</p>' : ''}` : ''}
    ${d.reading ? `<div class="od-l">How it was read</div><p class="count" style="margin:0 0 8px">${esc(d.reading)}</p>` : ''}
    ${[d.action_label && `Action: ${d.action_label}`, d.destination && `Destination: ${d.destination}`, d.collector && `Collector: ${d.collector}`, d.review_at && `Review on ${dayWords(d.review_at)}`, d.hold_until && `Hold until ${dayWords(d.hold_until)}`, d.priority && `Priority: ${d.priority}`]
      .filter(Boolean)
      .map((t) => `<span class="lg-tag">${esc(t)}</span>`)
      .join(' ')}
    <div class="od-l" style="margin-top:10px">History</div>
    <div class="od-tl">${d.events.length ? d.events.map((e) => `<div class="od-ev"><b>${esc(e.label)}</b><span class="count" style="margin:0">${esc([e.by, e.source, e.at && fmtWhen(e.at)].filter(Boolean).join(' · '))}</span></div>`).join('') : '<p class="count" style="margin:0">Nothing recorded yet.</p>'}</div>
    ${d.confirmed_at ? `<p class="count" style="margin:8px 0 0">Confirmed ${esc(fmtWhen(d.confirmed_at))}${d.confirmed_by ? ` by ${esc(d.confirmed_by)}` : ''}${d.source ? ` · ${esc(d.source)}` : ''}</p>` : ''}
    <p class="count" style="margin:8px 0 0">Start, Done, the status and the decision: the card's buttons. <a href="#/lg/${d.id}">The decision's record</a> has its fields and history.</p>
  </div>`;
}

/* ── the brief to the owner, as the app composes it ───────────────── */

/* The app's odBriefCandidates: new, changed under a decision he made, reviews due; the ones already with him when ticked. */
function odBriefAll() {
  const rows = odState.data?.rows || [];
  const out = [];
  const add = (i, why) => {
    if (!out.some((x) => x.inc.id === i.id)) out.push({ inc: i, why });
  };
  rows.filter((i) => i.status === 'DECISION_NEEDED').forEach((i) => add(i, 'new'));
  rows.filter((i) => i.changed).forEach((i) => add(i, i.changed));
  rows.filter((i) => i.review_due).forEach((i) => add(i, 'review due'));
  if (odState.brief.includeSent) rows.filter((i) => ['SENT_TO_OWNER', 'VOICE_RECEIVED', 'AI_PROCESSING'].includes(i.status)).forEach((i) => add(i, 'asked before'));
  return out;
}
const odSentAlready = () => (odState.data?.rows || []).filter((i) => ['SENT_TO_OWNER', 'VOICE_RECEIVED', 'AI_PROCESSING'].includes(i.status));
function odBriefCandidates() {
  const b = odState.brief;
  const all = odBriefAll();
  if (!b.picked.size) return all;
  return all.filter((x) => b.picked.has(b.pick === 'supplier' ? x.inc.supplier : x.inc.location));
}

function odDrawBrief() {
  const box = $('#od-brief');
  if (!box || !odState.data) return;
  const b = odState.brief;
  const all = odBriefAll();
  const sent = odSentAlready();
  const bySupplier = b.pick === 'supplier';
  const groups = odGroups(
    all.map((x) => x.inc),
    (i) => (bySupplier ? i.supplier : i.location),
    bySupplier ? OD_NO_SUP : OD_NO_LOC
  );
  const chosen = odBriefCandidates();
  const field = (key, label) => `<label class="od-check"><input type="checkbox" data-field="${key}"${b.fields[key] ? ' checked' : ''}> ${label}</label>`;
  $('#od-brief-n').textContent = chosen.length ? `${chosen.length} watch${chosen.length === 1 ? '' : 'es'} in this brief` : 'Nothing to ask about';
  box.innerHTML = `
    <p class="count" style="margin:0 0 8px">The owner is not sent the whole book: what is new, what changed under a decision he made, and what he asked to be reminded about — grouped as he thinks about them. Sending it on WhatsApp waits for the switch-over (the app's bot and its keys are not here): copy it, paste it to him yourself, then mark it sent — the brief is recorded and every watch in it goes to Sent to Owner, as the app's send does.</p>
    <div class="od-l">Who needs a decision</div>
    <div class="lg-subtabs" role="group" aria-label="Pick by"><button type="button" class="pill${bySupplier ? '' : ' on'}" data-pick="location" aria-pressed="${!bySupplier}">By country</button><button type="button" class="pill${bySupplier ? ' on' : ''}" data-pick="supplier" aria-pressed="${bySupplier}">By supplier</button></div>
    ${sent.length ? `<label class="od-check od-resend"><input type="checkbox" id="od-sent"${b.includeSent ? ' checked' : ''}> Ask again about the ${sent.length} already with him</label>` : ''}
    ${
      groups.length
        ? `<div class="od-rows">${groups
            .map(
              ([name, rows]) => `<label class="od-row"><input type="checkbox" data-name="${esc(name)}"${!b.picked.size || b.picked.has(name) ? ' checked' : ''}><b>${esc(name)}</b>${bySupplier ? `<span class="count" style="margin:0">${esc(rows[0].location)}</span>` : ''}<span class="count" style="margin:0 0 0 auto">${rows.length} ${rows.length === 1 ? 'watch' : 'watches'}</span></label>`
            )
            .join('')}</div>`
        : `<p class="count" style="margin:0 0 8px">${sent.length && !b.includeSent ? `Nothing new since the last brief. Tick the box above to ask him again about the ${sent.length} he already has.` : 'Nothing is waiting on the owner.'}</p>`
    }
    <div class="od-l">Group by</div>
    <div class="lg-subtabs" role="group" aria-label="Group by"><button type="button" class="pill${b.group === 'supplier' ? ' on' : ''}" data-group="supplier" aria-pressed="${b.group === 'supplier'}">Supplier</button><button type="button" class="pill${b.group === 'location' ? ' on' : ''}" data-group="location" aria-pressed="${b.group === 'location'}">Location</button></div>
    <div class="od-l">Include</div>
    <div class="od-fields">${field('stock', 'Stock number')}${field('ref', 'Reference')}${field('price', 'Buy price')}${field('dest', 'Destination')}${field('notes', 'Current notes')}${field('serial', 'Serial')}</div>
    <div class="od-l">This is exactly what he will get</div>
    <pre class="od-pre" id="od-preview" data-nofx>${esc(odBriefText(chosen))}</pre>
    <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center"><button type="button" class="btn gold" id="od-copy"${chosen.length ? '' : ' disabled'}>Copy the brief</button>${lgOdBriefSentBtn(b, chosen.length)}<span class="count" style="margin:0">Send on WhatsApp: waits for the switch-over.</span></div>`;
}

/* The app's odBriefText, line for line. */
function odBriefText(items) {
  if (!items.length) return 'Nothing to ask about.';
  const b = odState.brief;
  const f = b.fields;
  const changed = items.filter((x) => x.why !== 'new');
  const keyOf = (x) => (b.group === 'location' ? x.inc.location : x.inc.supplier);
  const groups = new Map();
  for (const x of items) {
    const k = keyOf(x);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const ordered = [...groups.entries()].sort((a, c) => c[1].length - a[1].length || a[0].localeCompare(c[0]));
  const lines = ['📦 INCOMINGS — FOR YOUR DECISION', ''];
  const again = items.filter((x) => x.why === 'asked before').length;
  lines.push(`When you have a moment, could I please have your instructions on ${items.length} watch${items.length === 1 ? '' : 'es'}?`);
  if (again) lines.push(`${again === items.length ? 'These are ones' : `${again} of these are ones`} I sent before — sorry to ask again.`);
  if (changed.length) lines.push(`${changed.length} of ${changed.length === 1 ? 'them you have' : 'these you have'} seen before — something has changed since.`);
  lines.push('');
  for (const [name, rows] of ordered) {
    const loc = b.group === 'location' ? name : rows[0].inc.location;
    const who = b.group === 'location' ? '' : name;
    lines.push(`${odFlag(loc)} ${(who || loc).toUpperCase()}${who ? ` — ${loc.toUpperCase()}` : ''}`);
    lines.push(`${rows.length} watch${rows.length === 1 ? '' : 'es'}`);
    lines.push('');
    for (const { inc, why } of rows.slice(0, 4)) {
      const head = [f.stock && inc.stock_no ? `#${inc.stock_no}` : '', f.ref ? inc.reference || '' : ''].filter(Boolean).join('  ');
      if (head) lines.push(head);
      const sub = [];
      if (inc.brand) sub.push(inc.brand);
      if (f.serial && inc.serial) sub.push(`SN ${inc.serial}`);
      if (sub.length) lines.push(sub.join(' · '));
      if (f.price && inc.buy) lines.push(`Buy: ${inc.buy.currency || 'USD'} ${Number(inc.buy.amount).toLocaleString()}`);
      if (f.dest && inc.destination) lines.push(`Destination: ${inc.destination}`);
      if (f.notes && inc.notes) lines.push(`Note: ${String(inc.notes).slice(0, 70)}`);
      if (why === 'asked before') lines.push('↩ sent before');
      else if (why && why !== 'new') lines.push(`⚠ ${why}`);
      lines.push('');
    }
    if (rows.length > 4) {
      lines.push(`+${rows.length - 4} more watch${rows.length - 4 === 1 ? '' : 'es'}`);
      lines.push('');
    }
    // The app's odConsolidationFor: watches heading the same way may travel together — a suggestion, never an action.
    const byDest = new Map();
    for (const { inc } of rows) if (inc.destination) byDest.set(inc.destination, (byDest.get(inc.destination) || 0) + 1);
    let best = '';
    let n = 0;
    for (const [k, v] of byDest) if (v > n) [n, best] = [v, k];
    if (n > 1) {
      lines.push(`💡 ${n} of these share the same destination — ${best}. They may be able to travel together.`);
      lines.push('');
    }
  }
  lines.push('🎙 Whenever it suits you, please send a voice note with how you would like these handled. Thank you.');
  return lines.join('\n');
}
