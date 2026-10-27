/*
 * London Stock: the logistics app's "London Stock" page in the console's
 * look — and the one engine the app draws Dubai Stock and HK Stock with
 * (STOCK_LOC_CONFIG + renderLondonStock, switched by location). The three
 * tabs share this file: lg/dubaistock.js and lg/hkstock.js call
 * lgStockPage() with their own key.
 *
 * What the app's page has, and is here: In stock (rows current or on
 * consignment) as a list or as cards — the photo, stock number, received,
 * from, brand · model with its specs strip, reference, date, serial, cost
 * price / B2B / B2C, accessories present (+ the pending collect / give
 * badge), accessories missing, the place's two corners, polish, notes,
 * "not in Vault"; search; sort newest first or by stock number; the
 * History (rows moved out: moved on, destination, carrier, accessories
 * taken, spares left); the Spare Accessories by brand; Print. For Hong
 * Kong, the app's HK situation board too (sections, holder, stock status,
 * movements with their sales). Every row is OUR watch, linked with its
 * clients by Chrono Key's ids; a typed name links as far as it goes.
 *
 * Add row, Import CSV, Template, Reset, Move, Sold, Checkout, Consign,
 * Polish, Cost, the inline notes and the Vault switch change records: they
 * wait for the switch-over — a row opens its record (#/lg/<id>), which has
 * the edit form.
 */
'use strict';

/* Each tab's own state: what is typed, sorted, shown. */
const lgStockState = Object.create(null);
function lgStockOf(key) {
  if (!lgStockState[key]) {
    let view = 'list';
    try {
      view = localStorage.getItem(`masterapp.stockView.${key}`) || 'list';
    } catch {
      /* remembered for this visit only */
    }
    lgStockState[key] = { q: '', sort: 'new', view, chip: '', sub: 'stock', section: '', data: null };
  }
  return lgStockState[key];
}

