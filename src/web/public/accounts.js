/*
 * Accounts IS the accounts app (asked 4 Nov 2026: "add accountancy app to the
 * ERP same way as how we did logistic"): the app's own page, served by the ERP
 * at /acc-app/ behind the sign-in, in one frame under the bar — made once and
 * kept while other pages show. #/accounts/<page>/<what> opens one of the app's
 * pages and finds <what> there (the bridge inside the frame does it —
 * accapp-bridge.js): a stock number on the Stock report, a client by name on
 * Clients. The watch page's Accounts window reads OUR COPY of the app's
 * records (the sync keeps it a minute behind), so it needs no sign-in to the
 * app and works for every role.
 */
const accApp = { frame: null };
const accAppOn = () => Boolean(state.meta?.accounts?.app_embedded);
const accAppHost = () => document.getElementById('acc-app-host');
const accAppPath = (page) => state.meta?.accounts?.pages?.find((p) => p.key === page)?.path || '/';

function accAppFit() {
  const host = accAppHost();
  if (!host || host.classList.contains('hide')) return;
  const bar = document.getElementById('bar');
  host.style.height = `${Math.max(240, window.innerHeight - (bar ? bar.getBoundingClientRect().bottom : 0))}px`;
}
window.addEventListener('resize', accAppFit);
function accAppHide() {
  accAppHost()?.classList.add('hide');
  $('#app').classList.remove('hide');
}
/* Signed out: the frame goes too — the person's accounts session is in it. */
function accAppDrop() {
  accAppHide();
  accApp.frame?.remove();
  accApp.frame = null;
}
function accFrame(hash) {
  if (!accApp.frame) {
    accApp.frame = document.createElement('iframe');
    accApp.frame.title = 'Purosangue Watches Accounts';
    accApp.frame.src = `/acc-app/${hash || ''}`;
    accAppHost().appendChild(accApp.frame);
    return false;
  }
  return true;
}
function showAccounts(page, q) {
  if (!accAppOn()) {
    $('#app').innerHTML = `<h1>Accounts</h1><p class="count" style="max-width:560px">The accounts app is not set up here (ACCOUNTS_APP_URL).</p>`;
    return;
  }
  if (!can('editor')) {
    $('#app').innerHTML = `<h1>Accounts</h1><p class="count" style="max-width:560px">The accounts app saves straight into its own records, so it is for editors. Ask an admin for the editor role.</p>`;
    return;
  }
  const what = q ? decodeURIComponent(q) : '';
  const host = accAppHost();
  $('#app').classList.add('hide');
  $('#app').innerHTML = '';
  host.classList.remove('hide');
  accAppFit();
  // What to open: a stock number (the Stock report), a client by name, or one of the app's pages.
  const req = page === 'stock' && what ? { stock: what } : page === 'clients' && what ? { client: what } : { path: accAppPath(page), q: what };
  const hash = req.stock ? `#stock=${encodeURIComponent(req.stock)}` : req.client ? `#client=${encodeURIComponent(req.client)}` : `#path=${encodeURIComponent(req.path)}${req.q ? `&q=${encodeURIComponent(req.q)}` : ''}`;
  if (accFrame(hash)) accApp.frame.contentWindow?.postMessage({ erp: 'open', ...req }, location.origin);
}
/* A link of ours into the app: a watch by its stock number, a client by name, or a page. */
const accAppLink = (page, what) => `#/accounts/${encodeURIComponent(page)}${what ? `/${encodeURIComponent(what)}` : ''}`;

