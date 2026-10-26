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
  const words = String(s).replace(/_/g, ' ');
  return `<span class="chip ${tone}">${esc(words.charAt(0).toUpperCase() + words.slice(1))}</span>`;
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
  return dayWords(v);
}

/* A day as people read it — "20 Jun 2026" — from YYYY-MM-DD or day-first DD/MM/YYYY; anything else as it was typed. */
const DAY_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayWords(v) {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${Number(m[3])} ${DAY_MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${Number(m[1])} ${DAY_MONTHS[Number(m[2]) - 1] || m[2]} ${m[3]}`;
  return s;
}

/* ── values, whatever shape the logistics app gave them ──────────── */

const isFile = (v) => typeof v === 'string' && /^lgfile:\d+$/.test(v);
/*
 * A picture or PDF still on the logistics app's worker: shown through
 * masterapp, which copies it on first sight (the page may not load the
 * worker's address itself, and the worker goes when the logistics app does).
 */
const isWorkerFile = (v) => typeof v === 'string' && Boolean(state.meta?.logistics?.photoPrefix) && v.startsWith(state.meta.logistics.photoPrefix);
const fileUrl = (v, thumb) =>
  isWorkerFile(v)
    ? `/api/logistics/worker-file?u=${encodeURIComponent(v)}${thumb ? '&thumb=1' : ''}`
    : `/api/logistics/files/${v.slice(7)}${thumb ? '?thumb=1' : ''}`;
const isPicture = (v) => isFile(v) || isWorkerFile(v);
const picture = (v, cls = '') => `<a href="${esc(fileUrl(v))}" target="_blank" rel="noopener"><img${cls ? ` class="${cls}"` : ''} src="${esc(fileUrl(v, true))}" alt="" loading="lazy"></a>`;
const TIME_KEY = /(^ts$|At$|^date$|Date$|^eta$)/;

function lgValue(v, key = '', depth = 0) {
  if (v === null || v === undefined || v === '') return '<span class="blank">—</span>';
  if (isPicture(v)) return picture(v, 'lg-pic1');
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
    if (v.every((x) => isPicture(x) || x === 'lgfile:unreadable')) {
      return `<div class="lg-pics">${v.filter(isPicture).map((x) => picture(x)).join('')}</div>`;
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
  setTimeout(() => lgCountBadges(active));
  return `<div class="lg-head"><h1>Logistics</h1>${note ? `<span class="count" style="margin:0">${note}</span>` : ''}</div>
    <div class="lg-tabs" role="navigation" aria-label="Logistics">${lgGroups()
      .map(
        (g) =>
          `<a href="#/logistics${g.key === 'overview' ? '' : `/${esc(g.key)}`}" data-g="${esc(g.key)}" class="${g.key === active ? 'on' : ''}"${g.key === active ? ' aria-current="page"' : ''}>${lgTabLabel(g)}</a>`
      )
      .join('')}</div>`;
}

/*
 * The In Safe, Checked out and Hand carry tabs carry how many each holds, on
 * every logistics page — read again at most once a minute.
 */
const LG_COUNTED = {
  safe: { url: '/api/logistics/in-safe', n: (r) => r.watches.length, what: (n) => `${n} client watch${n === 1 ? '' : 'es'} in the safe` },
  checkout: { url: '/api/logistics/checked-out', n: (r) => r.watches.length, what: (n) => `${n} watch${n === 1 ? '' : 'es'} checked out` },
  handcarry: { url: '/api/logistics/hand-carry', n: (r) => r.plans.length, what: (n) => `${n} open hand-carry plan${n === 1 ? '' : 's'}` },
};
const lgCount = { safe: null, checkout: null, handcarry: null, at: 0 };
const lgTabLabel = (g) => {
  const n = lgCount[g.key];
  return `${esc(g.label)}${LG_COUNTED[g.key] && n ? ` <b class="lg-n" title="${esc(LG_COUNTED[g.key].what(n))}">${n}</b>` : ''}`;
};
function lgSetCount(key, n) {
  lgCount[key] = n;
  const a = $(`.lg-tabs a[data-g="${key}"]`);
  const g = lgGroups().find((x) => x.key === key);
  if (a && g) a.innerHTML = lgTabLabel(g);
}
/* The tab open now counts its own list as it reads it: only the others are asked for. */
function lgCountBadges(active) {
  if (Date.now() - lgCount.at < 60_000) return;
  lgCount.at = Date.now();
  for (const [key, c] of Object.entries(LG_COUNTED)) {
    if (key === active) continue;
    api(c.url)
      .then((r) => lgSetCount(key, c.n(r)))
      .catch(() => (lgCount.at = 0));
  }
}

/* ── a tab: one group's records ─────────────────────────────────── */

let lgSeq = 0;
let lgShown = [];
async function showLogistics(group) {
  if (!group || group === 'overview') return showLogisticsOverview();
  if (group === 'safe') return showLogisticsSafe();
  if (group === 'checkout') return showLogisticsCheckout();
  if (group === 'handcarry') return showLogisticsHandCarry();
  if (group === 'transactions') return showLogisticsTransactions();
  // The Accessories tab is the app's Accessories Management page; its lists (to collect, to give, settlements, swaps) are one link away.
  if (group === 'accessories') return showLogisticsAccessories();
  if (group === 'accessories-all') group = 'accessories';
  // The Clients tab shows each client's situation; its records, as lists, are one link away.
  if (group === 'contacts') return showLogisticsClients();
  if (group === 'contacts-all') group = 'contacts';
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

/* ── in the safe ────────────────────────────────────────────────── */

/*
 * The logistics app's In Safe page (asked 26 Oct 2026): the clients' watches
 * we hold — not our stock, never priced — each saying who it is for, and the
 * accessories we owe a client sitting in the safe. Cards or a list, searched
 * and sorted here (the safe holds tens, not thousands). A card opens its
 * record (edit, delete, history); our own watch of the same number is linked.
 */
const sf = { q: '', sort: 'new', view: 'cards', data: null };
try {
  sf.view = localStorage.getItem('masterapp.safeView') === 'list' ? 'list' : 'cards';
} catch {
  /* no storage: cards */
}

async function showLogisticsSafe() {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('safe')}
    <p class="sub" style="margin:0 0 12px">Clients’ watches we are holding — not our stock. Each one says who it is for.</p>
    <div class="lg-toolbar">
      <input class="q" type="search" id="sfq" placeholder="Stock number, reference, serial, brand, model, client…" value="${esc(sf.q)}">
      <select id="sfsort" aria-label="Order">
        <option value="new">Newest first</option>
        <option value="stockAsc">Stock number, low to high</option>
        <option value="stockDesc">Stock number, high to low</option>
      </select>
      <div class="sf-view" role="group" aria-label="View">
        <button type="button" class="pill" data-v="cards">Cards</button><button type="button" class="pill" data-v="list">List</button>
      </div>
    </div>
    <section class="panel sf-acc hide" id="sf-acc"></section>
    <div class="count" id="sf-count">Reading the safe…</div>
    <div id="sf-out"></div>`;
  $('#sfsort').value = sf.sort;
  let timer;
  $('#sfq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      sf.q = e.target.value;
      drawSafe();
    }, 150);
  });
  $('#sfsort').addEventListener('change', (e) => {
    sf.sort = e.target.value;
    drawSafe();
  });
  $$('.sf-view .pill').forEach((b) =>
    b.addEventListener('click', () => {
      sf.view = b.dataset.v;
      try {
        localStorage.setItem('masterapp.safeView', sf.view);
      } catch {
        /* remembered for this visit only */
      }
      drawSafe();
    })
  );
  lgOpenOnClick($('#sf-out'), $('#sf-acc'));
  let r;
  try {
    r = await api('/api/logistics/in-safe');
  } catch (err) {
    if (seq === lgPage && $('#sf-count')) $('#sf-count').textContent = `Could not read the safe: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#sf-out')) return;
  sf.data = r;
  lgSetCount('safe', r.watches.length);
  drawSafe();
}

/* A moment as this computer's day; a day the app wrote as a day (YYYY-MM-DD) stays that day, whatever the time zone. */
const sfDay = (iso) => (!iso ? '' : /^\d{4}-\d{2}-\d{2}$/.test(iso) ? dayWords(iso) : dayWords(localDay(new Date(iso).getTime())));
const sfNo = (s) => Number(String(s || '').replace(/\D/g, '')) || 0;
const sfMatch = (words, ...values) => {
  const blob = values.join(' ').toLowerCase();
  return words.every((w) => blob.includes(w));
};
const sfPic = (w) =>
  w.picture
    ? `<img loading="lazy" src="${esc(fileUrl(w.picture, true))}" alt="">`
    : w.watch?.photo_id
      ? `<img loading="lazy" src="/api/photos/${w.watch.photo_id}?thumb=1" alt="">`
      : '<span>No photo</span>';
/* What is worth knowing at a glance, in words: out with its owner, polish, consignment, what is missing. */
const sfTags = (w) =>
  [
    w.with_owner && `<span class="lg-tag warn">Out with its owner${w.with_owner === 'yes' ? '' : ` — ${esc(w.with_owner)}`}</span>`,
    w.polish && `<span class="lg-tag warn">At polish with ${esc(w.polish)}</span>`,
    !w.polish && w.need_polish && '<span class="lg-tag">Needs polish</span>',
    w.consignment && `<span class="lg-tag warn">On consignment with ${esc(w.consignment)}</span>`,
    w.accessories_missing && `<span class="lg-tag">Missing: ${esc(w.accessories_missing)}</span>`,
  ]
    .filter(Boolean)
    .join('');
const sfOurs = (w) => (w.watch ? `<a href="#/watch/${w.watch.id}">Our watch #${esc(w.watch.stock_no)}</a>` : '');
/*
 * A typed name, linked as far as it goes: to our client when the logistics
 * client of that name is one of ours (by its watches), else to that logistics
 * client's page; our client's own name beside it when it reads differently.
 */
function lgPerson(name, link, blank = 'not written') {
  if (!name) return esc(blank);
  if (link?.client_id) {
    const other = link.client_name && link.client_name.trim().toLowerCase() !== name.trim().toLowerCase();
    return `<a href="#/client/${link.client_id}">${esc(name)}</a>${other ? ` <span class="count" style="margin:0;font-weight:400">· our client ${esc(link.client_name)}</span>` : ''}`;
  }
  if (link?.lg_client_id) return `<a href="#/lg-client/${link.lg_client_id}" title="Their logistics page — not linked to one of our clients yet">${esc(name)}</a>`;
  return esc(name);
}
/* A card or a row opens its record; a link inside it goes where it says. */
function lgOpenOnClick(...boxes) {
  const open = (e) => {
    const at = e.target.closest('[data-id]');
    if (!at || e.target.closest('a')) return;
    if (e.type === 'keydown') {
      if (e.target !== at || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
    }
    location.hash = `#/lg/${at.dataset.id}`;
  };
  for (const box of boxes) {
    box.addEventListener('click', open);
    box.addEventListener('keydown', open);
  }
}

function drawSafe() {
  const r = sf.data;
  if (!r || !$('#sf-out')) return;
  $$('.sf-view .pill').forEach((b) => b.classList.toggle('on', b.dataset.v === sf.view));
  const words = sf.q.toLowerCase().split(/\s+/).filter(Boolean);
  const watches = r.watches
    .filter((w) => sfMatch(words, w.stock_no, w.brand, w.model, w.reference, w.serial, w.owner, w.owner_link?.client_name, w.where, w.accessories_present, w.accessories_missing, w.notes, w.watch_date))
    .sort((a, b) =>
      sf.sort === 'stockAsc'
        ? sfNo(a.stock_no) - sfNo(b.stock_no)
        : sf.sort === 'stockDesc'
          ? sfNo(b.stock_no) - sfNo(a.stock_no)
          : String(b.received_at || '').localeCompare(String(a.received_at || '')) || b.id - a.id
    );
  const acc = r.accessories.filter((a) => sfMatch(words, a.stock_no, a.about, a.items, a.for_client, a.notes));

  const box = $('#sf-acc');
  box.classList.toggle('hide', !acc.length);
  box.innerHTML = acc.length
    ? `<h2 class="sf-h">Accessories in the safe <span class="count">${acc.length}</span></h2>
       ${ovExplain('Things we owe a client, sitting in the safe.')}
       ${acc
         .map(
           (a) => `<div class="ov-row sf-row" data-id="${a.id}" tabindex="0" role="link">
             <div class="ov-row-main">
               <div>${a.stock_no ? `<span class="lg-stock">#${esc(a.stock_no)}</span> ` : ''}<b>${esc(a.items || 'Accessories')}</b></div>
               <div class="count" style="margin:2px 0 0">${[a.for_client && `For <b>${lgPerson(a.for_client, a.for_link)}</b>`, a.about && esc(a.about), a.notes && esc(a.notes), a.in_safe_at && `in the safe since ${esc(sfDay(a.in_safe_at))}`].filter(Boolean).join(' · ')}</div>
             </div>
             <div class="ov-row-side">${a.watch ? `<a href="#/watch/${a.watch.id}">Our watch</a>` : ''}</div>
           </div>`
         )
         .join('')}`
    : '';

  const n = watches.length;
  $('#sf-count').textContent = `${n} watch${n === 1 ? '' : 'es'}${words.length ? ` of ${r.watches.length}` : ''} in the safe${acc.length ? ` · ${acc.length} accessor${acc.length === 1 ? 'y' : 'ies'}` : ''}`;
  if (!n) {
    $('#sf-out').innerHTML = `<p class="sub">${words.length ? 'Nothing in the safe matches.' : 'The safe holds no client watches right now.'}</p>`;
    return;
  }
  if (sf.view === 'list') {
    $('#sf-out').innerHTML = `<div class="panel tscroll" style="padding:0"><table class="list lg"><thead><tr>
        <th>Stock</th><th>Watch</th><th>For</th><th>Received</th><th>Accessories</th><th>Notes</th>
      </tr></thead><tbody>${watches
        .map(
          (w) => `<tr data-id="${w.id}" tabindex="0">
            <td style="white-space:nowrap"><span class="lg-stock">#${esc(w.stock_no || '—')}</span></td>
            <td><a href="#/lg/${w.id}"><b>${esc([w.brand, w.model].filter(Boolean).join(' ') || 'Watch')}</b></a>
              <div class="count" style="margin:2px 0 0">${esc([w.reference && `Ref ${w.reference}`, w.serial && `Serial ${w.serial}`].filter(Boolean).join(' · '))}</div>
              ${sfTags(w) ? `<div class="lg-ov">${sfTags(w)}</div>` : ''}</td>
            <td><b>${lgPerson(w.owner, w.owner_link, '—')}</b></td>
            <td style="white-space:nowrap">${esc(sfDay(w.received_at))}</td>
            <td>${esc(w.accessories_present || '')}</td>
            <td>${esc(w.notes || '')}${w.watch ? `<div>${sfOurs(w)}</div>` : ''}</td>
          </tr>`
        )
        .join('')}</tbody></table></div>`;
    return;
  }
  $('#sf-out').innerHTML = `<div class="grid sf-grid">${watches
    .map(
      (w) => `<article class="tile sf-card" data-id="${w.id}" tabindex="0" role="link" aria-label="${esc(`#${w.stock_no} ${w.brand} ${w.model}, for ${w.owner || 'a client'}`)}">
        <div class="pic">${sfPic(w)}</div>
        <div class="body">
          <div class="m"><span class="lg-stock">#${esc(w.stock_no || '—')}</span>${w.brand ? ` <span>${esc(w.brand)}</span>` : ''}</div>
          <div class="t">${esc(w.model || w.brand || 'Watch')}</div>
          <div class="sf-for">For <b>${lgPerson(w.owner, w.owner_link)}</b></div>
          ${w.reference || w.watch_date ? `<div class="m">${esc([w.reference && `Ref ${w.reference}`, w.watch_date].filter(Boolean).join(' · '))}</div>` : ''}
          ${w.serial ? `<div class="m">Serial ${esc(w.serial)}</div>` : ''}
          <div class="m">${esc([w.received_at && `Received ${sfDay(w.received_at)}`, w.where && `in ${w.where}`].filter(Boolean).join(' · '))}</div>
          ${sfTags(w) ? `<div class="lg-ov">${sfTags(w)}</div>` : ''}
          ${w.notes ? `<div class="sf-notes">${esc(w.notes)}</div>` : ''}
          ${w.watch ? `<div class="m">${sfOurs(w)}</div>` : ''}
        </div>
      </article>`
    )
    .join('')}</div>`;
}

/* ── checked out ────────────────────────────────────────────────── */

/*
 * The logistics app's Checkout page (asked 26 Oct 2026): watches held
 * somewhere for a while, not sold. Each linked to our watch of that number and
 * to our client through it — who it was bought from, who it was sold to — so
 * "given back to Khawar" sits beside the client Chrono Key says it came from.
 * A watch the app lists more than once (checked out again without a return)
 * is one entry here, its earlier rows under it.
 */
const co = { q: '', sort: 'new', view: 'list', origin: '', data: null };
try {
  co.view = localStorage.getItem('masterapp.checkoutView') === 'cards' ? 'cards' : 'list';
} catch {
  /* no storage: the list, as the app shows it */
}

async function showLogisticsCheckout() {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('checkout')}
    <p class="sub" style="margin:0 0 12px">Watches held somewhere for a while — not sold. Each is linked to our stock and to the client it came from or went to.</p>
    <div class="lg-toolbar">
      <input class="q" type="search" id="coq" placeholder="Stock number, brand, model, reference, serial, client, reason…" value="${esc(co.q)}">
      <select id="cosort" aria-label="Order">
        <option value="new">Checked out most recently</option>
        <option value="old">Out the longest</option>
        <option value="stockAsc">Stock number, low to high</option>
        <option value="stockDesc">Stock number, high to low</option>
      </select>
      <div class="sf-view" role="group" aria-label="View">
        <button type="button" class="pill" data-v="list">List</button><button type="button" class="pill" data-v="cards">Cards</button>
      </div>
    </div>
    <div class="lg-subtabs" id="co-origins" role="group" aria-label="Checked out from"></div>
    <div class="count" id="co-count">Reading what is checked out…</div>
    <div id="co-out"></div>`;
  $('#cosort').value = co.sort;
  let timer;
  $('#coq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      co.q = e.target.value;
      drawCheckout();
    }, 150);
  });
  $('#cosort').addEventListener('change', (e) => {
    co.sort = e.target.value;
    drawCheckout();
  });
  $$('.sf-view .pill').forEach((b) =>
    b.addEventListener('click', () => {
      co.view = b.dataset.v;
      try {
        localStorage.setItem('masterapp.checkoutView', co.view);
      } catch {
        /* remembered for this visit only */
      }
      drawCheckout();
    })
  );
  $('#co-origins').addEventListener('click', (e) => {
    const b = e.target.closest('[data-o]');
    if (!b) return;
    co.origin = b.dataset.o;
    drawCheckout();
  });
  lgOpenOnClick($('#co-out'));
  let r;
  try {
    r = await api('/api/logistics/checked-out');
  } catch (err) {
    if (seq === lgPage && $('#co-count')) $('#co-count').textContent = `Could not read what is checked out: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#co-out')) return;
  co.data = r;
  if (co.origin && !r.by_origin.some((o) => o.origin === co.origin)) co.origin = '';
  lgSetCount('checkout', r.watches.length);
  drawCheckout();
}

/* How long it has been out, in days, by this computer's calendar. */
const coDays = (day) => {
  const n = Math.round((Date.parse(localDay()) - Date.parse(String(day || '').slice(0, 10))) / 86_400_000);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const coWhen = (w) => {
  const n = coDays(w.checked_out);
  return [sfDay(w.checked_out), n !== null && (n === 0 ? 'today' : `${n} day${n === 1 ? '' : 's'}`)].filter(Boolean).join(' · ');
};
/* Our watch and our clients — by Chrono Key's ids, never the typed reason. */
const coOurs = (w) => {
  const o = w.watch;
  if (!o) return '<span class="blank">Not one of our watches</span>';
  return [
    `<a href="#/watch/${o.id}">Our watch #${esc(o.stock_no)}</a> ${chip(o.status)}`,
    o.bought_from && `Bought from <a href="#/client/${o.bought_from.id}"><b>${esc(o.bought_from.name)}</b></a>`,
    o.sold_to && `Sold to <a href="#/client/${o.sold_to.id}"><b>${esc(o.sold_to.name)}</b></a>`,
  ]
    .filter(Boolean)
    .map((x) => `<div>${x}</div>`)
    .join('');
};
const coEarlier = (w) =>
  w.earlier.length
    ? `<div class="count" style="margin:4px 0 0">Also checked out ${w.earlier
        .map((e) => `<a href="#/lg/${e.id}">${esc(sfDay(e.checked_out) || 'earlier')}</a>${e.reason ? ` (${esc(e.reason)})` : ''}`)
        .join(', ')} — not returned in between</div>`
    : '';

function drawCheckout() {
  const r = co.data;
  if (!r || !$('#co-out')) return;
  $$('.sf-view .pill').forEach((b) => b.classList.toggle('on', b.dataset.v === co.view));
  $('#co-origins').innerHTML = [{ origin: '', n: r.watches.length }, ...r.by_origin]
    .map((o) => `<button type="button" class="pill${o.origin === co.origin ? ' on' : ''}" data-o="${esc(o.origin)}" aria-pressed="${o.origin === co.origin}">${esc(o.origin ? `From ${o.origin}` : 'All')}<b>${o.n}</b></button>`)
    .join('');
  const words = co.q.toLowerCase().split(/\s+/).filter(Boolean);
  const watches = r.watches
    .filter((w) => !co.origin || w.origin === co.origin)
    .filter((w) =>
      sfMatch(words, w.stock_no, w.brand, w.model, w.reference, w.serial, w.origin, w.reason, w.notes, w.watch?.bought_from?.name, w.watch?.sold_to?.name, ...w.earlier.map((e) => e.reason))
    )
    .sort((a, b) =>
      co.sort === 'old'
        ? String(a.checked_out).localeCompare(String(b.checked_out)) || a.id - b.id
        : co.sort === 'stockAsc'
          ? sfNo(a.stock_no) - sfNo(b.stock_no)
          : co.sort === 'stockDesc'
            ? sfNo(b.stock_no) - sfNo(a.stock_no)
            : String(b.checked_out).localeCompare(String(a.checked_out)) || b.id - a.id
    );

  const n = watches.length;
  const all = co.origin ? r.by_origin.find((o) => o.origin === co.origin)?.n || 0 : r.watches.length;
  $('#co-count').textContent = `${n} watch${n === 1 ? '' : 'es'}${words.length ? ` of ${all}` : ''} checked out${
    r.rows > r.watches.length ? ` · the logistics app lists ${r.rows} rows: a watch checked out again without a return is shown once` : ''
  }`;
  if (!n) {
    $('#co-out').innerHTML = `<p class="sub">${words.length || co.origin ? 'Nothing checked out matches.' : 'Nothing is checked out right now.'}</p>`;
    return;
  }
  // A number with no digits ("-", "xxxxxx") is no stock number: shown as typed, without the #.
  const stockOf = (w) => `<span class="lg-stock">${/\d/.test(w.stock_no) ? `#${esc(w.stock_no)}` : esc(w.stock_no && w.stock_no !== '-' ? w.stock_no : '—')}</span>`;
  // "Other" is the app's brand for one it does not list; the model then names it ("Richard Mille Automatic RM 72-01").
  const title = (w) => esc([/^other$/i.test(w.brand) && w.model ? '' : w.brand, w.model].filter(Boolean).join(' ') || 'Watch');
  const specs = (w) => esc([w.reference && `Ref ${w.reference}`, w.serial && `Serial ${w.serial}`, w.watch_date].filter(Boolean).join(' · '));
  if (co.view === 'list') {
    $('#co-out').innerHTML = `<div class="panel tscroll" style="padding:0"><table class="list lg"><thead><tr>
        <th>Stock</th><th>Watch</th><th>From</th><th>Checked out</th><th>Reason / who</th><th>Ours · client</th><th>Notes</th>
      </tr></thead><tbody>${watches
        .map(
          (w) => `<tr data-id="${w.id}" tabindex="0">
            <td style="white-space:nowrap">${stockOf(w)}</td>
            <td><a href="#/lg/${w.id}"><b>${title(w)}</b></a>${specs(w) ? `<div class="count" style="margin:2px 0 0">${specs(w)}</div>` : ''}${coEarlier(w)}</td>
            <td>${esc(w.origin || '—')}</td>
            <td style="white-space:nowrap">${esc(coWhen(w))}</td>
            <td>${esc(w.reason || '—')}</td>
            <td>${coOurs(w)}</td>
            <td>${esc(w.notes || '')}${w.photo_count ? `<div class="count" style="margin:2px 0 0">${w.photo_count} photo${w.photo_count === 1 ? '' : 's'}</div>` : ''}</td>
          </tr>`
        )
        .join('')}</tbody></table></div>`;
    return;
  }
  $('#co-out').innerHTML = `<div class="grid sf-grid">${watches
    .map(
      (w) => `<article class="tile sf-card" data-id="${w.id}" tabindex="0" role="link" aria-label="${esc(`#${w.stock_no} ${w.brand} ${w.model}, checked out ${sfDay(w.checked_out)}`)}">
        <div class="pic">${sfPic(w)}</div>
        <div class="body">
          <div class="m">${stockOf(w)}${w.brand && !/^other$/i.test(w.brand) ? ` <span>${esc(w.brand)}</span>` : ''}</div>
          <div class="t">${esc(w.model || w.brand || 'Watch')}</div>
          ${specs(w) ? `<div class="m">${specs(w)}</div>` : ''}
          <div class="m">${esc([`Out ${coWhen(w)}`, w.origin && `from ${w.origin}`].filter(Boolean).join(' · '))}</div>
          ${w.reason ? `<div class="sf-for"><b>${esc(w.reason)}</b></div>` : ''}
          ${w.notes ? `<div class="sf-notes">${esc(w.notes)}</div>` : ''}
          <div class="m">${coOurs(w)}</div>
          ${coEarlier(w)}
        </div>
      </article>`
    )
    .join('')}</div>`;
}

/* ── hand carry ─────────────────────────────────────────────────── */

/*
 * The logistics app's Hand Carry page (asked 26 Oct 2026): a person's plan of
 * stops, and at each the watches delivered, collected or moved. Same links as
 * In Safe and Checked out — each watch to our watch and its clients, the typed
 * buyer or supplier as far as it goes (lgPerson) — in this console's own look.
 * Open plans, the app's Plans History, and what is waiting for a plan. The
 * plan's own buttons (add a stop, assign, optimise, send to movements) are
 * the record's edit here.
 */
const hc = { q: '', show: 'open', data: null };

async function showLogisticsHandCarry() {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('handcarry')}
    <p class="sub" style="margin:0 0 12px">Plans for carrying watches by hand — each stop and what is delivered, collected or moved there. Every watch is linked to our stock and its client.</p>
    <div class="lg-toolbar" style="grid-template-columns:1fr">
      <input class="q" type="search" id="hcq" placeholder="Plan, city, stock number, brand, model, client…" value="${esc(hc.q)}">
    </div>
    <div class="lg-subtabs" id="hc-show" role="group" aria-label="Show"></div>
    <div class="count" id="hc-count">Reading the plans…</div>
    <div id="hc-out"></div>`;
  let timer;
  $('#hcq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      hc.q = e.target.value;
      drawHandCarry();
    }, 150);
  });
  $('#hc-show').addEventListener('click', (e) => {
    const b = e.target.closest('[data-s]');
    if (!b) return;
    hc.show = b.dataset.s;
    drawHandCarry();
  });
  lgOpenOnClick($('#hc-out'));
  let r;
  try {
    r = await api('/api/logistics/hand-carry');
  } catch (err) {
    if (seq === lgPage && $('#hc-count')) $('#hc-count').textContent = `Could not read the plans: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#hc-out')) return;
  hc.data = r;
  lgSetCount('handcarry', r.plans.length);
  drawHandCarry();
}

const HC_ROLE = { deliver: ['Deliver', 'moving', 'To'], collect: ['Collect', 'warn', 'From'], move: ['Move', '', 'From'] };
/* One watch on a stop or waiting for one: what, who it goes to or comes from, and ours with its clients. */
const hcRow = (x, role, extra = '') => {
  const [tag, tone, dir] = HC_ROLE[role];
  const who = x.who ? `${dir} <b>${lgPerson(x.who.name, x.who.link)}</b>` : '';
  return `<div class="ov-row"${x.id ? ` data-id="${x.id}" tabindex="0" role="link"` : ''}>
    <div class="ov-row-main">
      <div><span class="lg-tag ${tone}">${tag}</span> ${/\d/.test(x.stock_no) ? `<span class="lg-stock">#${esc(x.stock_no)}</span> ` : ''}<b>${esc([x.brand, x.model].filter(Boolean).join(' · ') || 'Watch')}</b></div>
      <div class="count" style="margin:2px 0 0">${[who, x.place && esc(x.place), extra].filter(Boolean).join(' · ') || '&nbsp;'}</div>
    </div>
    <div class="ov-row-side hc-ours">${coOurs(x)}</div>
  </div>`;
};
const hcWords = (p) =>
  [
    p.name,
    p.start,
    p.notes,
    ...p.stops.flatMap((s) => [s.to, s.from, s.flight, s.notes, ...['deliver', 'collect', 'move'].flatMap((k) => s[k].flatMap((x) => [x.stock_no, x.brand, x.model, x.place, x.who?.name, x.who?.link?.client_name, x.watch?.bought_from?.name, x.watch?.sold_to?.name]))]),
  ];
const hcWaitWords = (x) => [x.stock_no, x.brand, x.model, x.place, x.who?.name, x.who?.link?.client_name, x.on_plan?.name, x.watch?.bought_from?.name, x.watch?.sold_to?.name];

function hcPlan(p) {
  const c = p.counts;
  const flights = p.flights.map((f) => money(f.amount, f.currency || '')).join(' + ');
  const route = [p.start || 'Start', ...p.stops.map((s) => `${s.to || '?'}${s.date ? ` ${dayWords(s.date).replace(/ \d{4}$/, '')}` : ''}`)];
  return `<section class="panel hc-plan">
    <div class="hc-head">
      <h2 class="sf-h"><a href="#/lg/${p.id}">${esc(p.name)}’s plan</a></h2>
      ${p.completed ? `<span class="lg-tag">Completed${p.completed_at ? ` ${esc(sfDay(p.completed_at))}` : ''}</span>` : ''}
    </div>
    <div class="count" style="margin:4px 0 0">${[
      `${c.stops} stop${c.stops === 1 ? '' : 's'}`,
      `${c.deliver} to deliver`,
      `${c.collect} to collect`,
      c.move && `${c.move} to move`,
    ]
      .filter(Boolean)
      .join(' · ')}${flights ? ` · flights ${flights}` : ''}</div>
    <p class="hc-route">${route.map((x) => esc(x)).join(' <span aria-hidden="true">→</span> ')}</p>
    ${p.notes ? `<p class="sf-notes" style="margin:0 0 8px">${esc(p.notes)}</p>` : ''}
    ${
      p.stops.length
        ? p.stops
            .map((s) => {
              const items = [...s.deliver.map((x) => hcRow(x, 'deliver')), ...s.collect.map((x) => hcRow(x, 'collect')), ...s.move.map((x) => hcRow(x, 'move'))];
              const when = [s.date && dayWords(s.date), s.time, s.flight, s.cost && money(s.cost, s.currency || '')].filter(Boolean);
              return `<div class="hc-stop">
                <h3 class="hc-stop-h">Stop ${s.n} — ${esc(s.to || 'not written')}${s.from ? ` <span class="count" style="margin:0;font-weight:400">from ${esc(s.from)}</span>` : ''}</h3>
                ${when.length ? `<div class="count" style="margin:0">${when.map((w, i) => (i === when.length - 1 && s.cost ? w : esc(w))).join(' · ')}</div>` : ''}
                ${s.notes ? `<div class="sf-notes">${esc(s.notes)}</div>` : ''}
                ${items.length ? items.join('') : '<p class="sub" style="margin:6px 0 0">Nothing assigned to this stop yet.</p>'}
              </div>`;
            })
            .join('')
        : '<p class="sub" style="margin:8px 0 0">No stops yet.</p>'
    }
  </section>`;
}

function drawHandCarry() {
  const r = hc.data;
  if (!r || !$('#hc-out')) return;
  const waitN = r.waiting.deliver.length + r.waiting.collect.length;
  $('#hc-show').innerHTML = [
    ['open', 'Open plans', r.plans.length],
    ['waiting', 'Waiting for a plan', waitN],
    ['history', 'Plans history', r.history.length],
  ]
    .map(([k, label, n]) => `<button type="button" class="pill${hc.show === k ? ' on' : ''}" data-s="${k}" aria-pressed="${hc.show === k}">${label}<b>${n}</b></button>`)
    .join('');
  const words = hc.q.toLowerCase().split(/\s+/).filter(Boolean);

  if (hc.show === 'waiting') {
    const pick = (list) => list.filter((x) => sfMatch(words, ...hcWaitWords(x)));
    const deliver = pick(r.waiting.deliver);
    const collect = pick(r.waiting.collect);
    const onPlan = (x) => (x.on_plan ? `<a href="#/lg/${x.on_plan.id}">on ${esc(x.on_plan.name)}’s plan, stop ${x.on_plan.stop}${x.on_plan.to ? ` (${esc(x.on_plan.to)})` : ''}</a>` : 'not on a plan yet');
    const box = (title, list, role, blank) => `<section class="panel sf-acc">
      <h2 class="sf-h">${title} <span class="count">${list.length}</span></h2>
      ${list.length ? list.map((x) => hcRow(x, role, onPlan(x))).join('') : `<p class="sub" style="margin:6px 0 0">${words.length ? 'Nothing matches.' : blank}</p>`}
    </section>`;
    $('#hc-count').textContent = `${deliver.length} ready to deliver · ${collect.length} to collect${words.length ? ` (of ${r.waiting.deliver.length} and ${r.waiting.collect.length})` : ''}`;
    $('#hc-out').innerHTML = box('Ready to deliver', deliver, 'deliver', 'Nothing is waiting to be delivered.') + box('To collect', collect, 'collect', 'No incomings waiting to be collected.');
    return;
  }
  const all = hc.show === 'history' ? r.history : r.plans;
  const plans = all.filter((p) => sfMatch(words, ...hcWords(p)));
  const n = plans.length;
  $('#hc-count').textContent = `${n} ${hc.show === 'history' ? 'completed ' : 'open '}plan${n === 1 ? '' : 's'}${words.length ? ` of ${all.length}` : ''}`;
  $('#hc-out').innerHTML = n
    ? plans.map(hcPlan).join('')
    : `<p class="sub">${words.length ? 'No plan matches.' : hc.show === 'history' ? 'No plan has been completed yet.' : 'No hand-carry plan is open right now.'}</p>`;
}

/* ── transactions ───────────────────────────────────────────────── */

/*
 * The logistics app's All Transactions page (asked 26 Oct 2026): each watch
 * bought or sold with the accessories that go with it, and what is still
 * pending either way. Linked as on the other tabs: the watch to ours and its
 * clients, the client (the app's own id) to the logistics client and — as
 * that one is — to ours. The same rows sit on the watch's own page, with its
 * costs (txBlock), never on its tile.
 */
const tx = { q: '', type: '', country: '', client: '', data: null };

/* "4/4 pending", "complete", "no items" — the app's own words. */
const txStatus = (t) =>
  !t.total ? '<span class="count" style="margin:0">no items</span>' : !t.pending ? '<span class="lg-tag">Complete</span>' : `<span class="lg-tag warn">${t.pending}/${t.total} pending</span>`;
const txAcc = (it) => esc(it.qty > 1 ? `${it.accessory} × ${it.qty}` : it.accessory);
/* What is still owed, by which way it goes, then what is already settled. */
const txItems = (t) => {
  const open = (dir) => t.items.filter((it) => !it.done && it.dir === dir);
  return [
    open('give').length && `<span class="lg-tag warn">We give: ${open('give').map(txAcc).join(', ')}</span>`,
    open('get').length && `<span class="lg-tag warn">They give: ${open('get').map(txAcc).join(', ')}</span>`,
    t.items.some((it) => it.done) && `<span class="lg-tag">Settled: ${t.items.filter((it) => it.done).map(txAcc).join(', ')}</span>`,
  ]
    .filter(Boolean)
    .join('');
};
const txClient = (t) => (t.client ? lgPerson(t.client.name, t.client) : '<span class="blank">not written</span>');
const txType = (t) => (t.type === 'sold' ? 'Sold' : t.type === 'bought' ? 'Bought' : t.type || '—');

async function showLogisticsTransactions() {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('transactions')}
    <p class="sub" style="margin:0 0 12px">Accessory transactions — each watch bought or sold, and the accessories still to give or collect. Every row is linked to our stock and its client.</p>
    <div class="lg-toolbar tx-toolbar">
      <input class="q" type="search" id="txq" placeholder="Stock number, reference, client, accessory…" value="${esc(tx.q)}">
      <select id="txtype" aria-label="Type"><option value="">All types</option><option value="bought">Bought</option><option value="sold">Sold</option></select>
      <select id="txcountry" aria-label="Country"><option value="">All countries</option></select>
      <select id="txclient" aria-label="Client"><option value="">All clients</option></select>
    </div>
    <div class="count" id="tx-count">Reading the transactions…</div>
    <div id="tx-out"></div>`;
  let timer;
  $('#txq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      tx.q = e.target.value;
      drawTransactions();
    }, 150);
  });
  for (const [id, key] of [['#txtype', 'type'], ['#txcountry', 'country'], ['#txclient', 'client']]) {
    $(id).addEventListener('change', (e) => {
      tx[key] = e.target.value;
      drawTransactions();
    });
  }
  lgOpenOnClick($('#tx-out'));
  let r;
  try {
    r = await api('/api/logistics/transactions');
  } catch (err) {
    if (seq === lgPage && $('#tx-count')) $('#tx-count').textContent = `Could not read the transactions: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#tx-out')) return;
  tx.data = r;
  $('#txcountry').innerHTML = `<option value="">All countries</option>${r.countries.map((c) => `<option>${esc(c)}</option>`).join('')}`;
  $('#txclient').innerHTML = `<option value="">All clients</option>${r.clients.map((c) => `<option value="${c.id}">${esc(c.name)}${c.country ? ` (${esc(c.country)})` : ''}</option>`).join('')}`;
  if (!r.countries.includes(tx.country)) tx.country = '';
  if (!r.clients.some((c) => String(c.id) === tx.client)) tx.client = '';
  $('#txtype').value = tx.type;
  $('#txcountry').value = tx.country;
  $('#txclient').value = tx.client;
  drawTransactions();
}

function drawTransactions() {
  const r = tx.data;
  if (!r || !$('#tx-out')) return;
  const words = tx.q.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = r.transactions.filter(
    (t) =>
      (!tx.type || t.type === tx.type) &&
      (!tx.country || t.client?.country === tx.country) &&
      (!tx.client || String(t.client?.lg_client_id) === tx.client) &&
      sfMatch(words, t.stock_no, t.reference, t.brand, t.notes, t.client?.name, t.client?.client_name, ...t.items.map((it) => it.accessory), t.watch?.bought_from?.name, t.watch?.sold_to?.name)
  );
  const n = rows.length;
  const pending = rows.filter((t) => t.pending).length;
  $('#tx-count').textContent = `${n} transaction${n === 1 ? '' : 's'}${n < r.transactions.length ? ` of ${r.transactions.length}` : ''} · ${pending} with accessories pending`;
  if (!n) {
    $('#tx-out').innerHTML = `<p class="sub">${r.transactions.length ? 'No transaction matches.' : 'The logistics app has no accessory transactions.'}</p>`;
    return;
  }
  $('#tx-out').innerHTML = `<div class="panel tscroll" style="padding:0"><table class="list lg"><thead><tr>
      <th>Date</th><th>Stock</th><th>Type</th><th>Watch</th><th>Client</th><th>Country</th><th>Accessories</th><th>Status</th><th>Ours · client</th>
    </tr></thead><tbody>${rows
      .map(
        (t) => `<tr data-id="${t.id}" tabindex="0">
          <td style="white-space:nowrap">${esc(sfDay(t.date) || '—')}</td>
          <td style="white-space:nowrap">${/\d/.test(t.stock_no) ? `<span class="lg-stock">#${esc(t.stock_no)}</span>` : esc(t.stock_no || '—')}</td>
          <td>${esc(txType(t))}</td>
          <td><a href="#/lg/${t.id}"><b>${esc(t.brand || 'Watch')}</b></a>${t.reference && t.reference !== t.stock_no ? `<div class="count" style="margin:2px 0 0">Ref ${esc(t.reference)}</div>` : ''}</td>
          <td><b>${txClient(t)}</b></td>
          <td>${esc(t.client?.country || '—')}</td>
          <td>${txItems(t) ? `<div class="lg-ov" style="margin:0">${txItems(t)}</div>` : ''}</td>
          <td style="white-space:nowrap">${txStatus(t)}</td>
          <td>${coOurs(t)}</td>
        </tr>`
      )
      .join('')}</tbody></table></div>`;
}

/* ── accessories ────────────────────────────────────────────────── */

/*
 * The logistics app's Accessories Management page (asked 26 Oct 2026): what
 * we owe clients and what they owe us — by accessory, by brand, and by client
 * (grouped by country, one row per transaction and direction) — counted as
 * the app counts. Each row linked to our watch and the client as on the
 * Transactions tab. Settling is the transaction's edit, not a button here.
 */
const acc = { q: '', data: null };

async function showLogisticsAccessories() {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('accessories')}
    <p class="sub" style="margin:0 0 12px">Everything we owe and are owed, by accessory, brand and client — from the accessory transactions. <a href="#/logistics/accessories-all">See the lists</a> (to collect, to give, settlements, swaps).</p>
    <div id="acc-top" class="acc-two"></div>
    <div id="acc-brand"></div>
    <div class="lg-toolbar" style="grid-template-columns:1fr;margin-top:14px">
      <input class="q" type="search" id="accq" placeholder="Client, country, stock number, reference, accessory…" value="${esc(acc.q)}">
    </div>
    <div class="count" id="acc-count">Reading the accessories…</div>
    <div id="acc-out"></div>`;
  let timer;
  $('#accq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      acc.q = e.target.value;
      drawAccClients();
    }, 150);
  });
  lgOpenOnClick($('#acc-out'));
  let r;
  try {
    r = await api('/api/logistics/accessories');
  } catch (err) {
    if (seq === lgPage && $('#acc-count')) $('#acc-count').textContent = `Could not read the accessories: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#acc-out')) return;
  acc.data = r;
  const side = (title, s, blank) => `<section class="panel">
      <h2 class="sf-h">${title}</h2>
      <div class="acc-n">${s.total}</div>
      ${s.by_accessory.length ? `<div class="acc-break">${s.by_accessory.map((a) => `<div><span>${esc(a.accessory)}</span><b>${a.n}</b></div>`).join('')}</div>` : `<p class="sub" style="margin:4px 0 0">${blank}</p>`}
    </section>`;
  $('#acc-top').innerHTML = side('We need to give clients', r.give, 'Nothing to give — all clear.') + side('Clients need to give us', r.get, 'Nothing owed to us — all clear.');
  $('#acc-brand').innerHTML = `<section class="panel" style="margin-top:14px">
      <h2 class="sf-h">Pending by brand</h2>
      ${
        r.by_brand.length
          ? `<div class="tscroll"><table class="list lg"><thead><tr><th>Brand</th><th class="num">We owe</th><th class="num">Owed to us</th><th class="num">Transactions</th></tr></thead><tbody>${r.by_brand
              .map((b) => `<tr><td><b>${esc(b.brand || 'No brand')}</b></td><td class="num">${b.give || '—'}</td><td class="num">${b.get || '—'}</td><td class="num">${b.transactions}</td></tr>`)
              .join('')}</tbody></table></div>`
          : '<p class="sub" style="margin:4px 0 0">Nothing pending on any brand.</p>'
      }
    </section>`;
  drawAccClients();
}

function drawAccClients() {
  const r = acc.data;
  if (!r || !$('#acc-out')) return;
  const words = acc.q.toLowerCase().split(/\s+/).filter(Boolean);
  const rowWords = (x) => [x.stock_no, x.reference, x.brand, ...x.items, x.watch?.bought_from?.name, x.watch?.sold_to?.name];
  let shown = 0;
  const html = r.by_country
    .map((c) => {
      const clients = c.clients
        .map((p) => {
          const head = [c.country, p.client?.name, p.client?.client_name];
          const rows = p.rows.filter((x) => sfMatch(words, ...head, ...rowWords(x)));
          return rows.length ? { p, rows } : null;
        })
        .filter(Boolean);
      if (!clients.length) return '';
      shown += clients.length;
      const items = clients.reduce((a, x) => a + x.rows.reduce((b, y) => b + y.items.length, 0), 0);
      return `<details class="panel acc-country" open>
        <summary><h2 class="sf-h">${esc(c.country || 'No country')} <span class="count" style="margin:0">· ${clients.length} client${clients.length === 1 ? '' : 's'}</span></h2><span class="count" style="margin:0">${items} pending</span></summary>
        ${clients
          .map(
            ({ p, rows }) => `<div class="acc-client">
              <h3 class="hc-stop-h">${p.client ? lgPerson(p.client.name, p.client) : '<span class="blank">Client not listed in the logistics app</span>'} <span class="count" style="margin:0;font-weight:400">· we owe ${p.give} · owed to us ${p.get}</span></h3>
              ${rows
                .map(
                  (x) => `<div class="ov-row" data-id="${x.id}" tabindex="0" role="link">
                    <div class="ov-row-main">
                      <div>${/\d/.test(x.stock_no) ? (x.watch ? `<a class="lg-stock" href="#/watch/${x.watch.id}">#${esc(x.stock_no)}</a>` : `<span class="lg-stock">#${esc(x.stock_no)}</span>`) : `<span class="lg-stock">${esc(x.stock_no || '—')}</span>`}${
                        x.reference && x.reference !== x.stock_no ? ` <span class="count" style="margin:0">Ref ${esc(x.reference)}</span>` : ''
                      }${x.brand ? ` <span class="count" style="margin:0">· ${esc(x.brand)}</span>` : ''}</div>
                      <div class="lg-ov"><span class="lg-tag ${x.dir === 'give' ? 'problem' : 'warn'}">${x.dir === 'give' ? 'We give' : 'They give'}</span>${x.items.map((i) => `<span class="lg-tag">${esc(i)}</span>`).join('')}</div>
                    </div>
                    <div class="ov-row-side hc-ours">${coOurs(x)}</div>
                  </div>`
                )
                .join('')}
            </div>`
          )
          .join('')}
      </details>`;
    })
    .join('');
  const all = r.by_country.reduce((a, c) => a + c.clients.length, 0);
  $('#acc-count').textContent = `${shown} client${shown === 1 ? '' : 's'}${words.length ? ` of ${all}` : ''} with accessories pending`;
  $('#acc-out').innerHTML = html || `<p class="sub">${words.length ? 'Nothing pending matches.' : 'Nothing is pending with any client.'}</p>`;
}

/* One transaction on a watch's page: who, when, what is still owed either way, and what was handed over. */
function txBlock(t) {
  const who = t.type === 'sold' ? 'Sold to' : t.type === 'bought' ? 'Bought from' : txType(t);
  return `<div class="tx-block">
    <div class="tx-head"><a href="#/lg/${t.id}"><b>${esc(who)}</b></a> <b>${txClient(t)}</b>${t.client?.country ? ` <span class="count" style="margin:0">· ${esc(t.client.country)}</span>` : ''}
      <span class="tx-side">${txStatus(t)} <span class="count" style="margin:0">${esc(sfDay(t.date))}</span></span></div>
    ${t.reference && t.reference !== t.stock_no ? `<div class="count" style="margin:2px 0 0">Ref ${esc(t.reference)}</div>` : ''}
    ${txItems(t) ? `<div class="lg-ov">${txItems(t)}</div>` : ''}
    ${t.settlements
      .map(
        (s) =>
          `<div class="count" style="margin:4px 0 0">${esc(s.dir === 'give' ? 'Given' : 'Received')}${s.at ? ` ${esc(sfDay(s.at))}` : ''}${s.items.length ? `: ${esc(s.items.join(', '))}` : ''}${s.notes ? ` — ${esc(s.notes)}` : ''}${
            s.photo_count ? ` · ${s.photo_count} photo${s.photo_count === 1 ? '' : 's'}` : ''
          }</div>`
      )
      .join('')}
    ${t.notes ? `<div class="sf-notes" style="margin-top:4px">${esc(t.notes)}</div>` : ''}
  </div>`;
}

/* ── the overview ───────────────────────────────────────────────── */

/*
 * The logistics app's dashboard, in masterapp — laid out for a glance (asked
 * 24 Oct 2026: "easy to understand even for a dumb person"; .ux-profile.md):
 * five tiles in plain words, then search, then each list with one line per
 * thing and a short sentence saying what it is. Every watch it names is OUR
 * watch, linked to its page. Refreshed every minute while open; the search, an
 * open polish form and a list opened in full are left alone by the refresh.
 */
const ov = { search: { q: '', scope: 'all' }, costIn: 'USD', form: null, open: new Set(), timer: null, typing: null, data: null };

/* A record's stock numbers: to our watch's page where we hold it, else to the record. */
const stockLinksOf = (i) =>
  (i.stock_nos || [])
    .map((s) => {
      const w = (i.watches || []).find((x) => x.stock_no === s);
      return w ? `<a class="lg-stock" href="#/watch/${w.id}">#${esc(s)}</a>` : `<span class="lg-stock">#${esc(s)}</span>`;
    })
    .join(' ');

/* A panel's heading: what it is, how many, and a link to its whole tab. */
const ovHead = (title, n, href, linkText, level = 'h2') =>
  `<div class="ov-head"><${level} class="ov-h">${esc(title)}${n === null || n === undefined ? '' : `<span class="ov-n">${esc(n)}</span>`}</${level}>${
    href ? `<a class="ov-more" href="${esc(href)}">${esc(linkText)}</a>` : ''
  }</div>`;
const ovExplain = (text) => `<p class="ov-explain">${esc(text)}</p>`;
const ovEmpty = (text) => `<p class="ov-empty">${esc(text)}</p>`;
const ovSkeleton = '<div class="ov-skel"></div><div class="ov-skel"></div><div class="ov-skel"></div>';

/* One line per thing: what it is (to its page), then where it stands and its watches. */
const ovRow = (i, side = '') => `<div class="ov-row">
    <div class="ov-row-main">
      <a class="ov-title" href="#/lg/${i.id}">${esc(i.summary.title)}</a>
      <div class="ov-meta"><span>${stockLinksOf(i)}</span><span>${esc(i.summary.sub)}</span></div>
    </div>${side ? `<div class="ov-row-side">${side}</div>` : ''}
  </div>`;

/* The first few of a list, and all of them in place on "Show all" — the same list, not a tab with others in it. */
const OV_ROWS = 6;
function ovList(id, items, render, empty, rows = OV_ROWS) {
  if (!items.length) return ovEmpty(empty);
  const all = ov.open.has(id);
  return (
    (all ? items : items.slice(0, rows)).map(render).join('') +
    (items.length > rows ? `<button type="button" class="ov-all ov-all-btn" data-ovall="${id}">${all ? 'Show fewer' : `Show all ${items.length}`}</button>` : '')
  );
}
/* "Show all" / "Show fewer": redraw that panel only, and keep the keyboard on the button. */
function ovListToggles(root, redraw) {
  $$('[data-ovall]', root).forEach((b) =>
    b.addEventListener('click', () => {
      const id = b.dataset.ovall;
      if (ov.open.has(id)) ov.open.delete(id);
      else ov.open.add(id);
      redraw();
      $(`[data-ovall="${id}"]`)?.focus();
    })
  );
}

async function showLogisticsOverview() {
  const seq = ++lgPage;
  const still = () => seq === lgPage && (location.hash === '#/logistics' || location.hash === '#/logistics/overview');
  clearTimeout(ov.timer);
  clearTimeout(ov.typing);
  ov.form = null;
  ov.data = null;
  // Two columns, each stacking its own panels — no hole beside a short one ("too much empty whitespace"), and no
  // panel jumping sides when a list grows. On a phone, one column, in order of what matters (order: n).
  const panel = (id, order) => `<section class="panel ov-panel" id="${id}" style="order:${order}">${ovSkeleton}</section>`;
  $('#app').innerHTML = `${lgHeader('overview', '<span class="ov-asof" id="ov-asof">Reading the latest…</span>')}
    <div class="ov-banner" id="ov-error" role="alert"></div>
    <div class="ov-tiles" id="ov-cards">${'<div class="ov-tile ov-skel-tile"></div>'.repeat(5)}</div>
    <section class="panel ov-panel" id="ov-search"></section>
    <div class="ov-cols">
      <div class="ov-stack">${panel('ov-moving', 1)}${panel('ov-ready', 2)}${panel('ov-polish', 3)}${panel('ov-coming', 5)}</div>
      <div class="ov-stack">${panel('ov-donut', 4)}${panel('ov-places', 6)}${panel('ov-cost', 7)}${panel('ov-acc', 8)}${panel('ov-recent', 9)}</div>
    </div>`;
  renderOverviewSearch();
  await loadOverview(still);
}

/*
 * One read of the overview, and the next a minute later — whatever happened to
 * this one. A refresh that fails leaves the figures it had and says so; only a
 * first read with nothing to show puts the error in their place. Signed out or
 * gone to another page, it stops.
 */
async function loadOverview(still) {
  clearTimeout(ov.timer);
  const shown = () => still() && state.user && $('#ov-cards');
  try {
    const o = await api('/api/logistics/overview');
    if (!shown()) return;
    ov.data = o;
    $('#ov-error').textContent = '';
    renderOverview(o);
  } catch (err) {
    if (!shown()) return;
    // fetch itself failing is the connection; anything else is the server (errors: say which, and what to do).
    const what = err instanceof TypeError ? 'The connection dropped.' : `The server had a problem (${err.message}).`;
    if (ov.data) $('#ov-asof').textContent = `Could not refresh — ${what} Showing the last figures; trying again in a minute.`;
    else {
      $('#ov-asof').textContent = 'Not loaded';
      $('#ov-error').textContent = `The overview could not be loaded. ${what} It tries again every minute.`;
      $('#ov-cards').innerHTML = '';
      $$('.ov-panel .ov-skel').forEach((s) => s.remove());
    }
  } finally {
    clearTimeout(ov.timer);
    if (shown()) {
      ov.timer = setTimeout(() => {
        if (still() && state.user) loadOverview(still);
      }, 60_000);
    }
  }
}

/* "5 minutes ago", or the day and time when it is older than today. */
function ovAgo(at) {
  const t = new Date(at).getTime();
  const min = Math.round((Date.now() - t) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const h = Math.floor(min / 60);
  if (new Date(t).toDateString() === new Date().toDateString()) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function renderOverview(o) {
  // The minute's redraw keeps the keyboard where it was: the same link or button, found again by what it is.
  const had = document.activeElement;
  const back = had && had !== document.body && had.closest?.('.ov-panel, #ov-cards')
    ? { panel: had.closest('.ov-panel, #ov-cards').id, ovall: had.dataset?.ovall, href: had.getAttribute('href'), pick: had.dataset?.psend || had.dataset?.pdone }
    : null;
  drawOverview(o);
  if (back) {
    const root = document.getElementById(back.panel);
    const again = back.ovall
      ? root?.querySelector(`[data-ovall="${CSS.escape(back.ovall)}"]`)
      : back.pick
        ? root?.querySelector(`[data-psend="${CSS.escape(back.pick)}"], [data-pdone="${CSS.escape(back.pick)}"]`)
        : back.href
          ? root?.querySelector(`[href="${CSS.escape(back.href)}"]`)
          : null;
    again?.focus({ preventScroll: true });
  }
}

function drawOverview(o) {
  // "Live" only while the copy is fresh — the server says (read, or found unchanged, within the last few checks).
  if (o.as_of) {
    const at = new Date(o.as_of);
    const time = at.toDateString() === new Date().toDateString() ? at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : fmtWhen(o.as_of);
    $('#ov-asof').innerHTML =
      o.fresh
        ? `<span class="ov-live" title="Checks the logistics app for changes every minute">Live</span> Up to date at ${esc(time)}`
        : `<span class="ov-stale">Not updated since ${esc(time)}</span> The logistics app has not been read since then.`;
  } else $('#ov-asof').textContent = 'Not read from the logistics app yet';

  const D = o.deliveries;
  // A tile shows its list on this page (scrolls to it); the tab with everything is the link in the list's heading.
  const tile = (tone, label, n, help, panelId) =>
    `<a class="ov-tile ${tone}" href="#/logistics" data-scroll="${panelId}"><span class="ov-tile-label">${esc(label)}</span><b>${esc(n)}</b><small>${esc(help)}</small></a>`;
  $('#ov-cards').innerHTML = [
    tile('blue', 'On the way', D.in_motion, `not delivered yet${D.delayed ? ` · ${D.delayed} of them late` : ''}`, 'ov-moving'),
    D.delayed
      ? tile('bad', 'Late', D.delayed, D.delayed === 1 ? 'shipment past its due day' : 'shipments past their due day', 'ov-moving')
      : tile('good', 'Late', 0, 'none — all on time', 'ov-moving'),
    tile('warn', 'Waiting to hand over', D.ready, 'sold, not delivered yet', 'ov-ready'),
    tile('blue', 'Coming in', o.incoming.length, 'watches on their way to us', 'ov-coming'),
    tile('', 'Delivered', D.delivered, 'shipments since the start', 'ov-donut'),
  ].join('');
  $$('#ov-cards [data-scroll]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      $(`#${a.dataset.scroll}`)?.scrollIntoView({ block: 'start' });
    })
  );

  const drawMoving = () => {
    $('#ov-moving').innerHTML =
      ovHead('On the way', o.shipments.length, '#/logistics/shipments', 'See all shipments') +
      ovExplain(D.delayed ? 'Not delivered yet — the late ones first. The tag on the right says where the parcel is.' : 'Not delivered yet. The tag on the right says where the parcel is.') +
      ovList('moving', o.shipments, (i) => ovRow(i, i.late ? `<span class="chip lg-bad">Late — due ${esc(lgWhen(i.late))}</span>` : lgChip(i.summary.status)), 'Nothing is on the way right now.');
    ovListToggles($('#ov-moving'), drawMoving);
  };
  drawMoving();

  const drawReady = () => {
    $('#ov-ready').innerHTML =
      ovHead('Waiting to hand over', o.ready.length, '#/logistics/sales', 'See sales & delivery') +
      ovExplain('Sold watches the buyer does not have yet.') +
      ovList('ready', o.ready, (i) => ovRow(i, i.summary.status === 'shipped' ? lgChip('shipped') : ''), 'Every sold watch has been handed over.');
    ovListToggles($('#ov-ready'), drawReady);
  };
  drawReady();

  const drawComing = () => {
    $('#ov-coming').innerHTML =
      ovHead('Coming in', o.incoming.length, '#/logistics/incoming', 'See all incoming') +
      ovExplain('Watches we bought that are on their way to us.') +
      ovList('coming', o.incoming, (i) => ovRow(i, /pending/i.test(i.summary.status) ? '' : lgChip(i.summary.status)), 'Nothing is coming in right now.');
    ovListToggles($('#ov-coming'), drawComing);
  };
  drawComing();

  $('#ov-places').innerHTML =
    ovHead('Where the watches are', null, '#/logistics/stock', 'See stock by place') +
    ovExplain('How many watches are in each place right now.') +
    (o.places.length
      ? `<div class="ov-places">${o.places
          .map((p) => {
            const notes = [p.consignment && `${p.consignment} on consignment`, p.polish && `${p.polish} at polish`].filter(Boolean).join(', ');
            return `<a class="ov-place" href="#/logistics/stock"><b>${esc(p.n)}</b><span>${esc(p.label)}</span>${notes ? `<small>${esc(notes)}</small>` : ''}</a>`;
          })
          .join('')}</div>`
      : ovEmpty('No watches in any place yet.'));

  renderOverviewDonut(D);

  $('#ov-acc').innerHTML =
    ovHead('Accessories', null, '#/logistics/accessories', 'See accessories') +
    ovExplain('Boxes, papers and other items: what we must give to clients, and what clients must give us.') +
    `<div class="ov-acc-nums"><div><b class="give">${esc(o.accessories.give)}</b><span>item${o.accessories.give === 1 ? '' : 's'} we must give to clients</span></div><div><b class="owed">${esc(
      o.accessories.owed
    )}</b><span>item${o.accessories.owed === 1 ? '' : 's'} clients must give us</span></div></div>`;

  renderOverviewCost(o.costs);
  if (!ov.form) renderOverviewPolish(o.need_polish);
  else renderOverviewPolishRows(o.need_polish);

  $('#ov-recent').innerHTML =
    ovHead('Latest changes', null, '#/logistics/log', 'See the activity log') +
    ovExplain('The newest change to each watch, shipment or record — made here or in the logistics app.') +
    (o.recent.length ? `<ul class="ov-feed">${o.recent.map(ovChange).join('')}</ul>` : ovEmpty('No changes in the latest copies from the logistics app.'));
}

/* Every shipment so far, by where it stands — the logistics app's donut, in plain words: on time and late add up to on the way. */
function renderOverviewDonut(D) {
  const segs = [
    ['Delivered', D.delivered, 'var(--good)'],
    ['On the way, on time', D.in_progress, 'var(--blue)'],
    ['On the way, late', D.delayed, 'var(--bad)'],
  ];
  const sum = segs.reduce((a, s) => a + s[1], 0);
  const r = 62;
  const C = 2 * Math.PI * r;
  let off = 0;
  const arcs = sum
    ? segs
        .filter((s) => s[1] > 0)
        .map(([, n, color]) => {
          const len = C * (n / sum);
          const arc = `<circle cx="80" cy="80" r="${r}" fill="none" style="stroke:${color}" stroke-width="20" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-off}" transform="rotate(-90 80 80)"/>`;
          off += len;
          return arc;
        })
        .join('')
    : `<circle cx="80" cy="80" r="${r}" fill="none" style="stroke:var(--line)" stroke-width="20"/>`;
  $('#ov-donut').innerHTML =
    ovHead('All shipments', sum, '#/logistics/shipments', 'See all shipments') +
    ovExplain('Every shipment so far, by where it stands.') +
    `<div class="ov-donut"><svg width="160" height="160" viewBox="0 0 160 160" role="img" aria-label="${esc(`${sum} shipments: ${segs.map(([n, v]) => `${v} ${n.toLowerCase()}`).join(', ')}`)}">${arcs}
      <text x="80" y="82" text-anchor="middle" font-size="28" font-weight="600" style="fill:var(--ink)">${sum}</text>
      <text x="80" y="102" text-anchor="middle" font-size="14" style="fill:var(--muted)">shipments</text></svg>
      <div class="ov-legend">${segs
        .map(([name, n, color]) => `<div><i style="background:${color}"></i><span>${esc(name)}</span><b>${esc(n)}</b><small>${sum ? Math.round((n / sum) * 100) : 0}%</small></div>`)
        .join('')}</div></div>`;
}

/* A field's name and value as a person reads them: the list's own label, days as days, yes / no, words not codes. */
const ovSentence = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
function ovValue(v, f, k) {
  if (v === null || v === undefined || v === '') return 'blank';
  if (v === true) return 'yes';
  if (v === false) return 'no';
  if (f?.type === 'when' || f?.type === 'date' || TIME_KEY.test(k)) return lgWhen(v);
  let s = String(v);
  if (f?.type === 'enum' || /^[a-z]+(_[a-z]+)+$/.test(s)) s = s.replace(/_/g, ' ');
  if (f?.type === 'money' && Number.isFinite(Number(v))) s = Number(v).toLocaleString('en-GB', { maximumFractionDigits: 2 });
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/* One change in words. A block of details inside the record is "(details)" in the history: named, not shown. */
function ovWords(kind, k, [a, b]) {
  const f = lgKind(kind).fields.find((x) => x.key === k);
  const name = f?.label || ovSentence(humanKey(k));
  const blank = (v) => v === null || v === undefined || v === '';
  if (k === 'polish' && (a === '(details)' || b === '(details)')) return blank(b) ? 'Back from polish' : blank(a) ? 'Sent to polish' : 'Polish details changed';
  if (a === '(details)' || b === '(details)') return `${name} changed`;
  return `${name}: ${ovValue(a, f, k)} → ${ovValue(b, f, k)}`;
}

function ovChange(e) {
  const changes = e.changes || {};
  // "Sent to polish" already says the watch no longer needs polish.
  const keys = Object.keys(changes).filter((k) => !(k === 'needPolish' && 'polish' in changes));
  const what =
    { create: 'Added', delete: 'Removed', restore: 'Back again' }[e.action] ||
    keys
      .slice(0, 2)
      .map((k) => ovWords(e.item.kind, k, changes[k]))
      .join(', ') + (keys.length > 2 ? `, and ${keys.length - 2} more` : '') ||
    'Updated';
  const who = e.source === 'user' ? e.user_name || 'a masterapp user' : 'the logistics app';
  return `<li><time datetime="${esc(e.at)}" title="${esc(fmtWhen(e.at))}">${esc(ovAgo(e.at))}</time>
    <div class="ov-row-main">
      <a class="ov-title" href="#/lg/${e.item.id}">${esc(e.item.summary.title)}</a>
      <div class="ov-meta"><span>${stockLinksOf(e.item)}</span><span>${esc(what)}</span><span>by ${esc(who)}${
        e.earlier ? `, ${e.earlier} earlier change${e.earlier === 1 ? '' : 's'}` : ''
      }</span></div>
    </div></li>`;
}

/* What logistics has cost: one figure in a currency of your choosing, at the converter's rates, and each currency's own. */
function renderOverviewCost(c) {
  const parts = Object.entries(c.by_currency).sort(([a], [b]) => a.localeCompare(b));
  const R = c.rates?.table || {};
  const targets = c.targets.filter((t) => R[t]);
  const target = R[ov.costIn] ? ov.costIn : 'USD';
  let total = 0;
  const left = [];
  const rows = parts.map(([cur, v]) => {
    let conv = '';
    if (R[cur] && R[target]) {
      const n = (v.amount / R[cur]) * R[target];
      total += n;
      if (cur !== target) conv = `≈ ${money(Math.round(n), target)}`;
    } else left.push(cur);
    const amount = cur === 'OTHER' ? `${money(v.amount, null)} (no currency)` : money(v.amount, cur);
    return `<tr><th>${amount}</th><td>${conv || (left.includes(cur) ? 'no rate' : '')}</td><td>${esc(v.count)} payment${v.count === 1 ? '' : 's'}</td></tr>`;
  });
  const note = c.rates
    ? `All currencies added up at today’s ${c.rates.kind === 'daily' ? 'daily' : 'live'} rates${c.rates.stale ? ' (not the newest)' : ''}${left.length ? `. Not counted, no rate: ${left.join(', ')}` : ''}.`
    : 'No exchange rates yet — the total shows at the next refresh.';
  const hadFocus = document.activeElement?.id === 'ov-costin';
  $('#ov-cost').innerHTML =
    ovHead('Logistics costs since the start', null, '#/logistics/costs', 'See all costs') +
    (parts.length
      ? `<div class="ov-cost-top"><div class="ov-cost-total" data-nofx>${c.rates ? money(Math.round(total * 100) / 100, target) : '—'}</div>
           ${
             targets.length
               ? `<label class="ov-cost-in">Show in <select id="ov-costin">${targets.map((t) => `<option${t === target ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></label>`
               : ''
           }</div>
         ${ovExplain(note)}
         <table class="ov-curtable" data-nofx><tbody>${rows.join('')}</tbody></table>`
      : ovEmpty('No logistics costs yet.'));
  $('#ov-costin')?.addEventListener('change', (e) => {
    ov.costIn = e.target.value;
    renderOverviewCost(c);
  });
  if (hadFocus) $('#ov-costin')?.focus();
}

/* Need polish: the flagged watches — Send to polish for one still here, Back from polish for one at the polisher. */
function renderOverviewPolish(rows) {
  const box = $('#ov-polish');
  if (!box) return;
  const editor = can('editor');
  box.innerHTML =
    ovHead('Need polish', rows.length, '#/logistics/services', 'See the polish list') +
    (rows.length ? ovExplain(editor ? 'Press Send to polish when a watch goes to the polisher, and Back from polish when it returns.' : 'Watches marked for polish.') : '') +
    '<div id="ov-polish-form"></div><div id="ov-polish-rows"></div>';
  renderOverviewPolishRows(rows);
}

/* The rows alone — "Show all" and the minute refresh redraw these, never an open form above them. */
function renderOverviewPolishRows(rows) {
  const host = $('#ov-polish-rows');
  if (!host) return;
  const editor = can('editor');
  host.innerHTML = ovList(
    'polish',
    rows,
    (r) => `<div class="ov-row">
      <div class="ov-row-main">
        <a class="ov-title" href="#/lg/${r.id}">${esc(r.model ? [r.model, r.reference].filter(Boolean).join(' ') : r.summary.title)}</a>
        <div class="ov-meta"><span>${stockLinksOf(r)}</span><span>${esc(r.place)}</span>${
          r.polish
            ? `<span class="ov-warn-text">at the polisher${r.polish.sentTo ? `: ${esc(r.polish.sentTo)}` : ''}${r.polish.sentDate ? `, since ${esc(lgWhen(r.polish.sentDate))}` : ''}</span>`
            : ''
        }${r.from ? `<span>bought from ${esc(r.from)}</span>` : ''}</div>
      </div>
      <div class="ov-row-side">${
        editor && r.can_polish
          ? r.polish
            ? `<button class="btn" type="button" data-pdone="${r.id}">Back from polish</button>`
            : `<button class="btn" type="button" data-psend="${r.id}">Send to polish</button>`
          : ''
      }</div>
    </div>`,
    'Nothing needs polish.'
  );
  ovListToggles(host, () => renderOverviewPolishRows(rows));
  $$('[data-psend]', host).forEach((b) => b.addEventListener('click', () => polishForm('send', rows.find((r) => String(r.id) === b.dataset.psend))));
  $$('[data-pdone]', host).forEach((b) => b.addEventListener('click', () => polishForm('done', rows.find((r) => String(r.id) === b.dataset.pdone))));
}

function polishForm(action, r) {
  ov.form = action;
  const today = localDay();
  const host = $('#ov-polish-form');
  const title = `${r.stock_nos.length ? `#${r.stock_nos.join(', #')} · ` : ''}${r.model || r.summary.title}`;
  host.innerHTML =
    action === 'send'
      ? `<form class="ov-form" id="ov-pform"><span class="ov-form-title">Send to polish: ${esc(title)}</span>
          <div class="form-grid" style="margin-top:8px">
            <label>Polisher *<input type="text" name="sentTo" required></label>
            <label>Taken by<input type="text" name="takenBy"></label>
            <label>What goes<select name="itemDescription"><option value="Full Watch">Full watch</option><option value="Bracelet">Bracelet</option><option value="Case">Case</option><option value="Clasp">Clasp</option><option value="Other">Other</option></select></label>
            <label>Sent on<input type="date" name="sentDate" value="${today}"></label>
            <label>Expected back<input type="date" name="expectedBack"></label>
            <label>Cost<span class="row" style="flex-wrap:nowrap"><input type="text" inputmode="decimal" name="costAmount" placeholder="350"><input type="text" name="costCurrency" value="AED" maxlength="4" style="width:80px" aria-label="Currency"></span></label>
            <label class="wide">Notes<textarea name="notes" rows="2"></textarea></label>
          </div>
          <div class="err" id="ov-perr"></div>
          <div class="row"><button class="btn primary">Send to polish</button><button type="button" class="btn" id="ov-pcancel">Cancel</button></div></form>`
      : `<form class="ov-form" id="ov-pform"><span class="ov-form-title">Back from polish: ${esc(title)}</span> <span class="count">with ${esc(r.polish?.sentTo || 'the polisher')}${r.polish?.sentDate ? ` since ${esc(lgWhen(r.polish.sentDate))}` : ''}</span>
          <div class="form-grid" style="margin-top:8px">
            <label>Back on<input type="date" name="returnedDate" value="${today}"></label>
            <label class="wide">Notes<textarea name="returnNotes" rows="2"></textarea></label>
          </div>
          <div class="err" id="ov-perr"></div>
          <div class="row"><button class="btn primary">Save — back from polish</button><button type="button" class="btn" id="ov-pcancel">Cancel</button></div></form>`;
  host.scrollIntoView({ block: 'nearest' });
  $('#ov-pcancel').addEventListener('click', () => {
    ov.form = null;
    renderOverviewPolish(ov.data.need_polish);
  });
  $('#ov-pform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.target.querySelector('button.primary');
    if (button.disabled) return;
    button.disabled = true;
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      const res = await api(`/api/logistics/items/${r.id}/polish`, { method: 'POST', body: { action, ...body } });
      flash(action === 'send' ? `Sent to polish${res.cost ? ' — its cost is in Logistics costs' : ''}` : 'Back from polish — back in stock');
      ov.form = null;
      loadOverview(() => location.hash === '#/logistics' || location.hash === '#/logistics/overview');
    } catch (err) {
      button.disabled = false;
      if ($('#ov-perr')) $('#ov-perr').textContent = err.message;
    }
  });
}

/* Search everything — our watches and clients, and the logistics records; nothing twice. */
const OV_SCOPES = [
  ['all', 'All'],
  ['stock', 'In stock'],
  ['sold', 'Sold'],
  ['incoming', 'Coming in'],
  ['shipments', 'Shipments'],
  ['clients', 'Clients'],
  ['transactions', 'Accessories'],
];
let ovSearchSeq = 0;
function renderOverviewSearch() {
  const S = ov.search;
  $('#ov-search').innerHTML = `${ovHead('Search everything', null)}
    ${ovExplain('Find a watch, a client, a shipment or a tracking number.')}
    <input class="q" type="search" id="ov-q" aria-label="Search everything" placeholder="e.g. 1743, Daytona, 126500LN, a client, a tracking number" value="${esc(S.q)}" autocomplete="off">
    <div class="pills" id="ov-scopes" style="margin-top:10px">${OV_SCOPES.map(([k, l]) => `<button type="button" class="pill ${S.scope === k ? 'on' : ''}" data-scope="${k}" aria-pressed="${S.scope === k}">${esc(l)}</button>`).join('')}</div>
    <div id="ov-results"></div>`;
  $('#ov-q').addEventListener('input', (e) => {
    clearTimeout(ov.typing);
    ov.typing = setTimeout(() => {
      S.q = e.target.value;
      runOverviewSearch();
    }, 220);
  });
  $$('#ov-scopes .pill').forEach((b) =>
    b.addEventListener('click', () => {
      S.scope = b.dataset.scope;
      $$('#ov-scopes .pill').forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      });
      runOverviewSearch();
    })
  );
  if (S.q) runOverviewSearch();
}

async function runOverviewSearch() {
  const S = ov.search;
  const seq = ++ovSearchSeq;
  if (!$('#ov-results')) return;
  if (!S.q.trim()) {
    $('#ov-results').innerHTML = '';
    return;
  }
  let r;
  try {
    r = await api(`/api/logistics/search?${new URLSearchParams({ q: S.q, scope: S.scope })}`);
  } catch (err) {
    const what = err instanceof TypeError ? 'The connection dropped — type again in a moment.' : `The search did not work (${err.message}). Try again.`;
    if (seq === ovSearchSeq && $('#ov-results')) $('#ov-results').innerHTML = `<p class="err">${esc(what)}</p>`;
    return;
  }
  const out = $('#ov-results');
  if (seq !== ovSearchSeq || !out) return;
  const watchRows = r.watches.map(
    (w) => `<a class="lg-line" href="#/watch/${w.id}"><span class="lg-stock">#${esc(w.stock_no)}</span><span class="grow"><span class="ov-strong">${esc(w.title)}</span>${
      w.now ? ` <span class="count" style="margin:0">· ${esc(w.now.headline)}</span>` : w.location ? ` <span class="count" style="margin:0">· ${esc(w.location)}</span>` : ''
    }</span>${chip(w.status)}</a>`
  );
  const clientRows = r.clients.map(
    (c) => `<a class="lg-line" href="#/client/${c.id}"><span class="lg-stock">Client</span><span class="grow"><span class="ov-strong">${esc(c.name)}</span>${
      c.country ? ` <span class="count" style="margin:0">· ${esc(c.country)}</span>` : ''
    }</span><span class="count" style="margin:0">${esc(c.bought)} bought · ${esc(c.sold)} sold</span></a>`
  );
  const recordRows = r.records.map(
    (i) => `<div class="lg-line"><span>${stockLinksOf(i) || `<span class="lg-stock">${esc(i.kind_label)}</span>`}</span><a class="grow" href="${i.kind === 'clients' ? `#/lg-client/${i.id}` : `#/lg/${i.id}`}" style="color:inherit;text-decoration:none"><span class="ov-strong">${esc(i.summary.title)}</span>${
      i.summary.sub ? ` <span class="count" style="margin:0">· ${esc(i.summary.sub)}</span>` : ''
    } <span class="count" style="margin:0">· ${esc(i.kind_label)}</span></a>${lgChip(i.summary.status)}</div>`
  );
  const group = (label, rows) => (rows.length ? `<h3 class="ov-subh">${esc(label)}<span class="ov-n">${rows.length}</span></h3>${rows.join('')}` : '');
  const found = group('Watches', watchRows) + group('Clients', clientRows) + group('Other logistics entries', recordRows);
  if (found) {
    out.innerHTML = found;
    return;
  }
  // Nothing: say so, and offer the way out — the whole search when a chip narrowed it.
  const label = OV_SCOPES.find(([k]) => k === S.scope)?.[1] || 'All';
  out.innerHTML = `<div class="ov-empty"><span class="ov-strong">Nothing matches “${esc(S.q.trim())}”${S.scope === 'all' ? '' : ` in ${esc(label)}`}.</span>
    ${S.scope === 'all' ? 'Try a stock number, or one word of the name.' : '<button type="button" class="btn small" id="ov-search-all">Search all instead</button>'}</div>`;
  $('#ov-search-all')?.addEventListener('click', () => $('#ov-scopes [data-scope="all"]').click());
}

/* ── one record─────────────────────────────────────────────────── */

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
        ${it.kind === 'clients' && !it.deleted_at ? `<p style="margin:6px 0 0"><a class="ov-more" href="#/lg-client/${it.id}">See their logistics situation</a></p>` : ''}
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

/* ── clients: their logistics situation ─────────────────────────── */

/*
 * Logistics → Clients (asked 24 Oct 2026): every client of the logistics app
 * and its logistics situation alone — what is with them, what is owed either
 * way, their watches and shipments — and which of OUR clients it is (worked
 * out from the watches: src/logistics/clients.js). Our client's own page shows
 * the same situation beside everything else (loadClientLogistics).
 */
const lc = { q: '', filter: 'all' };

/* Why a logistics client is that client of ours, in words. */
function lcReason(link) {
  if (link.how === 'person') return 'chosen by a person';
  if (link.how === 'name') return 'matched by the full name';
  if (link.how === 'watches') {
    const n = link.stocks.length;
    const shown = link.stocks.slice(0, 4).map((s) => `#${s}`).join(', ');
    return `the same watch${n === 1 ? '' : 'es'} in both: ${shown}${n > 4 ? ` and ${n - 4} more` : ''}`;
  }
  return '';
}

/* One line: a title to its page, and plain details under it (each already escaped). */
const lcLine = (title, href, meta = [], side = '') => `<div class="ov-row">
    <div class="ov-row-main">
      <a class="ov-title" href="${href}">${esc(title)}</a>
      <div class="ov-meta">${meta.filter(Boolean).map((m) => `<span>${m}</span>`).join('')}</div>
    </div>${side ? `<div class="ov-row-side">${side}</div>` : ''}
  </div>`;

/* What is open with a client, in the same words as its page. */
const lcOpenWords = (c) =>
  [c.we_give && `${c.we_give} we must give`, c.they_give && `${c.they_give} they must give`, c.shipments_open && `${c.shipments_open} on the way`].filter(Boolean).join(' · ');

/* A search box that only ever shows the answer to what is in it now — an older, slower answer is dropped. */
function lcFinder(input, out, ask, render) {
  let timer;
  let seq = 0;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      const mine = ++seq;
      if (!q) return (out.innerHTML = '');
      let res;
      try {
        res = await ask(q);
      } catch (err) {
        if (mine === seq && out.isConnected) out.innerHTML = `<p class="err">The search did not work (${esc(err.message)}). Try again.</p>`;
        return;
      }
      if (mine === seq && out.isConnected) render(res, q);
    }, 220);
  });
}

