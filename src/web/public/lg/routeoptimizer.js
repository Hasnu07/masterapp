/*
 * Route Optimizer: the logistics app's "Logistics Route Optimizer" page
 * (asked 27 Oct 2026, "all these tabs … keep each page how it is"): plan a
 * move — where from, where to, which of the watches there go — with what
 * each cost to buy and what moving it has cost so far, the cargo summary,
 * and the historical costs on that route (every recorded move between the
 * two places, by method / carrier, and the most recent). Dollars at the
 * converter's rates. The app's two AI buttons — "Fetch Market Prices" and
 * "Get AI Recommendation" — run the route-prices / route-advice actions
 * (src/logistics/actions/shipping.js: the app's prompts verbatim, asked
 * with masterapp's own key); without ANTHROPIC_API_KEY they are greyed.
 * Every watch is ours, with its clients.
 */
'use strict';
const roState = { from: '', to: '', custom: '', q: '', picked: new Set(), data: null, prices: {}, advice: null, busy: '' };

/* The app's normalizeRouteLoc, as written. */
function roPlace(s) {
  s = String(s || '').toLowerCase().trim();
  if (/dubai|uae|\bae\b/.test(s)) return 'Dubai';
  if (/london|england|\buk\b|\bgb\b|mayfair|newcastle/.test(s)) return 'London';
  if (/hong.?kong|\bhk\b/.test(s)) return 'Hong Kong';
  if (/switzerland|swiss|geneva|zurich|\bch\b/.test(s)) return 'Switzerland';
  if (/italy|italian|milan|rome|\bit\b/.test(s)) return 'Italy';
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const roDollars = (n) => money(Math.round(n * 100) / 100, 'USD');
const roRound = (n) => Math.round(n).toLocaleString('en-GB');

LG_PAGES.routeoptimizer = async function () {
  const seq = ++lgPage;
  const options = (sel) => `<option value="">Choose…</option>${['Dubai', 'London', 'Hong Kong', 'Switzerland', 'Italy', 'Other'].map((p) => `<option value="${p}"${p === sel ? ' selected' : ''}>${p}</option>`).join('')}`;
  $('#app').innerHTML = `${lgHeader('routeoptimizer')}
    <p class="sub" style="margin:0 0 12px">Plan a move: where the watches are, where they go, and which of them. What each cost to buy and to move so far, and what past moves on that route cost. <span class="ro-waits" id="ro-waits"></span></p>
    <section class="panel ro-plan">
      <div class="shp-sec-h"><h2 class="sf-h">Plan a move</h2><button type="button" class="btn small" id="ro-reset">Reset</button></div>
      <div class="ro-route">
        <label><span>From</span><select id="ro-from" aria-label="From">${options(roState.from)}</select></label>
        <span class="ro-arrow" aria-hidden="true">→</span>
        <label><span>To</span><select id="ro-to" aria-label="To">${options(roState.to)}</select></label>
        <label id="ro-custom-l" class="${roState.from === 'Other' || roState.to === 'Other' ? '' : 'hide'}"><span>Which place</span><input type="text" id="ro-custom" placeholder="e.g. Geneva, Tokyo" value="${esc(roState.custom)}"></label>
      </div>
      <h3 class="ro-h">Watches to move</h3>
      <div id="ro-available"></div>
      <div id="ro-picked"></div>
      <div id="ro-summary"></div>
      <div id="ro-ai" class="ro-ai"></div>
    </section>
    <section class="panel ro-hist">
      <h2 class="sf-h" style="margin-bottom:8px">Historical costs on this route</h2>
      <div id="ro-history"><p class="count" style="margin:0">Reading the records…</p></div>
    </section>`;
  const redraw = () => {
    roDrawAvailable();
    roDrawPicked();
    roDrawHistory();
    roDrawAi();
  };
  // The app's two AI buttons: the action is posted straight from here (its input is the page's state, not a form).
  $('#ro-ai').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ro-ai]');
    if (b && !b.disabled) roRunAi(b.dataset.roAi);
  });
  $('#ro-from').addEventListener('change', (e) => {
    // The app's routeFromChanged: a new origin clears the picked watches.
    roState.from = e.target.value;
    roState.picked = new Set();
    roState.q = '';
    $('#ro-custom-l').classList.toggle('hide', roState.from !== 'Other' && roState.to !== 'Other');
    redraw();
  });
  $('#ro-to').addEventListener('change', (e) => {
    roState.to = e.target.value;
    $('#ro-custom-l').classList.toggle('hide', roState.from !== 'Other' && roState.to !== 'Other');
    roDrawHistory();
  });
  let timer;
  $('#ro-custom').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      roState.custom = e.target.value;
      roDrawHistory();
    }, 150);
  });
  $('#ro-reset').addEventListener('click', () => {
    Object.assign(roState, { from: '', to: '', custom: '', q: '', picked: new Set() });
    $('#ro-from').value = '';
    $('#ro-to').value = '';
    $('#ro-custom').value = '';
    $('#ro-custom-l').classList.add('hide');
    redraw();
  });
  // Ticking a watch, select all, clear, the search — one listener on the panel.
  $('#ro-available').addEventListener('click', (e) => {
    const all = e.target.closest('[data-all]');
    if (all) {
      roState.picked = all.dataset.all === 'yes' ? new Set(roAvailable().map((w) => w.id)) : new Set();
      roDrawAvailable();
      roDrawPicked();
      return;
    }
    const at = e.target.closest('[data-pick]');
    if (!at || e.target.closest('a')) return;
    const id = Number(at.dataset.pick);
    if (roState.picked.has(id)) roState.picked.delete(id);
    else roState.picked.add(id);
    roDrawAvailable();
    roDrawPicked();
  });
  // A tick card is a checkbox to the keyboard too.
  $('#ro-available').addEventListener('keydown', (e) => {
    const at = e.target.closest('[data-pick]');
    if (!at || e.target !== at || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    at.click();
  });
  $('#ro-available').addEventListener('input', (e) => {
    if (e.target.id !== 'ro-q') return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      roState.q = e.target.value;
      roDrawAvailable(true);
    }, 150);
  });
  $('#ro-picked').addEventListener('click', (e) => {
    const at = e.target.closest('[data-drop]');
    if (!at) return;
    roState.picked.delete(Number(at.dataset.drop));
    roDrawAvailable();
    roDrawPicked();
  });
  lgOpenOnClick($('#ro-history'));
  let r;
  try {
    r = await api('/api/logistics/page/routeoptimizer');
  } catch (err) {
    if (seq === lgPage && $('#ro-history')) $('#ro-history').innerHTML = `<p class="count" style="margin:0">Could not read the records: ${esc(err.message)}</p>`;
    return;
  }
  if (seq !== lgPage || !$('#ro-history')) return;
  roState.data = r;
  const ai = lgAction('route-prices');
  $('#ro-waits').textContent = ai?.ai_ready
    ? 'Market prices and the AI route recommendation are asked of Claude with masterapp’s own key.'
    : 'Market prices and the AI route recommendation need the AI key (ANTHROPIC_API_KEY): the two buttons are greyed until it is set.';
  redraw();
};

