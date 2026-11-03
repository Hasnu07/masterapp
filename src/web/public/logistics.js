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
    lgWin.live = true;
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
 * its story in the order it happened — every receipt, move, shipment, courier and sale,
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
  lgWin.live = false;
  // At once, from our copy of the app's records (a minute behind) — unless the app has answered first (3 Nov 2026: "still too slow").
  api(`/api/lg-app/passport?no=${encodeURIComponent(stockNo)}`)
    .then((p) => {
      if (lgWin.no === stockNo && !lgWin.live && p && !p.empty) lgWinRender(p);
    })
    .catch(() => {});
  // The frame answers from the app's data; made now, hidden, if it is not there yet — and asked again until it has loaded.
  lgAppWarm();
  const ask = () => lgApp.frame?.contentWindow?.postMessage({ erp: 'passport-data', stock: stockNo }, location.origin);
  ask();
  clearInterval(lgWin.timer);
  lgWin.timer = setInterval(ask, 500);
}
/*
 * The frame, hidden, loading the app before anyone asks for it (asked 3 Nov
 * 2026: the window "loads very late"): the app is 2 MB and reads its whole
 * document from its worker before it can answer, so app.js starts it a
 * moment after sign-in, for editors, and the first window finds it ready.
 */
function lgAppWarm() {
  if (!lgAppOn() || !can('editor') || lgApp.frame) return;
  lgApp.frame = document.createElement('iframe');
  lgApp.frame.title = 'Purosangue Watches Logistics';
  lgApp.frame.src = '/lg-app/#tab=dashboard';
  lgAppHost().appendChild(lgApp.frame);
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
// A picture on the worker is shown as the ERP's own thumbnail of it (/api/lg-app/photo); one the pass has copied
// ("lgfile:<id>", from our copy of the records) from the copy; one inline in the record as it is.
const lgFile = (p) => p.match(/^lgfile:(\d+)$/)?.[1];
const lgThumb = (p) => (/^(data:|blob:)/.test(p) ? p : lgFile(p) ? `/api/lg-app/file/${lgFile(p)}?thumb=1` : `/api/lg-app/photo?u=${encodeURIComponent(p)}&thumb=1`);
const lgFull = (p) => (lgFile(p) ? `/api/lg-app/file/${lgFile(p)}` : p);
const lgPics = (list, label = '') =>
  (list || []).length
    ? `<div class="lgw-pics">${list.map((p) => `<a href="${esc(lgFull(p))}" target="_blank" rel="noopener" class="lgw-pic"><img src="${esc(lgThumb(p))}" alt="">${label ? `<span>${esc(label)}</span>` : ''}</a>`).join('')}</div>`
    : '';
/*
 * A record's pictures: the addresses in its photo lists, and a picture among
 * its documents. A document is {data, name, type} in the app — a shipment's
 * customs papers and invoices, mostly PDFs — and is listed by name (lgDocsOf),
 * not shown as a picture that cannot load (3 Nov 2026: "picture missing").
 */
const lgPicsOf = (r) =>
  Object.keys(r || {})
    .filter((k) => /photo|image|pic|doc/i.test(k) && Array.isArray(r[k]))
    .flatMap((k) => r[k])
    .map((x) => (typeof x === 'string' ? x : x && typeof x.data === 'string' && /^image\//.test(x.type || '') ? x.data : null))
    .filter(Boolean);
const lgDocsOf = (r) =>
  Object.keys(r || {})
    .filter((k) => /doc|file|paper/i.test(k) && Array.isArray(r[k]))
    .flatMap((k) => r[k])
    .filter((x) => x && typeof x === 'object' && typeof x.data === 'string' && !/^image\//.test(x.type || ''))
    .map((x) => ({ url: x.data, name: x.name || 'document', type: x.type || '' }));
const lgIsPdf = (d) => /pdf/i.test(d.type) || /\.pdf$/i.test(d.name);
const lgDocs = (list) =>
  (list || []).length
    ? `<div class="lgw-docs">${list
        .map(
          (d) =>
            `<a href="${esc(lgFull(d.url))}" target="_blank" rel="noopener" title="${esc(d.type)}" ${lgIsPdf(d) ? `data-pdf="${esc(d.url)}" data-name="${esc(d.name)}"` : ''}>${esc(d.name)}</a>`
        )
        .join('')}</div>`
    : '';

/*
 * A PDF among a shipment's papers opens in a viewer over the window, with
 * Download under it (asked 3 Nov 2026). One on the worker is shown through
 * /api/lg-app/photo (same origin, so the browser's own viewer may frame it);
 * one held inline in the app's record (data:) is handed over as a blob.
 */
let lgDocUrl = null;
function lgDocOpen(url, name) {
  let d = document.getElementById('lg-doc');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'lg-doc';
    d.className = 'lgdoc';
    d.addEventListener('close', () => {
      d.querySelector('iframe')?.remove();
      if (lgDocUrl) URL.revokeObjectURL(lgDocUrl);
      lgDocUrl = null;
    });
    document.body.appendChild(d);
  }
  // &view=1 says nothing to the server; it keeps the viewer off a copy the browser cached before frames were allowed.
  const at = lgFile(url) ? `/api/lg-app/file/${lgFile(url)}?` : `/api/lg-app/photo?u=${encodeURIComponent(url)}&`;
  let src = `${at}view=1`;
  let download = `${at}download=${encodeURIComponent(name)}`;
  const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (m) {
    const bytes = m[2] ? Uint8Array.from(atob(m[3]), (c) => c.charCodeAt(0)) : new TextEncoder().encode(decodeURIComponent(m[3]));
    lgDocUrl = URL.createObjectURL(new Blob([bytes], { type: m[1] || 'application/pdf' }));
    src = download = lgDocUrl;
  }
  d.innerHTML = `
    <div class="lgdoc-head">
      <b>${esc(name)}</b>
      <span class="row">
        <a class="btn small" href="${esc(download)}" download="${esc(name)}">Download</a>
        <a class="btn small" href="${esc(src)}" target="_blank" rel="noopener">Open in a tab</a>
        <button type="button" class="btn small" id="lgdoc-close">Close</button>
      </span>
    </div>
    <iframe src="${esc(src)}" title="${esc(name)}"></iframe>`;
  d.querySelector('#lgdoc-close').addEventListener('click', () => d.close());
  d.addEventListener('click', (e) => {
    if (e.target === d) d.close();
  });
  if (!d.open) d.showModal();
}

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

  /*
   * The story, in the order it happened. Most of the app's moments are days,
   * not times, so a day's moments are put in the order a watch moves through
   * them (STAGE): incoming → shipped → delivered to us → arrived → received →
   * in stock → out for polish / on consignment / checked out → sold →
   * delivered to the buyer. And one arrival is one line: the app writes an
   * arrival, a receipt and the stock row for it (3 Nov 2026: "this doesn't
   * make sense" — In Dubai stock, Arrived, Received, Delivered, all 2 Nov).
   */
  const STAGE = { incoming: 10, shipped: 20, delivered: 30, arrived: 40, received: 50, stock: 60, moved: 65, polish: 70, back: 75, consignment: 80, checkout: 85, accessories: 90, ready: 95, sold: 100, handed: 110 };
  const ev = [];
  const add = (t, stage, title, detail = '', pics = [], tone = '', docs = [], place = '') => ev.push({ t: lgWhen(t), stage: STAGE[stage], title, detail, pics, tone, docs, place });
  for (const i of data.incomings || []) {
    add(i.createdAt || i.date || i.eta, 'incoming', `Incoming from ${i.supplier || 'a supplier'}`, [i.location, i.eta ? `expected ${lgDay(i.eta)}` : '', i.status ? String(i.status).replace(/_/g, ' ') : ''].filter(Boolean).join(' · '), lgPicsOf(i), 'moving');
    const arrived = i.arrivedAt || i.arrivalRecord?.date || i.arrivalRecord?.ts;
    if (arrived) add(arrived, 'arrived', 'Arrived', i.arrivalRecord?.notes || '', lgPicsOf(i.arrivalRecord || {}), 'here');
    const dest = PLACE[i.inventoryDest] ? `${PLACE[i.inventoryDest]} stock` : i.inventoryDest || 'stock';
    if (i.receivedAt || i.inventoryDest) add(i.receivedAt || arrived, 'received', `Received into ${dest}`, '', [], 'here', [], dest);
  }
  // Polish, as the app keeps it on the stock row: the one at the polisher now, and the ones done.
  const polishes = rows.flatMap((r) => [...(r.polish ? [{ ...r.polish, _active: true }] : []), ...(r.polishHistory || [])]);
  for (const p of polishes) {
    add(p.sentDate || p.sentAt, 'polish', `Sent to ${p.sentTo || 'the polisher'} for polish`, [p.itemDescription || '', p.takenBy ? `taken by ${p.takenBy}` : '', p.costAmount > 0 ? lgAmount(p.costAmount, p.costCurrency) : '', p.notes || ''].filter(Boolean).join(' · '), p.sentPhotos || [], 'warn');
    if (!p._active && (p.returnedDate || p.returnedAt)) add(p.returnedDate || p.returnedAt, 'back', 'Back from polish', p.returnNotes || '', p.donePhotos || [], 'here');
  }
  for (const r of rows) {
    add(r.receivedAt || r.createdAt || r.dateAdded, 'stock', `In ${r._place} stock`, [r.from ? `from ${r.from}` : '', r.status && r.status !== 'current' ? r.status : ''].filter(Boolean).join(' · '), lgPicsOf(r), 'here', [], `${r._place} stock`);
    for (const m of r.movements || []) {
      const to = m.to || m.destination || m.toLocation || '';
      add(m.date || m.ts || m.at || m.movedAt, 'moved', `${m.type ? String(m.type).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'Moved'}${to ? ` to ${to}` : ''}`, [m.carrier ? `by ${m.carrier}` : '', m.notes || m.note || '', m.cost ? lgAmount(m.cost, m.costCurrency || m.currency) : ''].filter(Boolean).join(' · '), lgPicsOf(m), 'moving');
    }
    if (r.consignment?.date) add(r.consignment.date, 'consignment', `On consignment${r.consignment.with ? ` with ${r.consignment.with}` : ''}`, r.consignment.returnDate ? `back by ${lgDay(r.consignment.returnDate)}` : '', [], 'warn');
  }
  for (const r of data.checkout || []) add(r.date || r.createdAt, 'checkout', `Checked out${r.to || r.reason ? ` — ${r.to || r.reason}` : ''}`, r.returnedAt ? `returned ${lgDay(r.returnedAt)}` : r.status || '', lgPicsOf(r), 'warn');
  for (const s of data.shipments || []) {
    add(s.date || s.createdAt, 'shipped', `Shipped ${who(s.fromClientId, s.fromText || s.from) || 'us'} → ${who(s.toClientId, s.toText || s.to) || '…'}`, [s.tracking ? `tracking ${s.tracking}` : '', s.status ? String(s.status).replace(/_/g, ' ') : '', s.costAmount ? lgAmount(s.costAmount, s.costCurrency) : s.cost || ''].filter(Boolean).join(' · '), lgPicsOf(s), 'moving', lgDocsOf(s));
    if (s.deliveredAt) add(s.deliveredAt, 'delivered', 'Delivered', s.deliveryNotes || '', s.deliveryPhotos || [], 'here');
  }
  for (const s of data.movers || []) {
    add(s.shipmentDate || s.createdAt, 'shipped', `With ${mover(s.moverId, s.moverName) || 'a courier'}, ${s.fromCountry || '…'} → ${s.toCountry || '…'}`, [s.items, s.amount ? lgAmount(s.amount, s.currency) : '', s.paymentStatus ? `payment ${s.paymentStatus}` : '', s.trackingNumber ? `tracking ${s.trackingNumber}` : ''].filter(Boolean).join(' · '), lgPicsOf(s), 'moving', lgDocsOf(s));
    if (s.status === 'delivered' && s.deliveryDate) add(s.deliveryDate, 'delivered', `Delivered by ${mover(s.moverId, s.moverName) || 'the courier'}`, '', [], 'here');
  }
  for (const r of data.ready || []) add(r.soldDate || r.createdAt, 'ready', `Sold to ${r.soldToBuyer || 'a buyer'}, awaiting delivery`, r.soldPrice ? lgAmount(r.soldPrice, r.soldCurrency) : '', lgPicsOf(r), 'sold');
  for (const s of data.sold || []) {
    add(s.soldDate, 'sold', `Sold to ${s.soldToBuyer || 'a buyer'}`, [s.soldPrice ? lgAmount(s.soldPrice, s.soldCurrency) : '', s.soldFromLocation ? `from ${s.soldFromLocation}` : '', s.soldNotes || ''].filter(Boolean).join(' · '), lgPicsOf(s), 'sold');
    if (s.deliveredAt) add(s.deliveredAt, 'handed', `Delivered${s.deliveredVia ? ` ${lgSay(s.deliveredVia)}` : ''}`, '', [], 'sold');
  }
  for (const t of data.transactions || []) {
    const items = t.items || [];
    add(t.date || t.createdAt, 'accessories', `${t.type === 'sold' ? 'Sold to' : 'Bought from'} ${who(t.clientId) || 'a client'}`, items.length ? `${items.filter((x) => x.status === 'pending').length} of ${items.length} accessory item${items.length === 1 ? '' : 's'} still pending` : '', [], '');
  }
  for (const t of data.trips || []) add(t.startDate, 'moved', `Carried by ${t.personName || 'someone'}, ${t.fromLocation || '…'} → ${t.toLocation || '…'}`, [t.purpose, t.status].filter(Boolean).join(' · '), [], 'moving');
  // By day, then by stage within the day (asked 3 Nov 2026: "this should be in chronological order"); a moment with no date last.
  const day = (e) => (e.t === null ? Infinity : Math.floor(e.t / 86400000));
  ev.sort((a, b) => day(a) - day(b) || a.stage - b.stage || (a.t ?? 0) - (b.t ?? 0));
  // One arrival, one line: Arrived + Received into X + In X stock on one day become "Arrived and received into X".
  const ARRIVAL = new Set([STAGE.arrived, STAGE.received, STAGE.stock]);
  for (let i = 1; i < ev.length; i++) {
    const prev = ev[i - 1];
    const e = ev[i];
    if (!ARRIVAL.has(prev.stage) || !ARRIVAL.has(e.stage) || day(prev) !== day(e) || e.t === null) continue;
    prev.arrived = prev.arrived || prev.stage === STAGE.arrived || e.stage === STAGE.arrived;
    prev.place = prev.place || e.place;
    prev.title = `${prev.arrived ? 'Arrived and received' : 'Received'} into ${prev.place || 'stock'}`;
    prev.detail = [...new Set([prev.detail, e.detail].filter(Boolean))].join(' · ');
    prev.pics = [...new Set([...prev.pics, ...e.pics])];
    prev.docs = [...prev.docs, ...e.docs];
    prev.stage = Math.max(prev.stage, e.stage);
    ev.splice(i, 1);
    i -= 1;
  }

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
                 <div><div class="lgw-ev">${esc(e.title)}</div>${e.detail ? `<div class="lgw-d">${esc(e.detail)}</div>` : ''}${lgPics(e.pics)}${lgDocs(e.docs)}</div></li>`
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
    <p class="lgw-foot"><button type="button" class="linkish" id="lgw-app">See it in the logistics app</button>${
      data.copied ? `<span class="count lgw-copied" style="margin:0 0 0 14px">From the ERP’s copy${data.copiedAt ? `, ${esc(fmtWhen(data.copiedAt))}` : ''} · the app itself is still loading…</span>` : ''
    }</p>`;
  // A picture the app no longer has says so, instead of an empty box.
  body.querySelectorAll('.lgw-pic img').forEach((i) => i.addEventListener('error', () => i.closest('.lgw-pic').classList.add('gone')));
  // A PDF opens in the viewer; any other paper in its own tab, as the link says.
  body.querySelectorAll('.lgw-docs a[data-pdf]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      lgDocOpen(a.dataset.pdf, a.dataset.name);
    })
  );
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
