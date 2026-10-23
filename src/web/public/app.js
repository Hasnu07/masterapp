/*
 * The masterapp console. No build step: this file is served as it is.
 *
 * Every value that came from Chrono Key, the vault or a person is ESCAPED
 * before it goes into the page (esc) — supplier names and notes are typed by
 * people outside this business, and nothing in one may become markup here.
 */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = {
  user: null,
  meta: null,
  list: { q: '', status: '', location: '', brand: '', sort: 'newest', deleted: false },
  clients: { q: '', type: '' },
  expenses: { q: '', type: '', from: '', to: '' },
};

async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: { 'X-Requested-With': 'masterapp' } };
  if (opts.body instanceof FormData) init.body = opts.body;
  else if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    state.user = null;
    showLogin();
    throw new Error('Signed out');
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

let flashTimer = null;
function flash(msg, bad = false) {
  let el = $('#flash');
  if (!el) {
    el = document.createElement('div');
    el.id = 'flash';
    document.body.append(el);
  }
  el.className = `flash${bad ? ' bad' : ''}`;
  el.textContent = msg;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.remove(), bad ? 8000 : 3500);
}

const can = (role) => {
  const order = ['viewer', 'editor', 'admin'];
  return state.user && order.indexOf(state.user.role) >= order.indexOf(role);
};

/* ── formatting ───────────────────────────────────────────────────── */

const SYMBOL = { EUR: '€', USD: '$', GBP: '£', AED: 'AED ', HKD: 'HK$', CHF: 'CHF ', USDT: 'USDT ' };
function money(n, cur, { plain = false } = {}) {
  if (n === null || n === undefined || n === '') return '';
  const s = Number(n).toLocaleString('en-GB', { maximumFractionDigits: 2 });
  if (cur === null) return esc(s); // a figure that has no currency field at all
  if (!cur && plain) return esc(s);
  if (!cur) return `${s} <span class="chip other" title="The record does not say which currency">currency not stated</span>`;
  const sym = SYMBOL[cur];
  return esc(sym ? `${sym}${s}` : `${s} ${cur}`);
}
const statusLabel = (k) => state.meta?.statuses.find((s) => s.key === k)?.label || k;
const chip = (k) => `<span class="chip ${esc(k)}">${esc(statusLabel(k))}</span>`;
const fmtDate = (iso) => {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};
const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');

/*
 * A watch page panel that folds (asked 24 Oct 2026): closed until somebody
 * opens it, the arrow on its heading. Opened, it stays open while the page
 * stays on that watch — through a redraw or the logistics panel's refresh.
 */
function fold(key, heading, body) {
  const open = current?.open?.[key] ? ' open' : '';
  return `<details class="fold" data-fold="${esc(key)}"${open}><summary><h3>${heading}</h3></summary>${body}</details>`;
}
document.addEventListener(
  'toggle',
  (e) => {
    const d = e.target;
    if (d instanceof HTMLDetailsElement && d.matches('details.fold[data-fold]') && current) (current.open ||= {})[d.dataset.fold] = d.open;
  },
  true
);
const yesNo = (v) => (v === true ? '✓ Yes' : v === false ? '✗ No' : '');

function display(f, w) {
  const v = w[f.key];
  switch (f.type) {
    case 'money':
      return v === null || v === undefined ? '' : money(v, f.fixedCurrency || (f.currency ? w[f.currency] : null));
    case 'date':
      return esc(fmtDate(v));
    case 'bool':
      return esc(yesNo(v));
    case 'enum':
      return f.key === 'status' ? chip(v) : esc(v);
    case 'payments': {
      const parts = Object.entries(v || {}).map(
        ([k, n]) => `${esc(state.meta.paymentKinds.find((p) => p.key === k)?.label || k)} ${esc(Number(n).toLocaleString('en-GB'))}`
      );
      return parts.join(' · ');
    }
    case 'longtext':
      return esc(v).replace(/\n/g, '<br>');
    default:
      return esc(v);
  }
}

/* ── routing ──────────────────────────────────────────────────────── */

function route() {
  if (!state.user) return showLogin();
  const hash = location.hash.replace(/^#/, '') || '/';
  const [, page, id] = hash.split('/');
  const section = { watch: 'inventory', client: 'clients', expense: 'expenses', lg: 'logistics', 'lg-new': 'logistics' }[page] || page || 'inventory';
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === section));
  menu(false);
  window.scrollTo(0, 0);
  if (!page) return showInventory();
  if (page === 'watch' && id) return showWatch(Number(id));
  if (page === 'clients') return id === 'new' ? showNewClient() : showClients();
  if (page === 'client' && id) return showClient(Number(id));
  if (page === 'expenses') return id === 'new' ? showNewExpense() : showExpenses();
  if (page === 'expense' && id) return showExpense(Number(id));
  if (page === 'logistics') return showLogistics(id);
  if (page === 'lg' && id) return showLogisticsItem(Number(id));
  if (page === 'lg-new' && id) return showNewLogisticsItem(id);
  if (page === 'new') return showNew();
  if (page === 'import') return showImport();
  if (page === 'users') return showUsers();
  location.hash = '#/';
}
window.addEventListener('hashchange', route);

/* The menu drawer, from the ☰. Closed by picking a page, the scrim, × or Esc;
   `inert` while closed, so its links are not tabbed to off screen. */
function menu(open, { focus = false } = {}) {
  $('#drawer').classList.toggle('open', open);
  $('#drawer').inert = !open;
  $('#scrim').classList.toggle('hide', !open);
  $('#menu').setAttribute('aria-expanded', String(open));
  if (open && focus) ($('#nav a.on') || $('#nav a:not(.hide)'))?.focus();
}
// Into the menu only when it was opened from the keyboard (a click's detail is 0 then).
$('#menu').addEventListener('click', (e) => menu(true, { focus: e.detail === 0 }));
$('#menu-close').addEventListener('click', () => menu(false));
$('#scrim').addEventListener('click', () => menu(false));
$('#nav').addEventListener('click', () => menu(false)); // the same page again changes no hash
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#drawer').classList.contains('open')) {
    menu(false);
    $('#menu').focus();
  }
});

/* ── sign-in ──────────────────────────────────────────────────────── */

function showLogin() {
  menu(false);
  $('#bar').classList.add('hide');
  $('#app').innerHTML = `
    <div class="login panel">
      <h1>Purosangue ERP</h1>
      <form id="login" class="stack">
        <input type="email" name="email" placeholder="Email" autocomplete="username" required>
        <input type="password" name="password" placeholder="Password" autocomplete="current-password" required>
        <div class="err" id="login-err"></div>
        <button class="btn primary" style="width:100%;justify-content:center">Sign in</button>
      </form>
    </div>`;
  $('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await api('/api/login', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } });
      await signedIn(r.user);
    } catch (err) {
      $('#login-err').textContent = err.message;
    }
  });
}

async function signedIn(user) {
  state.user = user;
  state.meta = await api('/api/meta');
  $('#bar').classList.remove('hide');
  $('#who').textContent = `${user.name || user.email} · ${user.role}`;
  $$('#nav [data-role]').forEach((a) => a.classList.toggle('hide', !can(a.dataset.role)));
  route();
}

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  state.user = null;
  showLogin();
});

/* ── inventory ────────────────────────────────────────────────────── */

let listSeq = 0;
async function showInventory() {
  const L = state.list;
  $('#app').innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-end;margin-bottom:12px">
      <div><h1>Inventory</h1><p class="sub" style="margin:0">Every watch, from Chrono Key, the Watch vault and added here.</p></div>
      ${can('editor') ? '<a class="btn gold" href="#/new">+ New watch</a>' : ''}
    </div>
    <div class="filters">
      <input class="q" type="search" id="q" placeholder="Stock number, reference, serial, brand, model, supplier, client…" value="${esc(L.q)}">
      <select id="brand"><option value="">All brands</option></select>
      <select id="sort">
        <option value="newest">Newest stock first</option>
        <option value="oldest">Oldest stock first</option>
        <option value="updated">Recently changed</option>
        <option value="price_high">Price, high to low</option>
        <option value="price_low">Price, low to high</option>
        <option value="brand">Brand A–Z</option>
      </select>
    </div>
    <div class="stack" style="margin-bottom:10px">
      <div class="pills" id="p-status"></div>
      <div class="pills" id="p-location"></div>
    </div>
    <div class="row" style="justify-content:space-between">
      <div class="count" id="count"></div>
      <label class="count" style="cursor:pointer"><input type="checkbox" id="deleted" ${L.deleted ? 'checked' : ''}> Show deleted</label>
    </div>
    <div class="grid" id="grid"></div>
    <div class="row" style="justify-content:center;margin-top:18px"><button class="btn hide" id="more">Load more</button></div>`;

  $('#sort').value = L.sort;
  let timer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      L.q = e.target.value;
      loadList();
    }, 220);
  });
  $('#sort').addEventListener('change', (e) => {
    L.sort = e.target.value;
    loadList();
  });
  $('#brand').addEventListener('change', (e) => {
    L.brand = e.target.value;
    loadList();
  });
  $('#deleted').addEventListener('change', (e) => {
    L.deleted = e.target.checked;
    loadList();
  });
  $('#more').addEventListener('click', () => loadList(true));
  loadList();
}

let shown = [];
async function loadList(more = false) {
  const L = state.list;
  const seq = ++listSeq;
  const params = new URLSearchParams({
    q: L.q,
    status: L.status,
    location: L.location,
    brand: L.brand,
    sort: L.sort,
    limit: 60,
    offset: more ? shown.length : 0,
  });
  if (L.deleted) params.set('deleted', '1');
  let r;
  try {
    r = await api(`/api/watches?${params}`);
  } catch (err) {
    return flash(err.message, true);
  }
  if (seq !== listSeq || !$('#grid')) return; // a newer search has answered, or the page changed
  shown = more ? [...shown, ...r.watches] : r.watches;

  const pills = (el, key, facet, label) => {
    const total = facet.reduce((a, f) => a + f.n, 0);
    el.innerHTML =
      `<button class="pill ${L[key] ? '' : 'on'}" data-v="">All ${label}<b>${total}</b></button>` +
      facet
        .filter((f) => f.k)
        .map(
          (f) =>
            `<button class="pill ${L[key] === f.k ? 'on' : ''}" data-v="${esc(f.k)}">${esc(key === 'status' ? statusLabel(f.k) : f.k)}<b>${f.n}</b></button>`
        )
        .join('');
    // A filter in force that now has no watches keeps its pill, so it can be lifted.
    if (L[key] && !facet.some((f) => f.k === L[key])) {
      el.insertAdjacentHTML('beforeend', `<button class="pill on" data-v="${esc(L[key])}">${esc(L[key])}<b>0</b></button>`);
    }
    $$('.pill', el).forEach((b) =>
      b.addEventListener('click', () => {
        L[key] = b.dataset.v;
        loadList();
      })
    );
  };
  pills($('#p-status'), 'status', r.facets.status, 'statuses');
  pills($('#p-location'), 'location', r.facets.location, 'places');

  const sel = $('#brand');
  sel.innerHTML =
    `<option value="">All brands</option>` +
    r.facets.brand
      .filter((b) => b.k)
      .map((b) => `<option value="${esc(b.k)}">${esc(b.k)} (${b.n})</option>`)
      .join('') +
    (L.brand && !r.facets.brand.some((b) => b.k === L.brand) ? `<option value="${esc(L.brand)}">${esc(L.brand)} (0)</option>` : '');
  sel.value = L.brand;

  $('#count').textContent = `${shown.length} of ${r.total} watch${r.total === 1 ? '' : 'es'}${L.deleted ? ' (deleted)' : ''}`;
  $('#grid').innerHTML = shown.length ? shown.map(tile).join('') : '<p class="sub">Nothing matches.</p>';
  $$('#grid .tile').forEach((t) => t.addEventListener('click', () => (location.hash = `#/watch/${t.dataset.id}`)));
  $('#more').classList.toggle('hide', shown.length >= r.total);
}

