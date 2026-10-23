/*
 * Logistics in the masterapp console: the logistics app's tabs (shipments,
 * incomings, the stock in each place, sales waiting for delivery, trips,
 * accessories, polish, costs …), every record readable and editable, and the
 * "right now" line, history and costs on each watch's page.
 *
 * Loaded after app.js, whose helpers it uses ($, esc, api, flash, can,
 * money, fmtDate, fmtWhen, state, current). Every value is escaped: these
 * records are typed by people across the business and by its couriers'
 * systems.
 */
'use strict';

const lgState = { q: '', kind: '', deleted: false };
/* Each logistics page drawn bumps this: an answer for a page no longer shown is dropped, not drawn over the new one. */
let lgPage = 0;

const LG_TONE = [
  [/^(delivered|done|paid|settled|back|current|arrived)$/i, 'lg-good'],
  [/(customs|pending|open|waiting|to give|to collect|at polish|not paid|consignment|checked out)/i, 'lg-warn'],
  [/(transit|shipped|picked|booked|moving|out|in_progress|planned)/i, 'lg-blue'],
  [/(cancel|problem|exception|lost)/i, 'lg-bad'],
];
const lgChip = (s) => {
  if (!s) return '';
  const tone = LG_TONE.find(([re]) => re.test(s))?.[1] || 'lg-muted';
  return `<span class="chip ${tone}">${esc(String(s).replace(/_/g, ' '))}</span>`;
};

const lgKinds = () => state.meta?.logistics?.kinds || [];
const lgGroups = () => state.meta?.logistics?.groups || [];
const lgKind = (key) => lgKinds().find((k) => k.key === key) || { key, label: key, group: 'log', fields: [] };
const lgGroupLabel = (key) => lgGroups().find((g) => g.key === key)?.label || 'Logistics';
const humanKey = (k) => String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/* A moment the app keeps as milliseconds or as a day. */
function lgWhen(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number' || /^\d{10,13}$/.test(String(v))) return fmtWhen(Number(v));
  if (/^\d{4}-\d{2}-\d{2}/.test(String(v))) return fmtDate(v);
  return String(v);
}

/* ── values, whatever shape the logistics app gave them ──────────── */

const isFile = (v) => typeof v === 'string' && /^lgfile:\d+$/.test(v);
const fileUrl = (v, thumb) => `/api/logistics/files/${v.slice(7)}${thumb ? '?thumb=1' : ''}`;
const TIME_KEY = /(^ts$|At$|^date$|Date$|^eta$)/;

function lgValue(v, key = '', depth = 0) {
  if (v === null || v === undefined || v === '') return '<span class="blank">—</span>';
  if (isFile(v)) return `<a href="${fileUrl(v)}" target="_blank" rel="noopener"><img class="lg-pic1" src="${fileUrl(v, true)}" alt=""></a>`;
  if (v === 'lgfile:unreadable') return '<span class="blank">a picture that could not be read</span>';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (TIME_KEY.test(key) && (typeof v === 'number' || /^\d{4}-\d{2}-\d{2}/.test(String(v)) || /^\d{10,13}$/.test(String(v)))) return esc(lgWhen(v));
  if (typeof v === 'number') return esc(v.toLocaleString('en-GB', { maximumFractionDigits: 2 }));
  if (typeof v === 'string') {
    if (/^https?:\/\//i.test(v)) return `<a href="${esc(v)}" target="_blank" rel="noopener noreferrer">${esc(v.length > 60 ? `${v.slice(0, 60)}…` : v)}</a>`;
    return esc(v).replace(/\n/g, '<br>');
  }
  if (Array.isArray(v)) {
    if (!v.length) return '<span class="blank">none</span>';
    if (v.every((x) => isFile(x) || x === 'lgfile:unreadable')) {
      return `<div class="lg-pics">${v.filter(isFile).map((x) => `<a href="${fileUrl(x)}" target="_blank" rel="noopener"><img src="${fileUrl(x, true)}" alt="" loading="lazy"></a>`).join('')}</div>`;
    }
    if (v.every((x) => x === null || typeof x !== 'object')) return v.map((x) => lgValue(x, key, depth + 1)).join(', ');
    if (depth > 2) return `<span class="blank">${v.length} entries</span>`;
    return `<div class="lg-sub">${v.map((x) => `<div class="lg-entry">${lgValue(x, key, depth + 1)}</div>`).join('')}</div>`;
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v).filter(([, x]) => x !== null && x !== undefined && x !== '' && !(Array.isArray(x) && !x.length));
    if (!entries.length) return '<span class="blank">—</span>';
    if (depth > 3) return '<span class="blank">(details)</span>';
    return `<dl class="fields lg-dl">${entries.map(([k, x]) => `<dt>${esc(humanKey(k))}</dt><dd>${lgValue(x, k, depth + 1)}</dd>`).join('')}</dl>`;
  }
  return esc(v);
}

