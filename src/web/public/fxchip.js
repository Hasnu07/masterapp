/* A converter under every price — the small blue ▾.
 *
 * Ported from InvoiceWEB (src/web/public/fxchip.js, 20 Oct 2026) and kept
 * alike, asked for here on 23 Oct 2026: "add the same converter widget against
 * every price". masterapp has no Converter tab, so the popup has no "Open
 * converter" button; otherwise it is the same.
 *
 * InvoiceWEB's words, as asked there:
 *
 * "Wherever there are prices I want a small widget of converter … a small
 * blue arrow pointing down; when clicked the converter which we already have
 * opens and shows a set of currencies converted to, and under it a bar to
 * select from and to."
 *
 * ONE watcher for the whole console rather than a button added by hand in
 * every tab: prices are drawn by a dozen renderers (the boards, the market
 * panel, Buy & Sell, the vault, the assistant's answers), and a hand-placed
 * arrow would be missing from whichever one was forgotten — or from the next
 * tab written. So text that reads as an amount WITH its currency ("109,000
 * HKD", "€12,750", "HK$109,500", "$13,800", "12.750€") gets an arrow after
 * it, whenever and wherever it is drawn.
 *
 * - The arrow adds NO TEXT. It is drawn with CSS, so anything reading a
 *   price's textContent — Copy list, the CSV, a redraw that carries text
 *   across — reads exactly what it did before.
 * - A figure with no currency gets none. Converting a bare number would be
 *   guessing its currency, which this console never does.
 * - The rates are /api/rates (src/rates), held a minute; the popup says it is
 *   mid-market and when it was taken. What is printed on the page is
 *   untouched: the converted figures exist only in the popup somebody opened.
 * - Not in links, form fields (the edit form), or the popup itself. Inside an
 *   inventory card, which is one big button, the arrow is a span acting as a
 *   button, and its click is caught before the card's, so it never opens it.
 */