/* The watches at the chosen origin: London and Dubai rows in stock or on consignment, the HK list's in-hand rows (the app's renderRouteAvailable). */
const roAvailable = () => roState.data?.available?.[roState.from] || [];
const roPickedList = () => roAvailable().filter((w) => roState.picked.has(w.id));
/* Dollars at the converter's rates; null when the currency has no rate. */
const roUsd = (amount, cur) => {
  const per = roState.data?.rates?.usd?.[String(cur || '').toUpperCase()];
  return per ? (Number(amount) || 0) / per : null;
};
const roOurs = (w) => {
  const o = w.watch;
  if (!o) return '<span class="blank">Not one of our watches</span>';
  return `<a href="#/watch/${o.id}">Our watch #${esc(o.stock_no)}</a> ${chip(o.status)}${o.bought_from ? ` · bought from <a href="#/client/${o.bought_from.id}">${esc(o.bought_from.name)}</a>` : ''}${
    o.sold_to ? ` · sold to <a href="#/client/${o.sold_to.id}">${esc(o.sold_to.name)}</a>` : ''
  }`;
};
const roTitle = (w) => esc([w.brand, w.model || w.reference].filter(Boolean).join(' ') || 'Watch');

function roDrawAvailable(searchOnly = false) {
  const box = $('#ro-available');
  if (!box || !roState.data) return;
  const items = roAvailable();
  if (!roState.from) {
    box.innerHTML = '<p class="count" style="margin:0 0 8px">Choose where the watches are now, and the ones there appear here to tick.</p>';
    return;
  }
  if (!items.length) {
    box.innerHTML = `<p class="count" style="margin:0 0 8px">${roState.from === 'Other' || roState.from === 'Switzerland' || roState.from === 'Italy' ? `The logistics app holds no stock list for ${esc(roState.from)} — only London, Dubai and Hong Kong.` : `No watches in ${esc(roState.from)} right now.`}</p>`;
    return;
  }
  const words = roState.q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = items.filter((w) => sfMatch(words, w.stock_no, w.brand, w.model, w.reference, w.from?.name, w.watch?.title));
  const grid = `<div class="ro-grid" role="group" aria-label="Available watches">${shown
    .map(
      (w) => `<div class="ro-pick${roState.picked.has(w.id) ? ' on' : ''}" data-pick="${w.id}" role="checkbox" aria-checked="${roState.picked.has(w.id)}" tabindex="0">
        <span class="ro-box" aria-hidden="true">${roState.picked.has(w.id) ? '✓' : ''}</span>
        <div class="ro-pick-body">
          <div><span class="lg-stock">#${esc(w.stock_no || '–')}</span> ${w.status === 'consignment' ? '<span class="chip lg-warn">On consignment</span>' : ''}</div>
          <div class="ro-pick-t">${roTitle(w)}</div>
          ${w.reference && w.model ? `<div class="count" style="margin:0">Ref ${esc(w.reference)}</div>` : ''}
          <div class="count" style="margin:0">${w.watch ? `<a href="#/watch/${w.watch.id}">Our watch</a> ${chip(w.watch.status)}` : '<span class="blank">not one of ours</span>'}</div>
        </div>
      </div>`
    )
    .join('')}${!shown.length ? '<p class="count" style="margin:0;grid-column:1/-1">No watch here matches.</p>' : ''}</div>`;
  if (searchOnly && $('#ro-grid-box')) {
    $('#ro-grid-box').innerHTML = grid;
    return;
  }
  box.innerHTML = `<div class="ro-avail-head">
      <span class="count" style="margin:0">${items.length} watch${items.length === 1 ? '' : 'es'} in ${esc(roState.from)} — tick the ones to move</span>
      <div class="ro-avail-acts"><input class="q" type="search" id="ro-q" aria-label="Find a watch" placeholder="Stock number, brand, model…" value="${esc(roState.q)}"><button type="button" class="pill" data-all="yes">Select all</button><button type="button" class="pill" data-all="no">Clear</button></div>
    </div><div id="ro-grid-box">${grid}</div>`;
}

