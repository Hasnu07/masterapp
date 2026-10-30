/*
 * The ERP inside the logistics app's page (30 Oct 2026). The ERP serves the
 * app at /lg-app/ and puts this script first in its <head>, so it runs before
 * the app's own. The two are one connected whole ("every watch should be
 * linked already because it is the same watch"): nothing is added to the
 * page but the links themselves —
 *  - the app's own sign-in screen is hidden; the ERP's sign-in stands in for it;
 *  - the tab the ERP asks for is opened (#tab=…&q=… on the frame's address, or
 *    a message from the ERP's page), and what it names is found there: a stock
 *    number's row scrolled to and marked for a moment (else the app's own
 *    search on it), or on Clients a client's name searched and its profile
 *    opened;
 *  - every stock number the app shows that is OUR watch IS the link to our
 *    watch, and every client name that is OUR client IS the link to our client
 *    — the text itself, no badge (POST /api/lg-app/links decides: a stock
 *    number is our watch of that number; a name is our client when exactly one
 *    of ours carries it, else as the copied records tie it to one);
 *  - a stock number typed into one of the app's forms fills the watch in from
 *    the ERP — brand, model, reference, serial, watch date — where the form's
 *    fields are still empty (GET /api/lg-app/watch); and our clients' names
 *    are offered in the app's own name lists, so a name typed there can be
 *    ours exactly (GET /api/lg-app/clients).
 * Nothing here writes to the app's records.
 */
