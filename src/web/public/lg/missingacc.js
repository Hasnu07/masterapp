/*
 * Missing Accessories: the logistics app's "Missing Accessories" page in the
 * console's look — what clients still have to give us, the combined count
 * across every location, the three locations by brand, filters (search,
 * brand, accessory), a drill-down into which watches need an accessory, and
 * the printable sheet. Summed in the browser from the rows the server
 * reads, exactly as the app sums (by row, by brand, by canonical accessory).
 * Every stock number is our watch with its clients; Chrono Key's own box /
 * papers stand beside the app's list.
 */
'use strict';
(() => {
  const ma = { q: '', brand: '', acc: '', drill: null, data: null };
  const PLACES = [
    ['london', 'London'],
    ['dubai', 'Dubai'],
    ['hk', 'HK'],
  ];
  const placeLabel = (key) => PLACES.find(([k]) => k === key)?.[1] || key;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const stockOf = (no) => (/\d/.test(no || '') ? `<span class="lg-stock">#${esc(no)}</span>` : esc(no && no !== '-' ? no : '—'));
  /* Our watch and our clients — by Chrono Key's ids, never the typed names. */
  const ours = (x) => {
    const o = x.watch;
    if (!o) return '<span class="blank">Not one of our watches</span>';
    return [
      `<a href="#/watch/${o.id}">Our watch #${esc(o.stock_no)}</a> ${chip(o.status)}`,
      o.bought_from && `Bought from <a href="#/client/${o.bought_from.id}"><b>${esc(o.bought_from.name)}</b></a>`,
      o.sold_to && `Sold to <a href="#/client/${o.sold_to.id}"><b>${esc(o.sold_to.name)}</b></a>`,
    ]
      .filter(Boolean)
      .map((s) => `<div>${s}</div>`)
      .join('');
  };
  /* What Chrono Key's own record says the watch lacks — beside the logistics app's list. */
  const ckSays = (x) => (!x.watch ? '<span class="blank">—</span>' : x.ck_missing.length ? `<span class="lg-tag problem">No ${esc(x.ck_missing.join(', ').toLowerCase())}</span>` : '<span class="lg-tag">Box and papers listed</span>');
  const tokenWords = (t) => `${t.accessory}${t.qty > 1 ? ` × ${t.qty}` : ''}`;

  const filtered = () => {
    const words = ma.q.toLowerCase().split(/\s+/).filter(Boolean);
    return ma.data.rows.filter(
      (r) =>
        (!ma.brand || r.brand === ma.brand) &&
        (!ma.acc || r.tokens.some((t) => t.accessory === ma.acc)) &&
        sfMatch(words, r.stock_no, r.brand, r.model, r.reference, ...r.tokens.map((t) => t.accessory), r.watch?.bought_from?.name, r.watch?.sold_to?.name)
    );
  };
  /* The app's aggregateMissing: place → brand → accessory → { qty, watches }. */
  const aggregate = (rows) => {
    const agg = {};
    for (const r of rows) {
      const p = (agg[r.place] ||= { byBrand: {}, watches: new Set() });
      p.watches.add(r.id);
      const b = (p.byBrand[r.brand] ||= { byAcc: {}, watches: new Set() });
      b.watches.add(r.id);
      for (const t of r.tokens) {
        const a = (b.byAcc[t.accessory] ||= { qty: 0, watches: [] });
        a.qty += t.qty;
        a.watches.push({ stock_no: r.stock_no, qty: t.qty });
      }
    }
    return agg;
  };
  const combined = (rows) => {
    const counts = {};
    for (const r of rows) for (const t of r.tokens) counts[t.accessory] = (counts[t.accessory] || 0) + t.qty;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  };

  LG_PAGES.missingacc = async function () {
    const seq = ++lgPage;
    $('#app').innerHTML = `${lgHeader('missingacc')}
      <div class="ma-screen">
        <div class="inc-head">
          <p class="sub" style="margin:0">What to source or collect across all stock locations. Every stock number is our watch, linked with its clients; Chrono Key's own box and papers stand beside the logistics app's list.</p>
          <button type="button" class="pill" id="ma-print">Print / save as PDF</button>
        </div>
        <section class="panel ma-owes" aria-labelledby="ma-owes-h">
          <div class="ma-panel-head">
            <div><h2 id="ma-owes-h">What clients need to give us</h2><div class="count">Accessories owed to us from pending transactions — by client, stock number and reference</div></div>
            <div class="ma-big"><b id="ma-owes-n">…</b><div class="count" id="ma-owes-sub"></div></div>
          </div>
          <div id="ma-owes"></div>
        </section>
        <section class="panel ma-combined" aria-labelledby="ma-comb-h">
          <div class="ma-panel-head">
            <div><h2 id="ma-comb-h">Combined — every location</h2><div class="count">London, Dubai and HK together · choose an accessory to see which watches need it</div></div>
            <div class="ma-big"><b id="ma-comb-n">…</b><div class="count" id="ma-comb-sub"></div></div>
          </div>
          <div class="lg-ov ma-chips" id="ma-comb"></div>
        </section>
        <div class="lg-toolbar ma-toolbar">
          <input class="q" type="search" id="ma-q" placeholder="Stock number, brand, model, accessory…" value="${esc(ma.q)}" aria-label="Search">
          <select id="ma-brand" aria-label="Brand"><option value="">All brands</option></select>
          <select id="ma-acc" aria-label="Accessory"><option value="">All accessories</option></select>
        </div>
        <div id="ma-drill"></div>
        <div class="ma-places" id="ma-places">${PLACES.map(([k, l]) => `<section class="panel ma-place ma-${k}" aria-labelledby="ma-${k}-h"><h3 id="ma-${k}-h">${l}</h3><div class="count" id="ma-${k}-sub">Reading…</div><div id="ma-${k}"></div></section>`).join('')}</div>
      </div>
      <div class="ma-sheet" id="ma-sheet" aria-hidden="true"></div>`;
    let timer;
    $('#ma-q').addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        ma.q = e.target.value;
        draw();
      }, 150);
    });
    $('#ma-brand').addEventListener('change', (e) => {
      ma.brand = e.target.value;
      draw();
    });
    $('#ma-acc').addEventListener('change', (e) => {
      ma.acc = e.target.value;
      draw();
    });
    $('#ma-print').addEventListener('click', () => {
      if (!ma.data || !filtered().length) {
        flash('Nothing missing to print with the current filters');
        return;
      }
      window.print();
    });
    // A chip opens the drill-down: which watches need that accessory (everywhere, or in one place and brand).
    $('.ma-screen').addEventListener('click', (e) => {
      const b = e.target.closest('[data-ma-acc]');
      if (b) {
        ma.drill = { acc: b.dataset.maAcc, place: b.dataset.maPlace || '', brand: b.dataset.maBrand || '' };
        drawDrill();
        $('#ma-drill')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        $('#ma-drill .ma-close')?.focus();
      } else if (e.target.closest('.ma-close')) {
        ma.drill = null;
        drawDrill();
      }
    });
    lgOpenOnClick($('#ma-owes'), $('#ma-drill'));
    let r;
    try {
      r = await api('/api/logistics/page/missingacc');
    } catch (err) {
      if (seq === lgPage && $('#ma-comb-sub')) $('#ma-comb-sub').textContent = `Could not read what is missing: ${err.message}`;
      return;
    }
    if (seq !== lgPage || !$('#ma-comb')) return;
    ma.data = r;
    $('#ma-brand').innerHTML = `<option value="">All brands</option>${r.brands.map((b) => `<option>${esc(b)}</option>`).join('')}`;
    $('#ma-acc').innerHTML = `<option value="">All accessories</option>${r.accessories.map((a) => `<option>${esc(a)}</option>`).join('')}`;
    if (!r.brands.includes(ma.brand)) ma.brand = '';
    if (!r.accessories.includes(ma.acc)) ma.acc = '';
    $('#ma-brand').value = ma.brand;
    $('#ma-acc').value = ma.acc;
    drawOwes();
    draw();
  };

  /* The app's "What Clients Need to Give Us": not filtered, by client, a table per client. */
  function drawOwes() {
    const o = ma.data.client_owes;
    $('#ma-owes-n').textContent = o.items;
    $('#ma-owes-sub').textContent = o.items ? `${plural(o.clients.length, 'client')} · ${plural(o.items, 'accessory item')} owed to us` : 'All accessories settled';
    if (!o.items) {
      $('#ma-owes').innerHTML = '<p class="sub" style="margin:0">Nothing outstanding — every client has handed over what they owed.</p>';
      return;
    }
    $('#ma-owes').innerHTML = o.clients
      .map(
        (c) => `<div class="ma-client">
          <div class="ma-client-head"><b>${c.link ? lgPerson(c.name, c.link) : esc(c.name)}</b>${c.country ? `<span class="count">· ${esc(c.country)}</span>` : ''}<span class="lg-tag warn">${plural(c.items, 'item')}</span></div>
          <div class="tscroll"><table class="list lg"><thead><tr><th>Stock</th><th>Reference</th><th>Brand</th><th>Accessories to receive from the client</th><th>Ours · client</th></tr></thead><tbody>${c.transactions
            .map(
              (t) => `<tr data-id="${t.id}" tabindex="0">
                <td style="white-space:nowrap">${stockOf(t.stock_no)}</td>
                <td style="white-space:nowrap">${t.reference && t.reference !== t.stock_no ? `<a href="#/lg/${t.id}">${esc(t.reference)}</a>` : '<span class="blank">—</span>'}</td>
                <td>${esc(t.brand || '—')}</td>
                <td><span class="lg-ov" style="margin:0">${t.items.map((it) => `<span class="lg-tag warn">${esc(tokenWords(it))}</span>`).join('')}</span></td>
                <td>${ours(t)}</td>
              </tr>`
            )
            .join('')}</tbody></table></div>
        </div>`
      )
      .join('');
  }

  function draw() {
    if (!ma.data || !$('#ma-comb')) return;
    const rows = filtered();
    const agg = aggregate(rows);
    const comb = combined(rows);
    const totalQty = comb.reduce((s, [, q]) => s + q, 0);
    const totalWatches = new Set(rows.map((r) => r.id)).size;
    const ckNo = rows.filter((r) => r.ck_missing.length).length;
    $('#ma-comb-n').textContent = totalQty;
    $('#ma-comb-sub').textContent = `${plural(totalWatches, 'watch', 'watches')} missing items across ${plural(comb.length, 'accessory type')}${ckNo ? ` · Chrono Key lists ${ckNo} of them without box or papers` : ''}`;
    $('#ma-comb').innerHTML = comb.length
      ? comb.map(([acc, qty]) => `<button type="button" class="pill ma-chip" data-ma-acc="${esc(acc)}"><span>${esc(acc)}</span><b>${qty}</b></button>`).join('')
      : `<p class="sub" style="margin:0">${ma.data.rows.length ? 'Nothing missing matches the current filters.' : 'Nothing is missing at any location.'}</p>`;
    for (const [key] of PLACES) {
      const card = agg[key];
      const sub = $(`#ma-${key}-sub`);
      const out = $(`#ma-${key}`);
      if (!card) {
        sub.textContent = '0 items missing';
        out.innerHTML = '<p class="sub" style="margin:0">Nothing missing here.</p>';
        continue;
      }
      let total = 0;
      for (const b of Object.values(card.byBrand)) for (const a of Object.values(b.byAcc)) total += a.qty;
      sub.textContent = `${total} items missing across ${plural(card.watches.size, 'watch', 'watches')}`;
      out.innerHTML = Object.keys(card.byBrand)
        .sort()
        .map((brand) => {
          const b = card.byBrand[brand];
          const accs = Object.entries(b.byAcc).sort((x, y) => y[1].qty - x[1].qty);
          const brandTotal = accs.reduce((s, [, v]) => s + v.qty, 0);
          return `<div class="ma-brand">
            <div class="ma-brand-head"><b>${esc(brand)}</b><span class="count">${plural(b.watches.size, 'watch', 'watches')} · ${brandTotal} items</span></div>
            <div class="lg-ov ma-chips" style="margin:0">${accs.map(([acc, v]) => `<button type="button" class="pill ma-chip small" data-ma-acc="${esc(acc)}" data-ma-place="${key}" data-ma-brand="${esc(brand)}"><span>${esc(acc)}</span><b>${v.qty}</b></button>`).join('')}</div>
          </div>`;
        })
        .join('');
    }
    drawDrill();
    drawSheet(rows, agg, comb);
  }

  /* Which watches need this accessory — the app's drill-down modal, here a panel under the filters. */
  function drawDrill() {
    const box = $('#ma-drill');
    if (!box) return;
    if (!ma.drill || !ma.data) {
      box.innerHTML = '';
      return;
    }
    const { acc, place, brand } = ma.drill;
    const rows = filtered().filter((r) => (!place || r.place === place) && (!brand || r.brand === brand) && r.tokens.some((t) => t.accessory === acc));
    const qtyOf = (r) => r.tokens.filter((t) => t.accessory === acc).reduce((s, t) => s + t.qty, 0);
    const total = rows.reduce((s, r) => s + qtyOf(r), 0);
    box.innerHTML = `<section class="panel ma-drill" aria-labelledby="ma-drill-h">
      <div class="ma-panel-head">
        <div><h2 id="ma-drill-h">Missing: ${esc(acc)}</h2><div class="count">${esc(place ? placeLabel(place) : 'All locations')}${brand ? ` · ${esc(brand)}` : ''} · <b>${total}</b> needed across ${plural(rows.length, 'watch', 'watches')}</div></div>
        <button type="button" class="btn small ma-close">Close</button>
      </div>
      ${
        rows.length
          ? `<div class="tscroll"><table class="list lg"><thead><tr><th>Location</th><th>Stock</th><th>Brand</th><th>Model</th><th>Reference</th><th>Chrono Key says</th><th>Ours · client</th><th class="num">Qty needed</th></tr></thead><tbody>${rows
              .map(
                (r) => `<tr data-id="${r.id}" tabindex="0">
                  <td>${esc(r.place_label)}</td>
                  <td style="white-space:nowrap">${stockOf(r.stock_no)}</td>
                  <td>${esc(r.brand)}</td>
                  <td><a href="#/lg/${r.id}">${esc(r.model.slice(0, 60) || 'Watch')}</a></td>
                  <td>${esc(r.reference || '—')}</td>
                  <td>${ckSays(r)}</td>
                  <td>${ours(r)}</td>
                  <td class="num"><b class="ma-qty">${qtyOf(r)}</b></td>
                </tr>`
              )
              .join('')}<tr class="ma-total"><td colspan="7" class="num">Total ${esc(acc)} needed</td><td class="num"><b class="ma-qty">${total}</b></td></tr></tbody></table></div>`
          : '<p class="sub" style="margin:0">No watch matches.</p>'
      }
    </section>`;
  }

  /* The app's printable sheet — "Missing Accessories — <today>" — rebuilt with every draw; shown only when printing. */
  function drawSheet(rows, agg, comb) {
    const today = dayWords(localDay());
    const section = (key, label) => {
      const card = agg[key];
      if (!card) return `<h2>${label}</h2><p>Nothing missing.</p>`;
      return `<h2>${label} <small>· ${plural(card.watches.size, 'watch', 'watches')}</small></h2>${Object.keys(card.byBrand)
        .sort()
        .map((brand) => {
          const accs = Object.entries(card.byBrand[brand].byAcc).sort((x, y) => y[1].qty - x[1].qty);
          return `<h3>${esc(brand)}</h3><table><thead><tr><th>Accessory</th><th class="num">Qty needed</th><th>Stocks</th></tr></thead><tbody>${accs
            .map(([acc, v]) => `<tr><td><b>${esc(acc)}</b></td><td class="num">${v.qty}</td><td>${esc(v.watches.map((w) => `${w.stock_no || '?'}${w.qty > 1 ? `×${w.qty}` : ''}`).join(', '))}</td></tr>`)
            .join('')}</tbody></table>`;
        })
        .join('')}`;
    };
    $('#ma-sheet').innerHTML = `<h1>Missing Accessories — ${esc(today)}</h1>
      <div class="ma-sheet-bar"><h2>Combined totals — across all locations</h2><table><thead><tr><th>Accessory</th><th class="num">Total needed</th></tr></thead><tbody>${
        comb.map(([acc, qty]) => `<tr><td><b>${esc(acc)}</b></td><td class="num">${qty}</td></tr>`).join('') || '<tr><td colspan="2">Nothing missing.</td></tr>'
      }</tbody></table></div>
      ${PLACES.map(([k, l]) => section(k, l)).join('')}`;
  }
})();