async function showLogisticsClients() {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('contacts')}
    <section class="panel ov-panel">
      ${ovHead('Clients', null, '#/logistics/contacts-all', 'See the client records')}
      ${ovExplain('Every client in the logistics app, and which of our clients it is. Open one to see what is happening with them.')}
      <input class="q" type="search" id="lcq" aria-label="Search the clients" placeholder="A name, a country, or our client's name" value="${esc(lc.q)}" autocomplete="off">
      <div class="pills" id="lc-filters" style="margin-top:10px">${[
        ['all', 'All'],
        ['open', 'Something open'],
        ['unlinked', 'Not linked yet'],
      ]
        .map(([k, l]) => `<button type="button" class="pill ${lc.filter === k ? 'on' : ''}" data-f="${k}" aria-pressed="${lc.filter === k}">${esc(l)}</button>`)
        .join('')}</div>
      <div id="lc-rows">${ovSkeleton}</div>
    </section>`;
  let r;
  let loadSeq = 0;
  const draw = () => {
    const rows = r.clients.filter((c) => (lc.filter === 'open' ? lcOpenWords(c) : lc.filter === 'unlinked' ? !c.us && !c.link.client_id : true));
    const filtered = lc.q || lc.filter !== 'all';
    $('#lc-rows').innerHTML =
      `<p class="ov-explain" style="margin-top:12px">${esc(`${r.linked} linked to our clients, ${r.unlinked} not yet.`)}</p>` +
      (rows.length
        ? ovList(
            'lc-list',
            rows,
            (c) =>
              lcLine(
                c.name,
                `#/lg-client/${c.id}`,
                [
                  esc(c.country),
                  c.us
                    ? 'one of our own locations'
                    : c.link.client_id
                      ? `our client <a href="#/client/${c.link.client_id}">${esc(c.link.client_name)}</a>`
                      : '<span class="ov-warn-text">not linked to our clients yet</span>',
                  c.watches ? esc(`${c.watches} watch${c.watches === 1 ? '' : 'es'}`) : '',
                ],
                lcOpenWords(c) ? `<span class="chip lg-warn">${esc(lcOpenWords(c))}</span>` : ''
              ),
            '',
            40
          )
        : `<div class="ov-empty">${filtered ? `<span class="ov-strong">No client matches${lc.q ? ` “${esc(lc.q)}”` : ''}${lc.filter !== 'all' ? ' with this filter' : ''}.</span> <button type="button" class="btn small" id="lc-clear">Show all clients</button>` : 'The logistics app has no clients yet.'}</div>`);
    ovListToggles($('#lc-rows'), draw);
    $('#lc-clear')?.addEventListener('click', () => {
      lc.q = '';
      lc.filter = 'all';
      showLogisticsClients();
    });
  };
  const load = async () => {
    const mine = ++loadSeq;
    try {
      r = await api(`/api/logistics/client-list?${new URLSearchParams({ q: lc.q })}`);
    } catch (err) {
      const box = $('#lc-rows');
      if (seq === lgPage && mine === loadSeq && box) box.innerHTML = `<p class="err">The clients could not be loaded (${esc(err.message)}). Try again in a moment.</p>`;
      return;
    }
    if (seq === lgPage && mine === loadSeq && $('#lc-rows')) draw();
  };
  let timer;
  $('#lcq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      lc.q = e.target.value.trim();
      load();
    }, 220);
  });
  $$('#lc-filters .pill').forEach((b) =>
    b.addEventListener('click', () => {
      lc.filter = b.dataset.f;
      $$('#lc-filters .pill').forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-pressed', String(x === b));
      });
      if (r) draw();
    })
  );
  await load();
}