function roDrawPicked() {
  const box = $('#ro-picked');
  if (!box || !roState.data) return;
  const picked = roPickedList();
  if (!picked.length) {
    box.innerHTML = roState.from && roAvailable().length ? '<p class="count" style="margin:8px 0 0">No watches selected yet — tick them above.</p>' : '';
    $('#ro-summary').innerHTML = '';
    return;
  }
  const rates = roState.data.rates;
  box.innerHTML = `<h3 class="ro-h">Selected</h3><div class="ro-sel">${picked
    .map(
      (w) => `<div class="ro-sel-row">
        <span class="lg-stock">#${esc(w.stock_no || '–')}</span>
        <div class="ro-sel-main"><b>${roTitle(w)}</b>${w.reference && w.model ? ` <span class="count" style="margin:0">· Ref ${esc(w.reference)}</span>` : ''} <span class="count" style="margin:0">· ${esc(w.place)}</span>
          <div class="count" style="margin:2px 0 0">${roOurs(w)}${w.from?.name ? ` · bought from (the app) ${lgPerson(w.from.name, w.from.link)}` : ''}</div></div>
        ${w.buy ? `<span class="ro-fig good" title="What it cost to buy, as the app's row says">Cost ${money(w.buy.amount, w.buy.currency)}${w.buy_usd != null && w.buy.currency !== 'USD' ? ` <small>≈ ${roDollars(w.buy_usd)}</small>` : ''}</span>` : '<span class="ro-fig warn">No cost price</span>'}
        ${w.log_usd > 0 ? `<span class="ro-fig bad" title="What moving it has cost so far, in dollars">Logistics ${roDollars(w.log_usd)}${w.log_missing.length ? ` <small>· ${esc(w.log_missing.join(', '))} left out</small>` : ''}</span>` : ''}
        ${roPriceFig(w)}
        <button type="button" class="btn small" data-drop="${w.id}" aria-label="Remove #${esc(w.stock_no)} from the move">✕</button>
      </div>`
    )
    .join('')}</div>`;
  // The app's cargo summary: watches, total cost price, existing logistic cost; market value and profit wait for the AI.
  const buy = picked.reduce((a, w) => a + (w.buy_usd || 0), 0);
  const noBuy = picked.filter((w) => !w.buy_usd).length;
  const log = picked.reduce((a, w) => a + (w.log_usd || 0), 0);
  // The app's cargo summary: market value and profit once the prices are fetched.
  const priced = picked.filter((w) => roState.prices[w.stock_no]?.usd);
  const mkt = priced.reduce((a, w) => a + roState.prices[w.stock_no].usd, 0);
  const profitBase = priced.reduce((a, w) => a + (w.buy_usd || 0), 0);
  $('#ro-summary').innerHTML = `<div class="ro-sum">
      <div><span class="count" style="margin:0">Watches selected</span><b>${picked.length}</b></div>
      <div><span class="count" style="margin:0">Total cost price</span><b class="good">${rates ? roDollars(buy) : '—'}</b>${noBuy ? `<small>${noBuy} with no cost price</small>` : ''}</div>
      <div><span class="count" style="margin:0">Existing logistic cost</span><b class="bad">${rates ? roDollars(log) : '—'}</b></div>
      <div><span class="count" style="margin:0">Market value · profit</span>${
        priced.length
          ? `<b>${roDollars(mkt)}</b><small class="${mkt - profitBase >= 0 ? 'good' : 'bad'}">${mkt - profitBase >= 0 ? '↑' : '↓'} ${roDollars(Math.abs(mkt - profitBase))} ${mkt - profitBase >= 0 ? 'profit' : 'loss'}${priced.length < picked.length ? ` · ${picked.length - priced.length} not priced` : ''}</small>`
          : '<b>—</b><small>fetch the market prices below</small>'
      }</div>
    </div><p class="count" style="margin:8px 0 0">Dollars ${rates ? `at today’s ${esc(rates.kind)} rates${rates.stale ? ' (not fresh)' : ''}` : '— no rates could be read'}. The purchase price is not counted as a logistic cost.</p>`;
}