/* A typed field, the way a person reads it. */
function lgShow(f, d, extra = {}) {
  const v = d[f.key];
  switch (f.type) {
    case 'money':
      return v === null || v === undefined || v === '' ? '' : money(v, f.fixedCurrency || (f.currency ? d[f.currency] || '' : null));
    case 'date':
    case 'when':
      return esc(lgWhen(v));
    case 'bool':
      return v === true ? 'Yes' : v === false ? 'No' : '';
    case 'enum':
      return f.key === 'status' || f.key === 'paymentStatus' ? lgChip(v) : esc(String(v ?? '').replace(/_/g, ' '));
    case 'client':
      return esc(extra.clients?.[f.key] || (v ? `client ${v}` : ''));
    case 'stock':
      return lgStockLinks(String(v ?? ''), extra.watches || []);
    case 'longtext':
      return esc(v ?? '').replace(/\n/g, '<br>');
    default:
      return v !== null && typeof v === 'object' ? lgValue(v, f.key) : esc(v ?? '');
  }
}

/* Stock numbers, each a link to our watch when we hold it. */
function lgStockLinks(text, watches) {
  const parts = String(text || '').split(/[,\n;]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return '';
  return parts
    .map((p) => {
      const w = watches.find((x) => x.stock_no.toLowerCase() === p.replace(/^#/, '').toLowerCase());
      return w ? `<a href="#/watch/${w.id}"><b>#${esc(w.stock_no)}</b></a>` : `<b>#${esc(p.replace(/^#/, ''))}</b>`;
    })
    .join(' ');
}

const stockTags = (nos) => (nos || []).map((s) => `<span class="lg-stock">#${esc(s)}</span>`).join(' ');

/*
 * Logistics is one entry in the menu. Its own tabs run across the top of
 * every logistics page — Overview first — and a tab's lists sit in a row
 * under them, so the menu is not a column of a dozen links.
 */
/* On a phone the tabs scroll sideways: the one open is brought into view. */
const lgTabIntoView = () => $('.lg-tabs a.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });

function lgHeader(active, note = '') {
  setTimeout(lgTabIntoView);
  return `<div class="lg-head"><h1>Logistics</h1>${note ? `<span class="count" style="margin:0">${note}</span>` : ''}</div>
    <div class="lg-tabs" role="navigation" aria-label="Logistics">${lgGroups()
      .map((g) => `<a href="#/logistics${g.key === 'overview' ? '' : `/${esc(g.key)}`}" class="${g.key === active ? 'on' : ''}"${g.key === active ? ' aria-current="page"' : ''}>${esc(g.label)}</a>`)
      .join('')}</div>`;
}

/* ── a tab: one group's records ─────────────────────────────────── */

let lgSeq = 0;
let lgShown = [];
async function showLogistics(group) {
  if (!group || group === 'overview') return showLogisticsOverview();
  lgPage += 1;
  if (!lgGroups().some((g) => g.key === group)) {
    location.hash = '#/logistics';
    return;
  }
  if (lgState.group !== group) Object.assign(lgState, { group, kind: '', q: '' });
  $('#app').innerHTML = `
    ${lgHeader(group)}
    <div class="lg-subtabs" id="lg-kinds"></div>
    <div class="lg-toolbar">
      <input class="q" type="search" id="lgq" placeholder="Stock number, name, tracking, anything in the record…" value="${esc(lgState.q)}">
      <label class="count" style="cursor:pointer;margin:0;white-space:nowrap"><input type="checkbox" id="lgdel" ${lgState.deleted ? 'checked' : ''}> Show deleted</label>
      ${can('editor') ? '<button class="btn gold" id="lg-add" style="white-space:nowrap">+ Add</button>' : ''}
    </div>
    <div class="count" id="lg-count"></div>
    <div class="panel tscroll" style="padding:0"><table class="list lg"><thead><tr>
      <th>Stock</th><th>What</th><th>Status</th><th>When</th><th>List</th>
    </tr></thead><tbody id="lg-rows"></tbody></table></div>
    <div class="row" style="justify-content:center;margin-top:18px"><button class="btn hide" id="lg-more">Show more</button></div>`;
  let timer;
  $('#lgq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      lgState.q = e.target.value;
      loadLogistics();
    }, 220);
  });
  $('#lgdel').addEventListener('change', (e) => {
    lgState.deleted = e.target.checked;
    loadLogistics();
  });
  $('#lg-more').addEventListener('click', () => loadLogistics(true));
  $('#lg-add')?.addEventListener('click', () => (location.hash = `#/lg-new/${lgAddKind()}`));
  $('#lg-rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('a')) location.hash = `#/lg/${tr.dataset.id}`;
  });
  loadLogistics();
}