function tile(w) {
  const price =
    w.status === 'sold' && w.sale_price
      ? `Sold ${money(w.sale_price, w.sale_currency, { plain: true })}`
      : w.b2c_price
        ? `B2C ${money(w.b2c_price, w.b2c_currency, { plain: true })}`
        : w.b2b_price
          ? `B2B ${money(w.b2b_price, w.b2b_currency, { plain: true })}`
          : '';
  return `<button class="tile" data-id="${w.id}">
    <div class="pic">${
      w.photo_id
        ? `<img loading="lazy" src="/api/photos/${w.photo_id}?thumb=1" alt="">`
        : `<span>${esc(w.reference || 'No photo')}</span>`
    }</div>
    <div class="body">
      <div class="t">${esc(w.title)}</div>
      <div class="m">${w.stock_no ? `<b>#${esc(w.stock_no)}</b>` : ''} ${w.deleted_at ? chip('deleted') : chip(w.status)} ${
        w.location ? esc(w.location) : ''
      }</div>
      <div class="m">${esc(w.watch_date)}${w.photo_count ? ` · ${w.photo_count} photo${w.photo_count === 1 ? '' : 's'}` : ''}</div>
      ${price ? `<div class="p">${price}</div>` : ''}
    </div>
  </button>`;
}

/*
 * Why a watch has its status, under its chip: where Chrono Key's own lists
 * put it (the Inventory tab, To-be-shipped, Returned consignments), or that
 * only the vault holds it — and what its Chrono Key page says.
 */
const VAULT_LIST = { dubaiStock: 'Dubai stock', londonStock: 'London stock', hkStock: 'HK stock', soldStocks: 'sold', incomings: 'incoming' };
function statusLine(w) {
  const y = w.status_why;
  if (!y || w.origin === 'manual') return '';
  const bits = [];
  const l = y.ck?.live ? y.ck.lists : null;
  const sold = w.status === 'sold';
  if (y.ck?.live && l) {
    // A sale on the grid is newer than any list: a sold watch is not described as on the shelf.
    if (l.inventory && !sold) {
      bits.push(
        `On Chrono Key's Inventory tab${l.inventory.badge && l.inventory.badge !== 'Available' ? ` — marked “${esc(l.inventory.badge)}”` : ''}${
          l.inventory.owner && l.inventory.owner !== 'INVENTORY' ? ` · owner ${esc(l.inventory.owner)}` : ''
        }`
      );
    }
    if (l.incoming) bits.push(w.status === 'sold' ? 'Sold, and still on Chrono Key’s To-be-shipped list' : 'On Chrono Key’s To-be-shipped list — on its way');
    if (l.returned && !sold) bits.push(`Returned to its client on Chrono Key${l.returned.date ? ` on ${esc(fmtDate(l.returned.date))}` : ''} (its Returned consignments)`);
    if (l.none && !sold) bits.push('On none of Chrono Key’s lists — not on its Inventory tab, nor to be shipped, sold or returned');
    // When those lists were read: if reads have not been trusted for a while, it says so.
    if (bits.length && y.ck.at) bits[bits.length - 1] += ` <span title="Chrono Key's lists, last read in full">(as of ${esc(fmtWhen(y.ck.at))})</span>`;
  } else if (!y.ck?.live && y.vault.length) {
    bits.push(
      `Only in the Watch vault (${esc(y.vault.map((v) => VAULT_LIST[v] || v).join(', '))}) — Chrono Key does not list it${
        y.same_serial.length
          ? ` · same serial as Chrono Key’s ${y.same_serial.map((o) => `<a href="#/watch/${o.id}">${esc(o.stock_no)}</a>`).join(', ')}`
          : ''
      }`
    );
  }
  if (y.ck?.item_status) bits.push(`its Chrono Key page says “${esc(y.ck.item_status)}”`);
  if (y.locked) bits.push('✎ status set here — the sync leaves it');
  return bits.length ? `<p class="count status-why" style="margin:6px 0 0">${bits.join(' · ')}</p>` : '';
}

/* ── one watch ────────────────────────────────────────────────────── */

let current = null;
async function showWatch(id, { keepEdit = false } = {}) {
  let w;
  try {
    w = await api(`/api/watches/${id}`);
  } catch (err) {
    $('#app').innerHTML = `<p class="err">${esc(err.message)}</p><a href="#/">Back to the inventory</a>`;
    return;
  }
  const same = current?.w?.id === w.id;
  current = { w, selected: same ? current.selected : 0, editing: keepEdit && current?.editing, logistics: same ? current.logistics : null, open: same ? current.open : {} };
  renderWatch();
  loadSide(w.id);
  loadWatchLogistics(w.id);
}

function renderWatch() {
  const { w } = current;
  const editor = can('editor') && !w.deleted_at;
  const groups = [...new Set(state.meta.fields.map((f) => f.group))];
  $('#app').innerHTML = `
    <div class="watch-head">
      <div>
        <a href="#/" class="count" style="text-decoration:none">← Inventory</a>
        <h1>${esc(w.display_title)}</h1>
        <div class="row">${w.stock_no ? `<b>Stock ${esc(w.stock_no)}</b>` : ''} ${w.deleted_at ? chip('deleted') : chip(w.status)}
          ${w.location ? `<span>${esc(w.location)}</span>` : ''}
          <span class="count" style="margin:0">From ${esc({ chronokey: 'Chrono Key', vault: 'the Watch vault', manual: 'masterapp' }[w.origin])}</span></div>
        ${statusLine(w)}
        <div id="lg-now"></div>
        <div class="figures">${[
          ['Purchase', w.purchase_price, w.purchase_currency],
          ['B2B', w.b2b_price, w.b2b_currency],
          ['B2C', w.b2c_price, w.b2c_currency],
          ['Chrono24', w.chrono24_price, w.chrono24_currency],
        ]
          .map(([k, n, cur]) => `<div><span>${k}</span><b>${money(n, cur) || '<span class="blank">—</span>'}</b></div>`)
          .join('')}</div>
        ${w.description ? `<p class="desc">${esc(w.description)}</p>` : ''}
      </div>
      <div class="row">
        ${editor && !current.editing ? '<button class="btn primary" id="edit">Edit</button>' : ''}
        ${can('editor') ? (w.deleted_at ? '<button class="btn" id="restore">Restore</button>' : '<button class="btn danger" id="del">Delete</button>') : ''}
      </div>
    </div>
    ${
      w.deleted_at
        ? w.source_gone_at && w.source_gone_at === w.deleted_at
          ? `<p class="note">Removed ${esc(fmtWhen(w.deleted_at))}: it is no longer on Chrono Key or in the vault. It comes back by itself if either lists it again; restore it to keep it here regardless.</p>`
          : `<p class="note">Deleted ${esc(fmtWhen(w.deleted_at))}. It stays deleted even when Chrono Key still lists it; restore it to bring it back.</p>`
        : ''
    }
    <div class="watch-layout">
      <div class="stack">
        <div class="panel gallery" id="gallery"></div>
        <div class="panel" id="wclients"></div>
        <div class="panel" id="sold-for" hidden></div>
        <div class="panel" id="related" hidden></div>
        <div class="panel" id="lg-panel" hidden></div>
      </div>
      <div class="stack">
        <form class="panel" id="details"></form>
      </div>
    </div>`;

  renderGallery();
  renderWatchClients();
  renderDetails(groups);
  // Kept on `current`: Edit redraws the page without reading its side panels again.
  renderWatchLogistics();
  $('#edit')?.addEventListener('click', () => {
    current.editing = true;
    renderWatch();
  });
  $('#del')?.addEventListener('click', async () => {
    if (!confirm(`Delete ${w.display_title}? It can be restored later.`)) return;
    await api(`/api/watches/${w.id}`, { method: 'DELETE' }).then(
      () => showWatch(w.id),
      (e) => flash(e.message, true)
    );
  });
  $('#restore')?.addEventListener('click', async () => {
    await api(`/api/watches/${w.id}/restore`, { method: 'POST' }).then(
      () => showWatch(w.id),
      (e) => flash(e.message, true)
    );
  });
}

async function loadSide(id) {
  const [rel, sold] = await Promise.all([
    api(`/api/watches/${id}/related`).catch(() => ({ related: [] })),
    api(`/api/watches/${id}/sold-for`).catch((err) => ({ error: err.message })),
  ]);
  if (current?.w.id !== id) return;
  renderSoldFor(sold);
  const r = $('#related');
  if (rel.related.length) {
    r.hidden = false;
    r.innerHTML = `<h3>The same watch, other purchases</h3>
      <p class="count" style="margin-top:0">Chrono Key holds this physical watch under more than one stock number — bought back and sold again.</p>
      ${rel.related
        .map(
          (o) =>
            `<div class="row"><a href="#/watch/${o.id}">Stock ${esc(o.stock_no)}</a> ${chip(o.status)} <span class="count" style="margin:0">bought ${esc(
              fmtDate(o.purchase_date)
            )}${o.sale_date ? `, sold ${esc(fmtDate(o.sale_date))}` : ''}</span></div>`
        )
        .join('')}`;
  }
}

/*
 * What this reference has sold for, under the photos: Chrono Key's euro
 * figure (else the sale price as held), the vault's own figure beside it, and
 * the examples still in stock.
 */
function renderSoldFor(s) {
  const box = $('#sold-for');
  if (!box || (!s.error && !s.reference)) return;
  box.hidden = false;
  if (s.error) {
    box.innerHTML = fold('sold-for', 'What it has sold for', `<p class="count">Could not read the sales: ${esc(s.error)}</p>`);
    return;
  }
  const line = (o) => {
    const v = o.vault;
    // A sale price with no currency, at the vault's figure, is that figure.
    const deal = o.deal && !o.deal.currency && v && v.price === o.deal.price ? v : o.deal;
    const main = o.eur !== null ? money(o.eur, 'EUR') : deal ? money(deal.price, deal.currency, { plain: true }) : money(v.price, v.currency);
    const also = v && (o.eur !== null || (deal !== v && o.deal)) ? ` <span class="count">· vault: ${money(v.price, v.currency)}</span>` : '';
    return `<div class="sold-row"><span><a href="#/watch/${o.id}"><b>${esc(o.stock_no)}</b></a>${o.self ? ' <span class="count">(this one)</span>' : ''} — ${main}${also}</span>
      <span class="count">${esc(fmtDate(o.date))}</span></div>`;
  };
  const more = s.soldTotal > s.sold.length ? `${s.soldTotal} sold in all; showing the ${s.sold.length} most recent.` : '';
  const stock = s.inStock.length
    ? `${s.inStock.length} still in stock: ${s.inStock
        .map((o) => `<a href="#/watch/${o.id}">${esc(o.stock_no)}</a>${o.self ? ' (this one)' : ''}`)
        .join(', ')}.`
    : 'None in stock.';
  const total = s.soldTotal || s.sold.length;
  box.innerHTML = fold(
    'sold-for',
    `What it has sold for <span class="fold-note" data-nofx>— ${esc(s.reference)}${total ? ` · ${total} sold` : ''}</span>`,
    `${s.sold.length ? s.sold.map(line).join('') : '<p class="count">No sale of this reference on record.</p>'}
    <p class="count" style="margin-bottom:0">${[more ? esc(more) : '', stock].filter(Boolean).join(' ')}</p>`
  );
}

/* ── photos ──────────────────────────────────────────────────────── */

function renderGallery() {
  const { w } = current;
  const photos = w.photos;
  const editor = can('editor') && !w.deleted_at;
  const sel = Math.min(current.selected, Math.max(photos.length - 1, 0));
  current.selected = sel;
  const p = photos[sel];
  const SRC = { chronokey: 'CK', vault: 'Vault', upload: '' };
  $('#gallery').innerHTML = `
    <div class="main" id="main-photo">${
      p ? `<img src="/api/photos/${p.id}" alt="" style="cursor:zoom-in">` : `<span class="count">No photos yet</span>`
    }</div>
    ${
      p
        ? `<div class="photo-tools">
            <span class="count" style="margin:0">Photo ${sel + 1} of ${photos.length}${p.source !== 'upload' ? ` · from ${p.source === 'chronokey' ? 'Chrono Key' : 'the Watch vault'}` : ''}</span>
            <span class="grow"></span>
            <a class="btn small" href="/api/photos/${p.id}?download=1">Download</a>
            ${
              editor
                ? `<button class="btn small" id="ph-left" ${sel === 0 ? 'disabled' : ''}>◀ Move</button>
                   <button class="btn small" id="ph-right" ${sel === photos.length - 1 ? 'disabled' : ''}>Move ▶</button>
                   ${sel ? '<button class="btn small" id="ph-first">Make main</button>' : ''}
                   <button class="btn small danger" id="ph-del">Remove</button>`
                : ''
            }
          </div>
          ${editor ? `<input type="text" id="ph-cap" placeholder="Caption (optional)" value="${esc(p.caption)}" style="margin-top:8px">` : p.caption ? `<p class="count">${esc(p.caption)}</p>` : ''}`
        : ''
    }
    <div class="thumbs">${photos
      .map(
        (x, i) => `<button type="button" class="thumb ${i === sel ? 'on' : ''}" data-i="${i}" ${editor ? 'draggable="true"' : ''}>
          <img loading="lazy" src="/api/photos/${x.id}?thumb=1" alt="">${SRC[x.source] ? `<span class="src">${SRC[x.source]}</span>` : ''}</button>`
      )
      .join('')}</div>
    ${
      editor
        ? `<label class="drop" id="drop">Drop photos here, paste them, or <u>choose files</u>
             <input type="file" id="pick" accept="image/*" multiple hidden></label>
           ${photos.length > 1 ? '<p class="count">Drag a thumbnail to reorder. The first photo is the one the inventory shows.</p>' : ''}`
        : ''
    }`;

  $$('#gallery .thumb').forEach((t) =>
    t.addEventListener('click', () => {
      current.selected = Number(t.dataset.i);
      renderGallery();
    })
  );
  $('#main-photo img')?.addEventListener('click', () => lightbox(sel));
  if (!editor) return;

  const move = async (from, to) => {
    const ids = photos.map((x) => x.id);
    const [m] = ids.splice(from, 1);
    ids.splice(to, 0, m);
    try {
      await api(`/api/watches/${w.id}/photos/order`, { method: 'POST', body: { ids } });
      current.selected = to;
      await refreshWatch();
    } catch (e) {
      flash(e.message, true);
    }
  };
  $('#ph-left')?.addEventListener('click', () => move(sel, sel - 1));
  $('#ph-right')?.addEventListener('click', () => move(sel, sel + 1));
  $('#ph-first')?.addEventListener('click', () => move(sel, 0));
  $('#ph-del')?.addEventListener('click', async () => {
    const note = p.source === 'upload' ? '' : ' It will not be copied back from ' + (p.source === 'chronokey' ? 'Chrono Key' : 'the vault') + '.';
    if (!confirm(`Remove photo ${sel + 1}?${note}`)) return;
    try {
      await api(`/api/watches/${w.id}/photos/${p.id}`, { method: 'DELETE' });
      await refreshWatch();
    } catch (e) {
      flash(e.message, true);
    }
  });
  $('#ph-cap')?.addEventListener('change', async (e) => {
    try {
      await api(`/api/watches/${w.id}/photos/${p.id}`, { method: 'PATCH', body: { caption: e.target.value } });
      p.caption = e.target.value;
      flash('Caption saved');
    } catch (err) {
      flash(err.message, true);
    }
  });

  // Drag a thumbnail onto another to put it there.
  let dragFrom = null;
  $$('#gallery .thumb').forEach((t) => {
    t.addEventListener('dragstart', () => (dragFrom = Number(t.dataset.i)));
    t.addEventListener('dragover', (e) => {
      if (dragFrom === null) return;
      e.preventDefault();
      t.classList.add('dragover');
    });
    t.addEventListener('dragleave', () => t.classList.remove('dragover'));
    t.addEventListener('drop', (e) => {
      e.preventDefault();
      t.classList.remove('dragover');
      const to = Number(t.dataset.i);
      if (dragFrom !== null && dragFrom !== to) move(dragFrom, to);
      dragFrom = null;
    });
  });

  const drop = $('#drop');
  $('#pick').addEventListener('change', (e) => upload([...e.target.files]));
  drop.addEventListener('dragover', (e) => {
    if (dragFrom !== null) return;
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    upload([...e.dataTransfer.files]);
  });
}

/* A photo dropped anywhere else on the page must not make the browser
   navigate away to it — that would lose whatever was being edited. */
document.addEventListener('dragover', (e) => e.dataTransfer?.types?.includes('Files') && e.preventDefault());
document.addEventListener('drop', (e) => e.dataTransfer?.types?.includes('Files') && e.preventDefault());

/* Paste a screenshot straight onto the watch being looked at. */
document.addEventListener('paste', (e) => {
  if (!current || !$('#drop') || e.target.closest('input, textarea')) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    upload(files);
  }
});

async function upload(files) {
  const pics = files.filter((f) => f.type.startsWith('image/'));
  const refused = files.length - pics.length;
  if (refused) flash(`${refused} file${refused === 1 ? ' is' : 's are'} not a picture and ${refused === 1 ? 'was' : 'were'} left out`, true);
  if (!pics.length) return;
  const fd = new FormData();
  pics.slice(0, 20).forEach((f) => fd.append('photos', f, f.name || 'pasted.png'));
  const drop = $('#drop');
  if (drop) drop.firstChild.textContent = `Uploading ${pics.length} photo${pics.length === 1 ? '' : 's'}… `;
  try {
    await api(`/api/watches/${current.w.id}/photos`, { method: 'POST', body: fd });
    flash(`${Math.min(pics.length, 20)} photo${pics.length === 1 ? '' : 's'} added`);
    current.selected = current.w.photos.length;
    await refreshWatch();
  } catch (e) {
    flash(e.message, true);
    renderGallery();
  }
}

async function refreshWatch() {
  const w = await api(`/api/watches/${current.w.id}`);
  current.w = w;
  renderGallery();
  loadSide(w.id);
}

function lightbox(start) {
  const photos = current.w.photos;
  let i = start;
  const box = document.createElement('div');
  box.className = 'lightbox';
  const draw = () => {
    box.innerHTML = `<img src="/api/photos/${photos[i].id}" alt="">
      <div class="lb-bar"><a class="btn small" href="/api/photos/${photos[i].id}?download=1">Download</a><button class="btn small" data-x>Close</button></div>
      ${photos.length > 1 ? '<button class="btn lb-nav lb-prev" data-p>◀</button><button class="btn lb-nav lb-next" data-n>▶</button>' : ''}`;
  };
  const close = () => {
    box.remove();
    document.removeEventListener('keydown', key);
  };
  const key = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') (i = (i - 1 + photos.length) % photos.length), draw();
    if (e.key === 'ArrowRight') (i = (i + 1) % photos.length), draw();
  };
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-x]') || e.target === box) close();
    else if (e.target.closest('[data-p]')) (i = (i - 1 + photos.length) % photos.length), draw();
    else if (e.target.closest('[data-n]')) (i = (i + 1) % photos.length), draw();
  });
  document.addEventListener('keydown', key);
  draw();
  document.body.append(box);
}

/* ── the details, read and edit ──────────────────────────────────── */

function inputFor(f, w) {
  const v = w[f.key];
  const name = `name="${f.key}"`;
  switch (f.type) {
    case 'enum':
      return `<select ${name}>${f.options.map((o) => `<option value="${o}" ${o === v ? 'selected' : ''}>${esc(statusLabel(o))}</option>`).join('')}</select>`;
    case 'bool':
      return `<select ${name}><option value="">Not stated</option><option value="true" ${v === true ? 'selected' : ''}>Yes</option><option value="false" ${v === false ? 'selected' : ''}>No</option></select>`;
    case 'date':
      return `<input type="date" ${name} value="${esc(v || '')}">`;
    case 'money':
    case 'number':
      return `<input type="text" inputmode="decimal" ${name} value="${v === null || v === undefined ? '' : esc(v)}">`;
    case 'currency':
      return `<input type="text" ${name} list="currencies" maxlength="4" value="${esc(v)}" placeholder="Not stated">`;
    case 'longtext':
      return `<textarea ${name}>${esc(v)}</textarea>`;
    case 'payments':
      return `<div class="pay" data-pay="${f.key}">${state.meta.paymentKinds
        .map(
          (p) => `<label>${esc(p.label)}<input type="text" inputmode="decimal" data-kind="${p.key}" value="${esc(v?.[p.key] ?? '')}"></label>`
        )
        .join('')}</div>`;
    default:
      return `<input type="text" ${name} value="${esc(v)}" ${f.suggest ? `list="sg-${f.key}"` : ''}>${
        f.suggest ? `<datalist id="sg-${f.key}">${f.suggest.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>` : ''
      }`;
  }
}

function renderDetails(groups) {
  const { w } = current;
  const form = $('#details');
  const locked = new Set(w.locked_fields || []);
  const lockMark = (k) =>
    locked.has(k)
      ? `<span class="lock" title="Edited in masterapp — the copy from Chrono Key and the vault will not overwrite it">✎ edited here${
          can('editor') ? ` · <a href="#" data-unlock="${k}">use Chrono Key's</a>` : ''
        }</span>`
      : '';

  if (!current.editing) {
    form.innerHTML = groups
      .map((g) => {
        const fs = state.meta.fields.filter((f) => f.group === g && !f.key.endsWith('_currency'));
        const rows = fs
          .map((f) => {
            const shown = display(f, w);
            return `<dt>${esc(f.label)}</dt><dd>${shown || '<span class="blank">—</span>'}${lockMark(f.key)}</dd>`;
          })
          .join('');
        return `<h3 style="margin-top:${g === groups[0] ? 0 : 18}px">${esc(g)}</h3><dl class="fields">${rows}</dl>`;
      })
      .join('');
    $$('[data-unlock]', form).forEach((a) =>
      a.addEventListener('click', async (e) => {
        e.preventDefault();
        if (!confirm('Hand this field back to Chrono Key? Its value will be replaced on the next sync.')) return;
        await api(`/api/watches/${w.id}/unlock`, { method: 'POST', body: { field: a.dataset.unlock } }).then(
          () => showWatch(w.id),
          (err) => flash(err.message, true)
        );
      })
    );
    return;
  }

  form.innerHTML = `
    ${w.origin !== 'manual' ? `<p class="note info" style="margin-top:0">Until the switch-over Chrono Key is the master. A field you change here is kept as you set it: the next copy from Chrono Key leaves it alone.</p>` : ''}
    ${groups
      .map(
        (g) => `<h3 style="margin-top:14px">${esc(g)}</h3><div class="form-grid">${state.meta.fields
          .filter((f) => f.group === g)
          .map(
            (f) =>
              `<label class="${f.type === 'longtext' || f.type === 'payments' ? 'wide' : ''}">${esc(f.label)}${inputFor(f, w)}${
                f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ''
              }</label>`
          )
          .join('')}</div>`
      )
      .join('')}
    <datalist id="currencies">${state.meta.currencies.map((c) => `<option value="${c}">`).join('')}</datalist>
    <div class="err" id="form-err"></div>
    <div class="sticky-save"><button class="btn primary">Save changes</button><button type="button" class="btn" id="cancel">Cancel</button></div>`;

  $('#cancel').addEventListener('click', () => {
    current.editing = false;
    renderWatch();
    loadSide(w.id);
  });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const patch = readForm(form, w);
    if (!Object.keys(patch).length) {
      current.editing = false;
      return renderWatch();
    }
    try {
      const r = await api(`/api/watches/${w.id}`, { method: 'PATCH', body: patch });
      flash(r.changed.length ? `Saved ${r.changed.length} change${r.changed.length === 1 ? '' : 's'}` : 'Nothing changed');
      current.editing = false;
      showWatch(w.id);
    } catch (err) {
      $('#form-err').textContent = err.message;
    }
  };
}

/** Only the fields that differ from what is held, so an edit never resends — and re-locks — the rest. */
function readForm(form, w) {
  const patch = {};
  for (const f of state.meta.fields) {
    let v;
    if (f.type === 'payments') {
      v = {};
      for (const inp of $$(`[data-pay="${f.key}"] input`, form)) if (inp.value.trim()) v[inp.dataset.kind] = inp.value.trim();
      const before = JSON.stringify(Object.fromEntries(Object.entries(w[f.key] || {}).map(([k, n]) => [k, String(n)]).sort()));
      if (JSON.stringify(Object.entries(v).sort().reduce((o, [k, n]) => ({ ...o, [k]: n }), {})) !== before) patch[f.key] = v;
      continue;
    }
    const el = form.elements[f.key];
    if (!el) continue;
    v = el.value;
    const was = w[f.key];
    const wasText = was === null || was === undefined ? '' : String(was);
    if (v.trim() !== wasText) patch[f.key] = v;
  }
  return patch;
}

/* ── clients ──────────────────────────────────────────────────────── */

const clientTypeLabel = (k) => state.meta.clientTypes.find((t) => t.key === k)?.label || '';
const dealPrice = (w, side) =>
  side === 'bought'
    ? money(w.purchase_price, w.purchase_currency)
    : w.sale_price_eur !== null && w.sale_price_eur !== undefined
      ? money(w.sale_price_eur, 'EUR')
      : money(w.sale_price, w.sale_currency);

async function showClients() {
  const C = state.clients;
  $('#app').innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-end;margin-bottom:12px">
      <div><h1>Clients</h1><p class="sub" style="margin:0">Who we buy from and sell to — from Chrono Key's client list, and added here.</p></div>
      ${can('editor') ? '<a class="btn gold" href="#/clients/new">+ Add client</a>' : ''}
    </div>
    <div class="filters" style="grid-template-columns:1fr">
      <input class="q" type="search" id="cq" placeholder="Name, nickname, company, email or phone…" value="${esc(C.q)}">
    </div>
    <div class="pills" id="ctypes" style="margin-bottom:10px"></div>
    <div class="count" id="ccount"></div>
    <div class="panel tscroll" style="padding:0"><table class="list clients"><thead><tr>
      <th>Name</th><th>Type</th><th>Company</th><th>Phone</th><th>Email</th><th>Bought from them</th><th>Sold to them</th><th>Last deal</th>
    </tr></thead><tbody id="crows"></tbody></table></div>
    <div class="row" style="justify-content:center;margin-top:18px"><button class="btn hide" id="cmore">Show more</button></div>`;
  let timer;
  $('#cq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      C.q = e.target.value;
      loadClients();
    }, 220);
  });
  $('#cmore').addEventListener('click', () => loadClients(true));
  // A row opens its client; a link inside it (the email) does its own thing.
  $('#crows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('a')) location.hash = `#/client/${tr.dataset.id}`;
  });
  loadClients();
}