const stNo = (s) => {
  const str = String(s ?? '').trim();
  const n = parseFloat(str.replace(/[^\d.-]/g, ''));
  return { has: !Number.isNaN(n) && /\d/.test(str), n, s: str.toLowerCase() };
};
/* The app's stock-number order: numbers first, by value; then the odd ones by their letters. */
const stCmpNo = (a, b) => {
  const A = stNo(a);
  const B = stNo(b);
  if (A.has && B.has && A.n !== B.n) return A.n - B.n;
  if (A.has && !B.has) return -1;
  if (!A.has && B.has) return 1;
  return A.s.localeCompare(B.s);
};
const stStock = (no) => `<span class="lg-stock">${/\d/.test(no || '') ? `#${esc(no)}` : esc(no && no !== '-' ? no : '—')}</span>`;
const stPrice = (p) => (p ? `${esc(p.currency)} ${esc(Number(p.amount).toLocaleString('en-GB', { maximumFractionDigits: 2 }))}` : '');
/* Our watch and our clients — by Chrono Key's ids, never the typed "from". */
const stOurs = (o) => {
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
/* The accessories lines of a row: with it, missing, and what is still to collect or give (the app's pending badge). */
const stAccessories = (w) =>
  [
    w.accessories_present && `<div class="st-acc good">With it: ${esc(w.accessories_present)}</div>`,
    w.accessories_missing && `<div class="st-acc bad">Missing: ${esc(w.accessories_missing)}</div>`,
    w.pending_collect.length && `<div class="st-acc warn">To collect: ${esc(w.pending_collect.join(', '))}</div>`,
    w.pending_give.length && `<div class="st-acc warn">To give: ${esc(w.pending_give.join(', '))}</div>`,
  ]
    .filter(Boolean)
    .join('');
/* What is worth knowing at a glance: consignment, polish, not in the Vault. */
const stTags = (w) =>
  [
    w.consignment &&
      (w.consignment.direction === 'from_client'
        ? `<span class="lg-tag warn">Consignment from ${esc(w.consignment.with || 'a client')}</span>`
        : `<span class="lg-tag warn">On consignment with ${esc(w.consignment.with || 'a client')}</span>`),
    w.polish && `<span class="lg-tag warn">At polish with ${esc(w.polish.sent_to)}</span>`,
    !w.polish && w.need_polish && '<span class="lg-tag">Needs polish</span>',
    w.hidden_from_vault && '<span class="lg-tag">Not in the Vault</span>',
  ]
    .filter(Boolean)
    .join('');
const stSpecs = (w) => esc([w.case_diameter, w.case_material, w.dial, w.bezel, w.movement].filter(Boolean).join(' · '));
const stIdent = (w) => esc([w.reference && `Ref ${w.reference}`, w.watch_date, w.serial && `SN ${w.serial}`].filter(Boolean).join(' · '));
const stTitle = (w) => esc([/^other$/i.test(w.brand) && w.model ? '' : w.brand, w.model].filter(Boolean).join(' ') || 'Watch');
/* The latest move written on a current row (accessories collected, given…): what it was and when. */
const stLastMove = (w) => {
  const m = w.movements[0];
  if (!m) return '';
  return `${w.movements.length} movement${w.movements.length === 1 ? '' : 's'} · ${esc([m.destination || m.type.replace(/_/g, ' '), sfDay(m.at) || m.day].filter(Boolean).join(', '))}`;
};
/* A corner's cell: "Yes" for a bare tick, else the words typed there ("box 3"). */
const stCorner = (w, key) => {
  const v = w.corners.find((x) => x.key === key)?.value;
  return v === 'yes' ? 'Yes' : v || '—';
};
const stConsignment = (w) => {
  const c = w.consignment;
  if (!c) return '';
  const who = c.with ? lgPerson(c.with, c.with_link) : 'a client';
  const when = [c.date && `since ${sfDay(c.date)}`, c.return_date && `due back ${sfDay(c.return_date)}`, c.accessories && `with ${c.accessories}`].filter(Boolean).join(' · ');
  return `<div class="st-cons">${c.direction === 'from_client' ? `A client’s watch on consignment from ${who}` : `On consignment with ${who}`}${when ? ` — ${esc(when)}` : ''}${
    c.notes ? `<div class="count" style="margin:2px 0 0">${esc(c.notes)}</div>` : ''
  }</div>`;
};
const stPolish = (w) => {
  if (w.polish) {
    const when = [w.polish.sent_date && `since ${sfDay(w.polish.sent_date)}`, w.polish.expected_back && `back ${sfDay(w.polish.expected_back)}`].filter(Boolean).join(', ');
    return `At polish with <b>${esc(w.polish.sent_to)}</b>${when ? ` · ${esc(when)}` : ''}`;
  }
  return w.need_polish ? 'Needs polish' : '';
};

async function lgStockPage(key) {
  const seq = ++lgPage;
  const st = lgStockOf(key);
  const hk = key === 'hkstock';
  $('#app').innerHTML = `${lgHeader(key)}
    <p class="sub" id="st-sub" style="margin:0 0 12px">Reading the stock…</p>
    <div class="lg-subtabs st-subs" id="st-subs" role="tablist" aria-label="Lists"></div>
    <div class="lg-toolbar st-toolbar">
      <input class="q" type="search" id="stq" placeholder="Stock number, reference, serial, brand, model, client, accessories, notes…" value="${esc(st.q)}" aria-label="Search">
      <select id="stsort" aria-label="Order">
        ${hk ? '<option value="section">By section (HK board)</option>' : ''}
        <option value="new">Newest first</option>
        <option value="stockAsc">Stock number, low to high</option>
        <option value="stockDesc">Stock number, high to low</option>
      </select>
      <div class="sf-view" role="group" aria-label="View">
        <button type="button" class="pill" data-v="list">List</button><button type="button" class="pill" data-v="cards">Cards</button>
      </div>
      <button type="button" class="btn" id="st-print" title="Print the list shown, or save it as a PDF">Print</button>
    </div>
    <div class="lg-subtabs st-chips" id="st-chips" role="group" aria-label="Show"></div>
    <div class="count" id="st-count"></div>
    <div id="st-out"></div>`;
  $('#stsort').value = st.sort;
  if ($('#stsort').value !== st.sort) $('#stsort').value = st.sort = 'new';
  let timer;
  $('#stq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      st.q = e.target.value;
      lgStockDraw(key);
    }, 150);
  });
  $('#stsort').addEventListener('change', (e) => {
    st.sort = e.target.value;
    lgStockDraw(key);
  });
  $$('.sf-view .pill').forEach((b) =>
    b.addEventListener('click', () => {
      st.view = b.dataset.v;
      try {
        localStorage.setItem(`masterapp.stockView.${key}`, st.view);
      } catch {
        /* remembered for this visit only */
      }
      lgStockDraw(key);
    })
  );
  $('#st-subs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sub]');
    if (!b) return;
    st.sub = b.dataset.sub;
    st.chip = '';
    st.section = '';
    lgStockDraw(key);
  });
  $('#st-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-chip]');
    if (!b) return;
    if (st.sub === 'board') st.section = b.dataset.chip;
    else st.chip = b.dataset.chip;
    lgStockDraw(key);
  });
  // The app's "Print / PDF": the current rows as a table, with the search and sort in force.
  $('#st-print').addEventListener('click', () => {
    if (st.view !== 'list') {
      st.view = 'list';
      lgStockDraw(key);
    }
    window.print();
  });
  lgOpenOnClick($('#st-out'));
  let r;
  try {
    r = await api(`/api/logistics/page/${key}`);
  } catch (err) {
    if (seq === lgPage && $('#st-count')) $('#st-count').textContent = `Could not read the stock: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#st-out')) return;
  st.data = r;
  $('#st-sub').innerHTML = `The logistics app’s ${esc(r.place === 'Hong Kong' ? 'HK' : r.place)} Stock page — ${esc(r.note)}. Every row is our watch, linked with the clients it was bought from and sold to.
    ${r.as_of ? `Read from the logistics app ${esc(fmtWhen(r.as_of))}.` : ''}
    Adding, moving, selling, checking out, consigning, polishing and the notes wait for the switch-over: a row opens its record, which has the edit form. Clients’ watches we hold are on the <a href="#/logistics/safe">In Safe</a> tab.`;
  lgStockDraw(key);
}

/* Which rows a chip keeps. */
const stChipKeeps = (w, chip) =>
  !chip ||
  (chip === 'plain' && w.status === 'current') ||
  (chip === 'consignment_to' && w.consignment?.direction === 'to_client') ||
  (chip === 'consignment_from' && w.consignment?.direction === 'from_client') ||
  (chip === 'need_polish' && w.need_polish && !w.polish) ||
  (chip === 'at_polish' && Boolean(w.polish)) ||
  (chip === 'ours' && Boolean(w.watch)) ||
  (chip === 'not_ours' && !w.watch) ||
  (chip.startsWith('corner:') && w.corners.some((c) => c.key === chip.slice(7)));

function lgStockDraw(key) {
  const st = lgStockOf(key);
  const r = st.data;
  if (!r || !$('#st-out')) return;
  const c = r.counts;
  $$('.sf-view .pill').forEach((b) => b.classList.toggle('on', b.dataset.v === st.view));
  const subs = [
    ['stock', `In stock`, c.in_stock],
    ['history', 'History', c.moved],
    ['spares', 'Spare accessories', c.spares],
    ...(r.situation ? [['board', 'HK situation', r.situation.rows.length]] : []),
  ];
  $('#st-subs').innerHTML = subs
    .map(([k, label, n]) => `<button type="button" class="pill${st.sub === k ? ' on' : ''}" role="tab" data-sub="${k}" aria-selected="${st.sub === k}">${esc(label)}<b>${n}</b></button>`)
    .join('');
  const words = st.q.toLowerCase().split(/\s+/).filter(Boolean);
  const sort = (rows, by) =>
    rows.sort((a, b) =>
      st.sort === 'stockAsc' ? stCmpNo(a.stock_no, b.stock_no) : st.sort === 'stockDesc' ? stCmpNo(b.stock_no, a.stock_no) : by(a, b)
    );
  $('#st-print').hidden = st.sub === 'spares';

  if (st.sub === 'history') {
    $('#st-chips').innerHTML = '';
    const rows = sort(
      r.history.filter((w) => sfMatch(words, w.stock_no, w.brand, w.model, w.reference, w.serial, w.from, w.watch?.bought_from?.name, w.watch?.sold_to?.name, w.movements[0]?.destination, w.movements[0]?.carrier, w.notes)),
      (a, b) => String(b.moved_at || '').localeCompare(String(a.moved_at || '')) || b.id - a.id
    );
    $('#st-count').textContent = `${rows.length}${words.length ? ` of ${r.history.length}` : ''} watch${rows.length === 1 ? '' : 'es'} moved out of ${r.place}. “Move back” waits for the switch-over: open the row’s record.`;
    if (!rows.length) {
      $('#st-out').innerHTML = `<p class="sub">${words.length ? 'Nothing moved out matches.' : `Nothing has been moved out of ${esc(r.place)} yet — a watch moved on in the logistics app shows here.`}</p>`;
      return;
    }
    $('#st-out').innerHTML = `<div class="panel tscroll" style="padding:0"><table class="list lg st-table"><thead><tr>
        <th>Moved on</th><th>Stock</th><th>Watch</th><th>From</th><th>Destination</th><th>Accessories taken</th><th>Spares left</th><th>Ours · client</th>
      </tr></thead><tbody>${rows
        .map((w) => {
          const m = w.movements[0] || { taken: [], left: [] };
          return `<tr data-id="${w.id}" tabindex="0">
            <td style="white-space:nowrap">${esc(sfDay(m.at || w.moved_at) || m.day || '—')}</td>
            <td style="white-space:nowrap">${stStock(w.stock_no)}</td>
            <td class="st-watch"><a href="#/lg/${w.id}"><b>${stTitle(w)}</b></a>${stIdent(w) ? `<div class="count" style="margin:2px 0 0">${stIdent(w)}</div>` : ''}</td>
            <td>${lgPerson(w.from, w.from_link, '—')}</td>
            <td>${esc(m.destination || m.type.replace(/_/g, ' ') || '—')}${m.carrier ? `<div class="count" style="margin:2px 0 0">by ${esc(m.carrier)}</div>` : ''}${m.notes ? `<div class="count" style="margin:2px 0 0">${esc(m.notes)}</div>` : ''}</td>
            <td class="st-small">${esc(m.taken.join(', ') || '—')}</td>
            <td class="st-small">${esc(m.left.join(', ') || '—')}</td>
            <td>${stOurs(w.watch)}</td>
          </tr>`;
        })
        .join('')}</tbody></table></div>`;
    return;
  }

  if (st.sub === 'spares') {
    $('#st-chips').innerHTML = '';
    const rows = r.spares.filter((s) => sfMatch(words, s.brand, s.accessory, s.from_stock, s.from_watch, s.notes));
    $('#st-count').textContent = `${rows.length}${words.length ? ` of ${r.spares.length}` : ''} spare accessor${rows.length === 1 ? 'y' : 'ies'} in ${r.place}${c.spare_items !== c.spares && !words.length ? ` (${c.spare_items} pieces)` : ''} — left behind when a watch moved out without them.`;
    if (!rows.length) {
      $('#st-out').innerHTML = `<p class="sub">${words.length ? 'No spare accessory matches.' : 'No spare accessories yet. Spares collect when a watch moves out and some of its accessories stay behind.'}</p>`;
      return;
    }
    const brands = [...new Set(rows.map((s) => s.brand || '(no brand)'))].sort((a, b) => a.localeCompare(b));
    $('#st-out').innerHTML = brands
      .map((b) => {
        const mine = rows.filter((s) => (s.brand || '(no brand)') === b);
        return `<section class="panel st-brand"><h3>${esc(b)} <span class="count" style="margin:0">· ${mine.length} item${mine.length === 1 ? '' : 's'}</span></h3>
          <div class="tscroll"><table class="list lg st-table"><thead><tr><th>Accessory</th><th>Qty</th><th>From stock</th><th>From watch</th><th>Added</th><th>Notes</th></tr></thead><tbody>${mine
            .map(
              (s) => `<tr data-id="${s.id}" tabindex="0">
                <td><a href="#/lg/${s.id}"><b>${esc(s.accessory || '—')}</b></a></td>
                <td>${s.qty}</td>
                <td style="white-space:nowrap">${s.watch ? `<a href="#/watch/${s.watch.id}">#${esc(s.from_stock)}</a> ${chip(s.watch.status)}` : stStock(s.from_stock)}</td>
                <td class="st-small">${esc(s.from_watch || '—')}</td>
                <td style="white-space:nowrap">${esc(sfDay(s.added_at) || '—')}</td>
                <td class="st-small">${esc(s.notes || '')}</td>
              </tr>`
            )
            .join('')}</tbody></table></div></section>`;
      })
      .join('');
    return;
  }

  if (st.sub === 'board') {
    lgStockDrawBoard(key, st, r, words);
    return;
  }

  /* In stock: the app's list / cards. */
  const chips = [
    ['', 'All', c.in_stock],
    ['plain', 'On the shelf', c.plain],
    ['consignment_to', 'On consignment', c.consignment_to],
    ['consignment_from', 'From a client', c.consignment_from],
    ['need_polish', 'Needs polish', c.need_polish],
    ['at_polish', 'At polish', c.at_polish],
    ...c.corners.map((k) => [`corner:${k.key}`, k.label, k.n]),
    ['not_ours', 'Not our stock', c.in_stock - c.ours],
  ].filter(([k, , n]) => !k || n);
  $('#st-chips').innerHTML = chips
    .map(([k, label, n]) => `<button type="button" class="pill${st.chip === k ? ' on' : ''}" data-chip="${esc(k)}" aria-pressed="${st.chip === k}">${esc(label)}<b>${n}</b></button>`)
    .join('');
  const rows = sort(
    r.watches
      .filter((w) => stChipKeeps(w, st.chip))
      .filter((w) =>
        sfMatch(
          words,
          w.stock_no, w.reference, w.serial, w.brand, w.model, w.from, w.from_link?.client_name, w.accessories_present, w.accessories_missing,
          ...w.corners.map((x) => `${x.label} ${x.value}`), w.notes, w.watch_date, w.consignment?.with, w.polish?.sent_to, w.watch?.bought_from?.name, w.watch?.sold_to?.name
        )
      ),
    (a, b) => String(b.added_at || '').localeCompare(String(a.added_at || '')) || b.id - a.id
  );
  const all = st.chip ? r.watches.filter((w) => stChipKeeps(w, st.chip)).length : c.in_stock;
  const facts = [
    c.consignment_to && `${c.consignment_to} on consignment`,
    c.consignment_from && `${c.consignment_from} from a client`,
    c.at_polish && `${c.at_polish} at polish`,
    c.need_polish && `${c.need_polish} need${c.need_polish === 1 ? 's' : ''} polish`,
    c.in_stock - c.ours && `${c.in_stock - c.ours} not in our stock list`,
  ].filter(Boolean);
  $('#st-count').textContent =
    words.length || st.chip
      ? `${rows.length} of ${all} match`
      : `${c.in_stock} watch${c.in_stock === 1 ? '' : 'es'} in ${r.place}${facts.length ? ` · ${facts.join(' · ')}` : ''}`;
  if (!rows.length) {
    $('#st-out').innerHTML = `<p class="sub">${words.length || st.chip ? 'No watch in stock matches. Try a stock number, reference, serial, brand or client name.' : `Nothing in ${esc(r.place)} right now — a watch received there in the logistics app shows here.`}</p>`;
    return;
  }
  if (st.view === 'list') {
    $('#st-out').innerHTML = `<div class="panel tscroll" style="padding:0"><table class="list lg st-table"><thead><tr>
        <th></th><th>Stock</th><th>Watch</th><th>From</th><th>Received</th><th>Cost · B2B · B2C</th><th>Accessories</th>${r.corners.map((k) => `<th>${esc(k.label)}</th>`).join('')}<th>Polish</th><th>Ours · client</th><th>Notes</th>
      </tr></thead><tbody>${rows
        .map(
          (w) => `<tr data-id="${w.id}" tabindex="0" class="${w.consignment ? (w.consignment.direction === 'from_client' ? 'st-from-client' : 'st-consigned') : ''}${w.need_polish || w.polish ? ' st-polish' : ''}">
            <td class="st-pic">${w.picture ? `<img loading="lazy" src="${esc(fileUrl(w.picture, true))}" alt="" title="${w.photo_count} photo${w.photo_count === 1 ? '' : 's'}">` : w.watch?.photo_id ? `<img loading="lazy" src="/api/photos/${w.watch.photo_id}?thumb=1" alt="">` : ''}</td>
            <td style="white-space:nowrap">${stStock(w.stock_no)}${w.hidden_from_vault ? '<div class="count" style="margin:2px 0 0">Not in the Vault</div>' : ''}</td>
            <td class="st-watch"><a href="#/lg/${w.id}"><b>${stTitle(w)}</b></a>${stIdent(w) ? `<div class="count" style="margin:2px 0 0">${stIdent(w)}</div>` : ''}${stSpecs(w) ? `<div class="count" style="margin:2px 0 0">${stSpecs(w)}</div>` : ''}${stConsignment(w)}${w.movements.length ? `<div class="count" style="margin:2px 0 0">${stLastMove(w)}</div>` : ''}</td>
            <td>${lgPerson(w.from, w.from_link, '—')}</td>
            <td style="white-space:nowrap">${esc(sfDay(w.received_at) || '—')}</td>
            <td style="white-space:nowrap">${[w.cost && `<div>Cost <b>${stPrice(w.cost)}</b></div>`, w.b2b && `<div>B2B ${stPrice(w.b2b)}</div>`, w.b2c && `<div>B2C ${stPrice(w.b2c)}</div>`].filter(Boolean).join('') || '<span class="blank">—</span>'}</td>
            <td class="st-small">${stAccessories(w) || '<span class="blank">—</span>'}</td>
            ${r.corners.map((k) => `<td>${esc(stCorner(w, k.key))}</td>`).join('')}
            <td>${stPolish(w) || '<span class="blank">—</span>'}</td>
            <td class="st-ours">${stOurs(w.watch)}</td>
            <td class="st-small">${esc(w.notes || '')}${w.photo_count ? `<div class="count" style="margin:2px 0 0">${w.photo_count} photo${w.photo_count === 1 ? '' : 's'}${w.receiving_photos ? ` · ${w.receiving_photos} receiving` : ''}${w.bracelet_photos ? ` · ${w.bracelet_photos} bracelet` : ''}</div>` : ''}</td>
          </tr>`
        )
        .join('')}</tbody></table></div>`;
    return;
  }
  $('#st-out').innerHTML = `<div class="grid sf-grid">${rows
    .map(
      (w) => `<article class="tile sf-card st-card${w.consignment ? (w.consignment.direction === 'from_client' ? ' st-from-client' : ' st-consigned') : ''}" data-id="${w.id}" tabindex="0" role="link" aria-label="${esc(`#${w.stock_no} ${w.brand} ${w.model}`)}">
        <div class="pic">${sfPic(w)}${w.photo_count > 1 ? `<span class="pic-n">${w.photo_count} photos</span>` : ''}</div>
        <div class="body">
          <div class="m">${stStock(w.stock_no)}${w.brand && !/^other$/i.test(w.brand) ? ` <span>${esc(w.brand)}</span>` : ''}</div>
          <div class="t">${esc(w.model || w.brand || 'Watch')}</div>
          ${stIdent(w) ? `<div class="m">${stIdent(w)}</div>` : ''}
          ${stSpecs(w) ? `<div class="m">${stSpecs(w)}</div>` : ''}
          <div class="m">${esc([w.received_at && `Received ${sfDay(w.received_at)}`, w.corner].filter(Boolean).join(' · '))}</div>
          <div class="sf-for">From ${lgPerson(w.from, w.from_link, '—')}</div>
          ${w.cost || w.b2b || w.b2c ? `<div class="m st-prices">${[w.cost && `<span class="lg-tag good">Cost ${stPrice(w.cost)}</span>`, w.b2b && `<span class="lg-tag">B2B ${stPrice(w.b2b)}</span>`, w.b2c && `<span class="lg-tag">B2C ${stPrice(w.b2c)}</span>`].filter(Boolean).join('')}</div>` : ''}
          ${stTags(w) ? `<div class="m">${stTags(w)}</div>` : ''}
          ${stAccessories(w)}
          ${w.notes ? `<div class="sf-notes">${esc(w.notes)}</div>` : ''}
          ${w.movements.length ? `<div class="m">${stLastMove(w)}</div>` : ''}
          <div class="m">${stOurs(w.watch)}</div>
        </div>
      </article>`
    )
    .join('')}</div>`;
}

