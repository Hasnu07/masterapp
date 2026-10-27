/*
 * Logistic Cost: the logistics app's "Logistic Cost" page (asked 27 Oct
 * 2026, "all these tabs … keep each page how it is"): every cost line, the
 * totals by currency — all-time, and for what the filters leave — its
 * filters (search, currency, title, from / to date; and the line's source,
 * added here), the app's order (date, newest first), and a printable sheet.
 * On top of the app's page: the total in dollars at the converter's rates,
 * as the Overview and Movement tabs. Every stock number on a line is our
 * watch with its clients; From / To link as far as the logistics client
 * does. + Add Cost (the app's, a line linkable to a live shipment) is in the
 * toolbar and each line has Edit / Delete — the cost-* actions
 * (src/logistics/actions/costs.js).
 */
'use strict';
const lcState = { q: '', cur: '', title: '', source: '', from: '', to: '', data: null };
const LC_SOURCE = { shipment: 'Live shipment', mover: 'Mover shipment', trip: 'Trip', polish: 'Polish', manual: 'Typed by hand' };

LG_PAGES.costs = async function () {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('costs')}
    <p class="sub lc-sub" style="margin:0 0 12px">All shipping costs across deliveries — every line the logistics app wrote, in its own currency. A cost is written when a live shipment is delivered, a mover is paid, a trip's expenses are added, or by hand — Add cost here, as the app's + Add Cost (a line can be linked to a live shipment); each line has Edit and Delete.</p>
    <section class="panel lc-totals" id="lc-totals" aria-live="polite"><p class="count" style="margin:0">Reading the costs…</p></section>
    <div class="lc-filters" id="lc-filters">
      <input class="q" type="search" id="lc-q" aria-label="Search" placeholder="Search title, stock number, from, to, notes…" value="${esc(lcState.q)}">
      <select id="lc-cur" aria-label="Currency"><option value="">All currencies</option></select>
      <select id="lc-title" aria-label="Title"><option value="">All titles</option></select>
      <select id="lc-source" aria-label="Where the line came from"><option value="">Any source</option>${Object.entries(LC_SOURCE)
        .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`)
        .join('')}</select>
      <label class="lc-date"><span>From</span><input type="date" id="lc-from" value="${esc(lcState.from)}"></label>
      <label class="lc-date"><span>To</span><input type="date" id="lc-to" value="${esc(lcState.to)}"></label>
      <div class="lc-acts">
        ${lgPageActs('costs')}
        <button type="button" class="btn small" id="lc-clear">Clear filters</button>
        <button type="button" class="btn small" id="lc-print">Print / PDF</button>
      </div>
    </div>
    <div class="count" id="lc-count"></div>
    <div id="lc-out"></div>`;
  let timer;
  $('#lc-q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      lcState.q = e.target.value;
      lcDraw();
    }, 150);
  });
  for (const [id, key] of [['lc-cur', 'cur'], ['lc-title', 'title'], ['lc-source', 'source'], ['lc-from', 'from'], ['lc-to', 'to']]) {
    $(`#${id}`).addEventListener('change', (e) => {
      lcState[key] = e.target.value;
      lcDraw();
    });
  }
  $('#lc-clear').addEventListener('click', () => {
    Object.assign(lcState, { q: '', cur: '', title: '', source: '', from: '', to: '' });
    $('#lc-q').value = '';
    $('#lc-from').value = '';
    $('#lc-to').value = '';
    lcDraw();
  });
  $('#lc-print').addEventListener('click', () => window.print());
  lgOpenOnClick($('#lc-out'));
  let r;
  try {
    r = await api('/api/logistics/page/costs');
  } catch (err) {
    if (seq === lgPage && $('#lc-count')) $('#lc-count').textContent = `Could not read the costs: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#lc-out')) return;
  lcState.data = r;
  // The app's filters offer what the lines hold: every currency, every title.
  const fill = (id, values, cur) => {
    const sel = $(`#${id}`);
    sel.innerHTML = sel.options[0].outerHTML + values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    sel.value = values.includes(cur) ? cur : '';
  };
  fill('lc-cur', [...new Set(r.lines.map((l) => l.currency).filter(Boolean))].sort(), lcState.cur);
  fill('lc-title', [...new Set(r.lines.map((l) => l.title).filter(Boolean))].sort((a, b) => a.localeCompare(b)), lcState.title);
  $('#lc-source').value = lcState.source;
  lcDraw();
};