/* "+ Add" adds to the list picked in the row of lists, else to the tab's first. */
const lgAddKind = () => lgState.kind || lgKinds().find((k) => k.group === lgState.group && k.key !== 'vaultTracking')?.key || '';

async function loadLogistics(more = false) {
  const seq = ++lgSeq;
  // A new search starts a new list: "Show more" waits for it, so it never adds the old list's next page to it.
  if (!more) $('#lg-more')?.classList.add('hide');
  const p = new URLSearchParams({ group: lgState.group, kind: lgState.kind, q: lgState.q, limit: 100, offset: more ? lgShown.length : 0 });
  if (lgState.deleted) p.set('deleted', '1');
  let r;
  try {
    r = await api(`/api/logistics/items?${p}`);
  } catch (err) {
    return flash(err.message, true);
  }
  if (seq !== lgSeq || !$('#lg-rows')) return;
  // Records the sync added since the first page push the rest down: a row already shown is not shown twice.
  const had = new Set(lgShown.map((i) => i.id));
  lgShown = more ? [...lgShown, ...r.items.filter((i) => !had.has(i.id))] : r.items;
  // The lists in the logistics app's own order (London before Dubai), not the alphabet's.
  const order = (key) => {
    const i = lgKinds().findIndex((k) => k.key === key);
    return i < 0 ? 999 : i;
  };
  r.kinds.sort((a, b) => order(a.kind) - order(b.kind));
  const all = r.kinds.reduce((a, k) => a + k.n, 0);
  const add = $('#lg-add');
  if (add) add.textContent = `+ Add to ${lgKind(lgAddKind()).label}`;
  $('#lg-kinds').innerHTML =
    `<button class="pill ${lgState.kind ? '' : 'on'}" data-k="">All ${esc(lgGroupLabel(lgState.group).toLowerCase())}<b>${all}</b></button>` +
    r.kinds.map((k) => `<button class="pill ${lgState.kind === k.kind ? 'on' : ''}" data-k="${esc(k.kind)}">${esc(k.label)}<b>${k.n}</b></button>`).join('') +
    (lgState.kind && !r.kinds.some((k) => k.kind === lgState.kind) ? `<button class="pill on" data-k="${esc(lgState.kind)}">${esc(lgKind(lgState.kind).label)}<b>0</b></button>` : '');
  $$('#lg-kinds .pill').forEach((b) =>
    b.addEventListener('click', () => {
      lgState.kind = b.dataset.k;
      loadLogistics();
    })
  );
  $('#lg-count').textContent = `${lgShown.length} of ${r.total} record${r.total === 1 ? '' : 's'}${lgState.deleted ? ' (deleted)' : ''}`;
  $('#lg-rows').innerHTML =
    lgShown
      .map(
        (i) => `<tr data-id="${i.id}">
          <td style="white-space:nowrap">${stockTags(i.stock_nos) || '<span class="blank">—</span>'}</td>
          <td><a href="#/lg/${i.id}"><b>${esc(i.summary.title)}</b></a>${i.summary.sub ? `<div class="count" style="margin:2px 0 0">${esc(i.summary.sub)}</div>` : ''}
            ${i.summary.money ? `<div>${money(i.summary.money.amount, i.summary.money.currency || '')}</div>` : ''}</td>
          <td>${lgChip(i.summary.status)}${i.locked_fields.length ? ' <span class="lock" title="Edited here">✎</span>' : ''}${i.origin === 'manual' ? ' <span class="count" style="margin:0">added here</span>' : ''}</td>
          <td style="white-space:nowrap">${esc(i.summary.date ? fmtDate(i.summary.date) : '')}</td>
          <td class="count" style="margin:0">${esc(i.kind_label)}</td>
        </tr>`
      )
      .join('') || '<tr><td colspan="5" class="count">Nothing here yet.</td></tr>';
  $('#lg-more').classList.toggle('hide', lgShown.length >= r.total);
}

/* ── the overview ───────────────────────────────────────────────── */