let clientSeq = 0;
let clientsShown = [];
async function loadClients(more = false) {
  const C = state.clients;
  const seq = ++clientSeq;
  const p = new URLSearchParams({ q: C.q, type: C.type, limit: 100, offset: more ? clientsShown.length : 0 });
  let r;
  try {
    r = await api(`/api/clients?${p}`);
  } catch (err) {
    return flash(err.message, true);
  }
  if (seq !== clientSeq || !$('#crows')) return;
  clientsShown = more ? [...clientsShown, ...r.clients] : r.clients;

  const all = r.types.reduce((n, t) => n + t.n, 0);
  $('#ctypes').innerHTML =
    `<button class="pill ${C.type ? '' : 'on'}" data-v="">All<b>${all}</b></button>` +
    r.types
      .filter((t) => t.k)
      .map((t) => `<button class="pill ${C.type === t.k ? 'on' : ''}" data-v="${esc(t.k)}">${esc(clientTypeLabel(t.k))}<b>${t.n}</b></button>`)
      .join('');
  $$('#ctypes .pill').forEach((b) =>
    b.addEventListener('click', () => {
      C.type = b.dataset.v;
      loadClients();
    })
  );
  $('#ccount').textContent = `${r.total.toLocaleString('en-GB')} client${r.total === 1 ? '' : 's'}${C.q ? ` matching “${C.q}”` : ''}`;
  $('#crows').innerHTML =
    clientsShown
      .map(
        (c) => `<tr data-id="${c.id}">
          <td><a href="#/client/${c.id}"><b>${esc(c.name)}</b></a>${c.nickname && c.nickname !== c.name ? `<div class="count" style="margin:0">${esc(c.nickname)}</div>` : ''}</td>
          <td>${esc(clientTypeLabel(c.type))}</td>
          <td>${esc(c.company)}</td>
          <td style="white-space:nowrap">${esc(c.phone)}</td>
          <td>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : ''}</td>
          <td>${c.bought || '<span class="blank">—</span>'}</td>
          <td>${c.sold || '<span class="blank">—</span>'}</td>
          <td style="white-space:nowrap">${esc(fmtDate(c.last_deal))}</td>
        </tr>`
      )
      .join('') || `<tr><td colspan="8" class="count">No client matches.</td></tr>`;
  $('#cmore').classList.toggle('hide', clientsShown.length >= r.total);
}