/* The situation's figures, as tiles that take you to their list. */
function lcTiles(n, prefix) {
  const tile = (tone, label, value, help, to) =>
    `<a class="ov-tile ${tone}" href="#" data-to="${prefix}-${to}"><span class="ov-tile-label">${esc(label)}</span><b>${esc(value)}</b><small>${esc(help)}</small></a>`;
  return `<div class="ov-tiles lc-tiles">${[
    tile('', 'Watches', n.stocks, 'bought from them or sold to them', 'stocks'),
    tile('blue', 'With them now', n.with_them, 'on consignment, sold and not delivered, in our safe', 'with'),
    tile(n.we_give ? 'bad' : 'good', 'We must give', n.we_give, n.we_give ? `item${n.we_give === 1 ? '' : 's'} still to give them` : 'nothing — all given', 'acc'),
    tile(n.they_give ? 'warn' : 'good', 'They must give', n.they_give, n.they_give ? `item${n.they_give === 1 ? '' : 's'} still to come from them` : 'nothing — all received', 'acc'),
    tile('blue', 'On the way', n.shipments_open, `shipment${n.shipments_open === 1 ? '' : 's'} not delivered · ${n.shipments} in all`, 'ships'),
  ].join('')}</div>`;
}
const lcTileClicks = (root) =>
  $$('[data-to]', root).forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(a.dataset.to)?.scrollIntoView({ block: 'start' });
    })
  );

