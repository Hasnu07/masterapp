/*
 * The watch's whole story in one window (asked 4 Nov 2026: "a separate
 * timeline button that shows both accountancy and logistics combined
 * timeline, with attached pdf"): what the ERP itself knows — bought, sold,
 * every status change and who made it — laid in order with the logistics
 * app's story (lgStory, logistics.js: incoming, shipped, received, moved,
 * polish, consignment, sold, delivered, with its pictures and customs papers)
 * and the accounts app's (accStory, accounts.js: the legs posted, every
 * payment through its wallet, invoices, expenses, commission, with its
 * invoices and proofs). Each line says which app it comes from; every paper
 * opens in the viewer; "Save as PDF" prints the window alone. Logistics comes
 * at once from our copy and is replaced by the app's own answer when the
 * frame has it (as the Logistics window does); accounts come from our copy.
 */
const tlWin = { no: '', id: 0, w: null, lg: null, acc: null, events: [], timer: null, live: false };
const tlOn = () => (typeof lgAppOn === 'function' && lgAppOn()) || (typeof accAppOn === 'function' && accAppOn());

function tlWinEl() {
  let d = document.getElementById('tl-win');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'tl-win';
    d.className = 'lgw tlw';
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
    });
    d.addEventListener('close', () => {
      tlWin.no = '';
      clearInterval(tlWin.timer);
    });
    document.body.appendChild(d);
  }
  return d;
}
const tlShell = (w, body) => `
  <div class="lgw-head">
    <div>
      <div class="lgw-eyebrow">Timeline</div>
      <h2>${esc(w.display_title || w.title || `Stock ${w.stock_no}`)}</h2>
      <div class="count" style="margin:0">Stock ${esc(w.stock_no)}${w.reference ? ` · ${esc(w.reference)}` : ''}${w.serial ? ` · ${esc(w.serial)}` : ''}</div>
    </div>
    <span class="row tl-noprint">
      <button type="button" class="btn" id="tlw-print" title="Print the timeline, or save it as a PDF">Save as PDF</button>
      <button type="button" class="btn" id="tlw-close">Close</button>
    </span>
  </div>
  <div class="lgw-body" id="tlw-body">${body}</div>`;

/* The watch, read in full (the list's row carries less), then everything the three apps hold on it, side by side. */
async function showTimelineWindow(watch) {
  if (!watch?.id) return;
  const d = tlWinEl();
  tlWin.id = watch.id;
  tlWin.no = watch.stock_no || '';
  tlWin.live = false;
  tlWin.lg = tlWin.acc = null;
  if (tlWin.briefFor !== watch.id) tlWin.briefHtml = '';
  d.innerHTML = tlShell(watch, '<p class="count lgw-wait">Reading the ERP, the logistics app and the accounts…</p>');
  if (!d.open) d.showModal();
  tlBind(d);
  const no = tlWin.no;
  const quiet = (p) => p.catch(() => null);
  const [w, ev, docs, lg, acc] = await Promise.all([
    quiet(api(`/api/watches/${watch.id}`)),
    quiet(api(`/api/watches/${watch.id}/events`)),
    quiet(api(`/api/watches/${watch.id}/documents`)),
    no && typeof lgAppOn === 'function' && lgAppOn() ? quiet(api(`/api/lg-app/passport?no=${encodeURIComponent(no)}`)) : null,
    no && typeof accAppOn === 'function' && accAppOn() ? quiet(api(`/api/acc-app/stock/${encodeURIComponent(no)}`)) : null,
  ]);
  if (tlWin.id !== watch.id) return;
  tlWin.w = w || watch;
  tlWin.events = ev?.events || [];
  tlWin.docs = docs?.documents || [];
  tlWin.lg = lg && !lg.empty ? lg : null;
  tlWin.acc = acc;
  tlRender(d);
  // The logistics app's own answer, when the frame has loaded, replaces our copy's (editors: the frame is theirs).
  if (no && typeof lgAppOn === 'function' && lgAppOn() && can('editor') && typeof lgAppWarm === 'function') {
    lgAppWarm();
    const ask = () => lgApp.frame?.contentWindow?.postMessage({ erp: 'passport-data', stock: no }, location.origin);
    ask();
    clearInterval(tlWin.timer);
    tlWin.timer = setInterval(ask, 1000);
  }
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || e.data.erp !== 'passport-data' || !tlWin.no || e.data.stock !== tlWin.no) return;
  clearInterval(tlWin.timer);
  if (!e.data.data) return;
  tlWin.live = true;
  tlWin.lg = e.data.data;
  tlRender(tlWinEl());
});
function tlBind(d) {
  d.querySelector('#tlw-close')?.addEventListener('click', () => d.close());
  d.querySelector('#tlw-print')?.addEventListener('click', () => window.print());
}