/* ── reading the app's records ── */
const accDay = (v) => {
  if (!v) return '';
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const accWhen = (v) => {
  if (!v) return null;
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : Date.parse(s);
  return Number.isNaN(t) ? null : t;
};
const accNum = (v) => Number(String(v ?? '').replace(/[^\d.-]/g, '')) || 0;
const accAmount = (n, cur) => {
  const x = accNum(n);
  return `${cur ? `${esc(String(cur).toUpperCase())} ` : ''}${x.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const ACC_STATUS = { open: ['Open', 'warn'], partial: ['Partly paid', 'warn'], settled: ['Settled', 'here'], cancelled: ['Cancelled', 'quiet'] };

/*
 * A file as an accounts record holds it: "acfile:<id>" where the pass copied
 * an inline picture (served from our copy), "/uploads/…" for one the app keeps
 * (served through the ERP), an address or data: as it is.
 */
const accFileId = (p) => String(p || '').match(/^acfile:(\d+)$/)?.[1];
const accUrl = (p) => {
  if (!p || typeof p !== 'string') return '';
  if (accFileId(p)) return `/api/acc-app/file/${accFileId(p)}`;
  if (p.startsWith('/uploads/')) return `/acc-app${p}`;
  return p;
};
const accThumb = (p) => (accFileId(p) ? `/api/acc-app/file/${accFileId(p)}?thumb=1` : accUrl(p));
const ACC_FILE_KEYS = ['attachments', 'proofs', 'invoiceProof', 'proof', 'documents', 'files', 'receipt', 'receipts'];
/* The pictures and papers on a record (an entry's invoice, a payment's proofs): each {thumb, full} or {url, name, type}. */
function accFilesOf(r) {
  const pics = [];
  const docs = [];
  const one = (x, label) => {
    const raw = typeof x === 'string' ? x : x && typeof x === 'object' ? x.url || x.dataUrl || x.data : null;
    if (typeof raw !== 'string' || !raw) return;
    const name = (x && typeof x === 'object' && x.name) || label;
    const type = (x && typeof x === 'object' && x.type) || '';
    const isPdf = /pdf/i.test(type) || /\.pdf$/i.test(name) || /^data:application\/pdf/.test(raw);
    const isPic = /^image\//.test(type) || /\.(png|jpe?g|webp|gif)$/i.test(name) || /^data:image\//.test(raw) || (!type && !isPdf && (accFileId(raw) || /^data:/.test(raw)));
    if (isPic && !isPdf) pics.push({ thumb: accThumb(raw), full: accUrl(raw), label });
    else docs.push({ url: accUrl(raw), name, type: type || (isPdf ? 'application/pdf' : '') });
  };
  for (const k of ACC_FILE_KEYS) {
    const v = r?.[k];
    if (!v) continue;
    const label = k === 'invoiceProof' ? 'Invoice' : k === 'proofs' || k === 'proof' ? 'Proof' : 'Attachment';
    (Array.isArray(v) ? v : [v]).forEach((x) => one(x, label));
  }
  return { pics, docs };
}
const accPics = (list) =>
  (list || []).length
    ? `<div class="lgw-pics">${list.map((p) => `<a href="${esc(p.full)}" target="_blank" rel="noopener" class="lgw-pic"><img loading="lazy" src="${esc(p.thumb)}" alt="">${p.label ? `<span>${esc(p.label)}</span>` : ''}</a>`).join('')}</div>`
    : '';
const accDocs = (list) =>
  (list || []).length
    ? `<div class="lgw-docs">${list.map((d) => `<a href="${esc(d.url)}" target="_blank" rel="noopener" title="${esc(d.type)}" ${/pdf/i.test(d.type) || /\.pdf$/i.test(d.name) ? `data-pdf="${esc(d.url)}" data-name="${esc(d.name)}"` : ''}>${esc(d.name)}</a>`).join('')}</div>`
    : '';
/* The window's pictures and papers behave as the Logistics window's: a missing picture says so, a PDF opens in the viewer. */
function accBindFiles(root) {
  root.querySelectorAll('.lgw-pic img').forEach((i) => i.addEventListener('error', () => i.closest('.lgw-pic').classList.add('gone')));
  root.querySelectorAll('.lgw-docs a[data-pdf]').forEach((a) =>
    a.addEventListener('click', (e) => {
      if (typeof lgDocOpen !== 'function') return;
      e.preventDefault();
      lgDocOpen(a.dataset.pdf, a.dataset.name);
    })
  );
}

/*
 * The money's story out of our copy of the app's records: where it stands in
 * one line; each ledger leg with its track — posted, then every payment with
 * the wallet it went through and what was left after it; what happened, in
 * order; the pictures and papers. For the Accounts window, and for the watch's
 * Timeline (timeline.js), which lays it beside the logistics and the ERP's own
 * history.
 */
function accStory(data) {
  const no = data.stock;
  const wallets = data.wallets || {};
  const walletOf = (p) => {
    const id = p?._walletAccId || p?.walletAccId || p?.accountId;
    const w = id ? wallets[String(id)] : null;
    if (w) return `${w.name || 'wallet'}${w.company && w.company.toLowerCase() !== (w.name || '').toLowerCase() ? ` · ${w.company}` : ''}`;
    return p?._walletCcy ? `a ${p._walletCcy} wallet` : '';
  };
  const whoName = (e) => {
    const c = e.clientId != null ? data.clients?.[String(e.clientId)] : null;
    return c?.name || e.counterEntity || e.client || '';
  };
  const whoHtml = (e) => {
    const c = e.clientId != null ? data.clients?.[String(e.clientId)] : null;
    const name = whoName(e);
    if (c?.client_id) return `<a href="#/client/${c.client_id}">${esc(name)}</a>`;
    return esc(name || 'a client');
  };

  // Each leg: its payments in order, and what was left after each.
  const legs = (data.entries || []).map((l) => {
    const e = l.data;
    const pays = [...(e.payments || [])].sort((a, b) => (accWhen(a.date) || 0) - (accWhen(b.date) || 0));
    let left = l.target;
    const track = pays.map((p) => {
      const applied = accNum(p.applied != null ? p.applied : p.amount);
      left = Math.round((left - applied) * 100) / 100;
      const paidIn = p.ccy && String(p.ccy).toUpperCase() !== String(e.ccy || '').toUpperCase() ? ` (${accAmount(p.amount, p.ccy)} paid${p.rate ? ` at ${p.rate}` : ''})` : '';
      return { t: accWhen(p.date), date: p.date, applied, paidIn, wallet: walletOf(p), method: p.method || '', note: p.note || '', left: Math.max(0, left), files: accFilesOf(p) };
    });
    const costs = (e.costs || []).filter((c) => accNum(c.amount));
    return { ...l, e, purchase: e.type === 'PAYABLE', who: whoName(e), whoHtml: whoHtml(e), track, costs, files: accFilesOf(e), walletsUsed: [...new Set(track.map((p) => p.wallet).filter(Boolean))] };
  });
  const buys = legs.filter((l) => l.purchase);
  const sales = legs.filter((l) => !l.purchase);

  // Where the money stands, in one sentence.
  const say = (l, verb) => {
    const owed = l.outstanding > 0.005 && l.status !== 'cancelled' ? `, ${accAmount(l.outstanding, l.e.ccy)} still owed` : l.status === 'settled' ? ', settled' : l.status === 'cancelled' ? ' (cancelled)' : '';
    return { text: `${verb} ${l.whoHtml} for ${accAmount(l.e.amount, l.e.ccy)}${l.e.date ? ` on ${esc(accDay(l.e.date))}` : ''}${owed}`, warn: l.outstanding > 0.005 && l.status !== 'cancelled' };
  };
  let now = { html: `Nothing in the accounts app for stock ${esc(no)}`, tone: 'quiet' };
  const parts = [];
  if (buys[0]) parts.push(say(buys[0], 'Bought from'));
  if (sales[0]) parts.push(say(sales[0], 'Sold to'));
  if (parts.length) now = { html: parts.map((p) => p.text).join(' · '), tone: parts.some((p) => p.warn) ? 'warn' : sales[0] ? 'sold' : 'here' };
  else if ((data.quick_sales || []).length) now = { html: `Sold as a quick sale${data.quick_sales[0].data.date ? ` on ${esc(accDay(data.quick_sales[0].data.date))}` : ''}`, tone: 'sold' };

  // Plain facts under it: paid and remaining each way, the wallets, the invoice.
  const side = (list, label) => {
    if (!list.length) return [];
    const ccy = list[0].e.ccy;
    const total = list.reduce((t, l) => t + l.target, 0);
    const paid = list.reduce((t, l) => t + (l.status === 'cancelled' ? 0 : l.paid), 0);
    const left = list.reduce((t, l) => t + (l.status === 'cancelled' ? 0 : l.outstanding), 0);
    return [[label, `${accAmount(total, ccy)} · paid ${accAmount(paid, ccy)}${left > 0.005 ? ` · <b>${accAmount(left, ccy)} remaining</b>` : ' · nothing remaining'}`]];
  };
  const walletsUsed = [...new Set(legs.flatMap((l) => l.walletsUsed))];
  const invoices = [...new Set(legs.map((l) => l.e.invoiceNo).filter(Boolean))];
  const facts = [...side(buys, 'Bought for'), ...side(sales, 'Sold for'), walletsUsed.length && ['Wallets', esc(walletsUsed.join(', '))], invoices.length && ['Invoice', esc(invoices.join(', '))]].filter(Boolean);

  // What happened, in order: the legs posted, every payment, the invoice, quick sales, expenses, commission.
  const ev = [];
  const add = (t, title, detail = '', tone = '', files = { pics: [], docs: [] }, stage = 50) => ev.push({ t, title, detail, tone, pics: files.pics || [], docs: files.docs || [], src: 'accounts', stage });
  for (const l of legs) {
    const e = l.e;
    add(accWhen(e.date), `${l.purchase ? 'Purchase posted' : 'Sale posted'} — ${accAmount(e.amount, e.ccy)} ${l.purchase ? 'to' : 'from'} ${l.who || 'a client'}`, [e.invoiceNo ? `invoice ${e.invoiceNo}` : '', e.ourEntity ? `our company ${e.ourEntity}` : '', e.dueDate ? `due ${accDay(e.dueDate)}` : '', e._createdByName ? `entered by ${e._createdByName}` : '', e._cancelled ? 'cancelled since' : ''].filter(Boolean).join(' · '), l.purchase ? 'moving' : 'sold', l.files, l.purchase ? 10 : 60);
    for (const p of l.track) {
      add(p.t, `${l.purchase ? 'Paid' : 'Received'} ${accAmount(p.applied, e.ccy)}${p.paidIn}${p.wallet ? ` ${l.purchase ? 'from' : 'into'} ${p.wallet}` : ''}`, [p.method, p.note, p.left > 0.005 ? `${accAmount(p.left, e.ccy)} left` : 'settled'].filter(Boolean).join(' · '), p.left > 0.005 ? 'warn' : 'here', p.files, l.purchase ? 20 : 70);
    }
  }
  for (const r of data.invoices || []) add(accWhen(r.data.date), `${r.data.docType || 'Invoice'} ${r.data.invoiceNo || ''} issued`, [r.data.status, r.data.ourEntity, r.data.billTo?.name].filter(Boolean).join(' · '), '', accFilesOf(r.data), 55);
  for (const r of data.quick_sales || []) add(accWhen(r.data.date), `Quick sale — ${accAmount(r.data.saleAmount, r.data.ccy)}${r.data.item ? ` · ${r.data.item}` : ''}`, [r.data.cost ? `cost ${accAmount(r.data.cost, r.data.costCcy || r.data.ccy)}` : '', r.data.invoiceNo ? `invoice ${r.data.invoiceNo}` : '', walletOf(r.data)].filter(Boolean).join(' · '), 'sold', accFilesOf(r.data), 65);
  for (const r of data.expenses || []) add(accWhen(r.data.date), `Expense — ${r.data.title || r.data.description || 'cost'} ${accAmount(r.data.amount, r.data.ccy)}`, [r.data.category, r.data.vendor].filter(Boolean).join(' · '), 'warn', accFilesOf(r.data), 80);
  for (const r of data.settlements || []) {
    const lines = (r.data.lines || []).filter((x) => String(x.stock || '').trim() === String(no));
    add(accWhen(r.data.date), `Commission settled — ${r.data.employee || r.data.empName || 'an employee'}`, lines.map((x) => `${x.role ? `${x.role} · ` : ''}${accAmount(x.commission, 'USD')}`).join('; '), '', { pics: [], docs: [] }, 90);
  }
  const day = (e) => (e.t === null ? Infinity : Math.floor(e.t / 86400000));
  ev.sort((a, b) => day(a) - day(b) || a.stage - b.stage || (a.t ?? 0) - (b.t ?? 0));

  const pics = [];
  const docs = [];
  for (const e of ev) {
    pics.push(...e.pics);
    docs.push(...e.docs);
  }
  return { now, facts, legs, ev, pics, docs, wallets: walletsUsed };
}

/*
 * The watch's accounts as a window over its page, in the console's own look
 * (the Logistics window's shape): one line on where the money stands, the
 * ledger — every purchase and sale leg, its payments through which wallet and
 * what was left after each — then what happened in order, the quick sales,
 * invoices, expenses and commission lines that name the stock number, and
 * every picture and paper. Read from our copy of the app's records. Nothing is
 * written back.
 */
const accWin = { no: '' };
function accWinEl() {
  let d = document.getElementById('acc-win');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'acc-win';
    d.className = 'lgw';
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
    });
    d.addEventListener('close', () => {
      accWin.no = '';
    });
    document.body.appendChild(d);
  }
  return d;
}
const accWinShell = (no, title, body) => `
  <div class="lgw-head">
    <div>
      <div class="lgw-eyebrow">Accounts</div>
      <h2>${esc(title || `Stock ${no}`)}</h2>
      ${title ? `<div class="count" style="margin:0">Stock ${esc(no)}</div>` : ''}
    </div>
    <button type="button" class="btn" id="accw-close">Close</button>
  </div>
  <div class="lgw-body" id="accw-body">${body}</div>`;
async function showAccountsWindow(stockNo, title = '') {
  if (!accAppOn() || !stockNo) return;
  accWin.no = stockNo;
  const d = accWinEl();
  d.innerHTML = accWinShell(stockNo, title, '<p class="count lgw-wait">Reading the accounts…</p>');
  if (!d.open) d.showModal();
  d.querySelector('#accw-close')?.addEventListener('click', () => d.close());
  let data;
  try {
    data = await api(`/api/acc-app/stock/${encodeURIComponent(stockNo)}`);
  } catch (err) {
    d.querySelector('#accw-body').innerHTML = `<p class="err">${esc(err.message)}</p>`;
    return;
  }
  if (accWin.no !== stockNo) return;
  accWinRender(d, data);
}

const accEvents = (ev) =>
  ev.length
    ? `<ol class="lgw-tl">${ev
        .map(
          (e) => `<li class="${esc(e.tone)}"><time>${e.t ? esc(accDay(new Date(e.t).toISOString())) : '<span class="blank">no date</span>'}</time>
            <div><div class="lgw-ev">${esc(e.title)}</div>${e.detail ? `<div class="lgw-d">${esc(e.detail)}</div>` : ''}${accPics(e.pics)}${accDocs(e.docs)}</div></li>`
        )
        .join('')}</ol>`
    : '';

function accWinRender(d, data) {
  const body = d.querySelector('#accw-body');
  if (!body) return;
  const no = data.stock;
  const s = accStory(data);
  const leg = (l) => {
    const e = l.e;
    const st = ACC_STATUS[l.status] || [l.status, ''];
    return `<div class="lgw-card">
      <div class="lgw-card-top"><b>${l.purchase ? 'Purchase from' : 'Sale to'} ${l.whoHtml}</b><span class="count" style="margin:0">${esc(accDay(e.date))}</span></div>
      <div class="lgw-d">${accAmount(e.amount, e.ccy)}${l.costs.length ? ` + costs ${l.costs.map((c) => `${c.label ? `${esc(c.label)} ` : ''}${accAmount(c.amount, c.ccy || e.ccy)}`).join(', ')}` : ''} · <span class="lgw-ev ${esc(st[1])}" style="font-size:14px">${esc(st[0])}</span></div>
      <div class="lgw-d">${[e.invoiceNo ? `Invoice ${e.invoiceNo}` : '', e.ourEntity ? `our company ${e.ourEntity}` : '', e.model || '', e.employee ? `by ${e.employee}` : '', e.dueDate ? `due ${accDay(e.dueDate)}` : ''].filter(Boolean).map(esc).join(' · ')}</div>
      ${
        l.status !== 'cancelled'
          ? `<div class="acc-track">
              <div><span>${l.purchase ? 'To pay' : 'To receive'}</span><b>${accAmount(l.target, e.ccy)}</b></div>
              ${l.track
                .map(
                  (p) => `<div class="acc-pay"><span>${esc(accDay(p.date))} · ${l.purchase ? 'paid' : 'received'} <b>${accAmount(p.applied, e.ccy)}</b>${esc(p.paidIn)}${p.wallet ? ` ${l.purchase ? 'from' : 'into'} <b>${esc(p.wallet)}</b>` : ''}${p.method ? ` · ${esc(p.method)}` : ''}${p.note ? `<span class="count" style="display:block;margin:0">${esc(p.note)}</span>` : ''}${accPics(p.files.pics)}${accDocs(p.files.docs)}</span><span class="acc-left">${p.left > 0.005 ? `${accAmount(p.left, e.ccy)} left` : 'settled'}</span></div>`
                )
                .join('')}
              <div class="lgw-total"><span>${l.paid > 0 ? `Paid ${accAmount(l.paid, e.ccy)}` : 'Nothing paid yet'}</span><b>${l.outstanding > 0.005 ? `${accAmount(l.outstanding, e.ccy)} remaining` : 'Settled'}</b></div>
            </div>`
          : ''
      }
      ${accPics(l.files.pics)}${accDocs(l.files.docs)}
      ${e.note ? `<div class="lgw-d" style="margin-top:6px">${esc(e.note)}</div>` : ''}
      ${e._createdByName || e._updatedByName ? `<div class="count" style="margin:6px 0 0">${esc(e._createdByName ? `entered by ${e._createdByName}` : '')}${e._updatedByName && e._updatedByName !== e._createdByName ? `${e._createdByName ? ', ' : ''}last changed by ${esc(e._updatedByName)}` : ''}</div>` : ''}
    </div>`;
  };
  const lines = (title, list, one) => (list.length ? `<h3>${title}</h3><div class="lgw-cards">${list.map(one).join('')}</div>` : '');
  body.innerHTML = `
    <p class="lgw-now ${esc(s.now.tone)}">${s.now.html}</p>
    ${s.facts.length ? `<div class="lgw-facts">${s.facts.map(([k, v]) => `<div><span class="k">${esc(k)}</span> ${v}</div>`).join('')}</div>` : ''}
    ${lines('Ledger', s.legs, leg)}
    ${s.ev.length ? `<h3>What happened</h3>${accEvents(s.ev)}` : ''}
    ${lines('Quick sales', data.quick_sales || [], (r) => `<div class="lgw-card"><div class="lgw-card-top"><b>${esc(r.data.item || r.data.model || 'Quick sale')}</b><span class="count" style="margin:0">${esc(accDay(r.data.date))}</span></div><div class="lgw-d">${accAmount(r.data.saleAmount, r.data.ccy)}${r.data.cost ? ` · cost ${accAmount(r.data.cost, r.data.costCcy || r.data.ccy)}` : ''}${r.data.invoiceNo ? ` · invoice ${esc(r.data.invoiceNo)}` : ''}</div>${accPics(accFilesOf(r.data).pics)}${accDocs(accFilesOf(r.data).docs)}</div>`)}
    ${lines('Documents', data.invoices || [], (r) => `<div class="lgw-card"><div class="lgw-card-top"><b>${esc(r.data.invoiceNo || r.data.docType || 'Invoice')}</b><span class="count" style="margin:0">${esc(accDay(r.data.date))}</span></div><div class="lgw-d">${[r.data.status, r.data.ourEntity, r.data.billTo?.name].filter(Boolean).map(esc).join(' · ')}</div></div>`)}
    ${lines('Expenses', data.expenses || [], (r) => `<div class="lgw-card"><div class="lgw-card-top"><b>${esc(r.data.title || r.data.description || 'Expense')}</b><span class="count" style="margin:0">${esc(accDay(r.data.date))}</span></div><div class="lgw-d">${accAmount(r.data.amount, r.data.ccy)}${r.data.category ? ` · ${esc(r.data.category)}` : ''}${r.data.vendor ? ` · ${esc(r.data.vendor)}` : ''}</div>${accPics(accFilesOf(r.data).pics)}${accDocs(accFilesOf(r.data).docs)}</div>`)}
    ${lines('Commission', data.settlements || [], (r) => `<div class="lgw-card"><div class="lgw-card-top"><b>${esc(r.data.employee || r.data.empName || 'Settlement')}</b><span class="count" style="margin:0">${esc(accDay(r.data.date))}</span></div><div class="lgw-d">${(r.data.lines || []).filter((x) => String(x.stock || '').trim() === String(no)).map((x) => `${x.role ? `${esc(x.role)} · ` : ''}commission ${accAmount(x.commission, 'USD')}`).join('; ')}</div></div>`)}
    ${s.pics.length ? `<h3>Pictures</h3>${accPics(s.pics)}` : ''}
    <p class="lgw-foot"><button type="button" class="linkish" id="accw-app">See it in the accounts app</button>
      ${data.read_at ? `<span class="count" style="margin:0 0 0 12px">Copy read ${esc(fmtWhen(data.read_at))}${data.sync ? '' : ' · sync off'}</span>` : ''}</p>`;
  accBindFiles(body);
  d.querySelector('#accw-app')?.addEventListener('click', () => {
    d.close();
    location.hash = accAppLink('stock', no);
  });
}