/* ── Hong Kong: the HK situation board ──────────────────────────── */

const stSectionTone = { in_hand: 'lg-good', incoming: 'lg-blue', outgoing: 'lg-warn', sold: 'lg-muted' };
const stSectionChip = (row) => `<span class="chip ${stSectionTone[row.section] || 'lg-muted'}">${esc(row.section ? row.section.replace('_', ' ').replace(/^./, (ch) => ch.toUpperCase()) : 'No section')}</span>`;
/* The app's holder pill and stock status: a name, or "IN SAFE"; the status's own words. */
const stHolder = (row) => (row.holder ? `<span class="lg-tag${/safe/i.test(row.holder) ? ' warn' : ''}">${lgPerson(row.holder, row.holder_link)}</span>` : '<span class="blank">—</span>');
/* Every watch the row names — an incoming group names several — each ours where we hold it. */
const stBoardWatches = (row) =>
  row.stock_nos.length
    ? row.stock_nos
        .map((no, i) => {
          const o = row.watches[i];
          return o ? `<div><a href="#/watch/${o.id}">Our watch #${esc(o.stock_no)}</a> ${chip(o.status)}${o.bought_from ? ` · bought from <a href="#/client/${o.bought_from.id}">${esc(o.bought_from.name)}</a>` : ''}${o.sold_to ? ` · sold to <a href="#/client/${o.sold_to.id}">${esc(o.sold_to.name)}</a>` : ''}</div>` : `<div>${stStock(no)} <span class="blank">not one of our watches</span></div>`;
        })
        .join('')
    : '<span class="blank">No stock number</span>';