function roDrawHistory() {
  const box = $('#ro-history');
  if (!box || !roState.data) return;
  const from = roState.from === 'Other' ? roPlace(roState.custom) : roState.from;
  const to = roState.to === 'Other' ? roPlace(roState.custom) : roState.to;
  if (!from || !to || from === to) {
    box.innerHTML = '<p class="count" style="margin:0">Choose two different places above to see what past moves between them cost.</p>';
    return;
  }
  // The app's buildRouteHistoricalData: every move between the two places with a cost in dollars —
  // except a cost line written for a shipment, a mover's shipment or a trip, which is that move already (the app counts both).
  const onRoute = roState.data.moves.filter((m) => m.from === from && m.to === to && m.usd > 0);
  const twice = onRoute.filter((m) => m.kind === 'cost' && ['shipment', 'mover', 'trip'].includes(m.stands_for)).length;
  const moves = onRoute.filter((m) => !(m.kind === 'cost' && ['shipment', 'mover', 'trip'].includes(m.stands_for)));
  const total = moves.length;
  if (!total) {
    box.innerHTML = `<p class="count" style="margin:0">No historical moves recorded for <b>${esc(from)} → ${esc(to)}</b>.</p>`;
    return;
  }
  const byMethod = new Map();
  for (const m of moves) {
    const x = byMethod.get(m.method) || { count: 0, total: 0 };
    x.count++;
    x.total += m.usd;
    byMethod.set(m.method, x);
  }
  const recent = [...moves].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  const KIND = { shipment: 'Live shipment', mover: 'Mover shipment', cost: 'Cost line', trip: 'Trip' };
  box.innerHTML = `<p class="count" style="margin:0 0 8px">${total} recorded move${total === 1 ? '' : 's'} on ${esc(from)} → ${esc(to)}, in dollars at ${roState.data.rates ? `today’s ${esc(roState.data.rates.kind)} rates` : 'no rates'}${
    twice ? ` · ${twice} cost line${twice === 1 ? '' : 's'} written for these shipments and trips not counted twice` : ''
  }</p>
    <div class="tscroll"><table class="list ro-table"><thead><tr><th>Method / carrier</th><th class="ro-c">Times used</th><th class="ro-r">Average</th><th class="ro-r">Total spent</th></tr></thead><tbody>${[...byMethod]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([m, v]) => `<tr><td><b>${esc(m)}</b></td><td class="ro-c">${v.count}</td><td class="ro-r good">$${roRound(v.total / v.count)}</td><td class="ro-r count" style="margin:0">$${roRound(v.total)}</td></tr>`)
      .join('')}</tbody></table></div>
    <h3 class="ro-h">Recent moves</h3>
    <div class="tscroll"><table class="list lg ro-table"><thead><tr><th>Date</th><th>Method</th><th>What</th><th>Detail</th><th class="ro-r">Cost</th></tr></thead><tbody>${recent
      .map(
        (m) => `<tr data-id="${m.id}" tabindex="0">
          <td class="count" style="margin:0;white-space:nowrap">${esc(m.date ? dayWords(m.date) : '–')}</td>
          <td><a href="#/lg/${m.id}"><b>${esc(m.method || '–')}</b></a></td>
          <td>${esc(KIND[m.kind] || m.kind)}</td>
          <td>${esc(m.detail)}</td>
          <td class="ro-r"><b>$${roRound(m.usd)}</b>${m.kind !== 'trip' && m.currency !== 'USD' ? `<div class="count" style="margin:0">${money(m.amount, m.currency)}</div>` : ''}${
            m.kind === 'trip' ? `<div class="count" style="margin:0">${Object.entries(m.amounts || {}).map(([c, n]) => money(n, c)).join(' + ')}</div>` : ''
          }</td>
        </tr>`
      )
      .join('')}</tbody></table></div>`;
}

