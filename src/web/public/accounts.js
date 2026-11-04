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

/*
 * The watch's accounts as a window over its page, in the console's own look
 * (the Logistics window's shape): one line on where the money stands, then
 * the ledger — every purchase and sale leg with its payments — and the
 * quick sales, invoices, expenses and commission lines that name the stock
 * number. Read from our copy of the app's records. Nothing is written back.
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

const accDay = (v) => {
  if (!v) return '';
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : Date.parse(s);
  return Number.isNaN(t) ? s : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};
const accAmount = (n, cur) => {
  const x = Number(String(n ?? '').replace(/[^\d.-]/g, ''));
  if (!x && x !== 0) return '';
  return `${cur ? `${esc(String(cur).toUpperCase())} ` : ''}${x.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const ACC_STATUS = { open: ['Open', 'warn'], partial: ['Partly paid', 'warn'], settled: ['Settled', 'here'], cancelled: ['Cancelled', 'quiet'] };

function accWinRender(d, data) {
  const body = d.querySelector('#accw-body');
  if (!body) return;
  const no = data.stock;
  const who = (e) => {
    const c = e.clientId != null ? data.clients[String(e.clientId)] : null;
    const name = c?.name || e.counterEntity || e.client || '';
    if (c?.client_id) return `<a href="#/client/${c.client_id}">${esc(name)}</a>`;
    return esc(name || 'a client');
  };
  const legs = data.entries || [];
  const buys = legs.filter((l) => l.data.type === 'PAYABLE');
  const sales = legs.filter((l) => l.data.type === 'RECEIVABLE');
  const say = (l, verb) => {
    const e = l.data;
    const st = ACC_STATUS[l.status] || ['', ''];
    const owed = l.outstanding > 0.005 && l.status !== 'cancelled' ? `, ${accAmount(l.outstanding, e.ccy)} still owed` : l.status === 'settled' ? ', settled' : l.status === 'cancelled' ? ' (cancelled)' : '';
    return { text: `${verb} ${who(e)} for ${accAmount(e.amount, e.ccy)}${e.date ? ` on ${accDay(e.date)}` : ''}${owed}`, tone: st[1] };
  };
  let now = { text: `Nothing in the accounts app for stock ${esc(no)}`, tone: 'quiet' };
  const parts = [];
  if (buys[0]) parts.push(say(buys[0], 'Bought from'));
  if (sales[0]) parts.push(say(sales[0], 'Sold to'));
  if (parts.length) now = { text: parts.map((p) => p.text).join(' · '), tone: parts.some((p) => p.tone === 'warn') ? 'warn' : sales[0] ? 'sold' : 'here' };
  else if ((data.quick_sales || []).length) now = { text: `Sold as a quick sale${data.quick_sales[0].data.date ? ` on ${accDay(data.quick_sales[0].data.date)}` : ''}`, tone: 'sold' };

  const pay = (p) => `<div class="lgw-d">${esc(accDay(p.date))} · ${accAmount(p.applied != null ? p.applied : p.amount, p.ccy || p.payCcy)}${p.method ? ` · ${esc(p.method)}` : ''}${p.walletName || p.accountName ? ` · ${esc(p.walletName || p.accountName)}` : ''}${p.note ? ` · ${esc(p.note)}` : ''}</div>`;
  const leg = (l) => {
    const e = l.data;
    const st = ACC_STATUS[l.status] || [l.status, ''];
    return `<div class="lgw-card">
      <div class="lgw-card-top"><b>${e.type === 'PAYABLE' ? 'Purchase from' : 'Sale to'} ${who(e)}</b><span class="count" style="margin:0">${esc(accDay(e.date))}</span></div>
      <div class="lgw-d">${accAmount(e.amount, e.ccy)}${(e.costs || []).length ? ` + costs ${e.costs.map((c) => accAmount(c.amount, c.ccy || e.ccy)).join(', ')}` : ''} · <span class="lgw-ev ${esc(st[1])}" style="font-size:14px">${esc(st[0])}</span>${
        l.status !== 'cancelled' && l.paid > 0 ? ` · paid ${accAmount(l.paid, e.ccy)}` : ''
      }${l.outstanding > 0.005 && l.status !== 'cancelled' ? ` · <b>${accAmount(l.outstanding, e.ccy)} outstanding</b>` : ''}</div>
      <div class="lgw-d">${[e.invoiceNo ? `Invoice ${e.invoiceNo}` : '', e.ourEntity ? `our company ${e.ourEntity}` : '', e.model || '', e.employee ? `by ${e.employee}` : '', e.dueDate ? `due ${accDay(e.dueDate)}` : ''].filter(Boolean).map(esc).join(' · ')}</div>
      ${(e.payments || []).length ? `<div style="margin-top:6px">${e.payments.map(pay).join('')}</div>` : ''}
      ${e.note ? `<div class="lgw-d" style="margin-top:6px">${esc(e.note)}</div>` : ''}
      ${e._createdByName || e._updatedByName ? `<div class="count" style="margin:6px 0 0">${esc(e._createdByName ? `entered by ${e._createdByName}` : '')}${e._updatedByName && e._updatedByName !== e._createdByName ? `${e._createdByName ? ', ' : ''}last changed by ${esc(e._updatedByName)}` : ''}</div>` : ''}
    </div>`;
  };
  const lines = (title, list, one) => (list.length ? `<h3>${title}</h3><div class="lgw-cards">${list.map(one).join('')}</div>` : '');
  body.innerHTML = `
    <p class="lgw-now ${esc(now.tone)}">${now.text}</p>
    ${lines('Ledger', legs, leg)}
    ${lines('Quick sales', data.quick_sales || [], (r) => `<div class="lgw-card"><div class="lgw-card-top"><b>${esc(r.data.item || r.data.model || 'Quick sale')}</b><span class="count" style="margin:0">${esc(accDay(r.data.date))}</span></div><div class="lgw-d">${accAmount(r.data.saleAmount, r.data.ccy)}${r.data.cost ? ` · cost ${accAmount(r.data.cost, r.data.costCcy || r.data.ccy)}` : ''}${r.data.invoiceNo ? ` · invoice ${esc(r.data.invoiceNo)}` : ''}</div></div>`)}
    ${lines('Documents', data.invoices || [], (r) => `<div class="lgw-card"><div class="lgw-card-top"><b>${esc(r.data.invoiceNo || r.data.docType || 'Invoice')}</b><span class="count" style="margin:0">${esc(accDay(r.data.date))}</span></div><div class="lgw-d">${[r.data.status, r.data.ourEntity, r.data.billTo?.name].filter(Boolean).map(esc).join(' · ')}</div></div>`)}
    ${lines('Expenses', data.expenses || [], (r) => `<div class="lgw-card"><div class="lgw-card-top"><b>${esc(r.data.title || r.data.description || 'Expense')}</b><span class="count" style="margin:0">${esc(accDay(r.data.date))}</span></div><div class="lgw-d">${accAmount(r.data.amount, r.data.ccy)}${r.data.category ? ` · ${esc(r.data.category)}` : ''}${r.data.vendor ? ` · ${esc(r.data.vendor)}` : ''}</div></div>`)}
    ${lines('Commission', data.settlements || [], (r) => `<div class="lgw-card"><div class="lgw-card-top"><b>${esc(r.data.employee || r.data.empName || 'Settlement')}</b><span class="count" style="margin:0">${esc(accDay(r.data.date))}</span></div><div class="lgw-d">${(r.data.lines || []).filter((x) => String(x.stock || '').trim() === String(no)).map((x) => `${x.role ? `${esc(x.role)} · ` : ''}commission ${accAmount(x.commission, 'USD')}`).join('; ')}</div></div>`)}
    <p class="lgw-foot"><button type="button" class="linkish" id="accw-app">See it in the accounts app</button>
      ${data.read_at ? `<span class="count" style="margin:0 0 0 12px">Copy read ${esc(new Date(data.read_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}${data.sync ? '' : ' · sync off'}</span>` : ''}</p>`;
  d.querySelector('#accw-app')?.addEventListener('click', () => {
    d.close();
    location.hash = accAppLink('stock', no);
  });
}