async function showClient(id) {
  let c;
  try {
    c = await api(`/api/clients/${id}`);
  } catch (err) {
    $('#app').innerHTML = `<p class="err">${esc(err.message)}</p><a href="#/clients">Back to the clients</a>`;
    return;
  }
  renderClient(c, false);
}

function renderClient(c, editing) {
  const editor = can('editor');
  const F = state.meta.clientFields;
  const shown = (f) => (f.key === 'type' ? clientTypeLabel(c.type) : c[f.key]);
  const watchRows = (list, side) =>
    list
      .map(
        (w) => `<a class="cw-row" href="#/watch/${w.id}" data-text="${esc(
          [w.stock_no, w.title, w.reference, w.serial].join(' ').toLowerCase()
        )}">
          ${w.photo_id ? `<img src="/api/photos/${w.photo_id}?thumb=1" alt="" loading="lazy">` : '<span class="cw-none"></span>'}
          <span class="cw-main"><b>${esc(w.stock_no || '')}</b> ${esc(w.title)}<span class="count" style="display:block;margin:0">${chip(w.status)} ${esc(
            fmtDate(side === 'bought' ? w.purchase_date : w.sale_date)
          )}</span></span>
          <span class="cw-price">${dealPrice(w, side) || '<span class="blank">—</span>'}</span>
        </a>`
      )
      .join('') || '<p class="count">None.</p>';

  $('#app').innerHTML = `
    <div class="watch-head">
      <div>
        <a href="#/clients" class="count" style="text-decoration:none">← Clients</a>
        <h1>${esc(c.name)}</h1>
        <div class="row">${c.type ? `<b>${esc(clientTypeLabel(c.type))}</b>` : ''}${c.company ? `<span>${esc(c.company)}</span>` : ''}
          <span class="count" style="margin:0">${c.origin === 'chronokey' ? 'From Chrono Key' : 'Added in masterapp'}</span></div>
        <div class="figures">
          <div><span>Bought from them</span><b>${c.bought.length}</b></div>
          <div><span>Sold to them</span><b>${c.sold.length}</b></div>
        </div>
      </div>
      <div class="row">${editor && !editing ? '<button class="btn primary" id="cedit">Edit</button>' : ''}</div>
    </div>
    <div class="watch-layout">
      <div class="stack">
        <div class="panel">
          <input type="search" id="cwq" placeholder="Search this client's watches — stock, model, reference, serial…" style="width:100%">
        </div>
        <div class="panel"><h3>Bought from them · ${c.bought.length}</h3><div class="cw" id="cw-bought">${watchRows(c.bought, 'bought')}</div></div>
        <div class="panel"><h3>Sold to them · ${c.sold.length}</h3><div class="cw" id="cw-sold">${watchRows(c.sold, 'sold')}</div></div>
      </div>
      <div class="stack">
        ${
          editing
            ? `<form class="panel" id="cform"><h3>Client</h3><div class="form-grid">${F.map((f) =>
                f.type === 'enum'
                  ? `<label>${esc(f.label)}<select name="${f.key}">${f.options
                      .map((o) => `<option value="${esc(o)}"${c[f.key] === o ? ' selected' : ''}>${esc(o ? clientTypeLabel(o) : '—')}</option>`)
                      .join('')}</select></label>`
                  : f.type === 'longtext'
                    ? `<label class="wide">${esc(f.label)}<textarea name="${f.key}" rows="3">${esc(c[f.key])}</textarea></label>`
                    : `<label>${esc(f.label)}<input name="${f.key}" value="${esc(c[f.key])}"></label>`
              ).join('')}</div>
              <div class="row" style="margin-top:12px"><button class="btn primary">Save</button><button type="button" class="btn" id="ccancel">Cancel</button></div></form>`
            : `<div class="panel"><h3>Client</h3><dl class="fields">${F.map(
                (f) => `<dt>${esc(f.label)}</dt><dd>${shown(f) ? esc(shown(f)).replace(/\n/g, '<br>') : '<span class="blank">—</span>'}${
                  c.locked_fields.includes(f.key) ? ' <span class="count" style="margin:0" title="Edited here; the copy from Chrono Key leaves it alone">✎ edited here</span>' : ''
                }</dd>`
              ).join('')}</dl></div>`
        }
      </div>
    </div>`;

  $('#cwq').addEventListener('input', (e) => {
    const words = e.target.value.toLowerCase().split(/\s+/).filter(Boolean);
    $$('.cw-row').forEach((a) => (a.hidden = !words.every((w) => a.dataset.text.includes(w))));
  });
  $('#cedit')?.addEventListener('click', () => renderClient(c, true));
  $('#ccancel')?.addEventListener('click', () => renderClient(c, false));
  $('#cform')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = {};
    for (const f of F) {
      const v = e.target.elements[f.key].value.trim();
      if (v !== (c[f.key] ?? '')) patch[f.key] = v;
    }
    try {
      if (Object.keys(patch).length) await api(`/api/clients/${c.id}`, { method: 'PATCH', body: patch });
      flash('Saved');
      showClient(c.id);
    } catch (err) {
      flash(err.message, true);
    }
  });
}

