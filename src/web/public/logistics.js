/*
 * Logistics IS the logistics app (asked 30 Oct 2026: "put the whole logistics
 * app on the ERP, same how it already is"): the app's own page, served by the
 * ERP at /lg-app/ behind the sign-in, in one frame under the bar. The frame is
 * made once and kept while other pages show, so coming back costs nothing.
 * #/logistics/<tab>/<what> opens the app's tab and finds <what> there — a stock
 * number on most tabs, a client's name on Clients (the bridge inside the frame
 * does it — lgapp-bridge.js). The ERP's own logistics pages were removed the
 * same day; only the app is left.
 */
const lgApp = { frame: null };
const lgGroups = () => state.meta?.logistics?.groups || [];
const lgAppOn = () => Boolean(state.meta?.logistics?.app_embedded);
const lgAppHost = () => document.getElementById('lg-app-host');
/* The app's tab for one of our links: a key of GROUPS (kinds.js), or the app's own tab name. */
const lgAppTab = (group) => lgGroups().find((x) => x.key === group)?.app || group || 'dashboard';

/* The frame fills the screen under the bar, whatever height the bar wraps to. */
function lgAppFit() {
  const host = lgAppHost();
  if (!host || host.classList.contains('hide')) return;
  const bar = document.getElementById('bar');
  host.style.height = `${Math.max(240, window.innerHeight - (bar ? bar.getBoundingClientRect().bottom : 0))}px`;
}
window.addEventListener('resize', lgAppFit);
function lgAppHide() {
  lgAppHost()?.classList.add('hide');
  lgAppHost()?.classList.remove('as-window');
  document.getElementById('lg-app-scrim')?.remove();
  $('#app').classList.remove('hide');
}

/*
 * The app's own passport of a stock number as a window over the page — the
 * same frame laid over the page like a window, the app's chrome hidden around
 * it (the bridge's erp-window). The app's Close, the scrim, × or Esc put it
 * away; the frame stays loaded. Reached from the foot of our own window.
 */
function showLogisticsAppWindow(stockNo) {
  if (!lgAppOn() || !can('editor') || !stockNo) return;
  const host = lgAppHost();
  if (!document.getElementById('lg-app-scrim')) {
    const scrim = document.createElement('div');
    scrim.id = 'lg-app-scrim';
    scrim.innerHTML = '<button type="button" class="lg-win-x" aria-label="Close the logistics window">×</button>';
    scrim.addEventListener('click', lgWindowClose);
    document.body.appendChild(scrim);
  }
  host.classList.add('as-window');
  host.classList.remove('hide');
  if (!lgApp.frame) {
    lgApp.frame = document.createElement('iframe');
    lgApp.frame.title = 'Purosangue Watches Logistics';
    lgApp.frame.src = `/lg-app/#passport=${encodeURIComponent(stockNo)}`;
    host.appendChild(lgApp.frame);
  } else {
    lgApp.frame.contentWindow?.postMessage({ erp: 'passport', stock: stockNo }, location.origin);
  }
}
function lgWindowClose() {
  if (!lgAppHost()?.classList.contains('as-window')) return;
  lgApp.frame?.contentWindow?.postMessage({ erp: 'passport-close' }, location.origin);
  lgAppHide();
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.erp === 'passport-closed') lgAppHide();
  if (e.data.erp === 'passport-data' && e.data.stock === lgWin.no) {
    clearInterval(lgWin.timer);
    lgWinRender(e.data.data);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') lgWindowClose();
});

/*
 * The watch's logistics as a window over its page, in the console's own look
 * (asked 30 Oct 2026: "each logistics info shown to the inventory watch —
 * live shipment, incoming, sold or in stock — as a window when I tap a button
 * named Logistics"; then "design a better window"). The frame, hidden,
 * hands over everything the app holds on the stock number (the bridge's
 * passport-data); the window says in one line where the watch is, then tells
 * its story newest first — every receipt, move, shipment, courier and sale,
 * with the pictures taken — and lists what is still owed and what moving it
 * cost. Nothing is written back. The app's own passport is one link away.
 */
