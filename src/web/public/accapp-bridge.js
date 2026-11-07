/*
 * The ERP inside the accounts app's page (4 Nov 2026). The ERP serves the app
 * at /acc-app/ and puts this script first in its <head>, so it runs before the
 * app's own. The two are one connected whole, as with the logistics app:
 * nothing is added to the page but the links themselves —
 *  - every stock number the app shows that is OUR watch IS the link to our
 *    watch, and every client name that is OUR client IS the link to our client
 *    — the text itself, no badge (POST /api/acc-app/links decides: a stock
 *    number is our watch of that number; a name is our client when exactly one
 *    of ours carries it, else as the copied ledger ties it to one);
 *  - a stock number typed into one of the app's forms (an entry's "Stock no.",
 *    a part-exchange row) fills the watch in from the ERP — model, serial —
 *    where the form's fields are still empty (GET /api/acc-app/watch);
 *  - the page the ERP asks for is opened (#path=…&q=…, #stock=…, #client=… on
 *    the frame's address, or a message from the ERP's page): a stock number on
 *    the Stock report, a client's own profile when the ERP knows which one;
 *  - the app's API and uploads are reached through the ERP (/acc-app/…): the
 *    served script is already rewritten; this is the safety net for any call
 *    built at run time.
 * The app's own sign-in stays: each person signs in to the accounts app once,
 * here, with their own accounts account, so it still records who did what.
 * Nothing here writes to the app's records.
 */