const LC_DIR = { bought: 'Bought from them', sold: 'Sold to them', incoming: 'Coming in from them' };
const lcItems = (items) => items.map((it) => (typeof it === 'string' ? esc(it) : `${esc(it.accessory)}${it.qty > 1 ? ` × ${esc(it.qty)}` : ''}`)).join(', ');

/* The panels of a situation: what is with them, the accessories, their watches, the shipments, the history. */
function lcPanels(s, prefix, level = 'h2') {
  const head = (title, n) => ovHead(title, n, '', '', level);
  const sub = level === 'h2' ? 'h3' : 'h5';
  const acc = s.accessories;
  const accLine = (l) => lcLine(`#${l.stock || '—'}${l.title ? ` ${l.title}` : ''}`, `#/lg/${l.tx}`, [lcItems(l.items)]);
  const accessories =
    acc.we_give.length || acc.they_give.length || acc.missing.length
      ? `${acc.we_give.length ? `<${sub} class="ov-subh">We must give them</${sub}>${acc.we_give.map(accLine).join('')}` : ''}
         ${
           acc.they_give.length || acc.missing.length
             ? `<${sub} class="ov-subh">They must give us</${sub}>${acc.they_give.map(accLine).join('')}${acc.missing
                 .map((m) => lcLine(`#${m.stock}`, '#/logistics/stock', [`arrived without: ${lcItems(m.items)}`]))
                 .join('')}`
             : ''
         }`
      : ovEmpty('Nothing is owed either way.');
  return {
    with: head('With them now', s.with_them.length) + ovExplain('Watches with them, or theirs with us, right now.') +
      ovList(`${prefix}-with`, s.with_them, (w) => lcLine(w.item.summary.title, `#/lg/${w.item.id}`, [esc(w.label), stockLinksOf(w.item), esc(w.item.summary.sub)]), 'Nothing is with them right now.'),
    acc: head('Accessories still to settle', null) + ovExplain('Boxes, papers and other items, by watch.') + accessories,
    stocks:
      head('Their watches', s.stocks.length) +
      ovExplain('Every watch bought from them or sold to them, newest first, and where it is now.') +
      ovList(
        `${prefix}-stocks`,
        s.stocks,
        (w) =>
          lcLine(w.title, w.watch ? `#/watch/${w.watch.id}` : `#/lg/${w.item}`, [
            esc(LC_DIR[w.dir] || w.dir),
            w.watch ? `<a class="lg-stock" href="#/watch/${w.watch.id}">#${esc(w.stock)}</a>` : `<span class="lg-stock">#${esc(w.stock)}</span>`,
            w.now ? `now: ${esc(w.now.headline)}` : '',
            w.date ? esc(lgWhen(w.date.slice(0, 10))) : '',
          ]),
        'No watches with them in the logistics app.'
      ),
    ships:
      head('Shipments', s.shipments.length) +
      ovExplain('To them and from them — the ones not delivered first.') +
      ovList(
        `${prefix}-ships`,
        s.shipments,
        (x) => lcLine(x.item.summary.title, `#/lg/${x.item.id}`, [x.dir === 'to_them' ? 'to them' : 'from them', stockLinksOf(x.item), esc(x.item.summary.sub)], lgChip(x.item.summary.status)),
        'No shipments to or from them.'
      ),
    hist:
      head('Already given and collected', null) +
      (s.history_total > s.history.length ? ovExplain(`The newest ${s.history.length} of ${s.history_total}.`) : '') +
      ovList(
        `${prefix}-hist`,
        s.history,
        (h) => lcLine(`${h.dir === 'given' ? 'Given' : 'Collected'}: ${h.accessory}${h.qty > 1 ? ` × ${h.qty}` : ''}`, `#/lg/${h.tx}`, [h.stock ? `#${esc(h.stock)}` : '', h.at ? esc(lgWhen(h.at)) : '']),
        'Nothing given or collected yet.'
      ),
  };
}