async function showLogisticsOverview() {
  const seq = ++lgPage;
  const still = () => seq === lgPage && (location.hash === '#/logistics' || location.hash === '#/logistics/overview');
  $('#app').innerHTML = `${lgHeader('overview')}<p class="sub">Reading…</p>`;
  let o;
  try {
    o = await api('/api/logistics/overview');
  } catch (err) {
    if (still()) $('#app').innerHTML = `${lgHeader('overview')}<p class="err">${esc(err.message)}</p>`;
    return;
  }
  if (!still()) return;
  const row = (i, extra = '') => `<a class="lg-line" href="#/lg/${i.id}">
      <span>${stockTags(i.stock_nos)}</span>
      <span class="grow"><b>${esc(i.summary.title)}</b>${i.summary.sub ? ` <span class="count" style="margin:0">${esc(i.summary.sub)}</span>` : ''}</span>
      ${extra || lgChip(i.summary.status)}</a>`;
  const places = o.places.map((p) => `<div><b>${p.n}</b><span>${esc(p.label)}${p.consignment ? ` · ${p.consignment} on consignment` : ''}${p.polish ? ` · ${p.polish} at polish` : ''}${p.need_polish ? ` · ${p.need_polish} need polish` : ''}</span></div>`).join('');
  const change = (e) => {
    const keys = Object.keys(e.changes || {}).filter((k) => !['back', 'gone'].includes(k));
    const words =
      e.action === 'delete' ? 'removed' : e.action === 'restore' ? 'back' : e.action === 'create' ? 'added' : keys.slice(0, 3).map((k) => {
        const [a, b] = e.changes[k] || [];
        const short = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? '…' : String(v).slice(0, 40));
        return `${humanKey(k)}: ${short(a)} → ${short(b)}`;
      }).join('; ');
    return `<li><time>${esc(fmtWhen(e.at))}</time><div><a href="#/lg/${e.item.id}">${esc(e.item.summary.title)}</a> ${stockTags(e.item.stock_nos)}
      <div class="d">${esc(words)} · ${esc(e.source === 'user' ? e.user_name || 'someone here' : 'the logistics app')}</div></div></li>`;
  };
  $('#app').innerHTML = `
    ${lgHeader('overview', o.as_of ? `the logistics app as of ${esc(fmtWhen(o.as_of))}` : 'the logistics app has not been read yet')}
    <div class="stat" style="margin-bottom:16px">
      <div><b>${o.shipments.length}</b><span>shipments on their way</span></div>
      <div><b>${o.ready.length}</b><span>sold, waiting for delivery</span></div>
      <div><b>${o.incoming.length}</b><span>watches coming in</span></div>
      ${places}
    </div>
    <div class="watch-layout">
      <div class="stack">
        <div class="panel"><h3>Shipments on their way</h3>${o.shipments.map((i) => row(i)).join('') || '<p class="count" style="margin:0">None.</p>'}</div>
        <div class="panel"><h3>Sold, waiting for delivery</h3>${o.ready.map((i) => row(i)).join('') || '<p class="count" style="margin:0">None.</p>'}</div>
        <div class="panel"><h3>Coming in</h3>${o.incoming.map((i) => row(i)).join('') || '<p class="count" style="margin:0">None.</p>'}</div>
      </div>
      <div class="stack">
        <div class="panel"><h3>Latest changes</h3><ul class="lg-tl">${o.recent.map(change).join('') || '<li class="count">Nothing yet.</li>'}</ul></div>
      </div>
    </div>`;
}

/* ── one record ─────────────────────────────────────────────────── */