(function () {
  'use strict';
  var inErp = window.parent !== window;
  var ours = { watches: {}, clients: {} }; // stock number → our watch; a name, lower-cased → our client
  var known = ''; // what was last asked, so the same lists are not sent twice
  var ourNames = null; // every client of ours, by name, for the app's name lists

  var style = document.createElement('style');
  style.textContent = [
    '#authScreen { display: none !important; }',
    '.erp-link { color: inherit; text-decoration: none; border-bottom: 1px dotted rgba(90, 80, 60, .45); cursor: pointer; }',
    '.erp-link:hover, .erp-link:focus-visible { color: #8a6a2f; border-bottom-color: #8a6a2f; outline: none; }',
    '.erp-hit { outline: 3px solid #8a6a2f; outline-offset: 2px; transition: outline-color 1.5s; }',
    '.erp-hit.erp-fade { outline-color: transparent; }',
    // As a window on the ERP's watch page: only the watch's own passport shows, none of the app around it.
    // The app's windows live inside <main>: everything in it but a window goes.
    'body.erp-window .sidebar, body.erp-window main > *:not(.modal-bg), body.erp-window .mobile-bottom-nav, body.erp-window #syncBanner, body.erp-window #saveHealthBar { display: none !important; }',
    'body.erp-window { background: #fff; }',
    'body.erp-window #stockPassportModal.show { background: #fff; padding: 0; align-items: stretch; }',
    'body.erp-window #stockPassportModal.show > * { max-width: none; width: 100%; max-height: none; height: 100%; border-radius: 0; box-shadow: none; }',
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);

  var erpHeaders = { 'X-Requested-With': 'masterapp' };
  function erpGet(url) {
    return fetch(url, { credentials: 'same-origin', headers: erpHeaders }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

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
        if (!r || typeof r !== 'object') return;
        if (r.stockNumber != null) {
          split(r.stockNumber).forEach(function (n) {
            n = String(n).trim();
            if (/^\d{1,6}[A-Za-z]?$/.test(n)) nos[n] = 1;
          });
        }
        // Names typed on records: a supplier, a buyer, who a watch came from, who it is with.
        ['supplier', 'soldToBuyer', 'from', 'fromClientName', 'holder'].forEach(function (f) {
          var v = r[f];
          if (typeof v === 'string' && v.trim() && v.length < 80) names[v.trim()] = 1;
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

  /* ── the links: the text itself ── */
  var HASH_NO = /#\s?(\d{1,6}[A-Za-z]?)(?![\w.])/g; // "#1461" anywhere in a text
  var BARE_NO = /^\s*(\d{3,6}[A-Za-z]?)\s*$/; // a cell or label that is only the number
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1 };

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
  /* Wrap [from, to) of a text node in a link, keeping the text as it is. */
  function wrap(node, from, to, a) {
    var mid = from > 0 ? node.splitText(from) : node;
    if (to - from < mid.nodeValue.length) mid.splitText(to - from);
    mid.parentNode.insertBefore(a, mid);
    a.appendChild(mid);
  }
  var labelLike = function (el) { return /^(TD|TH|B|STRONG|SPAN|DIV|LI|H[1-6]|LABEL|P|SMALL|EM)$/.test(el.nodeName) && el.childNodes.length <= 3; };

  function decorate(node) {
    var parent = node.parentNode;
    if (!parent) return;
    var text = node.nodeValue;
    // "#1461" in a sentence or a cell. From the end, so earlier offsets hold.
    var found = [], m;
    HASH_NO.lastIndex = 0;
    while ((m = HASH_NO.exec(text))) if (ours.watches[m[1]]) found.push({ from: m.index, to: m.index + m[0].length, no: m[1] });
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

  /* Only what is on screen: the tab shown, and any open window or drawer. */
  function roots() {
    var out = [];
    document.querySelectorAll('main > section').forEach(function (s) { if (s.style.display !== 'none') out.push(s); });
    document.querySelectorAll('.modal-bg.show, aside:not([hidden]):not(.sidebar)').forEach(function (m) { out.push(m); });
    return out;
  }
  function scan() {
    if (Object.keys(ours.watches).length || Object.keys(ours.clients).length) {
      roots().forEach(function (root) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
          acceptNode: function (n) {
            var p = n.parentNode;
            // Not inside a link or a button of the app's own, nor one of ours already.
            if (!p || p.nodeType !== 1 || SKIP[p.nodeName] || p.closest('a, button, .erp-link')) return NodeFilter.FILTER_REJECT;
            return /\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          },
        });
        var nodes = [], n;
        while ((n = walker.nextNode())) nodes.push(n);
        nodes.forEach(decorate);
      });
    }
    offerNames();
    watchForms();
  }
  var scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 200);
  }

  /* ── our clients' names in the app's own name lists ── */
  function offerNames() {
    if (!ourNames) return;
    ['clientNameList', 'shipClientList'].forEach(function (id) {
      var dl = document.getElementById(id);
      if (!dl) return;
      var have = {};
      dl.querySelectorAll('option').forEach(function (o) { have[(o.value || '').trim().toLowerCase()] = 1; });
      ourNames.forEach(function (c) {
        if (have[c.name.toLowerCase()]) return;
        var o = document.createElement('option');
        o.value = c.name;
        o.setAttribute('data-erp-client', c.id);
        dl.appendChild(o);
      });
    });
  }

  /* ── a stock number typed in one of the app's forms fills the watch in from the ERP ── */
  // The app's forms, by the id of their stock-number field: where the brand, model, reference, serial and date go.
  var FORMS = [
    { stock: 'lonRowStock', brand: 'lonRowBrand', model: 'lonRowModel', reference: 'lonRowRef', serial: 'lonRowSerial' },
    { stock: 'incStock', brand: 'incBrand', model: 'incWatchModel', reference: 'incRef', serial: 'incSerial', date: 'incWatchDate' },
    { stock: 'receiveStock', brand: 'receiveBrand', model: 'receiveModel', reference: 'receiveRef', serial: 'receiveSerial', date: 'receiveWatchDate' },
    { stock: 'hkRowStock', brand: 'hkRowBrand', desc: 'hkRowDesc' },
    { stock: 'tpmShipStock', brand: 'tpmShipBrand', reference: 'tpmShipRef' },
    { stock: 'txStock', brand: 'txBrand', reference: 'txReference' },
  ];
  var fetched = {}; // stock number → our watch, or null
  function ourWatch(no) {
    if (no in fetched) return Promise.resolve(fetched[no]);
    return erpGet('/api/lg-app/watch?no=' + encodeURIComponent(no)).then(function (j) {
      fetched[no] = j && j.watch ? j.watch : null;
      return fetched[no];
    });
  }
  function setValue(el, value) {
    if (!el || !value) return false;
    if (el.tagName === 'SELECT') {
      var opt = Array.prototype.find.call(el.options, function (o) { return (o.text || o.value).trim().toLowerCase() === value.trim().toLowerCase(); });
      if (!opt || el.value === opt.value) return false;
      el.value = opt.value;
    } else {
      if (el.value.trim()) return false; // what somebody typed stands
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  function fillFrom(form, input) {
    var no = (input.value || '').trim();
    if (!/^\d{1,6}[A-Za-z]?$/.test(no)) return;
    ourWatch(no).then(function (w) {
      if (!w || (input.value || '').trim() !== no) return;
      var el = function (k) { return form[k] ? document.getElementById(form[k]) : null; };
      setValue(el('brand'), w.brand);
      setValue(el('model'), w.model);
      setValue(el('reference'), w.reference);
      setValue(el('serial'), w.serial);
      setValue(el('date'), w.watch_date);
      if (form.desc) setValue(el('desc'), [w.brand, w.model].filter(Boolean).join(' ') + (w.reference ? ' | Ref ' + w.reference : '') + (w.serial ? ' | SNR ' + w.serial : ''));
    });
  }
  function watchForms() {
    FORMS.forEach(function (form) {
      var input = document.getElementById(form.stock);
      if (!input || input.getAttribute('data-erp-fills')) return;
      input.setAttribute('data-erp-fills', '1');
      var t = null;
      input.addEventListener('input', function () { clearTimeout(t); t = setTimeout(function () { fillFrom(form, input); }, 500); });
      input.addEventListener('change', function () { clearTimeout(t); fillFrom(form, input); });
    });
  }

  /* ── what the ERP asks for: a tab, and something to find on it — a stock number, or a client's name on Clients ── */
  function parseRequest(hash) {
    var p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    return { tab: p.get('tab') || '', q: p.get('q') || p.get('stock') || '', passport: p.get('passport') || '' };
  }
  var pending = null;
  function applyRequest(r) {
    if (!r || (!r.tab && !r.passport)) return;
    if (!window._bootstrapDone) { pending = r; return; }
    if (r.passport) return showPassport(r.passport);
    if (r.passportInApp) return showPassport(r.passportInApp, true);
    if (typeof showTab === 'function' && document.getElementById('tab-' + r.tab)) showTab(r.tab);
    if (!r.q) return;
    if (r.tab === 'clients') findClient(r.q);
    else setTimeout(function () { if (!highlight(r.q)) searchFor(r.q); }, 350);
  }

  /*
   * The watch's passport as a window on the ERP's watch page (asked 30 Oct
   * 2026: "whatever it is in logistics, its info as a window when I tap a
   * button named Logistics"): the app's own stock passport — its rows in
   * every list, photos, handover history, shipments — with the rest of the
   * app hidden around it. Its Close button, or the ERP's, ends it; the ERP
   * is told, so it can take the frame away again.
   */
  var inWindow = false;
  function tellErp(msg) {
    if (inErp) window.parent.postMessage(msg, location.origin);
  }

  /*
   * Everything the app holds on one stock number, handed to the ERP as records
   * (asked 30 Oct 2026: the watch's logistics as a window on its page, in the
   * ERP's own look): the same lists the app's passport gathers — incomings,
   * the rows in every stock list with their movements, sales, waiting
   * deliveries, shipments, courier shipments, accessory transactions and their
   * settlements, cost lines, trips — plus the names its ids stand for, and
   * every picture with an address the ERP can show.
   */
  function photoUrl(p) {
    if (typeof p !== 'string' || !p) return null;
    if (/^(data:|https?:|blob:)/.test(p)) return p;
    var base = (typeof _r2Url === 'function' && _r2Url()) || window.PUROSANGUE_CF_WORKER || '';
    return base ? base.replace(/\/+$/, '') + (p[0] === '/' ? '' : '/') + p : null;
  }
  function withPhotos(r) {
    if (!r || typeof r !== 'object') return r;
    var out = Array.isArray(r) ? [] : {};
    Object.keys(r).forEach(function (k) {
      var v = r[k];
      if (Array.isArray(v) && v.length && v.every(function (x) { return typeof x === 'string'; }) && /photo|image|pic|doc/i.test(k)) out[k] = v.map(photoUrl).filter(Boolean);
      else if (v && typeof v === 'object') out[k] = withPhotos(v);
      else out[k] = v;
    });
    return out;
  }
  function passportData(no) {
    var s = typeof state !== 'undefined' ? state : null;
    if (!s) return null;
    var split = typeof splitStockList === 'function' ? splitStockList : function (v) { return String(v || '').split(/[,\n;]+/).map(function (x) { return x.trim(); }).filter(Boolean); };
    var want = {};
    split(no).forEach(function (x) { want[x] = 1; });
    var has = function (v) { return split(String(v || '')).some(function (x) { return want[x]; }); };
    var exact = function (r) { return r && want[String(r.stockNumber || '').trim()]; };
    var list = function (k, f) { return ((s[k] || []).filter(f)).map(withPhotos); };
    var txns = (s.transactions || []).filter(function (t) { return has(t.stockNumber); });
    var txIds = {};
    txns.forEach(function (t) { txIds[t.id] = 1; });
    var costs = (s.logisticCosts || []).filter(function (c) { return has(c.stockNumber); });
    var tripIds = {};
    costs.forEach(function (c) { if (c.tripId) tripIds[c.tripId] = 1; });
    (s.personTrips || []).forEach(function (t) {
      (t.stockIds || []).forEach(function (id) {
        var row = String(id).replace(/^[a-z]+-/, '');
        ['londonStock', 'dubaiStock', 'hkStock', 'incomings', 'soldStocks', 'readyForDelivery'].forEach(function (k) {
          if ((s[k] || []).some(function (r) { return r.id === row && exact(r); })) tripIds[t.id] = 1;
        });
      });
    });
    var names = {};
    (s.clients || []).forEach(function (c) { if (c && c.id) names[c.id] = { name: c.name || '', country: c.country || '' }; });
    var movers = {};
    (s.thirdPartyMovers || []).forEach(function (m) { if (m && m.id) movers[m.id] = { name: m.name || '', country: m.country || '' }; });
    var meta = typeof lookupStockMeta === 'function' ? lookupStockMeta(no) : null;
    return {
      stock: no,
      meta: meta || null,
      incomings: list('incomings', function (r) { return has(r.stockNumber); }),
      london: list('londonStock', exact),
      dubai: list('dubaiStock', exact),
      hk: list('hkStock', exact),
      hkSituation: list('hkSituation', exact),
      safe: list('safeStock', exact),
      checkout: list('checkoutStock', exact),
      sold: list('soldStocks', exact),
      ready: list('readyForDelivery', exact),
      shipments: list('shipments', function (r) { return has(r.stockNumber); }),
      movers: list('thirdPartyShipments', function (r) { return has(r.stockNumber); }),
      transactions: txns.map(withPhotos),
      settlements: list('settlements', function (x) { return x.txId && txIds[x.txId]; }),
      costs: costs.map(withPhotos),
      trips: list('personTrips', function (t) { return tripIds[t.id]; }),
      polish: list('externalPolish', function (r) { return has(r.stockNumber); }),
      collect: list('accCollect', function (r) { return has(r.stockNumber); }),
      give: list('accGive', function (r) { return has(r.stockNumber); }),
      clients: names,
      moverNames: movers,
    };
  }
  var dataWanted = null;
  function answerData(no) {
    if (!window._bootstrapDone) { dataWanted = no; return; }
    tellErp({ erp: 'passport-data', stock: no, data: passportData(no) });
  }
  function showPassport(no, inApp) {
    if (typeof openStockPassportModal !== 'function') return;
    // In the app itself (the Logistics page, the app around it): the passport in front, nothing hidden.
    if (inApp) {
      if (typeof showTab === 'function') showTab('dashboard');
      openStockPassportModal(no);
      return;
    }
    inWindow = true;
    document.body.classList.add('erp-window');
    openStockPassportModal(no);
    window.scrollTo(0, 0);
    var modal = document.getElementById('stockPassportModal');
    if (modal) modal.scrollTop = 0;
  }
  function leaveWindow() {
    if (!inWindow) return;
    inWindow = false;
    document.body.classList.remove('erp-window');
    tellErp({ erp: 'passport-closed' });
  }
  document.addEventListener('DOMContentLoaded', function () {
    var modal = document.getElementById('stockPassportModal');
    if (!modal) return;
    new MutationObserver(function () {
      if (inWindow && !modal.classList.contains('show')) leaveWindow();
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  });
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
    if (e.origin !== location.origin || !e.data) return;
    if (e.data.erp === 'tab') {
      // Back to the app as a page: a passport left open as a window is closed first.
      if (inWindow && typeof closeModal === 'function') closeModal('stockPassportModal');
      applyRequest({ tab: String(e.data.tab || ''), q: String(e.data.q || e.data.stock || '') });
    } else if (e.data.erp === 'passport') {
      if (e.data.inApp) {
        if (!window._bootstrapDone) pending = { tab: 'dashboard', passportInApp: String(e.data.stock || '') };
        else showPassport(String(e.data.stock || ''), true);
      } else applyRequest({ passport: String(e.data.stock || '') });
    } else if (e.data.erp === 'passport-data') {
      answerData(String(e.data.stock || ''));
    } else if (e.data.erp === 'passport-close' && typeof closeModal === 'function') {
      closeModal('stockPassportModal');
      leaveWindow();
    }
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
      erpGet('/api/lg-app/clients').then(function (j) {
        ourNames = (j && j.clients) || [];
        scheduleScan();
      });
      applyRequest(pending || parseRequest(location.hash));
      pending = null;
      if (dataWanted) answerData(dataWanted);
      dataWanted = null;
    });
  });
})();