/* ── the AI (the app's fetchRouteMarketPrices / runRouteOptimizerAI) ─────── */

/* The market price and the profit on a selected row, once fetched. */
function roPriceFig(w) {
  const p = roState.prices[w.stock_no];
  if (!p?.usd) return '';
  const profit = w.buy_usd ? p.usd - w.buy_usd : null;
  return `<span class="ro-fig good" title="Market price, an AI estimate (${esc(p.confidence)})">Market ${roDollars(p.usd)} <small class="ro-conf ${esc(p.confidence)}">${esc(p.confidence)}</small></span>${
    profit !== null ? `<span class="ro-fig ${profit >= 0 ? 'good' : 'bad'}">${profit >= 0 ? '↑' : '↓'} ${roDollars(Math.abs(profit))} ${profit >= 0 ? 'profit' : 'loss'}</span>` : ''
  }`;
}

/* One of the two buttons: nothing for a viewer; greyed, with the reason, without the AI key. */
function roAiBtn(key, which, label) {
  const a = lgAction(key);
  if (!a || !can('editor')) return '';
  const off = a.ai && !a.ai_ready;
  const busy = roState.busy === which;
  return `<button type="button" class="btn${which === 'advice' ? ' primary' : ''}${off ? ' off' : ''}" data-ro-ai="${which}"${off || busy ? ' disabled' : ''}${off ? ' title="Needs the AI key (ANTHROPIC_API_KEY)"' : ''}>${esc(busy ? (which === 'prices' ? 'Fetching…' : 'Claude is analysing route and historical costs…') : label)}</button>`;
}