async function showLogisticsItem(id, { editing = false } = {}) {
  const seq = ++lgPage;
  const still = () => seq === lgPage && location.hash === `#/lg/${id}`;
  let it;
  let events = [];
  try {
    [it, { events }] = await Promise.all([api(`/api/logistics/items/${id}`), api(`/api/logistics/items/${id}/events`)]);
  } catch (err) {
    if (still()) $('#app').innerHTML = `<p class="err">${esc(err.message)}</p><a href="#/logistics">Back to logistics</a>`;
    return;
  }
  if (!still()) return;
  const k = lgKind(it.kind);
  const editor = can('editor') && !it.deleted_at;
  const locked = new Set(it.locked_fields || []);
  const lockMark = (key) =>
    locked.has(key)
      ? `<span class="lock" title="Edited in masterapp — the copy from the logistics app will not overwrite it">✎ edited here${
          can('editor') ? ` · <a href="#" data-unlock="${esc(key)}">use the logistics app’s</a>` : ''
        }</span>`
      : '';
  const typedKeys = new Set(k.fields.map((f) => f.key));
  // The currency of an amount shows with the amount.
  const withAmount = new Set(k.fields.filter((f) => f.type === 'money' && f.currency).map((f) => f.currency));
  const rest = Object.entries(it.data).filter(([key]) => !typedKeys.has(key) && key !== 'id');
  const scalars = rest.filter(([, v]) => v === null || typeof v !== 'object');
  // A list or a set of details with nothing in it says nothing: not shown.
  const nested = rest.filter(([, v]) => v !== null && typeof v === 'object' && (Array.isArray(v) ? v.length : Object.values(v).some((x) => x !== null && x !== '' && x !== undefined)));
  const extra = { clients: it.clients, watches: it.watches };

  const details = editing
    ? `<form class="panel" id="lg-form"><h3>${esc(k.label)}</h3>
        ${it.origin !== 'manual' ? '<p class="note info" style="margin-top:0">Until the switch-over the logistics app is the master. A field you change here is kept as you set it: the next copy leaves it alone.</p>' : ''}
        ${lgForm(k.fields, it.data)}
        ${
          scalars.length
            ? `<details style="margin-top:12px"><summary class="count" style="cursor:pointer">More fields (${scalars.length})</summary><div class="form-grid" style="margin-top:8px">${scalars
                .map(([key, v]) => `<label>${esc(humanKey(key))}${typeof v === 'boolean' ? `<select name="x:${esc(key)}"><option value="true"${v ? ' selected' : ''}>Yes</option><option value="false"${v ? '' : ' selected'}>No</option></select>` : `<input type="text" name="x:${esc(key)}" value="${esc(v ?? '')}">`}</label>`)
                .join('')}</div></details>`
            : ''
        }
        <div class="err" id="lg-err"></div>
        <div class="sticky-save"><button class="btn primary">Save changes</button><button type="button" class="btn" id="lg-cancel">Cancel</button></div></form>`
    : `<div class="panel"><h3>${esc(k.label)}</h3><dl class="fields">${
        k.fields
          .filter((f) => !withAmount.has(f.key))
          // An amount's currency shows with it — and so does its lock, when the currency was edited here.
          .map((f) => `<dt>${esc(f.label)}</dt><dd>${lgShow(f, it.data, extra) || '<span class="blank">—</span>'}${lockMark(f.key)}${f.type === 'money' && f.currency ? lockMark(f.currency) : ''}</dd>`)
          .join('') +
        scalars.map(([key, v]) => `<dt>${esc(humanKey(key))}</dt><dd>${lgValue(v, key)}${lockMark(key)}</dd>`).join('')
      }</dl></div>`;

  $('#app').innerHTML = `
    ${lgHeader(k.group)}
    <div class="watch-head">
      <div>
        <a href="#/logistics/${esc(k.group)}" class="count" style="text-decoration:none">← ${esc(lgGroupLabel(k.group))} · ${esc(k.label)}</a>
        <h2 class="lg-title">${esc(it.summary.title)}</h2>
        <div class="row">${lgStockLinks(it.stock_nos.join(', '), it.watches)} ${it.deleted_at ? '<span class="chip deleted">deleted</span>' : lgChip(it.summary.status)}
          <span class="count" style="margin:0">${esc(k.label)} · ${it.origin === 'manual' ? 'added in masterapp' : 'from the logistics app'}</span></div>
        ${it.summary.sub ? `<p class="desc">${esc(it.summary.sub)}</p>` : ''}
      </div>
      <div class="row">
        ${editor && !editing ? '<button class="btn primary" id="lg-edit">Edit</button>' : ''}
        ${can('editor') ? (it.deleted_at ? '<button class="btn" id="lg-restore">Restore</button>' : '<button class="btn danger" id="lg-del">Delete</button>') : ''}
      </div>
    </div>
    ${
      it.deleted_at
        ? `<p class="note">Deleted ${esc(fmtWhen(it.deleted_at))}. ${
            it.origin === 'logistics' ? 'If the logistics app removed it, it comes back by itself when the app lists it again; restore it to keep it regardless.' : 'Restore it to bring it back.'
          }</p>`
        : ''
    }
    <div class="watch-layout">
      <div class="stack">
        ${details}
        ${it.watches.length ? `<div class="panel"><h3>Watches</h3>${it.watches.map((w) => `<div class="row" style="padding:4px 0"><a href="#/watch/${w.id}"><b>#${esc(w.stock_no)}</b></a> ${esc([w.brand, w.model, w.reference].filter(Boolean).join(' '))}</div>`).join('')}</div>` : ''}
      </div>
      <div class="stack">
        ${nested.map(([key, v]) => `<div class="panel"><h3>${esc(humanKey(key))}</h3>${lgValue(v, key)}${lockMark(key)}</div>`).join('')}
        <div class="panel"><h3>History</h3><ul class="lg-tl">${
          events
            .map((e) => {
              const keys = Object.keys(e.changes || {});
              const what =
                e.action === 'create' ? (e.source === 'user' ? 'Added here' : 'Copied from the logistics app') : e.action === 'delete' ? 'Deleted' : e.action === 'restore' ? 'Restored' : e.action === 'unlock' ? `Handed back to the logistics app: ${keys.map(humanKey).join(', ')}` : '';
              const changes =
                ['update', 'sync', 'unlock'].includes(e.action) && keys.length
                  ? keys
                      .slice(0, 8)
                      .map((key) => {
                        const pair = Array.isArray(e.changes[key]) ? e.changes[key] : [null, e.changes[key]];
                        const short = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? '…' : String(v).slice(0, 60));
                        return `<div>${esc(humanKey(key))}: <span class="blank">${esc(short(pair[0]))}</span> → ${esc(short(pair[1]))}</div>`;
                      })
                      .join('')
                  : '';
              return `<li><time>${esc(fmtWhen(e.at))}</time><div>${esc(what)}${changes}<div class="d">${esc(e.source === 'user' ? e.user_name || 'someone here' : 'the logistics app')}</div></div></li>`;
            })
            .join('') || '<li class="count">Nothing yet.</li>'
        }</ul></div>
      </div>
    </div>`;

  $('#lg-edit')?.addEventListener('click', () => showLogisticsItem(id, { editing: true }));
  $('#lg-cancel')?.addEventListener('click', () => showLogisticsItem(id));
  $('#lg-del')?.addEventListener('click', async () => {
    if (!confirm(`Delete “${it.summary.title}”? It can be restored later.`)) return;
    await api(`/api/logistics/items/${id}`, { method: 'DELETE' }).then(() => showLogisticsItem(id), (err) => flash(err.message, true));
  });
  $('#lg-restore')?.addEventListener('click', async () => {
    await api(`/api/logistics/items/${id}/restore`, { method: 'POST' }).then(() => showLogisticsItem(id), (err) => flash(err.message, true));
  });
  $$('[data-unlock]').forEach((a) =>
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!confirm('Hand this field back to the logistics app? Its value there comes back now.')) return;
      await api(`/api/logistics/items/${id}/unlock`, { method: 'POST', body: { field: a.dataset.unlock } }).then(
        () => showLogisticsItem(id),
        (err) => flash(err.message, true)
      );
    })
  );
  const form = $('#lg-form');
  if (form) {
    fillLogisticsClients(form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = lgRead(form, k.fields, it.data);
      for (const [key, v] of scalars) {
        const el = form.elements[`x:${key}`];
        if (!el) continue;
        const next = typeof v === 'boolean' ? el.value === 'true' : typeof v === 'number' && el.value.trim() !== '' && Number.isFinite(Number(el.value)) ? Number(el.value) : el.value;
        if (String(next) !== String(v ?? '')) patch[key] = next;
      }
      try {
        const r = Object.keys(patch).length ? await api(`/api/logistics/items/${id}`, { method: 'PATCH', body: patch }) : { changed: [] };
        flash(r.changed.length ? `Saved ${r.changed.length} change${r.changed.length === 1 ? '' : 's'}` : 'Nothing changed');
        showLogisticsItem(id);
      } catch (err) {
        $('#lg-err').textContent = err.message;
      }
    });
  }
}

