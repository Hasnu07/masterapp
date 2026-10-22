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

const state = { user: null, meta: null, list: { q: '', status: '', location: '', brand: '', sort: 'newest', deleted: false } };

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
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.nav === (page || 'inventory')));
  window.scrollTo(0, 0);
  if (!page) return showInventory();
  if (page === 'watch' && id) return showWatch(Number(id));
  if (page === 'new') return showNew();
  if (page === 'import') return showImport();
  if (page === 'users') return showUsers();
  location.hash = '#/';
}
window.addEventListener('hashchange', route);

/* ── sign-in ──────────────────────────────────────────────────────── */

function showLogin() {
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
  current = { w, selected: current?.w?.id === w.id ? current.selected : 0, editing: keepEdit && current?.editing };
  renderWatch();
  loadSide(w.id);
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
      </div>
      <div class="row">
        ${editor && !current.editing ? '<button class="btn primary" id="edit">Edit</button>' : ''}
        ${can('editor') ? (w.deleted_at ? '<button class="btn" id="restore">Restore</button>' : '<button class="btn danger" id="del">Delete</button>') : ''}
      </div>
    </div>
    ${w.deleted_at ? `<p class="note">Deleted ${esc(fmtWhen(w.deleted_at))}. It stays deleted even when Chrono Key still lists it; restore it to bring it back.</p>` : ''}
    <div class="watch-layout">
      <div class="stack">
        <div class="panel gallery" id="gallery"></div>
        <div class="panel" id="related" hidden></div>
        <div class="panel"><h3>Chrono Key and the Watch vault</h3><div id="sources"></div></div>
      </div>
      <div class="stack">
        <form class="panel" id="details"></form>
        <div class="panel"><h3>History</h3><ul class="events" id="events"><li class="count">Loading…</li></ul></div>
      </div>
    </div>`;

  renderGallery();
  renderDetails(groups);
  renderSources();
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
  const [ev, rel] = await Promise.all([
    api(`/api/watches/${id}/events`).catch(() => ({ events: [] })),
    api(`/api/watches/${id}/related`).catch(() => ({ related: [] })),
  ]);
  if (current?.w.id !== id) return;
  const label = (k) => state.meta.fields.find((f) => f.key === k)?.label || k;
  const show = (v) => (v === null || v === '' || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const words = {
    create: 'Added',
    update: 'Edited',
    sync: 'Updated from',
    delete: 'Deleted',
    restore: 'Restored',
    photo_add: 'Photos added',
    photo_remove: 'Photo removed',
    photo_order: 'Photos reordered',
    unlock: 'Handed back to Chrono Key',
  };
  const src = { chronokey: 'Chrono Key', vault: 'the Watch vault', masterapp: 'masterapp', user: '' };
  $('#events').innerHTML =
    ev.events
      .map((e) => {
        const who = e.source === 'user' ? e.user_name || e.user_email || 'someone' : src[e.source] || e.source;
        let ch = '';
        if (e.action === 'update' || e.action === 'sync') {
          ch = Object.entries(e.changes)
            .map(([k, [a, b]]) => `${esc(label(k))}: ${esc(show(a))} → ${esc(show(b))}`)
            .join('<br>');
        } else if (e.action === 'unlock') {
          ch = esc(label(e.changes.field));
          if ('cleared' in e.changes) ch += ` — Chrono Key has none, so ${esc(show(e.changes.cleared))} was cleared`;
        } else if (e.action === 'photo_add') ch = `${e.changes.count} photo${e.changes.count === 1 ? '' : 's'}`;
        else if (e.action === 'photo_remove' && e.changes.placeholder) ch = "Chrono Key's 'no image' graphic, not a photo";
        else if (e.action === 'photo_remove' && e.changes.duplicates) {
          const n = e.changes.photos.length;
          ch = `${n} photo${n === 1 ? '' : 's'} repeating another of this watch's photos`;
        }
        return `<li><b>${esc(words[e.action] || e.action)}</b> ${e.action === 'sync' ? '' : 'by'} ${esc(who)}
          <span class="when">· ${esc(fmtWhen(e.at))}</span>${ch ? `<div class="ch">${ch}</div>` : ''}</li>`;
      })
      .join('') || '<li class="count">Nothing yet.</li>';

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

function renderSources() {
  const { w } = current;
  const box = $('#sources');
  const parts = [];
  for (const ck of w.sources.chronokey) {
    const sections = Object.entries(ck.sections || {})
      .map(
        ([name, fields]) =>
          `<div style="margin-top:8px"><b style="font-size:13px">${esc(name)}</b><div class="kv">${Object.entries(fields)
            .map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`)
            .join('')}</div></div>`
      )
      .join('');
    const tags = Object.entries(ck.tags || {})
      .map(([k, v]) => `${v ? '✓' : '✗'} ${esc(k)}`)
      .join(' · ');
    parts.push(`<details class="src"><summary>Chrono Key's page${ck.ck_id ? ` (id ${ck.ck_id})` : ''}</summary>
      <p class="count">Read ${esc(fmtWhen(ck.fetched_at)) || 'not yet'}. Prices on this page are labelled £ by Chrono Key and are euros.</p>
      ${ck.currencyNote ? `<p><b>Note:</b> ${esc(ck.currencyNote)}</p>` : ''}${tags ? `<p>${tags}</p>` : ''}${sections || '<p class="count">The page has not been read yet — only the product list.</p>'}</details>`);
  }
  for (const v of w.sources.vault) {
    const rows = Object.entries(v.data || {})
      .filter(([, val]) => val !== '' && val !== null && !(Array.isArray(val) && !val.length))
      .map(([k, val]) => `<div>${esc(k)}</div><div>${esc(typeof val === 'object' ? JSON.stringify(val) : val)}</div>`)
      .join('');
    parts.push(`<details class="src"><summary>Watch vault record (${esc(v.list)})</summary>
      <p class="count">Read ${esc(fmtWhen(v.fetched_at))}.</p><div class="kv">${rows}</div></details>`);
  }
  box.innerHTML = parts.join('<div style="height:8px"></div>') || '<p class="count">Added in masterapp — neither system holds it.</p>';
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
      'chronokey/details-new': 'Watch pages & photos — new',
      'chronokey/details-active': 'Watch pages & photos — unsold and recent',
      'chronokey/details-full': 'Watch pages & photos — everything',
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
        admin
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
          <button class="btn gold" data-job="chronokey-new">Read new watch pages & photos</button>
          <button class="btn" data-job="chronokey-active">Re-read unsold & recent</button>
          <button class="btn" data-job="chronokey-full">Re-read every page</button>
        </div>
      </div>
      <div class="panel">
        <h2>3 · The Watch vault</h2>
        ${s.configured.vault ? '' : '<p class="note">Not configured — set VAULT_TOKEN (the worker’s WORKER_TOKEN) on the server.</p>'}
        <p class="sub">Brings in B2B and B2C prices, the vault's photos, and watches only the vault holds.</p>
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