/* What the ERP itself knows: the deal's two dates, and the history — every status change, by whom. */
function tlErpEvents(w, events, docs = []) {
  const ev = [];
  const src = w.origin === 'chronokey' ? 'chronokey' : 'erp';
  const add = (t, title, detail = '', tone = '', stage = 50, from = src) => ev.push({ t, title, detail, tone, pics: [], docs: [], src: from, stage });
  const who = (role, typed) => w.clients?.[role]?.name || typed || '';
  const price = (n, cur) => (n ? money(n, cur, { plain: true }) : '');
  if (w.purchase_date) add(Date.parse(`${String(w.purchase_date).slice(0, 10)}T00:00:00Z`), `Bought${who('purchase', w.purchased_from) ? ` from ${who('purchase', w.purchased_from)}` : ''}`, price(w.purchase_price, w.purchase_currency), 'moving', 5);
  if (w.sale_date) add(Date.parse(`${String(w.sale_date).slice(0, 10)}T00:00:00Z`), `Sold${who('sale', w.sold_to) ? ` to ${who('sale', w.sold_to)}` : ''}`, price(w.sale_price, w.sale_currency), 'sold', 100);
  const by = (e) => e.user_name || { chronokey: 'Chrono Key', vault: 'the Watch vault', masterapp: 'masterapp', user: 'someone' }[e.source] || e.source;
  for (const e of events || []) {
    const t = Date.parse(e.at);
    if (e.action === 'create') add(t, 'Added to the ERP', `by ${by(e)}`, '', 1, e.source === 'chronokey' || e.source === 'vault' ? 'chronokey' : 'erp');
    else if (e.action === 'restore') add(t, 'Restored in the ERP', `by ${by(e)}`, '', 95, 'erp');
    else if (e.action === 'delete') add(t, 'Deleted in the ERP', `by ${by(e)}`, 'quiet', 95, 'erp');
    const st = e.changes?.status;
    if (Array.isArray(st) && st[1]) add(t, `Status ${statusLabel(st[0] || 'other')} → ${statusLabel(st[1])}`, `by ${by(e)}`, st[1] === 'sold' ? 'sold' : st[1] === 'in_stock' ? 'here' : 'moving', 50, e.source === 'chronokey' || e.source === 'vault' ? 'chronokey' : 'erp');
  }
  // The watch's own papers, as they were added.
  const KIND = { invoice: 'Invoice', papers: 'Papers', customs: 'Customs form', receipt: 'Receipt', other: 'Document' };
  for (const d of docs) {
    ev.push({
      t: Date.parse(d.created_at), title: `${KIND[d.kind] || 'Document'} added — ${d.name || ''}`.trim(), detail: d.user_name ? `by ${d.user_name}` : '', tone: '', src: 'erp', stage: 50,
      pics: d.has_thumb ? [{ thumb: `/api/watch-documents/${d.id}?thumb=1`, full: `/api/watch-documents/${d.id}`, label: KIND[d.kind] || '' }] : [],
      docs: d.has_thumb ? [] : [{ url: `/api/watch-documents/${d.id}`, name: d.name || 'document.pdf', type: d.content_type }],
    });
  }
  return ev;
}