function roDrawAi() {
  const box = $('#ro-ai');
  if (!box || !roState.data) return;
  const picked = roPickedList();
  const buttons = roAiBtn('route-prices', 'prices', 'Fetch market prices') + roAiBtn('route-advice', 'advice', 'Get AI recommendation');
  if (!buttons) {
    box.innerHTML = '';
    return;
  }
  const prices = picked.map((w) => roState.prices[w.stock_no]).filter(Boolean);
  const adv = roState.advice;
  box.innerHTML = `<h3 class="ro-h">Ask the AI</h3>
    <div class="ro-ai-acts">${buttons}<span class="count ro-ai-msg" style="margin:0" id="ro-ai-msg">${picked.length ? '' : 'Tick the watches to move first.'}</span></div>
    ${
      prices.length
        ? `<div class="ro-prices"><div class="ro-prices-h">Current market prices (AI estimate)</div>${prices
            .map(
              (p) => `<div class="ro-price-row"><span class="lg-stock">#${esc(p.stockNumber)}</span><span class="ro-price-l">${esc(p.label || '')}</span><b class="good">${p.usd ? roDollars(p.usd) : '—'}</b>${
                p.buyUsd ? `<span class="count" style="margin:0">Buy ${roDollars(p.buyUsd)}</span>` : ''
              }${p.profit !== null && p.profit !== undefined ? `<span class="ro-fig ${p.profit >= 0 ? 'good' : 'bad'}">${p.profit >= 0 ? '↑' : '↓'} ${roDollars(Math.abs(p.profit))} ${p.profit >= 0 ? 'profit' : 'loss'}</span>` : ''}<span class="ro-conf ${esc(p.confidence)}">${esc(p.confidence)}</span>${
                p.note ? `<span class="count ro-price-note" style="margin:0">${esc(p.note)}</span>` : ''
              }</div>`
            )
            .join('')}</div>`
        : ''
    }
    ${
      adv
        ? `<div class="ro-advice">${roMdToHtml(adv.text)}</div>
           <p class="count ro-note" style="margin:8px 0 0">Flight prices and carrier rates are Claude AI estimates — always verify live prices on Google Flights or airline sites before booking. Historical costs shown above come directly from your own records and are accurate.</p>`
        : ''
    }`;
}

/* The app's _routeMdToHtml, over escaped text: "## " headings, bold, italics, "- " bullets, line breaks. */
function roMdToHtml(md) {
  return esc(md)
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<em>$2</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '<br><br>')
    .replace(/\n/g, '<br>');
}

/* The answer the action gives back: its data, else the message it packed it in. */
function roAnswer(r) {
  if (r.data) return r.data;
  try {
    return JSON.parse(r.message);
  } catch {
    return { text: r.message };
  }
}

async function roRunAi(which) {
  const picked = roPickedList();
  const msg = (t) => {
    const el = $('#ro-ai-msg');
    if (el) el.textContent = t;
  };
  if (!picked.length) return msg(which === 'prices' ? 'Select watches first' : 'Add at least one watch to the move');
  const ids = picked.map((w) => w.id).join(',');
  roState.busy = which;
  roDrawAi();
  try {
    if (which === 'prices') {
      const r = await api('/api/logistics/act/route-prices', { method: 'POST', body: { ids } });
      const out = roAnswer(r);
      for (const p of out.prices || []) if (p.stockNumber) roState.prices[p.stockNumber] = p;
      roState.busy = '';
      roDrawPicked();
      roDrawAi();
      msg(`${(out.prices || []).length} price${(out.prices || []).length === 1 ? '' : 's'} fetched`);
    } else {
      if (!roState.from || !roState.to) {
        roState.busy = '';
        roDrawAi();
        return msg('Select From and To locations first');
      }
      const prices = Object.fromEntries(picked.filter((w) => roState.prices[w.stock_no]?.usd).map((w) => [w.stock_no, { usd: roState.prices[w.stock_no].usd, confidence: roState.prices[w.stock_no].confidence }]));
      const r = await api('/api/logistics/act/route-advice', { method: 'POST', body: { ids, from: roState.from, to: roState.to, custom: roState.custom, prices: JSON.stringify(prices) } });
      roState.advice = roAnswer(r);
      roState.busy = '';
      roDrawAi();
      $('.ro-advice')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  } catch (err) {
    roState.busy = '';
    roDrawAi();
    msg(err.message);
  }
}