/* ── forms ──────────────────────────────────────────────────────── */

function lgInput(f, d) {
  const v = d[f.key];
  const name = `name="${esc(f.key)}"`;
  switch (f.type) {
    case 'enum': {
      const opts = [...new Set(['', ...f.options, ...(v && !f.options.includes(v) ? [v] : [])])];
      return `<select ${name}>${opts.map((o) => `<option value="${esc(o)}"${o === (v ?? '') ? ' selected' : ''}>${esc(o ? o.replace(/_/g, ' ') : '—')}</option>`).join('')}</select>`;
    }
    case 'bool':
      return `<select ${name}><option value="false"${v ? '' : ' selected'}>No</option><option value="true"${v ? ' selected' : ''}>Yes</option></select>`;
    case 'date':
    case 'when': {
      const t = asDay(v);
      return `<input type="date" ${name} value="${esc(/^\d{4}-\d{2}-\d{2}$/.test(t) ? t : '')}">`;
    }
    case 'money':
    case 'number':
      return `<input type="text" inputmode="decimal" ${name} value="${v === null || v === undefined ? '' : esc(v)}">`;
    case 'currency':
      return `<input type="text" ${name} list="lg-currencies" maxlength="4" value="${esc(v ?? '')}" placeholder="Not stated">`;
    case 'client':
      return `<select ${name} data-client="${esc(v ?? '')}"><option value="${esc(v ?? '')}">${v ? 'Loading…' : '—'}</option></select>`;
    case 'longtext':
      return `<textarea ${name}>${esc(v ?? '')}</textarea>`;
    default:
      return `<input type="text" ${name} value="${esc(v ?? '')}">`;
  }
}

function lgForm(fields, d) {
  return `<div class="form-grid">${fields
    .map((f) => `<label class="${f.type === 'longtext' ? 'wide' : ''}">${esc(f.label)}${lgInput(f, d)}</label>`)
    .join('')}</div><datalist id="lg-currencies">${(state.meta.currencies || []).map((c) => `<option value="${esc(c)}">`).join('')}</datalist>`;
}