/* Our client, on a button that links them: the name, and what tells two of the same name apart. */
const lcClientButton = (c) =>
  `<button type="button" class="btn small" data-pick="${c.id}" data-name="${esc(c.name)}">Link to ${esc(c.name)}${[
    c.company,
    c.type && clientTypeLabel(c.type),
    c.country,
    c.phone && `phone …${String(c.phone).replace(/\D/g, '').slice(-4)}`,
    `${c.bought} bought · ${c.sold} sold`,
  ]
    .filter(Boolean)
    .map((x) => ` · ${esc(x)}`)
    .join('')}</button>`;

async function showLogisticsClient(id) {
  const seq = ++lgPage;
  const here = () => seq === lgPage && location.hash === `#/lg-client/${id}`;
  $('#app').innerHTML = `${lgHeader('contacts')}<a href="#/logistics/contacts" class="count lc-back" style="text-decoration:none">← Clients</a><div id="lc-page">${ovSkeleton}</div>`;
  let v;
  try {
    v = await api(`/api/logistics/client-view/${id}`);
  } catch (err) {
    if (here() && $('#lc-page')) $('#lc-page').innerHTML = `<p class="err">This client could not be loaded (${esc(err.message)}).</p>`;
    return;
  }
  if (!here() || !$('#lc-page')) return;
  const PANELS = [
    ['with', 1, 'left'],
    ['acc', 2, 'left'],
    ['ships', 4, 'left'],
    ['stocks', 3, 'right'],
    ['hist', 5, 'right'],
  ];
  $('#lc-page').innerHTML = `
    <h2 class="lg-title">${esc(v.name)}</h2>
    <p class="sub">${[v.country, v.phone, v.notes].filter(Boolean).map(esc).join(' · ') || 'Logistics client'}</p>
    <section class="panel ov-panel lc-link" id="lc-link"></section>
    ${lcTiles(v.situation.counts, 'lc')}
    <div class="ov-cols">
      <div class="ov-stack">${PANELS.filter((p) => p[2] === 'left').map(([k, o]) => `<section class="panel ov-panel" id="lc-${k}" style="order:${o}"></section>`).join('')}</div>
      <div class="ov-stack">${PANELS.filter((p) => p[2] === 'right').map(([k, o]) => `<section class="panel ov-panel" id="lc-${k}" style="order:${o}"></section>`).join('')}</div>
    </div>`;
  lcTileClicks($('#lc-page'));
  // Each panel redraws itself only ("Show all"), never the link box above with a search typed in it.
  const drawPanel = (key) => {
    const box = $(`#lc-${key}`);
    if (!box) return;
    box.innerHTML = lcPanels(v.situation, 'lc')[key];
    ovListToggles(box, () => drawPanel(key));
  };
  PANELS.forEach(([k]) => drawPanel(k));

  const setLink = async (clientId, buttons) => {
    buttons.forEach((b) => (b.disabled = true));
    try {
      await api(`/api/logistics/client-view/${v.id}/link`, { method: 'PUT', body: { client_id: clientId } });
      flash(clientId === null ? 'Marked as not our client' : clientId === 'auto' ? 'Worked out again from the watches' : 'Linked to our client');
      if (location.hash === `#/lg-client/${v.id}`) showLogisticsClient(v.id);
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      flash(err.message, true);
    }
  };
  const box = $('#lc-link');
  const L = v.link;
  const editor = can('editor');
  const same = v.same_name.length
    ? `<p class="ov-explain">Also in the logistics app with the same name: ${v.same_name.map((x) => `<a href="#/lg-client/${x.id}">${esc(x.name)}</a>${x.country ? ` (${esc(x.country)})` : ''}`).join(', ')}.</p>`
    : '';
  box.innerHTML = v.us
    ? '<p class="ov-explain" style="margin:0">This is one of our own locations in the logistics app, not a client.</p>'
    : `${
        L.client_id
          ? `<p class="lc-who">Our client: <a href="#/client/${L.client_id}">${esc(L.client_name)}</a> <span class="count" style="margin:0">— ${esc(lcReason(L))}</span></p>`
          : `<p class="lc-who">${L.how === 'person' ? 'A person said this is not one of our clients.' : 'Not linked to one of our clients yet.'}</p>${
              v.candidates.length
                ? `<p class="ov-explain">It may be: ${v.candidates
                    .map((x) =>
                      editor
                        ? `<button type="button" class="btn small" data-link="${x.client_id}">Link to ${esc(x.name)}${x.stocks.length ? ` — ${x.stocks.length} watch${x.stocks.length === 1 ? '' : 'es'} in both` : ' — same name'}</button>`
                        : `<a href="#/client/${x.client_id}">${esc(x.name)}</a>`
                    )
                    .join(' ')}</p>`
                : ''
            }`
      }${same}${editor ? '<div class="row"><button type="button" class="btn small" id="lc-change">Choose another client</button></div><div id="lc-chooser"></div>' : ''}`;
  $$('#lc-link [data-link]').forEach((b) => b.addEventListener('click', () => setLink(Number(b.dataset.link), $$('#lc-link button'))));
  $('#lc-change')?.addEventListener('click', () => {
    $('#lc-chooser').innerHTML = `<div class="ov-form">
        <label>Our client<input type="search" id="lc-find" placeholder="A name, a company or a phone number" autocomplete="off"></label>
        <div id="lc-found"></div>
        <div class="row" style="margin-top:8px">
          <button type="button" class="btn small" id="lc-none">Mark as not our client</button>
          ${L.how === 'person' ? '<button type="button" class="btn small" id="lc-auto">Work it out from the watches again</button>' : ''}
          <button type="button" class="btn small" id="lc-cancel">Cancel</button>
        </div></div>`;
    $('#lc-find').focus();
    lcFinder($('#lc-find'), $('#lc-found'), (q) => api(`/api/clients?${new URLSearchParams({ q, limit: 8 })}`), (res) => {
      $('#lc-found').innerHTML = res.clients.length ? res.clients.map(lcClientButton).join(' ') : '<p class="ov-explain">No client of ours matches.</p>';
      $$('#lc-found [data-pick]').forEach((b) => b.addEventListener('click', () => setLink(Number(b.dataset.pick), $$('#lc-link button'))));
    });
    $('#lc-chooser').addEventListener('keydown', (e) => {
      if (e.key === 'Escape') $('#lc-cancel').click();
    });
    $('#lc-none').addEventListener('click', () => setLink(null, $$('#lc-link button')));
    $('#lc-auto')?.addEventListener('click', () => setLink('auto', $$('#lc-link button')));
    $('#lc-cancel').addEventListener('click', () => {
      $('#lc-chooser').innerHTML = '';
      $('#lc-change')?.focus();
    });
  });
}