function showNewClient() {
  if (!can('editor')) return (location.hash = '#/clients');
  const F = state.meta.clientFields;
  $('#app').innerHTML = `
    <a href="#/clients" class="count" style="text-decoration:none">← Clients</a>
    <h1>Add a client</h1>
    <form class="panel" id="nform" style="max-width:760px"><div class="form-grid">${F.map((f) =>
      f.type === 'enum'
        ? `<label>${esc(f.label)}<select name="${f.key}">${f.options.map((o) => `<option value="${esc(o)}">${esc(o ? clientTypeLabel(o) : '—')}</option>`).join('')}</select></label>`
        : f.type === 'longtext'
          ? `<label class="wide">${esc(f.label)}<textarea name="${f.key}" rows="3"></textarea></label>`
          : `<label>${esc(f.label)}<input name="${f.key}"></label>`
    ).join('')}</div>
    <div class="row" style="margin-top:12px"><button class="btn primary">Add client</button></div></form>`;
  $('#nform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const f of F) if (e.target.elements[f.key].value.trim()) body[f.key] = e.target.elements[f.key].value.trim();
    try {
      const r = await api('/api/clients', { method: 'POST', body });
      location.hash = `#/client/${r.id}`;
    } catch (err) {
      flash(err.message, true);
    }
  });
}

/*
 * A watch's two clients, on its page: who it was bought from and who it was
 * sold to, each a link to the client. An editor can change either — the link
 * is then locked against the sync — or hand it back to Chrono Key.
 */
