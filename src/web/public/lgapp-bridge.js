/*
 * The ERP inside the logistics app's page (asked 30 Oct 2026). The ERP serves
 * the app at /lg-app/ and puts this script first in its <head>, so it runs
 * before the app's own:
 *  - the app's own sign-in screen is hidden — the ERP's sign-in stands in for it;
 *  - the tab the ERP asks for is opened (#tab=…&q=… on the frame's address, or
 *    a message from the ERP's page), and what it names is found there: a stock
 *    number's row scrolled to and marked for a moment (else the app's own
 *    search on it), or on Clients a client's name searched and its profile
 *    opened;
 *  - every stock number and client name the app shows gets a small "ERP" mark
 *    that opens OUR watch or OUR client — by the ERP's own rule: a stock number
 *    is our watch of that number; a typed name is our client only as the
 *    Clients tab links it (POST /api/lg-app/links decides both).
 * Nothing here writes to the app's records, and nothing of the app's is changed
 * but what is on screen.
 */
(function () {
  'use strict';
  var inErp = window.parent !== window;
  var ours = { watches: {}, clients: {} }; // stock number → our watch; a name, lower-cased → our client
  var known = ''; // what was last asked, so the same lists are not sent twice

  var style = document.createElement('style');
  style.textContent = [
    '#authScreen { display: none !important; }',
    '.erp-go { display: inline-block; margin-left: 5px; padding: 0 5px; border: 1px solid #8a6a2f; border-radius: 4px; color: #8a6a2f; background: #fff;',
    '  font: 600 10px/16px Inter, system-ui, sans-serif; letter-spacing: .4px; text-decoration: none; vertical-align: middle; cursor: pointer; }',
    '.erp-go:hover, .erp-go:focus-visible { background: #8a6a2f; color: #fff; outline: none; }',
    '.erp-hit { outline: 3px solid #8a6a2f; outline-offset: 2px; transition: outline-color 1.5s; }',
    '.erp-hit.erp-fade { outline-color: transparent; }',
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  /* The ERP's page is the one around this frame; opened alone, the ERP is the site itself. */
  function openInErp(hash) {
    if (inErp) window.parent.location.hash = hash;
    else window.location.href = '/' + hash;
  }

  /* ── what the app knows: every stock number in its lists, every client's name ── */
  function collect() {
    var s = typeof state !== 'undefined' ? state : null; // the app's own global (a let, so not on window)
    if (!s || typeof s !== 'object') return null;
    var split = typeof splitStockList === 'function' ? splitStockList : function (v) { return String(v || '').split(/[,\n;]+/); };
    var nos = {}, names = {};
    Object.keys(s).forEach(function (k) {
      var list = s[k];
      if (!Array.isArray(list)) return;
      list.forEach(function (r) {
        if (!r || typeof r !== 'object' || r.stockNumber == null) return;
        split(r.stockNumber).forEach(function (n) {
          n = String(n).trim();
          if (/^\d{1,6}[A-Za-z]?$/.test(n)) nos[n] = 1;
        });
      });
    });
    (s.clients || []).forEach(function (c) {
      var n = c && String(c.name || '').trim();
      if (n) names[n] = 1;
    });
    return { stock: Object.keys(nos), clients: Object.keys(names) };
  }

  function ask() {
    var c = collect();
    if (!c) return;
    var key = c.stock.join(',') + '|' + c.clients.join(',');
    if (key === known) return;
    known = key;
    fetch('/api/lg-app/links', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'masterapp' },
      body: JSON.stringify(c),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) { known = ''; return; }
        ours.watches = j.watches || {};
        ours.clients = {};
        Object.keys(j.clients || {}).forEach(function (n) { ours.clients[n.toLowerCase()] = j.clients[n]; });
        scheduleScan();
      })
      .catch(function () { known = ''; });
  }

  /* ── the marks ── */
  var HASH_NO = /#\s?(\d{1,6}[A-Za-z]?)(?![\w.])/g; // "#1461" anywhere in a text
  var BARE_NO = /^\s*(\d{3,6}[A-Za-z]?)\s*$/; // a cell or label that is only the number
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, BUTTON: 1 };

  function mark(attr, value, hash, title) {
    var a = document.createElement('a');
    a.className = 'erp-go';
    a.href = '/' + hash;
    a.setAttribute(attr, value);
    a.title = title;
    a.textContent = 'ERP';
    a.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openInErp(hash);
    });
    return a;
  }
  var watchMark = function (no, w) { return mark('data-erp-stock', no, '#/watch/' + w.id, 'Open stock ' + no + ' in the ERP' + (w.title ? ' — ' + w.title : '')); };
  var clientMark = function (c) { return mark('data-erp-client', String(c.id), '#/client/' + c.id, 'Open ' + c.name + ' in the ERP'); };

  function markedAfter(node, attr, value) {
    var s = node.nextSibling;
    return Boolean(s && s.nodeType === 1 && s.classList.contains('erp-go') && s.getAttribute(attr) === value);
  }
  var labelLike = function (el) { return /^(TD|TH|B|STRONG|SPAN|DIV|LI|H[1-6]|LABEL|P|SMALL|EM)$/.test(el.nodeName) && el.childNodes.length <= 3; };

  function decorate(node) {
    var parent = node.parentNode;
    if (!parent) return;
    var text = node.nodeValue;
    // "#1461" in a sentence or a cell: the mark goes right after the number. From the end, so earlier offsets hold.
    var found = [], m;
    HASH_NO.lastIndex = 0;
    while ((m = HASH_NO.exec(text))) if (ours.watches[m[1]]) found.push({ end: m.index + m[0].length, no: m[1] });
    if (found.length) {
      for (var i = found.length - 1; i >= 0; i--) {
        var f = found[i];
        if (f.end === node.nodeValue.length) {
          if (!markedAfter(node, 'data-erp-stock', f.no)) parent.insertBefore(watchMark(f.no, ours.watches[f.no]), node.nextSibling);
        } else {
          var tail = node.splitText(f.end);
          parent.insertBefore(watchMark(f.no, ours.watches[f.no]), tail);
        }
      }
      return;
    }
    if (!labelLike(parent)) return;
    var b = BARE_NO.exec(text);
    if (b && ours.watches[b[1]]) {
      if (!markedAfter(node, 'data-erp-stock', b[1])) parent.insertBefore(watchMark(b[1], ours.watches[b[1]]), node.nextSibling);
      return;
    }
    var c = ours.clients[text.trim().toLowerCase()];
    if (c && !markedAfter(node, 'data-erp-client', String(c.id))) parent.insertBefore(clientMark(c), node.nextSibling);
  }

  /* Only what is on screen: the tab shown, and any open window or drawer. */
  function roots() {
    var out = [];
    document.querySelectorAll('main > section').forEach(function (s) { if (s.style.display !== 'none') out.push(s); });
    document.querySelectorAll('.modal-bg.show, aside:not([hidden]):not(.sidebar)').forEach(function (m) { out.push(m); });
    return out;
  }
  function scan() {
    if (!Object.keys(ours.watches).length && !Object.keys(ours.clients).length) return;
    roots().forEach(function (root) {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function (n) {
          var p = n.parentNode;
          if (!p || p.nodeType !== 1 || SKIP[p.nodeName] || p.closest('.erp-go')) return NodeFilter.FILTER_REJECT;
          return /\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
      var nodes = [], n;
      while ((n = walker.nextNode())) nodes.push(n);
      nodes.forEach(decorate);
    });
  }
  var scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 200);
  }

  /* ── what the ERP asks for: a tab, and something to find on it — a stock number, or a client's name on Clients ── */
  function parseRequest(hash) {
    var p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    return { tab: p.get('tab') || '', q: p.get('q') || p.get('stock') || '' };
  }
  var pending = null;
  function applyRequest(r) {
    if (!r || !r.tab) return;
    if (!window._bootstrapDone) { pending = r; return; }
    if (typeof showTab === 'function' && document.getElementById('tab-' + r.tab)) showTab(r.tab);
    if (!r.q) return;
    if (r.tab === 'clients') findClient(r.q);
    else setTimeout(function () { if (!highlight(r.q)) searchFor(r.q); }, 350);
  }
  /* The row carrying this stock number on the tab shown: scrolled to and marked for a moment. */
  function highlight(no) {
    scan();
    var hit = null;
    roots().some(function (root) {
      hit = root.querySelector('[data-erp-stock="' + CSS.escape(no) + '"]');
      return Boolean(hit);
    });
    if (!hit) return false;
    var row = hit.closest('tr, li, [class*="card"], [class*="row"]') || hit.parentNode;
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.add('erp-hit');
    setTimeout(function () { row.classList.add('erp-fade'); }, 1800);
    setTimeout(function () { row.classList.remove('erp-hit', 'erp-fade'); }, 3500);
    return true;
  }
  /* Not on this tab: the app's own search on the dashboard, which looks everywhere. */
  function searchFor(q) {
    var input = document.getElementById('dashSearchInput');
    if (!input || typeof dashSearchLive !== 'function') return;
    if (typeof showTab === 'function') showTab('dashboard');
    input.value = q;
    dashSearchLive(q);
    input.focus();
  }
  /* A client by name: the Clients tab searched for it, and the client's own profile when exactly one carries the name. */
  function findClient(name) {
    var input = document.getElementById('clientSearch');
    if (input) {
      input.value = name;
      if (typeof renderClients === 'function') renderClients();
    }
    var s = typeof state !== 'undefined' ? state : null;
    var same = ((s && s.clients) || []).filter(function (c) { return String(c.name || '').trim().toLowerCase() === name.trim().toLowerCase(); });
    if (same.length === 1 && typeof openClientDetail === 'function') setTimeout(function () { openClientDetail(same[0].id); }, 250);
  }
  window.addEventListener('hashchange', function () { applyRequest(parseRequest(location.hash)); });
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || e.data.erp !== 'tab') return;
    applyRequest({ tab: String(e.data.tab || ''), q: String(e.data.q || e.data.stock || '') });
  });

  /* ── start, once the app has loaded its data ── */
  function whenReady(fn) {
    if (window._bootstrapDone) return fn();
    var tries = 0;
    var t = setInterval(function () {
      if (window._bootstrapDone || ++tries > 800) {
        clearInterval(t);
        if (window._bootstrapDone) fn();
      }
    }, 150);
  }
  document.addEventListener('DOMContentLoaded', function () {
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    whenReady(function () {
      ask();
      setInterval(ask, 60000);
      applyRequest(pending || parseRequest(location.hash));
      pending = null;
    });
  });
})();