const lgWin = { no: '', timer: null };
function lgWinEl() {
  let d = document.getElementById('lg-win');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'lg-win';
    d.className = 'lgw';
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
    });
    d.addEventListener('close', () => {
      lgWin.no = '';
      clearInterval(lgWin.timer);
    });
    document.body.appendChild(d);
  }
  return d;
}
function showLogisticsWindow(stockNo, title = '') {
  if (!lgAppOn() || !can('editor') || !stockNo) return;
  lgWin.no = stockNo;
  lgWin.title = title;
  const d = lgWinEl();
  d.innerHTML = lgWinShell(stockNo, title, '<p class="count lgw-wait">Reading the logistics app…</p>');
  if (!d.open) d.showModal();
  lgWinBind(d);
  // The frame answers from the app's data; made now, hidden, if it is not there yet — and asked again until it has loaded.
  if (!lgApp.frame) {
    lgApp.frame = document.createElement('iframe');
    lgApp.frame.title = 'Purosangue Watches Logistics';
    lgApp.frame.src = '/lg-app/#tab=dashboard';
    lgAppHost().appendChild(lgApp.frame);
  }
  const ask = () => lgApp.frame?.contentWindow?.postMessage({ erp: 'passport-data', stock: stockNo }, location.origin);
  ask();
  clearInterval(lgWin.timer);
  lgWin.timer = setInterval(ask, 2000);
}
const lgWinShell = (no, title, body) => `
  <div class="lgw-head">
    <div>
      <div class="lgw-eyebrow">Logistics</div>
      <h2>${esc(title || `Stock ${no}`)}</h2>
      ${title ? `<div class="count" style="margin:0">Stock ${esc(no)}</div>` : ''}
    </div>
    <button type="button" class="btn" id="lgw-close">Close</button>
  </div>
  <div class="lgw-body" id="lgw-body">${body}</div>`;
function lgWinBind(d) {
  d.querySelector('#lgw-close')?.addEventListener('click', () => d.close());
  // "See it in the logistics app": the Logistics page — the app itself — with this watch's passport in front of it.
  d.querySelector('#lgw-app')?.addEventListener('click', () => {
    const no = lgWin.no;
    d.close();
    location.hash = '#/logistics';
    setTimeout(() => lgApp.frame?.contentWindow?.postMessage({ erp: 'passport', stock: no, inApp: true }, location.origin), 50);
  });
}

/* ── reading the app's loosely typed values ── */
// A moment as the app writes it: milliseconds, an ISO day or stamp, or DD/MM/YYYY.
function lgWhen(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) {
    const n = Number(v);
    return n > 1e11 ? n : n * 1000;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) + (s.length > 10 ? Date.parse(s) - Date.UTC(+m[1], +m[2] - 1, +m[3]) || 0 : 0);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1]);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
const lgDay = (v) => {
  const t = lgWhen(v);
  return t ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
};
const lgWords = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[,\n;]+/)).map((x) => String(x).trim()).filter(Boolean);
// The app's codes as words: in_person → in person.
const lgSay = (s) => String(s ?? '').replace(/_/g, ' ');
const lgAmount = (n, cur) => {
  const x = Number(String(n ?? '').replace(/[^\d.-]/g, ''));
  if (!x) return '';
  return `${cur ? `${esc(String(cur).toUpperCase())} ` : ''}${x.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`;
};
const lgPics = (list, label = '') =>
  (list || []).length
    ? `<div class="lgw-pics">${list.map((p) => `<a href="${esc(p)}" target="_blank" rel="noopener" class="lgw-pic"><img loading="lazy" src="${esc(p)}" alt="">${label ? `<span>${esc(label)}</span>` : ''}</a>`).join('')}</div>`
    : '';
const lgPicsOf = (r) => Object.keys(r || {}).filter((k) => /photo|image|pic|doc/i.test(k) && Array.isArray(r[k])).flatMap((k) => r[k]);