const stBoardMoves = (row) =>
  row.movements.length
    ? `<details class="st-moves"><summary>${row.movements.length} movement${row.movements.length === 1 ? '' : 's'}</summary>${row.movements
        .map(
          (m) => `<div class="st-move">
            <div><b>${esc(m.from_section || '—')}${m.from_holder ? ` · ${esc(m.from_holder)}` : ''}</b> → <b>${esc(m.to_section || '—')}${m.to_holder ? ` · ${esc(m.to_holder)}` : ''}</b> <span class="count" style="margin:0">${esc(sfDay(m.at) || m.day)}</span></div>
            ${[m.carrier && `by ${esc(m.carrier)}`, m.destination && `to ${esc(m.destination)}`, m.cost && `cost ${esc(m.cost)}`, m.photos && `${m.photos} photo${m.photos === 1 ? '' : 's'}`].filter(Boolean).length ? `<div class="count" style="margin:2px 0 0">${[m.carrier && `by ${esc(m.carrier)}`, m.destination && `to ${esc(m.destination)}`, m.cost && `cost ${esc(m.cost)}`, m.photos && `${m.photos} photo${m.photos === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</div>` : ''}
            ${m.sale ? `<div class="st-acc good">Sold to ${m.sale.client ? lgPerson(m.sale.client, m.sale.client_link) : 'a client'}${m.sale.price ? ` for ${esc(m.sale.price)}` : ''}${m.sale.given.length ? ` · given: ${esc(m.sale.given.join(', '))}` : ''}${m.sale.still_owed.length ? ` · <span class="st-owe">still owed: ${esc(m.sale.still_owed.join(', '))}</span>` : ''}</div>` : ''}
            ${m.notes ? `<div class="count" style="margin:2px 0 0">${esc(m.notes)}</div>` : ''}
          </div>`
        )
        .join('')}</details>`
    : '';

function lgStockDrawBoard(key, st, r, words) {
  const b = r.situation;
  $('#st-chips').innerHTML = [{ key: '', short: 'All', n: b.rows.length }, ...b.sections]
    .map((s) => `<button type="button" class="pill${st.section === s.key ? ' on' : ''}" data-chip="${esc(s.key)}" aria-pressed="${st.section === s.key}">${esc(s.short)}<b>${s.n}</b></button>`)
    .join('');
  const order = ['in_hand', 'incoming', 'outgoing', 'sold', ''];
  const rows = b.rows
    .filter((row) => !st.section || row.section === st.section)
    .filter((row) => sfMatch(words, row.stock_no, row.brand, row.description, row.holder, row.holder_link?.client_name, row.notes, row.stock_status, ...row.watches.map((o) => o && `${o.bought_from?.name || ''} ${o.sold_to?.name || ''}`)))
    .sort((a, c) =>
      st.sort === 'stockAsc'
        ? stCmpNo(a.stock_no, c.stock_no)
        : st.sort === 'stockDesc'
          ? stCmpNo(c.stock_no, a.stock_no)
          : st.sort === 'new'
            ? String(c.added_at).localeCompare(String(a.added_at)) || c.id - a.id
            : order.indexOf(a.section) - order.indexOf(c.section) || String(c.added_at).localeCompare(String(a.added_at))
    );
  const all = st.section ? b.sections.find((s) => s.key === st.section)?.n || 0 : b.rows.length;
  $('#st-count').textContent =
    words.length || st.section
      ? `${rows.length} of ${all} on the HK board match`
      : `${b.rows.length} piece${b.rows.length === 1 ? '' : 's'} on the HK board — the logistics app’s HK situation: ${b.sections
          .filter((s) => s.n)
          .map((s) => `${s.n} ${s.short.toLowerCase()}`)
          .join(', ')}${b.holders.length ? ` · held by ${b.holders.join(', ')}` : ''}. Move, Sold and Checkout wait for the switch-over: a row opens its record.`;
  if (!rows.length) {
    $('#st-out').innerHTML = `<p class="sub">${words.length || st.section ? 'Nothing on the HK board matches.' : 'Nothing on the HK board yet — a watch put on it in the logistics app shows here.'}</p>`;
    return;
  }
  if (st.view === 'list') {
    $('#st-out').innerHTML = `<div class="panel tscroll" style="padding:0"><table class="list lg st-table"><thead><tr>
        <th></th><th>Stock</th><th>Brand</th><th>Description</th><th>Holder</th><th>Section</th><th>Status</th><th>Ours · client</th><th>Notes</th>
      </tr></thead><tbody>${rows
        .map(
          (row) => `<tr data-id="${row.id}" tabindex="0">
            <td class="st-pic">${row.picture ? `<img loading="lazy" src="${esc(fileUrl(row.picture, true))}" alt="" title="${row.photo_count} photo${row.photo_count === 1 ? '' : 's'}">` : row.watch?.photo_id ? `<img loading="lazy" src="/api/photos/${row.watch.photo_id}?thumb=1" alt="">` : ''}</td>
            <td style="white-space:nowrap">${stStock(row.stock_no)}</td>
            <td>${esc(row.brand || '—')}</td>
            <td class="st-desc"><a href="#/lg/${row.id}">${esc(row.description || row.section_title || 'HK watch').replace(/\n/g, '<br>')}</a>${row.accessories_present ? `<div class="st-acc good">With it: ${esc(row.accessories_present)}</div>` : ''}${row.accessories_missing ? `<div class="st-acc bad">Missing: ${esc(row.accessories_missing)}</div>` : ''}${stBoardMoves(row)}</td>
            <td>${stHolder(row)}</td>
            <td>${stSectionChip(row)}</td>
            <td class="st-small">${esc(row.stock_status || '—')}</td>
            <td>${stBoardWatches(row)}</td>
            <td class="st-small">${esc(row.notes || '')}${row.linked_shipment ? '<div class="count" style="margin:2px 0 0">Came on a shipment</div>' : ''}</td>
          </tr>`
        )
        .join('')}</tbody></table></div>`;
    return;
  }
  $('#st-out').innerHTML = `<div class="grid sf-grid">${rows
    .map(
      (row) => `<article class="tile sf-card st-card" data-id="${row.id}" tabindex="0" role="link" aria-label="${esc(`#${row.stock_no} ${row.brand} ${row.section_title}`)}">
        <div class="pic">${sfPic(row)}${row.photo_count > 1 ? `<span class="pic-n">${row.photo_count} photos</span>` : ''}</div>
        <div class="body">
          <div class="m">${stStock(row.stock_no)}${row.brand ? ` <span>${esc(row.brand)}</span>` : ''} ${stSectionChip(row)}</div>
          <div class="t">${esc(row.description || row.section_title || 'HK watch')}</div>
          ${row.holder ? `<div class="m">Holder: ${stHolder(row)}</div>` : ''}
          ${row.stock_status ? `<div class="m">Status: <b>${esc(row.stock_status)}</b></div>` : ''}
          ${row.accessories_present ? `<div class="st-acc good">With it: ${esc(row.accessories_present)}</div>` : ''}
          ${row.accessories_missing ? `<div class="st-acc bad">Missing: ${esc(row.accessories_missing)}</div>` : ''}
          ${row.notes ? `<div class="sf-notes">${esc(row.notes)}</div>` : ''}
          ${stBoardMoves(row)}
          <div class="m">${stBoardWatches(row)}</div>
        </div>
      </article>`
    )
    .join('')}</div>`;
}

LG_PAGES.londonstock = () => lgStockPage('londonstock');