function renderWatchClients() {
  const { w } = current;
  const box = $('#wclients');
  if (!box) return;
  const editor = can('editor') && !w.deleted_at;
  const side = (role, label, typed) => {
    const l = w.clients[role];
    return `<div class="wc" data-role="${role}">
      <div class="wc-line"><span class="wc-label">${label}</span>
        <span>${l.id ? `<a href="#/client/${l.id}"><b>${esc(l.name)}</b></a>` : `<span class="blank">Not linked</span>${typed ? ` <span class="count" style="margin:0">· typed “${esc(typed)}”</span>` : ''}`}
        ${l.locked ? ' <span class="count" style="margin:0">✎ set here</span>' : ''}</span>
        ${editor ? `<span class="wc-act"><button type="button" class="btn small" data-change>Change</button>${
          l.locked && w.origin !== 'manual' ? '<button type="button" class="btn small" data-back title="Use the client Chrono Key names">Use Chrono Key’s</button>' : ''
        }</span>` : ''}
      </div>
      <div class="wc-pick hide"><input type="search" placeholder="Search clients…"><div class="wc-hits"></div></div>
    </div>`;
  };
  box.innerHTML = `<h3>Clients</h3>${side('purchase', 'Bought from', w.purchased_from)}${side('sale', 'Sold to', w.sold_to)}`;

  const set = async (role, clientId) => {
    try {
      await api(`/api/watches/${w.id}/client`, { method: 'PUT', body: { role, client_id: clientId } });
      showWatch(w.id, { keepEdit: true });
    } catch (err) {
      flash(err.message, true);
    }
  };
  $$('.wc', box).forEach((el) => {
    const role = el.dataset.role;
    const pick = $('.wc-pick', el);
    const input = $('input', pick);
    let timer;
    const search = async () => {
      const r = await api(`/api/clients?${new URLSearchParams({ q: input.value, limit: 8 })}`).catch(() => ({ clients: [] }));
      $('.wc-hits', pick).innerHTML =
        r.clients
          .map((c) => `<button type="button" class="wc-hit" data-id="${c.id}"><b>${esc(c.name)}</b> <span class="count" style="margin:0">${esc(
            [clientTypeLabel(c.type), c.company, c.phone].filter(Boolean).join(' · ')
          )}</span></button>`)
          .join('') + (w.clients[role].id ? '<button type="button" class="wc-hit" data-id="">No client</button>' : '');
    };
    $('[data-change]', el)?.addEventListener('click', () => {
      pick.classList.toggle('hide');
      if (!pick.classList.contains('hide')) {
        input.value = (role === 'purchase' ? w.purchased_from : w.sold_to) || '';
        input.focus();
        search();
      }
    });
    $('[data-back]', el)?.addEventListener('click', () => set(role, 'chronokey'));
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(search, 200);
    });
    pick.addEventListener('click', (e) => {
      const b = e.target.closest('.wc-hit');
      if (b) set(role, b.dataset.id ? Number(b.dataset.id) : null);
    });
  });
}

/* ── expenses ─────────────────────────────────────────────────────── */

const payLabel = (k) => state.meta.paymentKinds.find((p) => p.key === k)?.label || '';
const expenseCost = (e) => money(e.amount, e.currency);

async function showExpenses() {
  const X = state.expenses;
  $('#app').innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:flex-end;margin-bottom:12px">
      <div><h1>Expenses</h1><p class="sub" style="margin:0">What the business spends — from Chrono Key's expense list, and added here.</p></div>
      ${can('editor') ? '<a class="btn gold" href="#/expenses/new">+ Add expense</a>' : ''}
    </div>
    <div class="filters" style="grid-template-columns:1fr auto auto auto">
      <input class="q" type="search" id="xq" placeholder="Title, type, description or amount…" value="${esc(X.q)}">
      <select id="xtype"><option value="">All types</option></select>
      <label class="count" style="margin:0">From <input type="date" id="xfrom" value="${esc(X.from)}"></label>
      <label class="count" style="margin:0">to <input type="date" id="xto" value="${esc(X.to)}"></label>
    </div>
    <div class="figures" id="xsum" style="margin:0 0 12px"></div>
    <div class="panel tscroll" style="padding:0"><table class="list clients"><thead><tr>
      <th>Date</th><th>Title</th><th>Type</th><th>Cost</th><th>In EUR</th><th>Paid by</th><th title="Payment copies">Copy</th>
    </tr></thead><tbody id="xrows"></tbody></table></div>
    <div class="row" style="justify-content:center;margin-top:18px"><button class="btn hide" id="xmore">Show more</button></div>`;
  let timer;
  $('#xq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      X.q = e.target.value;
      loadExpenses();
    }, 220);
  });
  for (const [id, key] of [
    ['#xtype', 'type'],
    ['#xfrom', 'from'],
    ['#xto', 'to'],
  ]) {
    $(id).addEventListener('change', (e) => {
      X[key] = e.target.value;
      loadExpenses();
    });
  }
  $('#xmore').addEventListener('click', () => loadExpenses(true));
  $('#xrows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('a')) location.hash = `#/expense/${tr.dataset.id}`;
  });
  loadExpenses();
}

let expenseSeq = 0;
let expensesShown = [];
async function loadExpenses(more = false) {
  const X = state.expenses;
  const seq = ++expenseSeq;
  const p = new URLSearchParams({ q: X.q, type: X.type, from: X.from, to: X.to, limit: 100, offset: more ? expensesShown.length : 0 });
  let r;
  try {
    r = await api(`/api/expenses?${p}`);
  } catch (err) {
    return flash(err.message, true);
  }
  if (seq !== expenseSeq || !$('#xrows')) return;
  expensesShown = more ? [...expensesShown, ...r.expenses] : r.expenses;

  $('#xtype').innerHTML =
    `<option value="">All types</option>` +
    r.types
      .filter((t) => t.k)
      .map((t) => `<option value="${esc(t.k)}"${X.type === t.k ? ' selected' : ''}>${esc(t.k)} (${t.n})</option>`)
      .join('') +
    (X.type && !r.types.some((t) => t.k === X.type) ? `<option selected value="${esc(X.type)}">${esc(X.type)} (0)</option>` : '');
  $('#xsum').innerHTML = `
    <div><span>Expenses</span><b>${r.total.toLocaleString('en-GB')}</b></div>
    <div><span>Total in EUR</span><b>${money(r.sum_eur, 'EUR')}</b></div>
    ${r.without_eur ? `<div><span>Not in the total</span><b title="No euro figure: the cost is in its own currency only">${r.without_eur} without a euro figure</b></div>` : ''}`;
  $('#xrows').innerHTML =
    expensesShown
      .map(
        (e) => `<tr data-id="${e.id}">
          <td style="white-space:nowrap">${esc(fmtDate(e.expense_date))}</td>
          <td><a href="#/expense/${e.id}"><b>${esc(e.title || 'Untitled')}</b></a></td>
          <td>${esc(e.type)}</td>
          <td style="white-space:nowrap">${expenseCost(e) || '<span class="blank">—</span>'}</td>
          <td style="white-space:nowrap">${money(e.cost_eur, 'EUR') || '<span class="blank">—</span>'}</td>
          <td>${esc(payLabel(e.payment_method))}</td>
          <td>${e.files ? `📎 ${e.files}` : ''}</td>
        </tr>`
      )
      .join('') || `<tr><td colspan="7" class="count">No expense matches.</td></tr>`;
  $('#xmore').classList.toggle('hide', expensesShown.length >= r.total);
}