(() => {
  const CODES = 'USD|HKD|EUR|GBP|AED|CHF|SAR|SGD|CNY|JPY|USDT|USDC';
  const SYMBOL = { 'HK$': 'HKD', 'US$': 'USD', $: 'USD', '€': 'EUR', '£': 'GBP' };
  const SHOW = ['USD', 'AED', 'EUR', 'GBP', 'HKD', 'CHF'];
  const NUM = '\\d{1,3}(?:[,.]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?';
  const RE = new RegExp(
    `(?<![\\w.,$€£])(?:(?<p>HK\\$|US\\$|\\$|€|£|\\b(?:${CODES})\\b)\\s?(?<a>${NUM})|(?<b>${NUM})\\s?(?<s>€|\\b(?:${CODES})\\b))(?![\\w])`,
    'g'
  );
  const SKIP = '.fx-pop, .fx-p, a, select, option, textarea, input, script, style, noscript, [contenteditable], [data-nofx]';

  /*
   * The house reading of a figure: a last group of exactly three digits is
   * thousands whichever mark sits before it ("12.750€" is twelve thousand
   * seven hundred and fifty — money is not written to three decimals); one
   * or two digits after the last mark is a decimal.
   */
  function amountOf(s) {
    const sep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
    if (sep === -1) return Number(s);
    if (s.length - sep - 1 === 3) return Number(s.replace(/[.,]/g, ''));
    return Number(s.slice(0, sep).replace(/[.,]/g, '') + '.' + s.slice(sep + 1));
  }
  const codeOf = (c) => {
    const k = SYMBOL[c] || String(c).toUpperCase();
    return k === 'USDT' || k === 'USDC' ? 'USD' : k;
  };

  /* ── finding prices ─────────────────────────────────────────────── */

  function wrap(node) {
    const text = node.nodeValue;
    RE.lastIndex = 0;
    let m;
    let last = 0;
    let frag = null;
    while ((m = RE.exec(text))) {
      const g = m.groups;
      const amount = amountOf(g.a || g.b);
      const code = codeOf(g.p || g.s);
      if (!(amount > 0)) continue;
      frag ||= document.createDocumentFragment();
      frag.append(text.slice(last, m.index));
      const span = document.createElement('span');
      span.className = 'fx-p';
      span.textContent = m[0];
      const chip = document.createElement('span');
      chip.className = 'fx-chip';
      chip.setAttribute('role', 'button');
      chip.tabIndex = 0;
      chip.dataset.a = String(amount);
      chip.dataset.c = code;
      chip.setAttribute('aria-label', `Convert ${m[0]}`);
      chip.title = 'Convert';
      span.append(chip);
      frag.append(span);
      last = m.index + m[0].length;
    }
    if (!frag) return;
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }

  function scan(root) {
    if (!root || (root.nodeType === 1 && root.closest(SKIP))) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!/\d/.test(n.nodeValue || '')) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        return !p || p.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    const found = [];
    while (walker.nextNode()) found.push(walker.currentNode);
    found.forEach(wrap);
  }

  // Everything drawn later — every board redraw, every answer — is scanned
  // as it lands, batched to one pass a frame.
  const queued = new Set();
  let frame = 0;
  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) queued.add(n);
        else if (n.nodeType === 3 && n.parentElement) queued.add(n.parentElement);
      }
    }
    if (queued.size && !frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        const roots = [...queued];
        queued.clear();
        for (const r of roots) if (r.isConnected) scan(r);
      });
    }
  });

  /* ── the popup ──────────────────────────────────────────────────── */

  let rates = null; // { rates, currencies, sourceName, kind, cachedAt, stale, at }
  async function getRates() {
    if (rates && Date.now() - rates.at < 60_000) return rates;
    const r = await fetch('/api/rates').then((x) => (x.ok ? x.json() : Promise.reject(new Error(`rates ${x.status}`))));
    rates = { ...r, at: Date.now() };
    return rates;
  }
  // `rates[X]` is X per one US dollar.
  const convert = (n, from, to, t) => {
    const rf = from === 'USD' ? 1 : Number(t[from]);
    const rt = to === 'USD' ? 1 : Number(t[to]);
    return rf > 0 && rt > 0 ? (n / rf) * rt : null;
  };
  const show = (n) =>
    Number(n).toLocaleString('en-GB', { minimumFractionDigits: n < 100 ? 2 : 0, maximumFractionDigits: n < 100 ? 2 : 0 });
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const clock = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  let pop = null;
  let anchor = null;
  const state = { amount: 0, from: 'USD', to: 'AED' };

  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    const a = anchor;
    anchor = null;
    a?.focus?.({ preventScroll: true });
  }

  /*
   * A page that redraws (a watch saved, the photos reordered) replaces the
   * arrow the popup hangs from. It is not
   * closed for that: it finds the same price drawn again — the same amount
   * and currency nearest where the old one was — and hangs from that. With
   * none, it simply stays where it is.
   */
  let lastRect = null;
  function reanchor() {
    if (!anchor) return false;
    const same = [...document.querySelectorAll(`.fx-chip[data-a="${CSS.escape(anchor.dataset.a)}"][data-c="${CSS.escape(anchor.dataset.c)}"]`)].filter(
      (c) => c.offsetParent
    );
    if (!same.length || !lastRect) return false;
    const d = (c) => {
      const r = c.getBoundingClientRect();
      return Math.hypot(r.left - lastRect.left, r.top - lastRect.top);
    };
    anchor = same.sort((a, b) => d(a) - d(b))[0];
    return true;
  }

  function place() {
    if (!pop || !anchor) return;
    if (!anchor.isConnected && !reanchor()) return;
    const r = anchor.getBoundingClientRect();
    lastRect = r;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = Math.min(Math.max(16, r.left + r.width / 2 - w / 2), innerWidth - w - 16);
    let top = r.bottom + 6;
    if (top + h > innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
    pop.style.left = `${Math.max(8, left)}px`;
    pop.style.top = `${Math.max(8, top)}px`;
  }

  function paint() {
    if (!pop) return;
    const t = rates?.rates;
    const list = SHOW.filter((c) => c !== state.from)
      .map((c) => {
        const v = t ? convert(state.amount, state.from, c, t) : null;
        return `<div class="fx-pop-row"><span>${esc(c)}</span><b>${v == null ? '—' : '≈ ' + esc(show(v))}</b></div>`;
      })
      .join('');
    pop.querySelector('.fx-pop-list').innerHTML = list;
    const v = t ? convert(Number(pop.querySelector('[data-fx="amt"]').value) || 0, state.from, state.to, t) : null;
    pop.querySelector('[data-fx="out"]').textContent = v == null ? '—' : `≈ ${show(v)} ${state.to}`;
    pop.querySelector('.fx-pop-foot span').textContent = !rates
      ? 'Loading rates…'
      : `${rates.stale ? 'Last good rate' : rates.kind === 'daily' ? 'Daily mid-market' : 'Live mid-market'} · ${rates.sourceName} · ${clock(rates.cachedAt)} — not a quote`;
  }

  async function open(chip) {
    close();
    anchor = chip;
    state.amount = Number(chip.dataset.a);
    state.from = chip.dataset.c;
    state.to = state.from === 'USD' ? 'AED' : 'USD';
    pop = document.createElement('div');
    pop.className = 'fx-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Currency converter');
    pop.innerHTML = `
      <div class="fx-pop-h"><b>${esc(show(state.amount))} ${esc(state.from)}</b>
        <button type="button" class="fx-pop-x" aria-label="Close">×</button></div>
      <div class="fx-pop-list"><div class="fx-pop-row"><span>…</span></div></div>
      <div class="fx-pop-bar">
        <input data-fx="amt" inputmode="decimal" value="${state.amount}" aria-label="Amount">
        <select data-fx="from" aria-label="From"></select>
        <span aria-hidden="true">→</span>
        <select data-fx="to" aria-label="To"></select>
      </div>
      <div class="fx-pop-out" data-fx="out">—</div>
      <div class="fx-pop-foot"><span>Loading rates…</span></div>`;
    document.body.append(pop);
    place();
    pop.querySelector('.fx-pop-x').onclick = close;
    const amt = pop.querySelector('[data-fx="amt"]');
    amt.oninput = paint;
    pop.querySelector('[data-fx="from"]').onchange = (e) => {
      state.from = e.target.value;
      paint();
    };
    pop.querySelector('[data-fx="to"]').onchange = (e) => {
      state.to = e.target.value;
      paint();
    };
    try {
      await getRates();
    } catch (err) {
      if (pop) pop.querySelector('.fx-pop-foot span').textContent = `Rates could not be read: ${err.message}`;
      return;
    }
    if (!pop) return; // closed while the rates were coming
    const codes = (rates.currencies || []).map((c) => c.code);
    for (const c of [state.from, ...SHOW]) if (!codes.includes(c)) codes.unshift(c);
    const opts = (sel) =>
      codes.map((c) => `<option${c === sel ? ' selected' : ''}>${esc(c)}</option>`).join('');
    pop.querySelector('[data-fx="from"]').innerHTML = opts(state.from);
    pop.querySelector('[data-fx="to"]').innerHTML = opts(state.to);
    paint();
    place();
  }

  /* ── wiring ─────────────────────────────────────────────────────── */

  // CAPTURE, so a click on the arrow inside an inventory card (one big
  // button) is taken here and never opens the watch.
  document.addEventListener(
    'click',
    (e) => {
      const chip = e.target.closest?.('.fx-chip');
      if (chip) {
        e.preventDefault();
        e.stopPropagation();
        if (anchor === chip) close();
        else open(chip);
        return;
      }
      if (pop && !pop.contains(e.target)) close();
    },
    true
  );
  document.addEventListener(
    'keydown',
    (e) => {
      const chip = e.target.closest?.('.fx-chip');
      if (chip && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        e.stopPropagation();
        open(chip);
        setTimeout(() => pop?.querySelector('[data-fx="amt"]')?.focus(), 0);
        return;
      }
      // Esc closes the popup first, and only the popup — not the window
      // behind it.
      if (pop && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    },
    true
  );
  // It follows its price when anything scrolls — closing instead would shut
  // it the moment a phone keyboard opens for the amount box.
  let moving = 0;
  const follow = () => {
    if (!pop || moving) return;
    moving = requestAnimationFrame(() => {
      moving = 0;
      if (anchor && !anchor.isConnected && !reanchor()) return; // stays where it is
      place();
    });
  };
  document.addEventListener('scroll', follow, true);
  addEventListener('resize', follow);

  const start = () => {
    scan(document.body);
    observer.observe(document.body, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