/*
 * Our client's page: the logistics situation beside everything else — the
 * logistics client(s) that are them, what is with them and owed either way,
 * shipments on the way — and where each of their watches is now. When none is
 * linked yet: the logistics clients that may be them, to link in one tap.
 * Read once per visit: Edit and Cancel, and "Show all", draw it again from what
 * was read.
 */
const lcOurs = { id: null, r: null };
async function loadClientLogistics(c, { fresh = false } = {}) {
  const box = $('#c-logistics');
  if (!box) return;
  if (fresh || lcOurs.id !== c.id || !lcOurs.r) {
    let r;
    try {
      r = await api(`/api/clients/${c.id}/logistics`);
    } catch (err) {
      if (box.isConnected && location.hash === `#/client/${c.id}`) box.innerHTML = `<h3>Logistics</h3><p class="err">The logistics situation could not be loaded (${esc(err.message)}).</p>`;
      return;
    }
    Object.assign(lcOurs, { id: c.id, r });
  }
  const now = $('#c-logistics');
  if (now && location.hash === `#/client/${c.id}`) renderClientLogistics(c, now, lcOurs.r);
}

function renderClientLogistics(c, box, r) {
  $$('.cw-now').forEach((el) => {
    const n = r.watch_now[el.dataset.stock];
    el.textContent = n ? `now: ${n.headline}` : '';
  });
  const editor = can('editor');
  const link = async (lc0, buttons) => {
    // A logistics client already linked to another of our clients moves only when the person says so.
    if (lc0.link?.client_id && lc0.link.client_id !== c.id && !window.confirm(`${lc0.name} is linked to ${lc0.link.client_name}. Link it to ${c.name} instead?`)) return;
    buttons.forEach((b) => (b.disabled = true));
    try {
      await api(`/api/logistics/client-view/${lc0.id}/link`, { method: 'PUT', body: { client_id: c.id } });
      flash('Linked to the logistics client');
      if (location.hash === `#/client/${c.id}`) loadClientLogistics(c, { fresh: true });
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      flash(err.message, true);
    }
  };
  if (!r.situation) {
    box.innerHTML = `<h3>Logistics</h3>
      <p class="ov-explain" style="margin-top:0">Not linked to a client in the logistics app yet.</p>
      ${
        r.suggestions.length
          ? `<p class="ov-explain">It may be: ${r.suggestions
              .map((x) =>
                editor
                  ? `<button type="button" class="btn small" data-lc="${x.id}">Link to ${esc(x.name)}${x.country ? ` (${esc(x.country)})` : ''}${x.stocks.length ? ` — ${x.stocks.length} watch${x.stocks.length === 1 ? '' : 'es'} in both` : ''}</button>`
                  : `<a href="#/lg-client/${x.id}">${esc(x.name)}</a>`
              )
              .join(' ')}</p>`
          : ''
      }
      ${editor ? '<label class="count" style="display:block;margin:8px 0 0">Find them in the logistics app<input type="search" id="clg-find" placeholder="Their name there" autocomplete="off"></label><div id="clg-found"></div>' : ''}`;
    $$('#c-logistics [data-lc]').forEach((b) =>
      b.addEventListener('click', () => link(r.suggestions.find((x) => String(x.id) === b.dataset.lc) || { id: Number(b.dataset.lc) }, $$('#c-logistics button')))
    );
    if ($('#clg-find')) {
      lcFinder($('#clg-find'), $('#clg-found'), (q) => api(`/api/logistics/client-list?${new URLSearchParams({ q })}`), (res) => {
        const list = res.clients.filter((x) => !x.us).slice(0, 8);
        $('#clg-found').innerHTML = list.length
          ? list
              .map(
                (x) =>
                  `<button type="button" class="btn small" data-lc="${x.id}">Link to ${esc(x.name)}${x.country ? ` (${esc(x.country)})` : ''}${x.watches ? ` · ${x.watches} watch${x.watches === 1 ? '' : 'es'}` : ''}${
                    x.link.client_id ? ` · now linked to ${esc(x.link.client_name)}` : ''
                  }</button>`
              )
              .join(' ')
          : '<p class="ov-explain">Nobody in the logistics app matches.</p>';
        $$('#clg-found [data-lc]').forEach((b) => b.addEventListener('click', () => link(list.find((x) => String(x.id) === b.dataset.lc), $$('#c-logistics button'))));
      });
    }
    return;
  }
  const s = r.situation;
  const n = s.counts;
  const fig = (value, label, tone = '') => `<div class="${tone}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
  box.innerHTML = `<h3>Logistics</h3>
    <p class="lc-who" style="margin-top:0">In the logistics app: ${r.linked
      .map((x) => `<a href="#/lg-client/${x.id}">${esc(x.name)}</a>${x.country ? ` (${esc(x.country)})` : ''} <span class="count" style="margin:0">— ${esc(lcReason(x.link))}</span>`)
      .join('<br>')}</p>
    <div class="lc-figs">
      ${fig(n.with_them, 'with them now')}
      ${fig(n.we_give, n.we_give === 1 ? 'item we must give' : 'items we must give', n.we_give ? 'give' : '')}
      ${fig(n.they_give, n.they_give === 1 ? 'item they must give' : 'items they must give', n.they_give ? 'owed' : '')}
      ${fig(n.shipments_open, 'on the way')}
    </div>
    <div class="lc-part" id="clg-with"></div>
    <div class="lc-part" id="clg-acc"></div>
    <div class="lc-part" id="clg-ships"></div>
    <p style="margin:12px 0 0">${r.linked.map((x) => `<a class="ov-more" href="#/lg-client/${x.id}">See everything for ${esc(x.name)} in Logistics</a>`).join('<br>')}</p>`;
  const drawPart = (key) => {
    const part = $(`#clg-${key}`);
    if (!part) return;
    part.innerHTML = lcPanels(s, 'clg', 'h4')[key];
    ovListToggles(part, () => drawPart(key));
  };
  ['with', 'acc', 'ships'].forEach(drawPart);
}