const TL_SRC = { erp: 'ERP', chronokey: 'Chrono Key', logistics: 'Logistics', accounts: 'Accounts' };
const tlPic = (p) => (typeof p === 'string' ? { thumb: lgThumb(p), full: lgFull(p), label: '' } : p);
const tlDoc = (d) => ({ url: d.url, name: d.name, type: d.type, open: typeof lgFile === 'function' && lgFile(d.url) ? d.url : d.url });
function tlRender(d) {
  const body = d.querySelector('#tlw-body');
  if (!body) return;
  const w = tlWin.w;
  const lg = tlWin.lg && typeof lgStory === 'function' ? lgStory(tlWin.lg) : null;
  const acc = tlWin.acc && typeof accStory === 'function' ? accStory(tlWin.acc) : null;
  const erp = tlErpEvents(w, tlWin.events, tlWin.docs || []);
  // One list, in the order it happened: by day; within a day in the order a deal moves (each app's own stage), the ERP's fact first.
  const all = [
    ...erp.map((e, i) => ({ ...e, seq: i })),
    ...(lg ? lg.ev.map((e, i) => ({ ...e, src: 'logistics', pics: (e.pics || []).map(tlPic), docs: (e.docs || []).map(tlDoc), seq: 1000 + i })) : []),
    ...(acc ? acc.ev.map((e, i) => ({ ...e, pics: (e.pics || []).map(tlPic), docs: (e.docs || []).map(tlDoc), seq: 2000 + i })) : []),
  ];
  const day = (e) => (e.t === null || e.t === undefined || Number.isNaN(e.t) ? Infinity : Math.floor(e.t / 86400000));
  all.sort((a, b) => day(a) - day(b) || (a.stage ?? 50) - (b.stage ?? 50) || a.seq - b.seq);
  const docs = all.flatMap((e) => e.docs);
  const pics = [];
  const seen = new Set();
  for (const e of all) for (const p of e.pics) if (!seen.has(p.full)) { seen.add(p.full); pics.push(p); }

  const line = (label, html, tone) => `<div class="tl-now ${esc(tone || '')}"><span class="tl-src">${label}</span> ${html}</div>`;
  body.innerHTML = `
    <div id="tl-brief"></div>
    <div class="tl-nows">
      ${line('ERP', `${chip(w.deleted_at ? 'deleted' : w.status)}${w.location ? ` <span>${esc(w.location)}</span>` : ''}${w.purchase_date ? ` · bought ${esc(fmtDate(w.purchase_date))}` : ''}${w.sale_date ? ` · sold ${esc(fmtDate(w.sale_date))}` : ''}`)}
      ${lg ? line('Logistics', esc(lg.now.text), lg.now.tone) : typeof lgAppOn === 'function' && lgAppOn() ? line('Logistics', '<span class="count" style="margin:0">Nothing in the logistics app.</span>') : ''}
      ${acc ? line('Accounts', acc.now.html, acc.now.tone) : typeof accAppOn === 'function' && accAppOn() ? line('Accounts', '<span class="count" style="margin:0">Nothing in the accounts app.</span>') : ''}
    </div>
    ${acc?.facts.length ? `<div class="lgw-facts">${acc.facts.map(([k, v]) => `<div><span class="k">${esc(k)}</span> ${v}</div>`).join('')}</div>` : ''}
    <h3>What happened</h3>
    ${
      all.length
        ? `<ol class="lgw-tl tl">${all
            .map(
              (e) => `<li class="${esc(e.tone || '')}"><time>${e.t && !Number.isNaN(e.t) ? esc(lgDay(e.t)) : '<span class="blank">no date</span>'}</time>
                <div><div class="lgw-ev"><span class="tl-src tl-${esc(e.src)}">${esc(TL_SRC[e.src] || e.src)}</span>${esc(e.title)}</div>${e.detail ? `<div class="lgw-d">${esc(e.detail)}</div>` : ''}${accPics(e.pics)}${accDocs(e.docs)}</div></li>`
            )
            .join('')}</ol>`
        : '<p class="count">Nothing recorded yet.</p>'
    }
    ${docs.length ? `<h3>Papers</h3>${accDocs(docs)}` : ''}
    ${pics.length ? `<h3>Pictures</h3>${accPics(pics)}` : ''}
    <p class="lgw-foot count tl-noprint" style="margin-top:18px">${[
      lg ? (tlWin.live ? 'Logistics from the app itself' : `Logistics from the ERP’s copy${tlWin.lg?.copiedAt ? `, ${esc(fmtWhen(tlWin.lg.copiedAt))}` : ''}`) : '',
      tlWin.acc ? (tlWin.acc.source === 'copy' ? `Accounts from the ERP’s copy${tlWin.acc.read_at ? `, read ${esc(fmtWhen(tlWin.acc.read_at))}` : ''}` : typeof accSourceNote === 'function' ? accSourceNote(tlWin.acc) : '') : '',
    ]
      .filter(Boolean)
      .join(' · ')}</p>
    <div id="tl-ask" class="tl-noprint"></div>
    <p class="tl-printed">Purosangue ERP · printed ${esc(fmtWhen(new Date().toISOString()))}</p>`;
  accBindFiles(body);
  // Claude's brief at the top and a question box at the foot (ask.js) — kept across a redraw when the logistics answer arrives.
  if (typeof aiOn === 'function' && aiOn()) {
    if (tlWin.briefHtml && tlWin.briefFor === tlWin.id) body.querySelector('#tl-brief').innerHTML = tlWin.briefHtml;
    else {
      tlWin.briefFor = tlWin.id;
      aiBrief(tlWin.id, body.querySelector('#tl-brief')).then(() => {
        tlWin.briefHtml = body.querySelector('#tl-brief')?.innerHTML || '';
      });
    }
    if (tlWin.askEl && tlWin.askFor === tlWin.id) body.querySelector('#tl-ask').replaceWith(tlWin.askEl);
    else {
      tlWin.askFor = tlWin.id;
      tlWin.askEl = body.querySelector('#tl-ask');
      aiAskPanel(tlWin.askEl, { watchId: tlWin.id, placeholder: `Ask about this watch — “Is it paid?”, “Where is it now?”, “What did we make on it?”` });
    }
  }
}