/* A day as this computer's calendar has it — not UTC's, which is yesterday in a Hong Kong or Dubai morning. */
function localDay(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/* The day a field holds, whichever way the app wrote it (milliseconds or a day). */
const asDay = (v) => (typeof v === 'number' || /^\d{10,13}$/.test(String(v ?? '')) ? localDay(Number(v)) : String(v ?? '').slice(0, 10));
/* Text as a form gives it back: the browser hands a textarea's line breaks back as \n, and trims nothing. */
const asText = (v) => (v === null || v === undefined ? '' : String(v)).replace(/\r\n?/g, '\n').trim();

/** Only the fields that differ from what is held, so an edit never resends — and re-locks — the rest. */
function lgRead(form, fields, d) {
  const patch = {};
  for (const f of fields) {
    const el = form.elements[f.key];
    if (!el) continue;
    const v = asText(el.value);
    const was = d[f.key];
    if (f.type === 'bool') {
      if ((v === 'true') !== Boolean(was)) patch[f.key] = v === 'true';
      continue;
    }
    if (f.type === 'date' || f.type === 'when') {
      if (v !== asDay(was)) patch[f.key] = v;
      continue;
    }
    if (v !== asText(was)) patch[f.key] = v;
  }
  return patch;
}

/* The logistics clients, asked for each time a form opens: one added a minute ago is there. */
async function fillLogisticsClients(form) {
  const sels = $$('select[data-client]', form);
  if (!sels.length) return;
  const clients = (await api('/api/logistics/clients').catch(() => ({ clients: [] }))).clients;
  for (const s of sels) {
    const v = s.dataset.client;
    s.innerHTML =
      '<option value="">—</option>' +
      clients.map((c) => `<option value="${esc(c.id)}"${c.id === v ? ' selected' : ''}>${esc(c.name || c.id)}${c.country ? ` (${esc(c.country)})` : ''}</option>`).join('') +
      (v && !clients.some((c) => c.id === v) ? `<option value="${esc(v)}" selected>client ${esc(v)}</option>` : '');
  }
}

function showNewLogisticsItem(kind) {
  const k = lgKind(kind);
  if (!can('editor') || !lgKinds().some((x) => x.key === kind)) return (location.hash = '#/logistics');
  lgPage += 1;
  const blank = {};
  for (const f of k.fields) if (f.type === 'date') blank[f.key] = localDay();
  $('#app').innerHTML = `
    ${lgHeader(k.group)}
    <a href="#/logistics/${esc(k.group)}" class="count" style="text-decoration:none">← ${esc(lgGroupLabel(k.group))}</a>
    <h2 class="lg-title">Add to ${esc(k.label)}</h2>
    <form class="panel" id="lg-new" style="max-width:860px">
      ${k.fields.length ? lgForm(k.fields, blank) : '<div class="form-grid"><label class="wide">Title<input type="text" name="title"></label><label class="wide">Notes<textarea name="notes"></textarea></label></div>'}
      <div class="err" id="lg-err"></div>
      <div class="row" style="margin-top:12px"><button class="btn primary">Add</button></div>
    </form>`;
  const form = $('#lg-new');
  fillLogisticsClients(form);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = k.fields.length ? k.fields : [{ key: 'title', type: 'text' }, { key: 'notes', type: 'longtext' }];
    const data = lgRead(form, fields, {});
    try {
      const { id } = await api('/api/logistics/items', { method: 'POST', body: { kind, data } });
      location.hash = `#/lg/${id}`;
    } catch (err) {
      $('#lg-err').textContent = err.message;
    }
  });
}

/* ── on a watch's page ──────────────────────────────────────────── */

const TONE_CLASS = { here: 'here', moving: 'moving', away: 'away', sold: 'sold' };