/* ── on a watch's page ──────────────────────────────────────────── */

const TONE_CLASS = { here: 'here', moving: 'moving', away: 'away', sold: 'sold' };

/*
 * The watch's accessories (asked 26 Oct 2026: "what is missing against that
 * watch and what we have"), in their own panel under Logistics: what it has
 * (Chrono Key's box / papers / service papers / accessories, what the place's
 * stock row says came with it, what a client has since handed over), what is
 * missing (Chrono Key's "no", the stock row's missing, what a client still
 * owes us, the To collect list), what we owe a buyer, and what we gave. Each
 * line says where it comes from and opens that record.
 */
function renderWatchAccessories() {
  const box = $('#acc-panel');
  const A = current?.logistics?.accessories;
  if (!box) return;
  if (!A) {
    box.hidden = true;
    return;
  }
  const ck = A.chrono_key || {};
  const CK = [['box', 'Box'], ['papers', 'Papers'], ['service_papers', 'Service papers']];
  const tag = (t, tone = '') => `<span class="lg-tag ${tone}">${esc(t)}</span>`;
  const line = (src, tags, href) =>
    tags.length ? `<div class="acc-src"><span class="count">${href ? `<a href="${href}">${src}</a>` : src}</span><span class="lg-ov" style="margin:0">${tags.join('')}</span></div>` : '';
  const who = (x, dir) => (x.client ? `${dir} ${esc(x.client.name)}` : x.type === 'sold' ? 'Sold' : 'Bought');
  const groups = [
    [
      'Has',
      [
        line('Chrono Key', [...CK.filter(([k]) => ck[k] === true).map(([, l]) => tag(l)), ...(ck.accessories ? [tag(ck.accessories)] : [])]),
        ...A.places.map((p) => line(`With it in ${esc(p.place)}`, p.present.map((x) => tag(x)), `#/lg/${p.id}`)),
        ...A.received.map((t) => line(`${who(t, 'Received from')}`, t.items.map((x) => tag(x)), `#/lg/${t.id}`)),
      ],
    ],
    [
      'Missing',
      [
        line('Chrono Key', CK.filter(([k]) => ck[k] === false).map(([, l]) => tag(`No ${l.toLowerCase()}`, 'warn'))),
        ...A.places.map((p) => line(`Missing in ${esc(p.place)}`, p.missing.map((x) => tag(x, 'warn')), `#/lg/${p.id}`)),
        ...A.owed_to_us.map((t) => line(`${who(t, 'To collect from')}`, t.items.map((x) => tag(x, 'warn')), `#/lg/${t.id}`)),
        ...A.to_collect.map((c) => line(`To collect${c.who ? ` from ${esc(c.who)}` : ''}`, c.items.map((x) => tag(x, 'warn')), `#/lg/${c.id}`)),
      ],
    ],
    [
      'We owe',
      [
        ...A.we_owe.map((t) => line(`${who(t, 'To give')}`, t.items.map((x) => tag(x, 'problem')), `#/lg/${t.id}`)),
        ...A.to_give.map((g) => line(`To give${g.who ? ` ${esc(g.who)}` : ''}${g.in_safe ? ' · in our safe' : ''}`, g.items.map((x) => tag(x, 'problem')), `#/lg/${g.id}`)),
      ],
    ],
    ['Given', A.given.map((t) => line(`${who(t, 'Given to')}`, t.items.map((x) => tag(x)), `#/lg/${t.id}`))],
  ]
    .map(([title, lines]) => [title, lines.filter(Boolean)])
    .filter(([, lines]) => lines.length);
  if (!groups.length) {
    box.hidden = true;
    return;
  }
  // How many accessories, not how many lines: a box missing in Dubai and still owed by the client is one box.
  const distinct = (lists) => new Set(lists.flat().map((x) => String(x).replace(/ × \d+$/, '').trim().toLowerCase()).filter(Boolean)).size;
  const missing = distinct([...A.places.map((p) => p.missing), ...A.owed_to_us.map((t) => t.items), ...A.to_collect.map((c) => c.items), CK.filter(([k]) => ck[k] === false).map(([, l]) => l)]);
  const owe = distinct([...A.we_owe.map((t) => t.items), ...A.to_give.map((g) => g.items)]);
  const note = [missing && `${missing} missing`, owe && `${owe} to give`].filter(Boolean).join(' · ');
  box.hidden = false;
  box.innerHTML = fold(
    'accessories',
    `Accessories${note ? ` <span class="fold-note">· ${note}</span>` : ''}`,
    groups.map(([title, lines]) => `<div class="lg-section"><h3>${esc(title)}</h3>${lines.join('')}</div>`).join('')
  );
}