(function () {
  'use strict';
  var inErp = window.parent !== window;
  var PREFIX = '/acc-app';
  // Inside the ERP the app opens in its light theme, the console's own look — unless the person has chosen one in the app (its toggle writes the same key).
  try {
    if (inErp && !localStorage.getItem('app-theme')) localStorage.setItem('app-theme', 'light');
  } catch (e) { /* storage unavailable */ }
  var ours = { watches: {}, clients: {} }; // stock number → our watch; a name, lower-cased → our client
  var asked = { stock: {}, clients: {} }; // what the ERP has been asked about already

  /* ── the app's own calls, through the ERP ── */
  function reroute(u) {
    if (typeof u !== 'string') return u;
    if (/^\/(api|uploads)\//.test(u) || u === '/api') return PREFIX + u;
    return u;
  }
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    if (typeof input === 'string') input = reroute(input);
    else if (input && typeof input === 'object' && typeof input.url === 'string' && input.url.indexOf(location.origin + '/api/') === 0) input = new Request(PREFIX + input.url.slice(location.origin.length), input);
    return origFetch.call(this, input, init);
  };
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    arguments[1] = reroute(url);
    return origOpen.apply(this, arguments);
  };
  var origWinOpen = window.open;
  window.open = function (url) {
    arguments[0] = reroute(url);
    return origWinOpen.apply(this, arguments);
  };

  var style = document.createElement('style');
  style.textContent = [
    '.erp-link { color: inherit; text-decoration: none; border-bottom: 1px dotted rgba(221, 185, 106, .55); cursor: pointer; }',
    '.erp-link:hover, .erp-link:focus-visible { color: #ddb96a; border-bottom-color: #ddb96a; outline: none; }',
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  var erpHeaders = { 'X-Requested-With': 'masterapp' };
  function erpGet(url) {
    return origFetch.call(window, url, { credentials: 'same-origin', headers: erpHeaders }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function openInErp(hash) {
    if (inErp) window.parent.location.hash = hash;
    else window.location.href = '/' + hash;
  }

  /* ── what is on screen: every stock-number-like token, every short text that could be a name ── */
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1, NOSCRIPT: 1 };
  var STOCK_TOKEN = /(?:^|[^\w.,])#?(\d{3,6}[A-Za-z]?)(?![\w.,%])/g;
  function textNodes() {
    var root = document.getElementById('root');
    if (!root) return [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode;
        if (!p || p.nodeType !== 1 || SKIP[p.nodeName] || p.closest('a, button, .erp-link')) return NodeFilter.FILTER_REJECT;
        return /\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    var nodes = [], n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }
  var nameLike = function (t) { return t.length >= 2 && t.length <= 60 && /\p{L}/u.test(t) && !/\d{3,}|[@:;|]|^\s*(total|net|balance|open|settled|partial|cancelled|paid|unpaid|due|date|amount|status|client|stock|model|notes?|invoice)\s*$/i.test(t); };

  function ask() {
    var stock = {}, names = {}, m;
    textNodes().forEach(function (n) {
      var text = n.nodeValue;
      STOCK_TOKEN.lastIndex = 0;
      while ((m = STOCK_TOKEN.exec(text))) if (!asked.stock[m[1]]) stock[m[1]] = 1;
      var t = text.trim();
      if (nameLike(t) && !asked.clients[t]) names[t] = 1;
    });
    var s = Object.keys(stock).slice(0, 2000), c = Object.keys(names).slice(0, 1000);
    if (!s.length && !c.length) return;
    s.forEach(function (x) { asked.stock[x] = 1; });
    c.forEach(function (x) { asked.clients[x] = 1; });
    origFetch.call(window, '/api/acc-app/links', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'masterapp' },
      body: JSON.stringify({ stock: s, clients: c }),
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) { s.forEach(function (x) { delete asked.stock[x]; }); c.forEach(function (x) { delete asked.clients[x]; }); return; }
        Object.keys(j.watches || {}).forEach(function (no) { ours.watches[no] = j.watches[no]; });
        Object.keys(j.clients || {}).forEach(function (n) { ours.clients[n.toLowerCase()] = j.clients[n]; });
        scheduleScan();
      })
      .catch(function () { s.forEach(function (x) { delete asked.stock[x]; }); c.forEach(function (x) { delete asked.clients[x]; }); });
  }

  /* ── the links: the text itself ── */
  var SAID_NO = /(?:#|\bstock\s*#?\s*)(\d{1,6}[A-Za-z]?)(?![\w.])/gi; // "#1461", "Stock 1461", "Stock #1461" in a sentence
  var BARE_NO = /^\s*#?(\d{3,6}[A-Za-z]?)\s*$/; // a cell or label that is only the number
  var labelLike = function (el) { return /^(TD|TH|B|STRONG|SPAN|DIV|LI|H[1-6]|LABEL|P|SMALL|EM|DT|DD)$/.test(el.nodeName) && el.childNodes.length <= 3; };

  function link(hash, title, attr, value) {
    var a = document.createElement('a');
    a.className = 'erp-link';
    a.href = '/' + hash;
    a.title = title;
    a.setAttribute(attr, value);
    a.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      openInErp(hash);
    });
    return a;
  }
  function wrap(node, from, to, a) {
    var mid = from > 0 ? node.splitText(from) : node;
    if (to - from < mid.nodeValue.length) mid.splitText(to - from);
    mid.parentNode.insertBefore(a, mid);
    a.appendChild(mid);
  }
  function decorate(node) {
    var parent = node.parentNode;
    if (!parent) return;
    var text = node.nodeValue;
    var found = [], m;
    SAID_NO.lastIndex = 0;
    while ((m = SAID_NO.exec(text))) if (ours.watches[m[1]]) found.push({ from: m.index, to: m.index + m[0].length, no: m[1] });
    if (found.length) {
      for (var i = found.length - 1; i >= 0; i--) {
        var f = found[i], w = ours.watches[f.no];
        wrap(node, f.from, f.to, link('#/watch/' + w.id, 'Stock ' + f.no + ' in the ERP' + (w.title ? ' — ' + w.title : ''), 'data-erp-stock', f.no));
      }
      return;
    }
    if (!labelLike(parent)) return;
    var b = BARE_NO.exec(text);
    if (b && ours.watches[b[1]]) {
      var bw = ours.watches[b[1]];
      wrap(node, 0, text.length, link('#/watch/' + bw.id, 'Stock ' + b[1] + ' in the ERP' + (bw.title ? ' — ' + bw.title : ''), 'data-erp-stock', b[1]));
      return;
    }
    var c = ours.clients[text.trim().toLowerCase()];
    if (c) wrap(node, 0, text.length, link('#/client/' + c.id, c.name + ' in the ERP', 'data-erp-client', String(c.id)));
  }
  function scan() {
    if (Object.keys(ours.watches).length || Object.keys(ours.clients).length) textNodes().forEach(decorate);
    watchForms();
  }
  var scanTimer = null, askTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 200);
    clearTimeout(askTimer);
    askTimer = setTimeout(ask, 600);
  }

  /* ── a stock number typed in one of the app's forms fills the watch in from the ERP ── */
  // The app's inputs are React's: a value set from outside must go through the element's own setter, then an input event.
  var valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  function setValue(el, value) {
    if (!el || !value || el.value.trim()) return false; // what somebody typed stands
    valueSetter.call(el, String(value).toUpperCase()); // the app writes everything in capitals
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  var STOCK_INPUT = /^e\.g\. (1385|stock no\.)$/i;
  var fetched = {};
  function ourWatch(no) {
    if (no in fetched) return Promise.resolve(fetched[no]);
    return erpGet('/api/acc-app/watch?no=' + encodeURIComponent(no)).then(function (j) {
      fetched[no] = j && j.watch ? j.watch : null;
      return fetched[no];
    });
  }
  /* The inputs after this one in the same form: the model/description, and a serial if the form has one. */
  function siblings(input) {
    var form = input.closest('form, .wt-modal, .wt-grid, [class*="modal"]') || document.getElementById('root');
    var all = Array.prototype.slice.call(form.querySelectorAll('input'));
    var i = all.indexOf(input);
    var after = all.slice(i + 1, i + 6);
    return {
      model: after.find(function (x) { return /model|description|exchange/i.test(x.placeholder || ''); }),
      serial: after.find(function (x) { return /serial/i.test(x.placeholder || ''); }),
    };
  }
  function fillFrom(input) {
    var no = (input.value || '').trim();
    if (!/^\d{1,6}[A-Za-z]?$/.test(no)) return;
    ourWatch(no).then(function (w) {
      if (!w || (input.value || '').trim() !== no) return;
      var s = siblings(input);
      setValue(s.model, [w.brand, w.model].filter(Boolean).join(' ') + (w.reference ? ' ' + w.reference : ''));
      setValue(s.serial, w.serial);
    });
  }
  function watchForms() {
    document.querySelectorAll('input[placeholder]').forEach(function (input) {
      if (!STOCK_INPUT.test(input.placeholder) || input.getAttribute('data-erp-fills')) return;
      input.setAttribute('data-erp-fills', '1');
      var t = null;
      input.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { fillFrom(input); }, 600); });
      input.addEventListener('blur', function () { clearTimeout(t); fillFrom(input); });
    });
  }

  /* ── what the ERP asks for: a page, and something to find on it ── */
  function navigate(path) {
    if (location.pathname !== path) {
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} })); // the app's router listens for this
    }
  }
  /* The page's own search box, once the page has drawn: filled in as if typed. */
  function searchFor(q, tries) {
    tries = tries || 0;
    var box = Array.prototype.find.call(document.querySelectorAll('main input[placeholder], input[placeholder]'), function (x) { return /search|stock, reference/i.test(x.placeholder || '') && !x.closest('aside, nav'); });
    if (!box) {
      if (tries < 20) setTimeout(function () { searchFor(q, tries + 1); }, 150);
      return;
    }
    valueSetter.call(box, q);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
  }
  function parseRequest(hash) {
    var p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    if (p.get('stock')) return { stock: p.get('stock') };
    if (p.get('client')) return { client: p.get('client') };
    if (p.get('path')) return { path: p.get('path'), q: p.get('q') || '' };
    return null;
  }
  var pending = parseRequest(location.hash);
  var signedIn = function () { return Boolean(document.querySelector('#root aside, #root nav')) && !document.querySelector('#root input[type="password"]'); };
  function applyRequest(r) {
    if (!r) return;
    if (!signedIn()) { pending = r; return; } // the app's own sign-in first; then this
    pending = null;
    if (r.stock) {
      navigate('/reports/stock');
      setTimeout(function () { searchFor(r.stock); }, 200);
    } else if (r.client) {
      erpGet('/api/acc-app/client?name=' + encodeURIComponent(r.client)).then(function (j) {
        if (j && j.acc_client_id) navigate('/clients/' + encodeURIComponent(j.acc_client_id));
        else {
          navigate('/clients');
          setTimeout(function () { searchFor(r.client); }, 200);
        }
      });
    } else if (r.path) {
      navigate(/^\/[\w\-/]*$/.test(r.path) ? r.path : '/');
      if (r.q) setTimeout(function () { searchFor(r.q); }, 200);
    }
  }
  window.addEventListener('hashchange', function () { applyRequest(parseRequest(location.hash)); });
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || e.data.erp !== 'open') return;
    applyRequest({ stock: e.data.stock, client: e.data.client, path: e.data.path, q: e.data.q });
  });

  /* ── start, and keep up with the page as the app redraws it ── */
  document.addEventListener('DOMContentLoaded', function () {
    new MutationObserver(function () {
      scheduleScan();
      if (pending && signedIn()) applyRequest(pending);
    }).observe(document.body, { childList: true, subtree: true });
    scheduleScan();
    setInterval(ask, 60000);
  });
})();