/* ── the window's content ── */
function lgWinRender(data) {
  const d = lgWinEl();
  const body = d.querySelector('#lgw-body');
  if (!body) return;
  if (!data) {
    body.innerHTML = '<p class="count">The logistics app has not loaded yet. Try again in a moment.</p>';
    return;
  }
  const no = data.stock;
  const who = (id, fallback = '') => data.clients?.[id]?.name || fallback || '';
  const mover = (id, fallback = '') => data.moverNames?.[id]?.name || fallback || '';
  const PLACE = { london: 'London', dubai: 'Dubai', hk: 'Hong Kong', safe: 'the safe' };
  const rows = ['london', 'dubai', 'hk', 'safe'].flatMap((k) => (data[k] || []).map((r) => ({ ...r, _place: PLACE[k] })));
  const current = rows.filter((r) => !r.status || r.status === 'current' || r.status === 'consignment');
  const openShip = (data.shipments || []).filter((s) => s.status !== 'delivered' && s.status !== 'cancelled');
  const openMover = (data.movers || []).filter((s) => s.status !== 'delivered' && s.status !== 'cancelled');
  const sold = [...(data.sold || [])].sort((a, b) => (lgWhen(b.soldDate) || 0) - (lgWhen(a.soldDate) || 0));
  const checkout = (data.checkout || []).filter((r) => !['returned', 'moved', 'sold', 'done'].includes(r.status));
  const incoming = (data.incomings || []).filter((i) => ['pending', 'in_transit', 'consignment', undefined, ''].includes(i.status));

  // Where it is, in one sentence.
  let now = { text: `Nothing in the logistics app for stock ${no}`, tone: 'quiet' };
  if (sold[0]) {
    const s = sold[0];
    now = {
      tone: 'sold',
      text: `Sold to ${s.soldToBuyer || 'a buyer'}${s.soldDate ? ` on ${lgDay(s.soldDate)}` : ''}${s.deliveredAt ? `, delivered${s.deliveredVia ? ` ${lgSay(s.deliveredVia)}` : ''}` : ''}`,
    };
  } else if (data.ready?.[0]) {
    const r = data.ready[0];
    now = { tone: 'warn', text: `Sold to ${r.soldToBuyer || 'a buyer'}, waiting for delivery${r.status === 'shipped' ? ' — shipped' : ''}` };
  } else if (openShip[0]) {
    const s = openShip[0];
    now = { tone: 'moving', text: `On its way, ${who(s.fromClientId, s.fromText || s.from) || 'us'} → ${who(s.toClientId, s.toText || s.to) || '…'}${s.status ? `, ${esc(String(s.status).replace(/_/g, ' '))}` : ''}` };
  } else if (openMover[0]) {
    const s = openMover[0];
    now = { tone: 'moving', text: `With ${mover(s.moverId, s.moverName) || 'a courier'}, ${s.fromCountry || '…'} → ${s.toCountry || '…'}${s.status ? `, ${String(s.status).replace(/_/g, ' ')}` : ''}` };
  } else if (current.find((r) => r.status === 'consignment')) {
    const r = current.find((r) => r.status === 'consignment');
    now = { tone: 'warn', text: `On consignment${r.consignment?.with ? ` with ${r.consignment.with}` : ''}${r.consignment?.date ? `, since ${lgDay(r.consignment.date)}` : ''}` };
  } else if (checkout[0]) {
    now = { tone: 'warn', text: `Checked out${checkout[0].to || checkout[0].reason ? ` — ${checkout[0].to || checkout[0].reason}` : ''}${checkout[0].date ? `, since ${lgDay(checkout[0].date)}` : ''}` };
  } else if (current[0]) {
    const r = current[0];
    const since = r.receivedAt || r.createdAt || r.dateAdded;
    now = { tone: 'here', text: `In ${r._place} stock${since ? ` since ${lgDay(since)}` : ''}${r.from ? `, from ${r.from}` : ''}` };
  } else if (incoming[0]) {
    const i = incoming[0];
    now = { tone: 'moving', text: `Incoming from ${i.supplier || 'a supplier'}${i.eta ? `, expected ${lgDay(i.eta)}` : ''}${i.location ? ` (${i.location})` : ''}` };
  }

  // Plain facts under it.
  const place = current[0] || rows[0];
  const pending = (data.transactions || []).flatMap((t) => (t.items || []).filter((it) => it.status === 'pending').map((it) => ({ ...it, _client: who(t.clientId) })));
  const weOwe = pending.filter((it) => it.direction === 'give');
  const theyOwe = pending.filter((it) => it.direction !== 'give');
  const item = (it) => `${it.qty && it.qty > 1 ? `${it.qty} × ` : ''}${it.accessory || 'item'}${it._client ? ` (${it._client})` : ''}`;
  const facts = [
    place?.watchSerial && ['Serial', place.watchSerial],
    place && lgWords(place.accessoriesPresent).length && ['With it', lgWords(place.accessoriesPresent).join(', ')],
    place && lgWords(place.accessoriesMissing).length && ['Missing', lgWords(place.accessoriesMissing).join(', ')],
    weOwe.length && ['We owe', weOwe.map(item).join(', ')],
    theyOwe.length && ['Owed to us', theyOwe.map(item).join(', ')],
    rows.some((r) => r.polish) && ['Polish', `with ${rows.find((r) => r.polish).polish.sentTo || 'the polisher'} now`],
  ].filter(Boolean);

  // The story, newest first.
  const ev = [];
  const add = (t, title, detail = '', pics = [], tone = '') => ev.push({ t: lgWhen(t), title, detail, pics, tone });
  for (const i of data.incomings || []) {
    add(i.createdAt || i.date || i.eta, `Incoming from ${i.supplier || 'a supplier'}`, [i.location, i.eta ? `expected ${lgDay(i.eta)}` : '', i.status ? String(i.status).replace(/_/g, ' ') : ''].filter(Boolean).join(' · '), lgPicsOf(i), 'moving');
    const arrived = i.arrivedAt || i.arrivalRecord?.date || i.arrivalRecord?.ts;
    if (arrived) add(arrived, 'Arrived', i.arrivalRecord?.notes || '', lgPicsOf(i.arrivalRecord || {}), 'here');
    if (i.receivedAt || i.inventoryDest) add(i.receivedAt || arrived, `Received into ${PLACE[i.inventoryDest] ? `${PLACE[i.inventoryDest]} stock` : i.inventoryDest || 'stock'}`, '', [], 'here');
  }
  // Polish, as the app keeps it on the stock row: the one at the polisher now, and the ones done.
  const polishes = rows.flatMap((r) => [...(r.polish ? [{ ...r.polish, _active: true }] : []), ...(r.polishHistory || [])]);
  for (const p of polishes) {
    add(p.sentDate || p.sentAt, `Sent to ${p.sentTo || 'the polisher'} for polish`, [p.itemDescription || '', p.takenBy ? `taken by ${p.takenBy}` : '', p.costAmount > 0 ? lgAmount(p.costAmount, p.costCurrency) : '', p.notes || ''].filter(Boolean).join(' · '), p.sentPhotos || [], 'warn');
    if (!p._active && (p.returnedDate || p.returnedAt)) add(p.returnedDate || p.returnedAt, 'Back from polish', p.returnNotes || '', p.donePhotos || [], 'here');
  }
  for (const r of rows) {
    add(r.receivedAt || r.createdAt || r.dateAdded, `In ${r._place} stock`, [r.from ? `from ${r.from}` : '', r.status && r.status !== 'current' ? r.status : ''].filter(Boolean).join(' · '), lgPicsOf(r), 'here');
    for (const m of r.movements || []) {
      const to = m.to || m.destination || m.toLocation || '';
      add(m.date || m.ts || m.at || m.movedAt, `${m.type ? String(m.type).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'Moved'}${to ? ` to ${to}` : ''}`, [m.carrier ? `by ${m.carrier}` : '', m.notes || m.note || '', m.cost ? lgAmount(m.cost, m.costCurrency || m.currency) : ''].filter(Boolean).join(' · '), lgPicsOf(m), 'moving');
    }
    if (r.consignment?.date) add(r.consignment.date, `On consignment${r.consignment.with ? ` with ${r.consignment.with}` : ''}`, r.consignment.returnDate ? `back by ${lgDay(r.consignment.returnDate)}` : '', [], 'warn');
  }
  for (const r of data.checkout || []) add(r.date || r.createdAt, `Checked out${r.to || r.reason ? ` — ${r.to || r.reason}` : ''}`, r.returnedAt ? `returned ${lgDay(r.returnedAt)}` : r.status || '', lgPicsOf(r), 'warn');
  for (const s of data.shipments || []) {
    add(s.date || s.createdAt, `Shipped ${who(s.fromClientId, s.fromText || s.from) || 'us'} → ${who(s.toClientId, s.toText || s.to) || '…'}`, [s.tracking ? `tracking ${s.tracking}` : '', s.status ? String(s.status).replace(/_/g, ' ') : '', s.costAmount ? lgAmount(s.costAmount, s.costCurrency) : s.cost || ''].filter(Boolean).join(' · '), [], 'moving');
    if (s.deliveredAt) add(s.deliveredAt, 'Delivered', s.deliveryNotes || '', s.deliveryPhotos || [], 'here');
  }
  for (const s of data.movers || []) {
    add(s.shipmentDate || s.createdAt, `With ${mover(s.moverId, s.moverName) || 'a courier'}, ${s.fromCountry || '…'} → ${s.toCountry || '…'}`, [s.items, s.amount ? lgAmount(s.amount, s.currency) : '', s.paymentStatus ? `payment ${s.paymentStatus}` : '', s.trackingNumber ? `tracking ${s.trackingNumber}` : ''].filter(Boolean).join(' · '), lgPicsOf(s), 'moving');
    if (s.status === 'delivered' && s.deliveryDate) add(s.deliveryDate, `Delivered by ${mover(s.moverId, s.moverName) || 'the courier'}`, '', [], 'here');
  }
  for (const r of data.ready || []) add(r.soldDate || r.createdAt, `Sold to ${r.soldToBuyer || 'a buyer'}, awaiting delivery`, r.soldPrice ? lgAmount(r.soldPrice, r.soldCurrency) : '', lgPicsOf(r), 'sold');
  for (const s of data.sold || []) {
    add(s.soldDate, `Sold to ${s.soldToBuyer || 'a buyer'}`, [s.soldPrice ? lgAmount(s.soldPrice, s.soldCurrency) : '', s.soldFromLocation ? `from ${s.soldFromLocation}` : '', s.soldNotes || ''].filter(Boolean).join(' · '), lgPicsOf(s), 'sold');
    if (s.deliveredAt) add(s.deliveredAt, `Delivered${s.deliveredVia ? ` ${lgSay(s.deliveredVia)}` : ''}`, '', [], 'sold');
  }
  for (const t of data.transactions || []) {
    const items = t.items || [];
    add(t.date || t.createdAt, `${t.type === 'sold' ? 'Sold to' : 'Bought from'} ${who(t.clientId) || 'a client'}`, items.length ? `${items.filter((x) => x.status === 'pending').length} of ${items.length} accessory item${items.length === 1 ? '' : 's'} still pending` : '', [], '');
  }
  for (const t of data.trips || []) add(t.startDate, `Carried by ${t.personName || 'someone'}, ${t.fromLocation || '…'} → ${t.toLocation || '…'}`, [t.purpose, t.status].filter(Boolean).join(' · '), [], 'moving');
  ev.sort((a, b) => (b.t || 0) - (a.t || 0));

  // What moving it cost: the app's cost lines, per currency.
  const totals = {};
  for (const c of data.costs || []) {
    const cur = String(c.currency || '').toUpperCase() || '—';
    totals[cur] = (totals[cur] || 0) + (Number(c.amount) || 0);
  }

  const pics = [];
  const seen = new Set();
  const take = (list, label) => (list || []).forEach((p) => { if (p && !seen.has(p)) { seen.add(p); pics.push({ p, label }); } });
  (data.incomings || []).forEach((r) => take(lgPicsOf(r), 'Incoming'));
  rows.forEach((r) => take(lgPicsOf(r), r._place));
  polishes.forEach((p) => {
    take(p.sentPhotos, 'Before polish');
    take(p.donePhotos, 'After polish');
  });
  (data.sold || []).forEach((r) => take(lgPicsOf(r), 'Sold'));
  (data.shipments || []).forEach((r) => take(r.deliveryPhotos, 'Delivery'));
  (data.movers || []).forEach((r) => take(lgPicsOf(r), 'Courier'));

  const title = lgWin.title || [data.meta?.brand, data.meta?.model].filter(Boolean).join(' ');
  if (title && !lgWin.title) d.querySelector('.lgw-head h2').textContent = title;
  body.innerHTML = `
    <p class="lgw-now ${esc(now.tone)}">${esc(now.text)}</p>
    ${facts.length ? `<div class="lgw-facts">${facts.map(([k, v]) => `<div><span class="k">${esc(k)}</span> ${esc(v)}</div>`).join('')}</div>` : ''}
    ${
      ev.length
        ? `<h3>What happened</h3>
           <ol class="lgw-tl">${ev
             .map(
               (e) => `<li class="${esc(e.tone)}"><time>${e.t ? esc(lgDay(e.t)) : '<span class="blank">no date</span>'}</time>
                 <div><div class="lgw-ev">${esc(e.title)}</div>${e.detail ? `<div class="lgw-d">${esc(e.detail)}</div>` : ''}${lgPics(e.pics)}</div></li>`
             )
             .join('')}</ol>`
        : ''
    }
    ${
      (data.shipments || []).length
        ? `<h3>Shipments</h3><div class="lgw-cards">${(data.shipments || [])
            .map(
              (s) => `<div class="lgw-card"><div class="lgw-card-top"><b>${esc(who(s.fromClientId, s.fromText || s.from) || 'Us')} → ${esc(who(s.toClientId, s.toText || s.to) || '…')}</b><span class="count" style="margin:0">${esc(lgDay(s.date || s.createdAt))}</span></div>
                ${s.items || s.stockNumber ? `<div class="lgw-d">${esc(s.items || `Stock ${s.stockNumber}`)}</div>` : ''}
                <div class="lgw-d">${[s.status ? String(s.status).replace(/_/g, ' ') : '', s.tracking ? `tracking ${s.tracking}` : '', s.deliveredAt ? `delivered ${lgDay(s.deliveredAt)}` : ''].filter(Boolean).map(esc).join(' · ')}</div></div>`
            )
            .join('')}</div>`
        : ''
    }
    ${
      Object.keys(totals).length
        ? `<h3>What moving it cost</h3><div class="lgw-costs">${(data.costs || [])
            .map((c) => `<div><span>${esc(c.title || c.notes || 'Cost')}${c.date ? ` <span class="count" style="margin:0">${esc(lgDay(c.date))}</span>` : ''}</span><b>${lgAmount(c.amount, c.currency) || '—'}</b></div>`)
            .join('')}<div class="lgw-total"><span>Total</span><b>${Object.entries(totals).map(([cur, n]) => lgAmount(n, cur === '—' ? '' : cur)).join(' + ')}</b></div></div>`
        : ''
    }
    ${pics.length ? `<h3>Pictures</h3>${lgPics(pics.map((x) => x.p))}` : ''}
    <p class="lgw-foot"><button type="button" class="linkish" id="lgw-app">See it in the logistics app</button></p>`;
  lgWinBind(d);
}
/* Signed out: the app goes too — its page holds the key to its records. */
function lgAppDrop() {
  lgAppHide();
  lgApp.frame?.remove();
  lgApp.frame = null;
}
function showLogistics(group, q) {
  if (!lgAppOn()) {
    $('#app').innerHTML = `<h1>Logistics</h1><p class="count" style="max-width:560px">The logistics app is not set up here (LOGISTICS_APP_URL).</p>`;
    return;
  }
  if (!can('editor')) {
    $('#app').innerHTML = `<h1>Logistics</h1><p class="count" style="max-width:560px">The logistics app saves straight into its own records, so it is for editors. Ask an admin for the editor role.</p>`;
    return;
  }
  const tab = lgAppTab(group);
  const what = q ? decodeURIComponent(q) : '';
  const host = lgAppHost();
  $('#app').classList.add('hide');
  $('#app').innerHTML = '';
  host.classList.remove('hide');
  lgAppFit();
  if (!lgApp.frame) {
    lgApp.frame = document.createElement('iframe');
    lgApp.frame.title = 'Purosangue Watches Logistics';
    lgApp.frame.src = `/lg-app/#tab=${encodeURIComponent(tab)}${what ? `&q=${encodeURIComponent(what)}` : ''}`;
    host.appendChild(lgApp.frame);
  } else {
    lgApp.frame.contentWindow?.postMessage({ erp: 'tab', tab, q: what }, location.origin);
  }
}
/* A link of ours into the app: a watch by its stock number, a client by name. */
const lgAppLink = (group, what) => `#/logistics/${encodeURIComponent(group)}${what ? `/${encodeURIComponent(what)}` : ''}`;