/* Dollars at the converter's rates (what one dollar is in each currency); null when a currency has no rate. */
const lcUsd = (amount, cur) => {
  const per = lcState.data?.rates?.usd?.[String(cur || '').toUpperCase()];
  return per ? (Number(amount) || 0) / per : null;
};
const lcAmount = (n) => Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 });
const lcDollars = (n) => money(Math.round(n * 100) / 100, 'USD');

/* Totals by currency, and the whole in dollars — a currency with no rate is named, not guessed. */
function lcTotals(lines) {
  const by = new Map();
  for (const l of lines) {
    const cur = l.currency || 'OTHER';
    const t = by.get(cur) || { amount: 0, count: 0 };
    t.amount += l.amount;
    t.count += 1;
    by.set(cur, t);
  }
  let usd = 0;
  const missing = [];
  for (const [cur, t] of by) {
    const v = cur === 'OTHER' ? null : lcUsd(t.amount, cur);
    if (v == null) missing.push(cur);
    else usd += v;
  }
  return { by: [...by].sort((a, b) => a[0].localeCompare(b[0])), usd, missing };
}

/* Our watch and our clients — by Chrono Key's ids, never the typed From / To. */
const lcWatchOf = (w) => {
  const o = w.watch;
  const no = `<span class="lg-stock">#${esc(w.stock_no)}</span>`;
  if (!o) return `<div>${no} <span class="blank">not one of our watches</span></div>`;
  return `<div>${no} <a href="#/watch/${o.id}">${esc(o.title || 'Our watch')}</a> ${chip(o.status)}${
    o.bought_from ? `<span class="count" style="margin:0 0 0 6px">bought from <a href="#/client/${o.bought_from.id}">${esc(o.bought_from.name)}</a></span>` : ''
  }${o.sold_to ? `<span class="count" style="margin:0 0 0 6px">sold to <a href="#/client/${o.sold_to.id}">${esc(o.sold_to.name)}</a></span>` : ''}</div>`;
};
const lcSide = (s) => (s.name ? lgPerson(s.name, s.link) : '<span class="blank">—</span>');
const lcSourceTag = (l) => {
  const label = LC_SOURCE[l.source] || 'Typed by hand';
  if (l.for_id) return `<a class="lg-tag lc-src lc-${esc(l.source)}" href="#/lg/${l.for_id}" title="Open the ${esc(label.toLowerCase())} this cost stands for">${esc(label)} ↗</a>`;
  return `<span class="lg-tag lc-src lc-${esc(l.source)}">${esc(label)}</span>`;
};