/** The "right now" line under the watch's status, and its logistics panel. */
function renderWatchLogistics() {
  renderWatchAccessories();
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
  const txPending = (L.transactions || []).reduce((a, x) => a + x.pending, 0);
  const sections = [
    L.costs.lines.length && {
      key: 'lg-cost',
      label: `What it cost — ${plural(L.costs.lines.length, 'line')}`,
      // Each currency's own total first — what the one figure above is made of.
      body: (t && totals.length > 1 ? `<p class="count" style="margin:0 0 6px">By currency: ${totals.map(([cur, n]) => money(n, cur === '?' ? '' : cur)).join(' · ')}</p>` : '') + L.costs.lines
        .map((c) => `<div class="sold-row"><span><a href="#/lg/${c.itemId}">${esc(c.source)}</a> · ${esc(c.title || '')}${c.detail ? ` <span class="count" style="margin:0">${esc(c.detail)}</span>` : ''}</span><span>${money(c.amount, c.currency || '')} <span class="count">${esc(fmtDate(c.date))}</span></span></div>`)
        .join(''),
    },
    // Its accessory transactions, beside what it cost (asked 26 Oct 2026: on the watch's page, not its tile).
    L.transactions?.length && {
      key: 'lg-tx',
      label: `Transactions — ${L.transactions.length}${txPending ? ` · ${txPending} pending` : ''}`,
      body: L.transactions.map(txBlock).join(''),
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