/* The form, for a new expense and an edit. */
function expenseForm(e) {
  const F = state.meta.expenseFields;
  const input = (f) => {
    const v = e[f.key];
    switch (f.type) {
      case 'date':
        return `<input type="date" name="${f.key}" value="${esc(v || '')}">`;
      case 'currency': {
        const codes = [...new Set([...state.meta.currencies, ...(v ? [v] : [])])];
        return `<select name="${f.key}"><option value="">—</option>${codes.map((c) => `<option${c === v ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select>`;
      }
      case 'enum':
        return `<select name="${f.key}">${f.options.map((o) => `<option value="${esc(o)}"${o === (v || '') ? ' selected' : ''}>${esc(o ? payLabel(o) : '—')}</option>`).join('')}</select>`;
      case 'longtext':
        return `<textarea name="${f.key}" rows="4">${esc(v || '')}</textarea>`;
      case 'bool':
        return `<input type="checkbox" name="${f.key}"${v ? ' checked' : ''} style="justify-self:start">`;
      default:
        return `<input name="${f.key}" value="${esc(v ?? '')}"${f.key === 'type' ? ' list="xtypes" autocomplete="off"' : ''}${
          f.type === 'money' || f.type === 'rate' ? ' inputmode="decimal"' : ''
        }>`;
    }
  };
  return `<div class="form-grid">${F.map(
    (f) => `<label class="${f.type === 'longtext' ? 'wide' : ''}">${esc(f.label)}${input(f)}</label>`
  ).join('')}</div><datalist id="xtypes"></datalist>`;
}

function readExpenseForm(form, e) {
  const patch = {};
  for (const f of state.meta.expenseFields) {
    const el = form.elements[f.key];
    const v = f.type === 'bool' ? el.checked : el.value.trim();
    const was = e[f.key];
    if (f.type === 'bool' ? Boolean(was) !== v : String(v) !== (was === null || was === undefined ? '' : String(was))) patch[f.key] = v;
  }
  return patch;
}

async function fillTypeSuggestions() {
  const r = await api('/api/expenses/types').catch(() => ({ types: [] }));
  const dl = $('#xtypes');
  if (dl) dl.innerHTML = r.types.map((t) => `<option value="${esc(t)}">`).join('');
}

async function showExpense(id) {
  let e;
  try {
    e = await api(`/api/expenses/${id}`);
  } catch (err) {
    $('#app').innerHTML = `<p class="err">${esc(err.message)}</p><a href="#/expenses">Back to the expenses</a>`;
    return;
  }
  renderExpense(e, false);
}

function renderExpense(e, editing) {
  const editor = can('editor');
  const fileTile = (f) => `<div class="xfile">
      <a href="/api/expense-files/${f.id}" target="_blank" rel="noopener">${
        f.has_thumb ? `<img src="/api/expense-files/${f.id}?thumb=1" alt="">` : '<span class="xpdf">PDF</span>'
      }<span class="xname">${esc(f.name || (f.content_type === 'application/pdf' ? 'Document.pdf' : 'Picture'))}</span></a>
      ${editor && !e.deleted_at ? `<button type="button" class="btn small danger" data-rm="${f.id}">Remove</button>` : ''}
    </div>`;
  $('#app').innerHTML = `
    <div class="watch-head">
      <div>
        <a href="#/expenses" class="count" style="text-decoration:none">← Expenses</a>
        <h1>${esc(e.title || 'Untitled expense')}</h1>
        <div class="row">${e.type ? `<b>${esc(e.type)}</b>` : ''}<span>${esc(fmtDate(e.expense_date))}</span>
          ${e.deleted_at ? chip('deleted') : ''}
          <span class="count" style="margin:0">${e.origin === 'chronokey' ? 'From Chrono Key' : 'Added in masterapp'}</span></div>
        <div class="figures">
          <div><span>Cost</span><b>${expenseCost(e) || '<span class="blank">—</span>'}</b></div>
          <div><span>In EUR</span><b>${money(e.cost_eur, 'EUR') || '<span class="blank">—</span>'}</b></div>
          ${e.exchange_rate ? `<div><span>Rate</span><b>${esc(Number(e.exchange_rate))}</b></div>` : ''}
          <div><span>Paid by</span><b>${esc(payLabel(e.payment_method)) || '<span class="blank">—</span>'}</b></div>
        </div>
        ${e.exclude_from_profit ? '<p class="count" style="margin:8px 0 0">Left out of profit (Loan Book on Chrono Key).</p>' : ''}
      </div>
      <div class="row">
        ${editor && !editing && !e.deleted_at ? '<button class="btn primary" id="xedit">Edit</button>' : ''}
        ${editor ? (e.deleted_at ? '<button class="btn" id="xrestore">Restore</button>' : '<button class="btn danger" id="xdel">Delete</button>') : ''}
      </div>
    </div>
    <div class="watch-layout">
      <div class="stack">
        <div class="panel"><h3>Payment copy</h3>
          <div class="xfiles">${e.files.map(fileTile).join('') || '<p class="count" style="margin:0">None attached yet.</p>'}</div>
          ${editor && !e.deleted_at ? `<label class="drop" id="xdrop" style="margin-top:12px">Drop a receipt or a transfer slip here, or <u>choose files</u> — pictures or PDFs
            <input type="file" id="xfile" multiple accept="image/*,application/pdf" hidden></label>` : ''}
        </div>
      </div>
      <div class="stack">
        ${
          editing
            ? `<form class="panel" id="xform"><h3>Expense</h3>${expenseForm(e)}
                <div class="row" style="margin-top:12px"><button class="btn primary">Save</button><button type="button" class="btn" id="xcancel">Cancel</button></div></form>`
            : `<div class="panel"><h3>Description</h3><div style="white-space:pre-wrap;overflow-wrap:anywhere">${
                e.description ? esc(e.description) : '<span class="blank">—</span>'
              }</div>${
                e.locked_fields.length
                  ? `<p class="count" style="margin:10px 0 0">✎ Edited here: ${esc(
                      e.locked_fields.map((k) => state.meta.expenseFields.find((f) => f.key === k)?.label || k).join(', ')
                    )} — the copy from Chrono Key leaves ${e.locked_fields.length === 1 ? 'it' : 'them'} alone.</p>`
                  : ''
              }</div>`
        }
      </div>
    </div>`;

  const upload = async (files) => {
    if (!files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    try {
      await api(`/api/expenses/${e.id}/files`, { method: 'POST', body: fd });
      flash(files.length === 1 ? 'Payment copy added' : `${files.length} payment copies added`);
      showExpense(e.id);
    } catch (err) {
      flash(err.message, true);
    }
  };
  $('#xfile')?.addEventListener('change', (ev) => upload([...ev.target.files]));
  const drop = $('#xdrop');
  if (drop) {
    drop.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (ev) => {
      ev.preventDefault();
      drop.classList.remove('over');
      upload([...ev.dataTransfer.files]);
    });
  }
  $$('[data-rm]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Remove this payment copy?')) return;
      await api(`/api/expenses/${e.id}/files/${b.dataset.rm}`, { method: 'DELETE' }).then(
        () => showExpense(e.id),
        (err) => flash(err.message, true)
      );
    })
  );
  $('#xedit')?.addEventListener('click', () => renderExpense(e, true));
  $('#xcancel')?.addEventListener('click', () => renderExpense(e, false));
  $('#xdel')?.addEventListener('click', async () => {
    if (!confirm(`Delete “${e.title}”? It can be restored later.`)) return;
    await api(`/api/expenses/${e.id}`, { method: 'DELETE' }).then(() => showExpense(e.id), (err) => flash(err.message, true));
  });
  $('#xrestore')?.addEventListener('click', async () => {
    await api(`/api/expenses/${e.id}/restore`, { method: 'POST' }).then(() => showExpense(e.id), (err) => flash(err.message, true));
  });
  $('#xform')?.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const patch = readExpenseForm(ev.target, e);
    try {
      if (Object.keys(patch).length) await api(`/api/expenses/${e.id}`, { method: 'PATCH', body: patch });
      flash('Saved');
      showExpense(e.id);
    } catch (err) {
      flash(err.message, true);
    }
  });
  if (editing) fillTypeSuggestions();
}

function showNewExpense() {
  if (!can('editor')) return (location.hash = '#/expenses');
  const blank = { expense_date: new Date().toISOString().slice(0, 10), payment_method: '', exclude_from_profit: false };
  $('#app').innerHTML = `
    <a href="#/expenses" class="count" style="text-decoration:none">← Expenses</a>
    <h1>Add an expense</h1>
    <form class="panel" id="xnew" style="max-width:820px">${expenseForm(blank)}
      <label class="drop" style="margin-top:14px">Payment copy — a receipt or a transfer slip, pictures or PDFs: <u>choose files</u>
        <input type="file" name="files" multiple accept="image/*,application/pdf" hidden></label>
      <div class="count" id="xpicked"></div>
      <div class="row" style="margin-top:12px"><button class="btn primary">Add expense</button></div></form>`;
  fillTypeSuggestions();
  const form = $('#xnew');
  form.elements.files.addEventListener('change', (ev) => {
    $('#xpicked').textContent = [...ev.target.files].map((f) => f.name).join(', ');
  });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = readExpenseForm(form, {});
    let id;
    try {
      id = (await api('/api/expenses', { method: 'POST', body })).id;
    } catch (err) {
      return flash(err.message, true);
    }
    const files = [...form.elements.files.files];
    if (files.length) {
      const fd = new FormData();
      for (const f of files) fd.append('files', f, f.name);
      await api(`/api/expenses/${id}/files`, { method: 'POST', body: fd }).catch((err) =>
        flash(`The expense is added, but the payment copy was not: ${err.message}`, true)
      );
    }
    location.hash = `#/expense/${id}`;
  });
}

/* ── new watch ────────────────────────────────────────────────────── */

function showNew() {
  if (!can('editor')) return (location.hash = '#/');
  const blank = { status: 'in_stock', locked_fields: [] };
  for (const f of state.meta.fields) if (!(f.key in blank)) blank[f.key] = f.type === 'payments' ? {} : null;
  const groups = [...new Set(state.meta.fields.map((f) => f.group))];
  $('#app').innerHTML = `<h1>New watch</h1><p class="sub">Photos can be added once it is saved.</p>
    <form class="panel" id="newform">${groups
      .map(
        (g) => `<h3 style="margin-top:14px">${esc(g)}</h3><div class="form-grid">${state.meta.fields
          .filter((f) => f.group === g)
          .map((f) => `<label class="${f.type === 'longtext' || f.type === 'payments' ? 'wide' : ''}">${esc(f.label)}${inputFor(f, blank)}</label>`)
          .join('')}</div>`
      )
      .join('')}
      <datalist id="currencies">${state.meta.currencies.map((c) => `<option value="${c}">`).join('')}</datalist>
      <div class="err" id="form-err"></div>
      <div class="sticky-save"><button class="btn primary">Create watch</button><a class="btn" href="#/">Cancel</a></div>
    </form>`;
  $('#newform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const patch = readForm(e.target, blank);
    patch.status = e.target.elements.status.value;
    try {
      const r = await api('/api/watches', { method: 'POST', body: patch });
      location.hash = `#/watch/${r.id}`;
    } catch (err) {
      $('#form-err').textContent = err.message;
    }
  });
}

/* ── import ───────────────────────────────────────────────────────── */

let importTimer = null;
async function showImport() {
  clearTimeout(importTimer);
  let s;
  try {
    s = await api('/api/import/status');
  } catch (err) {
    return flash(err.message, true);
  }
  if (!location.hash.startsWith('#/import')) return;
  const admin = can('admin');
  const c = s.counts;
  const runName = (r) =>
    ({
      'chronokey/csv': 'Product list (CSV upload)',
      'chronokey/list': 'Product list (live)',
      'chronokey/clients': 'Client list',
      'chronokey/expenses': 'Expenses',
      'chronokey/details-new': 'Watch pages & photos — new',
      'chronokey/details-active': 'Watch pages & photos — unsold and recent',
      'chronokey/details-full': 'Watch pages & photos — everything',
      'chronokey/details-rolling': 'Watch pages & photos — the longest unread',
      'vault/full': 'Watch vault',
    })[`${r.source}/${r.mode}`] || `${r.source} ${r.mode}`;
  const statsLine = (st) =>
    Object.entries(st || {})
      .filter(([k, v]) => !Array.isArray(v) && typeof v !== 'object' && v !== null && v !== '')
      .map(([k, v]) => `${esc(k)} ${esc(v)}`)
      .join(' · ');

  /*
   * A run still going: how far, and how long left at the pace so far. Watch
   * pages count done of todo; the vault counts watches done of the stock
   * numbers it found. Either is saved every few pages, so the bar moves in
   * small steps. A run with nothing to count just says it is running.
   */
  const n = (x) => Number(x || 0).toLocaleString('en-GB');
  const dur = (m) => (m < 1 ? 'under a minute' : m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`);
  const progress = (r) => {
    const st = r.stats || {};
    const todo = Number(st.todo ?? st.stockNumbers) || 0;
    const done = Number(st.done ?? (st.created || 0) + (st.updated || 0) + (st.unchanged || 0)) || 0;
    const mins = (Date.now() - new Date(r.started_at).getTime()) / 60000;
    if (!todo) {
      return `<div class="progress"><b>${esc(runName(r))}</b><div class="count">Running for ${dur(mins)} — starting up${st.photos ? ` · ${n(st.photos)} photos` : ''}</div></div>`;
    }
    const left = Math.max(0, todo - done);
    const pct = Math.min(100, Math.floor((done / todo) * 100));
    const rate = mins > 0 ? done / mins : 0;
    const eta = done >= 10 && rate ? left / rate : null;
    const at = eta === null ? '' : new Date(Date.now() + eta * 60000).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `<div class="progress">
      <div class="row" style="justify-content:space-between"><b>${esc(runName(r))}</b><b>${pct}%</b></div>
      <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${todo}" aria-valuenow="${done}"><i style="width:${pct}%"></i></div>
      <div class="count"><b>${n(done)}</b> of ${n(todo)} done · <b>${n(left)}</b> left${st.photos !== undefined ? ` · ${n(st.photos)} photos` : ''}${st.failed ? ` · <span style="color:var(--bad)">${n(st.failed)} failed</span>` : ''}</div>
      <div class="count">Running for ${dur(mins)}${rate ? ` · ${rate.toFixed(1)} a minute` : ''} · ${
        eta === null ? 'working out the time left…' : `<b>about ${dur(eta)} left</b>, done around ${at}`
      }</div>
    </div>`;
  };
  const going = s.runs.filter((r) => !r.finished_at);

  $('#app').innerHTML = `
    <h1>Import from Chrono Key and the Watch vault</h1>
    <p class="sub">Chrono Key stays the master until the switch-over. Its copy here is refreshed automatically; anything edited in masterapp is never overwritten.</p>
    <div class="stack">
      <div class="panel">
        <div class="stat">
          <div><b>${c.watches}</b><span>watches</span></div>
          <div><b>${c.ck_records}</b><span>on Chrono Key's product list</span></div>
          <div><b>${c.ck_details}</b><span>watch pages read (photos, € figures)</span></div>
          <div><b>${c.vault_records}</b><span>Watch vault records</span></div>
          <div><b>${c.photos}</b><span>photos stored</span></div>
          <div><b>${c.currency_not_stated}</b><span>purchases with no currency stated</span></div>
        </div>
        ${c.ck_errors ? `<p class="note" style="margin-top:12px">${c.ck_errors} Chrono Key page${c.ck_errors === 1 ? '' : 's'} could not be read — see the runs below.</p>` : ''}
        ${s.running ? `<p class="note info" style="margin-top:12px">Running now: ${esc(s.running.name)} (since ${esc(fmtWhen(s.running.startedAt))}). This page refreshes itself.</p>` : ''}
        ${going.map(progress).join('')}
      </div>
      ${
        admin && !s.configured.sync
          ? `<div class="panel"><p class="note info" style="margin:0">Sync is off (SYNC=off): masterapp is the master. Nothing is copied from Chrono Key or the vault — not by the timer, and not from this page.</p></div>`
          : admin
          ? `<div class="panel">
        <h2>1 · Chrono Key's product list (CSV)</h2>
        <p class="sub">Export the Product List from Chrono Key and upload it here. It brings in every purchase with all its columns. Upload a newer export any time — it updates what changed.</p>
        <form id="csv" class="row"><input type="file" name="file" accept=".csv,text/csv" required><button class="btn primary">Upload and import</button></form>
        <div id="csv-out"></div>
      </div>
      <div class="panel">
        <h2>2 · Live from Chrono Key</h2>
        ${s.configured.chronokey ? '' : '<p class="note">Not configured — set CHRONOKEY_USERNAME and CHRONOKEY_PASSWORD on the server.</p>'}
        <p class="sub">Each watch's own page brings its photos, Chrono Key's euro figures and the box / papers ticks. The first full read is about 1,700 pages at a polite pace — a couple of hours. It carries on where it stopped if interrupted.</p>
        <div class="row">
          <button class="btn" data-job="chronokey-list">Read the product list now</button>
          <button class="btn" data-job="chronokey-clients">Read the client list now</button>
          <button class="btn" data-job="chronokey-expenses">Read expenses now</button>
          <button class="btn gold" data-job="chronokey-new">Read new watch pages & photos</button>
          <button class="btn" data-job="chronokey-active">Re-read unsold & recent</button>
          <button class="btn" data-job="chronokey-full">Re-read every page</button>
        </div>
      </div>
      <div class="panel">
        <h2>3 · The Watch vault</h2>
        ${s.configured.vault ? '' : '<p class="note">Not configured — set VAULT_TOKEN (the worker’s WORKER_TOKEN) on the server.</p>'}
        <p class="sub">Brings in B2B, B2C and Chrono24 prices, the vault's photos, and watches only the vault holds.</p>
        <button class="btn gold" data-job="vault">Import the Watch vault</button>
      </div>`
          : ''
      }
      <div class="panel">
        <h2>Runs</h2>
        <div class="tscroll"><table class="list"><thead><tr><th>Started</th><th>What</th><th>Result</th><th>By</th></tr></thead><tbody>
        ${s.runs
          .map(
            (r) => `<tr><td>${esc(fmtWhen(r.started_at))}</td><td>${esc(runName(r))}</td>
            <td>${r.finished_at ? (r.ok ? '✓ ' : '<b style="color:var(--bad)">✗</b> ') : '… running · '}${statsLine(r.stats)}${
              r.error ? `<div class="err">${esc(r.error)}</div>` : ''
            }${(r.stats?.errors || []).length ? `<details><summary class="count">${r.stats.errors.length} problem(s)</summary><div class="count">${r.stats.errors.map(esc).join('<br>')}</div></details>` : ''}</td>
            <td>${esc(r.user_name || (r.started_by ? '' : 'automatic or command line'))}</td></tr>`
          )
          .join('') || '<tr><td colspan="4" class="count">Nothing has been imported yet.</td></tr>'}
        </tbody></table></div>
      </div>
    </div>`;

  $('#csv')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    btn.textContent = 'Importing…';
    try {
      const r = await api('/api/import/csv', { method: 'POST', body: new FormData(e.target) });
      const st = r.stats;
      flash(`Imported: ${st.created} new, ${st.updated} updated, ${st.unchanged} unchanged`);
      showImport();
    } catch (err) {
      $('#csv-out').innerHTML = `<p class="err">${esc(err.message)}</p>`;
      btn.disabled = false;
      btn.textContent = 'Upload and import';
    }
  });
  $$('[data-job]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (b.dataset.job === 'chronokey-full' && !confirm('Re-read every watch page on Chrono Key? About 1,700 pages — a couple of hours.')) return;
      try {
        await api('/api/import/run', { method: 'POST', body: { job: b.dataset.job } });
        flash('Started');
        setTimeout(showImport, 800);
      } catch (err) {
        flash(err.message, true);
      }
    })
  );
  if (s.running || s.runs.some((r) => !r.finished_at)) importTimer = setTimeout(showImport, 5000);
}

/* ── users ────────────────────────────────────────────────────────── */

async function showUsers() {
  if (!can('admin')) return (location.hash = '#/');
  const { users } = await api('/api/users');
  $('#app').innerHTML = `<h1>Users</h1>
    <p class="sub">Viewers read everything. Editors also add, edit and delete watches and photos. Admins also manage accounts and run imports.</p>
    <div class="stack">
      <div class="panel tscroll"><table class="list"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th><th></th></tr></thead><tbody>
      ${users
        .map(
          (u) => `<tr data-id="${u.id}"><td>${esc(u.name)}</td><td>${esc(u.email)}</td>
          <td><select data-role ${u.id === state.user.id ? 'disabled' : ''}>${['viewer', 'editor', 'admin']
            .map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`)
            .join('')}</select></td>
          <td>${esc(fmtWhen(u.last_login_at)) || '<span class="blank">never</span>'}</td>
          <td class="row"><button class="btn small" data-pw>Set password</button>${
            u.id === state.user.id ? '' : `<button class="btn small ${u.disabled ? '' : 'danger'}" data-dis>${u.disabled ? 'Enable' : 'Disable'}</button>`
          }</td></tr>`
        )
        .join('')}</tbody></table></div>
      <form class="panel" id="adduser"><h2>Add a user</h2><div class="form-grid">
        <label>Name<input type="text" name="name"></label>
        <label>Email<input type="email" name="email" required></label>
        <label>Role<select name="role"><option>viewer</option><option selected>editor</option><option>admin</option></select></label>
        <label>Password<input type="password" name="password" minlength="10" required placeholder="At least 10 characters"></label>
      </div><div class="err" id="u-err"></div><button class="btn primary" style="margin-top:10px">Add user</button></form>
    </div>`;
  const patch = async (id, body) => {
    try {
      await api(`/api/users/${id}`, { method: 'PATCH', body });
      flash('Saved');
      showUsers();
    } catch (err) {
      flash(err.message, true);
    }
  };
  $$('tr[data-id]').forEach((tr) => {
    const id = tr.dataset.id;
    $('[data-role]', tr)?.addEventListener('change', (e) => patch(id, { role: e.target.value }));
    $('[data-pw]', tr)?.addEventListener('click', () => {
      const pw = prompt('New password (at least 10 characters):');
      if (pw) patch(id, { password: pw });
    });
    $('[data-dis]', tr)?.addEventListener('click', (e) => patch(id, { disabled: e.target.textContent === 'Disable' }));
  });
  $('#adduser').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      await api('/api/users', { method: 'POST', body: fd });
      flash(`Added ${fd.email}`);
      showUsers();
    } catch (err) {
      $('#u-err').textContent = err.message;
    }
  });
}

/* ── start ────────────────────────────────────────────────────────── */

api('/api/me')
  .then((r) => (r.user ? signedIn(r.user) : showLogin()))
  .catch(() => showLogin());