function lcDraw() {
  const r = lcState.data;
  if (!r || !$('#lc-out')) return;
  const words = lcState.q.toLowerCase().split(/\s+/).filter(Boolean);
  const hasFilter = Boolean(words.length || lcState.cur || lcState.title || lcState.source || lcState.from || lcState.to);
  $$('#lc-filters select').forEach((s) => s.classList.toggle('on', Boolean(s.value)));
  // The app's filter, as written: currency and title exactly; the day within from / to; the words anywhere in title, stock numbers, from, to, notes.
  const lines = r.lines.filter(
    (l) =>
      (!lcState.cur || l.currency === lcState.cur) &&
      (!lcState.title || l.title === lcState.title) &&
      (!lcState.source || l.source === lcState.source) &&
      (!lcState.from || l.date >= lcState.from) &&
      (!lcState.to || l.date <= lcState.to) &&
      sfMatch(words, l.title, l.stock, l.from.name, l.to.name, l.notes, ...l.watches.map((w) => w.watch?.title))
  );

  // Totals: all-time, as the app's cards; and the filtered ones when a filter is set.
  const rates = r.rates;
  const ratesNote = rates ? `at today’s ${esc(rates.kind)} rates${rates.stale ? ' (not fresh)' : ''}` : '— no rates could be read';
  const tiles = (t, allBy) =>
    `<div class="lc-tiles">${t.by
      .map(
        ([cur, v]) => `<div class="lc-tile"><span class="lc-cur">${esc(cur === 'OTHER' ? 'No currency' : cur)}</span><b>${esc(lcAmount(v.amount))}</b><small>${
          allBy ? `${v.count} of ${allBy.get(cur) || v.count} line${(allBy.get(cur) || v.count) === 1 ? '' : 's'}` : `across ${v.count} line${v.count === 1 ? '' : 's'}`
        }</small></div>`
      )
      .join('')}<div class="lc-tile lc-usd"><span class="lc-cur">In dollars</span><b>${rates ? lcDollars(t.usd) : '—'}</b><small>${ratesNote}${t.missing.length ? ` · ${esc(t.missing.join(', '))} left out — no rate` : ''}</small></div></div>`;
  const all = lcTotals(r.lines);
  if (!r.lines.length) {
    $('#lc-totals').innerHTML = '<p class="count" style="margin:0">No costs yet. The logistics app writes one when a live shipment is marked delivered, or when a cost is added there.</p>';
  } else {
    const allBy = new Map(all.by.map(([cur, v]) => [cur, v.count]));
    const some = hasFilter ? lcTotals(lines) : null;
    $('#lc-totals').innerHTML = `<h2 class="sf-h lc-h">All-time totals</h2>${tiles(all)}${
      some
        ? `<h2 class="sf-h lc-h lc-h-filtered">Filtered totals</h2>${some.by.length ? tiles(some, allBy) : '<p class="count" style="margin:0">No costs match the current filter.</p>'}`
        : ''
    }`;
  }

  const n = lines.length;
  $('#lc-count').textContent = `${n}${hasFilter ? ` of ${r.lines.length}` : ''} cost line${n === 1 ? '' : 's'}${r.as_of ? ` · the logistics app as read ${fmtWhen(r.as_of)}` : ''}`;
  if (!n) {
    $('#lc-out').innerHTML = `<div class="panel"><p class="sub" style="margin:0">${hasFilter ? 'No logistic costs match. Clear a filter to see more.' : 'No logistic costs yet.'}</p></div>`;
    return;
  }
  $('#lc-out').innerHTML = `<div class="panel tscroll" style="padding:0"><table class="list lg lc-table"><thead><tr>
      <th>Date</th><th>What for</th><th>Stock · our watch</th><th>From → to</th><th class="lc-r">Amount</th><th>Notes</th><th>Source</th>
    </tr></thead><tbody>${lines
      .map((l) => {
        const usd = l.currency && l.currency !== 'USD' ? lcUsd(l.amount, l.currency) : null;
        return `<tr data-id="${l.id}" tabindex="0">
          <td class="lc-nowrap">${esc(l.date ? dayWords(l.date) : '—')}</td>
          <td><a href="#/lg/${l.id}"><b>${esc(l.title || 'Cost')}</b></a>${l.locked ? ' <span class="chip lg-muted" title="A field edited here — the sync leaves it alone">edited here</span>' : ''}${
            can('editor') ? `<div class="lg-rowacts">${lgActBtn('cost-edit', l.id, { label: 'Edit', cls: 'small' })}${lgActBtn('cost-delete', l.id, { label: 'Delete', cls: 'small' })}</div>` : ''
          }</td>
          <td class="lc-stock">${l.watches.length ? l.watches.map(lcWatchOf).join('') : l.stock ? `<span class="lg-stock">${esc(l.stock)}</span>` : '<span class="blank">—</span>'}</td>
          <td>${lcSide(l.from)} <span class="lc-arrow">→</span> ${lcSide(l.to)}</td>
          <td class="lc-r lc-nowrap"><b>${money(l.amount, l.currency || null)}</b>${!l.currency ? '<div class="count" style="margin:0">currency not stated</div>' : ''}${usd != null ? `<div class="count" style="margin:0">≈ ${lcDollars(usd)}</div>` : ''}</td>
          <td class="lc-notes">${esc(l.notes)}</td>
          <td>${lcSourceTag(l)}</td>
        </tr>`;
      })
      .join('')}</tbody></table></div>`;
}