/** The "right now" line under the watch's status, and its logistics panel. */
function renderWatchLogistics() {
  const L = current?.logistics;
  const strip = $('#lg-now');
  const panel = $('#lg-panel');
  if (!strip || !panel) return;
  if (!L || L.error) {
    strip.innerHTML = '';
    panel.hidden = true;
    return;
  }
  const n = L.now;
  const asOf = L.as_of ? ` <span class="count" style="margin:0" title="When the logistics app was last read">as of ${esc(fmtWhen(L.as_of))}</span>` : '';
  strip.className = `lg-now ${TONE_CLASS[n.tone] || ''}`;
  strip.innerHTML = n.headline || n.overlays.length
    ? `<div><span class="count" style="margin:0">Right now</span> ${n.itemId ? `<a href="#/lg/${n.itemId}" class="h">${esc(n.headline || 'In the logistics app')}</a>` : `<span class="h">${esc(n.headline || '')}</span>`}${n.detail ? ` — ${esc(n.detail)}` : ''}${asOf}</div>
       ${n.overlays.length ? `<div class="lg-ov">${n.overlays.map((o) => (o.itemId ? `<a class="lg-tag ${esc(o.tone)}" href="#/lg/${o.itemId}">${esc(o.text)}</a>` : `<span class="lg-tag ${esc(o.tone)}">${esc(o.text)}</span>`)).join('')}</div>` : ''}`
    : `<span class="count" style="margin:0">The logistics app holds nothing for this watch.</span>${asOf}`;

  if (!L.items.length && !L.timeline.length) {
    panel.hidden = true;
    return;
  }
  const totals = Object.entries(L.costs.totals || {});
  const t = L.costs.total;
  panel.hidden = false;
  const records = L.items.length;
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  /*
   * What moving it cost, as one figure in the currency it was bought in (the
   * server converts at the converter's rates). Without a rate, each currency
   * shows on its own rather than a guessed total.
   */
  const figure = !L.costs.lines.length
    ? ''
    : t
      ? `<div class="figures" style="margin:0 0 4px"><div><span>Moving it cost</span><b>${money(t.amount, t.currency)}</b></div></div>
         <p class="count" style="margin:0 0 6px">${t.bought_in ? 'In the currency it was bought in' : 'In dollars — its purchase currency is not recorded'}${
           totals.length > 1 || totals[0]?.[0] !== t.currency ? `, converted at today’s ${esc(t.rates)} rates${t.stale ? ' (not fresh)' : ''}` : ''
         }${t.missing.length ? `; ${esc(t.missing.join(', '))} left out — no rate` : ''}.</p>`
      : `<div class="figures" style="margin:0 0 6px">${totals.map(([cur, n]) => `<div><span>Moving it, ${esc(cur)}</span><b>${money(n, cur === '?' ? '' : cur)}</b></div>`).join('')}</div>`;

  /* What it cost, History and Records: a row of buttons, each opening its own section, all closed until opened. */
  const sections = [
    L.costs.lines.length && {
      key: 'lg-cost',
      label: `What it cost — ${plural(L.costs.lines.length, 'line')}`,
      // Each currency's own total first — what the one figure above is made of.
      body: (t && totals.length > 1 ? `<p class="count" style="margin:0 0 6px">By currency: ${totals.map(([cur, n]) => money(n, cur === '?' ? '' : cur)).join(' · ')}</p>` : '') + L.costs.lines
        .map((c) => `<div class="sold-row"><span><a href="#/lg/${c.itemId}">${esc(c.source)}</a> · ${esc(c.title || '')}${c.detail ? ` <span class="count" style="margin:0">${esc(c.detail)}</span>` : ''}</span><span>${money(c.amount, c.currency || '')} <span class="count">${esc(fmtDate(c.date))}</span></span></div>`)
        .join(''),
    },
    {
      key: 'lg-history',
      label: `History — ${plural(L.timeline.length, 'event')}`,
      body: `<ul class="lg-tl">${
        L.timeline
          .slice(0, 40)
          .map((e) => `<li><time>${esc(e.at ? fmtDate(e.at) : '—')}</time><div><a href="#/lg/${e.itemId}">${esc(e.text)}</a>${e.detail ? `<div class="d">${esc(e.detail)}</div>` : ''}</div></li>`)
          .join('') || '<li class="count">Nothing yet.</li>'
      }</ul>${L.timeline.length > 40 ? `<p class="count">and ${L.timeline.length - 40} earlier</p>` : ''}`,
    },
    {
      key: 'lg-records',
      label: `Records — ${records}`,
      body: L.items.map((i) => `<a class="lg-line" href="#/lg/${i.id}"><span class="count" style="margin:0;min-width:110px">${esc(i.kind_label)}</span><span class="grow">${esc(i.summary.title)}</span>${lgChip(i.summary.status)}</a>`).join(''),
    },
  ].filter(Boolean);
  const isOpen = (key) => Boolean(current?.open?.[key]);

  panel.innerHTML = fold(
    'logistics',
    // No converter arrow in the heading: a click there opens and closes the panel.
    `Logistics <span class="fold-note" data-nofx>· ${plural(records, 'record')}${t ? ` · moving it ${money(t.amount, t.currency)}` : ''}</span>`,
    `${figure}
    <div class="lg-folds">${sections
      .map((s) => `<button type="button" class="lg-fold-btn" data-lgfold="${s.key}" aria-expanded="${isOpen(s.key)}">${esc(s.label)}</button>`)
      .join('')}</div>
    ${sections
      .filter((s) => isOpen(s.key))
      .map((s) => `<div class="lg-section"><h3>${esc(s.label.split(' — ')[0])}</h3>${s.body}</div>`)
      .join('')}`
  );
  $$('[data-lgfold]', panel).forEach((b) =>
    b.addEventListener('click', () => {
      (current.open ||= {})[b.dataset.lgfold] = !isOpen(b.dataset.lgfold);
      renderWatchLogistics();
    })
  );
}

/* Fetched with the rest of the watch's side panels, then again every minute while the page stays open. */
let lgWatchTimer = null;
async function loadWatchLogistics(id) {
  clearTimeout(lgWatchTimer);
  const onPage = () => state.user && location.hash === `#/watch/${id}` && current?.w.id === id;
  const L = await api(`/api/watches/${id}/logistics`).catch((err) => ({ error: err.message }));
  // Signed out meanwhile: the sign-in form is showing — not redrawn, and no more refreshes.
  if (!onPage()) return;
  current.logistics = L;
  renderWatchLogistics();
  lgWatchTimer = setTimeout(() => {
    if (onPage()) loadWatchLogistics(id);
  }, 60_000);
}
