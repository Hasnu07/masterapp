/*
 * Sheets and Ask (asked 7 Nov 2026) — the console's part. Loaded after app.js
 * and uses its helpers ($, esc, api, flash, can, money, state).
 *
 *   #/sheets         the kept sheets, and "New sheet": what do you want —
 *                    logistics / accounting / client situation / stock
 *                    situation — then for which stock or client, a preview,
 *                    and the sheet
 *   #/sheet/<id>     the sheet: a grid with cells edited in place, formulas
 *                    (=SUM(F2:F9), =IF(…)), sums under every money column,
 *                    search, sort, add row / column, CSV and PDF. An edit
 *                    changes the sheet at once (saved on its own); a cell that
 *                    is the system's (a watch's field) then asks: put it in
 *                    the system too? — and only then is the watch changed,
 *                    through the same API as its edit form.
 *   #/ask            the assistant: conversations on the left, one open on
 *                    the right; what it did (its SQL) under each answer.
 */
'use strict';

/*
 * A question over the page in the console's own window (no native confirm()
 * or prompt(): they look like the browser's, not ours, and some browsers
 * drop them). Resolves true (or the typed text, with `input`) on the first
 * button, null on Cancel or Esc.
 */
function askDialog({ title, text = '', ok = 'OK', cancel = 'Cancel', danger = false, input = null }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'lgw move';
    dlg.innerHTML = `
      <div class="lgw-head"><div><h2 style="margin:0">${esc(title)}</h2></div></div>
      <div class="lgw-body"><form method="dialog" class="stack" id="ask-dlg">
        ${text ? `<p style="margin:0">${esc(text)}</p>` : ''}
        ${input ? `<label style="display:grid;gap:4px;font-size:13px;color:var(--muted)">${esc(input.label || '')}<input type="text" name="v" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" maxlength="${Number(input.maxlength) || 120}" autocomplete="off" required></label>` : ''}
        <div class="row" style="justify-content:flex-end;margin-top:6px"><button class="btn" type="button" id="ask-no">${esc(cancel)}</button><button class="btn ${danger ? 'danger' : 'primary'}" type="submit" id="ask-ok">${esc(ok)}</button></div>
      </form></div>`;
    document.body.append(dlg);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(value);
    };
    $('#ask-no', dlg).addEventListener('click', () => finish(null));
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      finish(null);
    });
    $('#ask-dlg', dlg).addEventListener('submit', (e) => {
      e.preventDefault();
      finish(input ? $('input[name=v]', dlg).value.trim() || null : true);
    });
    dlg.showModal();
    (input ? $('input[name=v]', dlg) : $('#ask-ok', dlg)).focus();
  });
}

/* ── the sheets ───────────────────────────────────────────────────── */

const SHEET_KIND = { logistics: 'Logistics', accounting: 'Accounting', client: 'Client situation', stock: 'Stock situation', blank: 'Blank' };
const sheetStatusLabel = (k) => (typeof statusLabel === 'function' ? statusLabel(k) : k);

async function showSheets() {
  $('#app').innerHTML = `
    <div class="watch-head">
      <div><h1>Sheets</h1><p class="sub">Spreadsheets built from the system — logistics, accounting, a client, the stock — kept here and edited like any sheet.</p></div>
      ${can('editor') ? '<button class="btn gold" id="sheet-new" type="button">+ New sheet</button>' : ''}
    </div>
    <div class="panel" id="sheets-panel"><p class="count">Loading…</p></div>`;
  $('#sheet-new')?.addEventListener('click', () => sheetPicker());
  let r;
  try {
    r = await api('/api/sheets');
  } catch (err) {
    $('#sheets-panel').innerHTML = `<p class="err">${esc(err.message)}</p>`;
    return;
  }
  if (!r.sheets.length) {
    $('#sheets-panel').innerHTML = `<div class="tscroll"><table class="list clients"><thead><tr><th>Sheet</th><th>Kind</th><th>Rows</th><th>Last change</th></tr></thead>
      <tbody><tr><td colspan="4"><p class="count" style="margin:12px 0">No sheets yet.${can('editor') ? ' Make the first one with “New sheet”: it asks what you want to see — logistics, accounting, a client or the stock — and builds it from what the system holds.' : ''}</p></td></tr></tbody></table></div>`;
    return;
  }
  $('#sheets-panel').innerHTML = `<div class="tscroll"><table class="list clients"><thead><tr><th>Sheet</th><th>Kind</th><th>Rows</th><th>Last change</th></tr></thead><tbody>
    ${r.sheets
      .map(
        (s) => `<tr data-id="${s.id}"><td><a href="#/sheet/${s.id}"><b>${esc(s.title || 'Untitled sheet')}</b></a></td><td>${esc(SHEET_KIND[s.kind] || s.kind)}</td>
          <td>${esc(String(s.row_count))}</td><td>${esc(fmtWhen(s.updated_at))}${s.updated_by_name ? ` · ${esc(s.updated_by_name)}` : ''}</td></tr>`
      )
      .join('')}</tbody></table></div>`;
  $('#sheets-panel tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && !e.target.closest('a')) location.hash = `#/sheet/${tr.dataset.id}`;
  });
}

/*
 * "What do you want?" — the picker, a window over the page: the kind, then
 * what it is about, a preview of the first rows, then the sheet.
 */
function sheetPicker(preset = {}) {
  const kinds = state.meta?.sheetKinds || [];
  const dlg = document.createElement('dialog');
  dlg.className = 'lgw move';
  dlg.innerHTML = `
    <div class="lgw-head"><div><div class="lgw-eyebrow">New sheet</div><h2 id="pk-title">What do you want to see?</h2></div><button class="btn small" type="button" id="pk-x">Close</button></div>
    <div class="lgw-body" id="pk-body"></div>`;
  document.body.append(dlg);
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  $('#pk-x', dlg).addEventListener('click', close);
  dlg.addEventListener('cancel', close);
  const body = $('#pk-body', dlg);
  let kind = preset.kind || null;
  let subject = { ...(preset.subject || {}) };
  let client = preset.client || null; // {id, name}

  const step1 = () => {
    $('#pk-title', dlg).textContent = 'What do you want to see?';
    body.innerHTML = `<div class="pk-kinds">${kinds
      .map((k) => `<button class="pk-kind" type="button" data-kind="${esc(k.key)}"><b>${esc(k.label)}</b><span>${esc(k.about)}</span></button>`)
      .join('')}<button class="pk-kind quiet" type="button" data-kind="blank"><b>Blank sheet</b><span>Start empty and type anything.</span></button></div>`;
    $$('.pk-kind', body).forEach((b) =>
      b.addEventListener('click', () => {
        kind = b.dataset.kind;
        if (kind === 'blank') return create();
        step2();
      })
    );
  };

  const step2 = () => {
    $('#pk-title', dlg).textContent = SHEET_KIND[kind];
    const stockField = (hint) => `<label>Stock numbers <span class="hint">${esc(hint)}</span><input type="text" id="pk-stock" value="${esc((subject.stock || []).join(', '))}" placeholder="1617, 1618 …"></label>`;
    const clientField = () => `<label>Client <span class="hint">type a name</span><input type="search" id="pk-client" autocomplete="off" value="${esc(client?.name || '')}" placeholder="Search a client"><div class="wc-hits" id="pk-hits"></div></label>`;
    let fields = '';
    if (kind === 'logistics') fields = stockField('leave empty for every stock that has logistics costs');
    if (kind === 'accounting') fields = `${stockField('for the money of particular watches')}<p class="count" style="margin:4px 0">— or —</p>${clientField()}`;
    if (kind === 'client') fields = clientField();
    if (kind === 'stock')
      fields = `<label>Which stock <select id="pk-status">${['in_stock', 'incoming', 'reserved', 'sold', 'returned', 'other', 'all']
        .map((s) => `<option value="${s}"${(subject.status || 'in_stock') === s ? ' selected' : ''}>${esc(s === 'all' ? 'All stock' : sheetStatusLabel(s))}</option>`)
        .join('')}</select></label><p class="count" style="margin:4px 0">— or particular watches —</p>${stockField('leave empty to take the status above')}`;
    body.innerHTML = `<div class="stack pk-form">${fields}
      <div id="pk-preview"></div>
      <div class="row" style="justify-content:space-between;margin-top:6px"><button class="btn" type="button" id="pk-back">← Back</button>
        <span class="row"><button class="btn" type="button" id="pk-prev">Preview</button><button class="btn primary" type="button" id="pk-go">Make the sheet</button></span></div></div>`;
    $('#pk-back', body).addEventListener('click', step1);
    const read = () => {
      subject = {};
      const st = $('#pk-stock', body)?.value.trim();
      if (st) subject.stock = st.split(/[\s,;]+/).filter(Boolean);
      if (client && (kind === 'client' || (kind === 'accounting' && !st))) subject.client = client.id;
      const status = $('#pk-status', body)?.value;
      if (status && !st) subject.status = status;
      return subject;
    };
    const input = $('#pk-client', body);
    if (input) {
      let seq = 0;
      input.addEventListener('input', async () => {
        client = null;
        const q = input.value.trim();
        const my = ++seq;
        if (q.length < 2) return ($('#pk-hits', body).innerHTML = '');
        const r = await api(`/api/sheets-pick/clients?q=${encodeURIComponent(q)}`).catch(() => ({ clients: [] }));
        if (my !== seq) return;
        $('#pk-hits', body).innerHTML = r.clients
          .map((c) => `<button class="wc-hit" type="button" data-id="${c.id}" data-name="${esc(c.name)}">${esc(c.name)}${c.company && c.company !== c.name ? ` <span class="count" style="margin:0">· ${esc(c.company)}</span>` : ''}</button>`)
          .join('') || '<p class="count" style="margin:6px 0">No client by that name.</p>';
        $$('.wc-hit', body).forEach((b) =>
          b.addEventListener('click', () => {
            client = { id: Number(b.dataset.id), name: b.dataset.name };
            input.value = b.dataset.name;
            $('#pk-hits', body).innerHTML = '';
          })
        );
      });
    }
    $('#pk-prev', body).addEventListener('click', async () => {
      read();
      const box = $('#pk-preview', body);
      box.innerHTML = '<p class="count">Reading the system…</p>';
      try {
        const p = await api('/api/sheets/preview', { method: 'POST', body: { kind, subject } });
        box.innerHTML = `<p class="count" style="margin:6px 0"><b>${esc(p.title)}</b> · ${p.row_count} row${p.row_count === 1 ? '' : 's'}${p.row_count > 20 ? ' (first 20 shown)' : ''}</p>
          <div class="tscroll pk-table"><table class="list"><thead><tr>${p.columns.map((c) => `<th>${esc(c.label)}</th>`).join('')}</tr></thead>
          <tbody>${p.rows.map((r) => `<tr>${p.columns.map((c) => `<td>${esc(cellText(c, r.cells[c.key]))}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${p.columns.length}" class="count">Nothing found for that.</td></tr>`}</tbody></table></div>`;
      } catch (err) {
        box.innerHTML = `<p class="err">${esc(err.message)}</p>`;
      }
    });
    $('#pk-go', body).addEventListener('click', () => {
      read();
      create();
    });
  };

  const create = async () => {
    try {
      const r = await api('/api/sheets', { method: 'POST', body: { kind, subject } });
      close();
      location.hash = `#/sheet/${r.id}`;
    } catch (err) {
      flash(err.message, true);
    }
  };

  if (kind) step2();
  else step1();
  dlg.showModal();
}

/* ── one sheet ────────────────────────────────────────────────────── */

const sheetView = { id: null, sheet: null, doc: null, sel: null, editing: false, dirty: false, saveTimer: null, q: '', sort: null, pending: null };

const isFormula = (v) => typeof v === 'string' && v.startsWith('=');

/* A cell as it is shown (not as it is edited): money with its thousands, a status by its name. */
function cellText(c, v) {
  if (v === null || v === undefined || v === '') return '';
  if (c.type === 'money' || c.type === 'number') {
    const n = typeof v === 'number' ? v : Number(String(v).replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : String(v);
  }
  if (c.type === 'status') return sheetStatusLabel(String(v));
  if (c.type === 'date') return typeof fmtDate === 'function' ? fmtDate(v) || String(v) : String(v);
  return String(v);
}

async function showSheet(id) {
  const v = sheetView;
  if (v.id !== id) Object.assign(v, { id, sheet: null, doc: null, sel: null, editing: false, dirty: false, q: '', sort: null, pending: null });
  $('#app').innerHTML = '<p class="count">Loading the sheet…</p>';
  try {
    v.sheet = await api(`/api/sheets/${id}`);
  } catch (err) {
    $('#app').innerHTML = `<p class="err">${esc(err.message)}</p><a href="#/sheets">Back to the sheets</a>`;
    return;
  }
  v.doc = v.sheet.doc;
  v.doc.rows ||= [];
  v.doc.columns ||= [];
  renderSheet();
}

/* GridCraft when the server has it (src/web/gridcraft.js); the console's own grid otherwise. */
function renderSheet() {
  if (state.meta?.gridcraft?.installed) return renderSheetCraft();
  return renderSheetGrid();
}

/*
 * The sheet in GridCraft — the open-source Excel-style spreadsheet, served
 * by the ERP at /gridcraft/ and framed here in its host mode: the frame says
 * "gridcraft:ready", the page hands it the sheet as an .xlsx
 * ("gridcraft:open"); every Save in GridCraft (Ctrl+S) comes back here as
 * "gridcraft:save" with the workbook, which goes to the server, is read into
 * the sheet, and every cell that changed in a column of the system's asks:
 * put it in the system too?
 */
const GC = { app: 'gridcraft', version: '1' };
function renderSheetCraft() {
  const v = sheetView;
  const s = v.sheet;
  const editor = can('editor');
  const author = encodeURIComponent(state.user?.name || state.user?.email || '');
  $('#app').innerHTML = `
    <a href="#/sheets" class="count back">← Sheets</a>
    <div class="watch-head sh-head">
      <div style="min-width:0;flex:1">
        <h1 class="sh-title" ${editor ? 'contenteditable="plaintext-only" spellcheck="false" title="Click to rename"' : ''} id="sh-title">${esc(s.title || 'Untitled sheet')}</h1>
        <p class="sub" style="margin:0">${esc(SHEET_KIND[s.kind] || s.kind)}${s.built_at ? ` · read from the system ${esc(fmtWhen(s.built_at))}` : ''} · <span class="sh-state" id="sh-state">opening…</span></p>
      </div>
      <div class="row sh-tools">
        <button class="btn primary" type="button" id="sh-full" title="The sheet over the whole screen (Esc to come back)">Full screen</button>
        ${editor && s.kind !== 'blank' ? '<button class="btn" type="button" id="sh-rebuild" title="Read the rows from the system again (your saved edits are kept)">Read again</button>' : ''}
        <a class="btn" href="/api/sheets/${s.id}/workbook?download=1" title="The workbook as last saved, for Excel">Excel</a>
        <a class="btn" href="/api/sheets/${s.id}/export" download>CSV</a>
        <a class="btn" href="/api/sheets/${s.id}/export?format=pdf" target="_blank" rel="noopener">PDF</a>
        ${editor ? '<button class="btn danger" type="button" id="sh-del">Delete</button>' : ''}
      </div>
    </div>
    ${v.doc.note ? `<p class="count sh-note">${esc(v.doc.note)}</p>` : ''}
    <div id="sh-pending"></div>
    <div class="sh-stage" id="sh-stage">
      <div class="sh-fullbar" id="sh-fullbar">
        <b class="sh-fullbar-title">${esc(s.title || 'Untitled sheet')}</b>
        <span class="sh-state" id="sh-state-full"></span>
        <span class="grow"></span>
        <button class="btn small" type="button" id="sh-full-exit" title="Back to the page (Esc)">Exit full screen</button>
      </div>
      <div class="sh-frame" id="sh-frame"><div class="sh-wait" id="sh-wait">Loading the spreadsheet…</div></div>
    </div>
    <p class="count sh-help">Edit as in Excel. <b>Save (Ctrl+S)</b> brings your changes to the ERP${editor ? ' — a changed cell in one of the system’s columns (a watch’s field) then asks whether to change the system too' : ''}. The spreadsheet is based on GridCraft by the ArtCraft team (storytold/gridcraft, open source, MIT / Apache-2.0)${state.meta.gridcraft.version ? `, version ${esc(state.meta.gridcraft.version)}` : ''}.</p>`;
  v.gc = { dirty: false, ready: false };
  // GridCraft keeps its look in localStorage (same origin as ours: `gridcraft.ui`). On a first visit it would follow the
  // system theme — dark, beside a light console — so it starts light; a theme the person then picks in it is theirs and kept.
  try {
    if (!localStorage.getItem('gridcraft.ui')) localStorage.setItem('gridcraft.ui', JSON.stringify({ dark: false, systemTheme: false }));
  } catch {}
  const frame = document.createElement('iframe');
  frame.title = 'The sheet, in GridCraft';
  frame.allow = 'fullscreen; clipboard-read; clipboard-write';
  frame.allowFullscreen = true;
  frame.src = `/gridcraft/?host=parent&chrome=notitlebar${author ? `&author=${author}` : ''}`;
  $('#sh-frame').append(frame);
  v.frame = frame;
  // A frame that never says ready (the app aborts on a bad file or an old browser): said, with a way back, instead of "Loading…" for ever.
  clearTimeout(v.readyTimer);
  v.readyTimer = setTimeout(() => {
    if (v.gc?.ready || v.frame !== frame) return;
    const wait = $('#sh-wait');
    if (wait) wait.innerHTML = `<div class="stack" style="text-align:center;pointer-events:auto"><p>The spreadsheet has not started after 40 seconds. It needs a browser with WebGL2 or WebGPU and a few MB to load the first time.</p><div class="row" style="justify-content:center"><button class="btn primary" type="button" id="sh-retry">Try again</button></div></div>`;
    $('#sh-retry')?.addEventListener('click', () => renderSheet());
  }, 40_000);
  const setState = (text, dirty = false) => {
    for (const el of [$('#sh-state'), $('#sh-state-full')]) {
      if (!el) continue;
      el.textContent = text;
      el.classList.toggle('dirty', dirty);
    }
  };
  // Full screen (asked 7 Nov 2026: "the window on excel sheet is too little"): the sheet over the whole screen, a thin
  // strip above it with the name, the saved state and the way back; the browser's own full screen on top where it allows.
  const setFull = (on) => {
    document.body.classList.toggle('sheet-full', on);
    $('#sh-full').textContent = on ? 'Exit full screen' : 'Full screen';
    if (on && !document.fullscreenElement && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    try {
      localStorage.setItem('masterapp.sheetFull', on ? '1' : '');
    } catch {}
    if (on) frame.focus();
  };
  $('#sh-full').addEventListener('click', () => setFull(!document.body.classList.contains('sheet-full')));
  $('#sh-full-exit').addEventListener('click', () => setFull(false));
  document.onfullscreenchange = () => {
    // Esc in the browser's full screen: back to the page as well.
    if (!document.fullscreenElement && document.body.classList.contains('sheet-full') && $('#sh-stage')) setFull(false);
  };
  try {
    if (localStorage.getItem('masterapp.sheetFull') === '1') document.body.classList.add('sheet-full');
  } catch {}
  if (document.body.classList.contains('sheet-full')) $('#sh-full').textContent = 'Exit full screen';
  const post = (type, fields, transfer) => frame.contentWindow?.postMessage({ type: `${GC.app}:${type}`, ...fields }, location.origin, transfer || []);
  const openWorkbook = async ({ fresh = false } = {}) => {
    setState('opening…');
    const res = await fetch(`/api/sheets/${s.id}/workbook${fresh ? '?fresh=1' : ''}`, { headers: { 'X-Requested-With': 'masterapp' } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    v.sheet.version = Number(res.headers.get('X-Sheet-Version')) || v.sheet.version;
    const bytes = await res.arrayBuffer();
    post('open', { name: `${(s.title || 'Sheet').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)}.xlsx`, bytes }, [bytes]);
    setState('saved');
    $('#sh-wait')?.remove();
  };
  const onMessage = async (e) => {
    if (e.origin !== location.origin || e.source !== frame.contentWindow || !e.data || typeof e.data.type !== 'string') return;
    const kind = e.data.type.startsWith(`${GC.app}:`) ? e.data.type.slice(GC.app.length + 1) : null;
    if (!kind) return;
    try {
      if (kind === 'ready') {
        v.gc.ready = true;
        post('host', { version: GC.version });
        await openWorkbook();
      } else if (kind === 'dirty') {
        v.gc.dirty = Boolean(e.data.dirty);
        setState(v.gc.dirty ? 'unsaved changes — press Ctrl+S in the sheet' : 'saved', v.gc.dirty);
      } else if (kind === 'save') {
        const name = String(e.data.name || 'document');
        const bytes = e.data.bytes instanceof ArrayBuffer ? e.data.bytes : e.data.bytes?.buffer instanceof ArrayBuffer ? e.data.bytes.buffer : null;
        if (!bytes) throw new Error('The sheet sent no file');
        if (/\.xlsx$/i.test(name)) {
          if (!editor) throw new Error('Only an editor can save a sheet');
          setState('saving…');
          const r = await fetch(`/api/sheets/${s.id}/workbook`, {
            method: 'PUT',
            headers: { 'X-Requested-With': 'masterapp', 'Content-Type': 'application/octet-stream', 'X-Sheet-Version': String(v.sheet.version) },
            body: bytes,
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
          v.sheet.version = data.version;
          v.doc = data.doc;
          v.gc.dirty = false;
          if (e.data.id !== undefined) post('saved', { id: e.data.id });
          setState(`saved ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`);
          v.lastSave = { changed: data.changed, added: data.added, removed: data.removed, columnsAdded: data.columnsAdded };
          drawCraftPending();
        } else {
          // A PDF (or anything else) GridCraft exported: the person asked for it in the sheet, so it downloads as it would anywhere.
          const url = URL.createObjectURL(new Blob([bytes], { type: /\.pdf$/i.test(name) ? 'application/pdf' : 'application/octet-stream' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = name;
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          if (e.data.id !== undefined) post('saved', { id: e.data.id });
        }
      } else if (kind === 'failed') {
        setState('could not start');
        flash(`The spreadsheet could not start: ${e.data.error || 'unknown reason'}`, true);
      }
    } catch (err) {
      setState('not saved', true);
      flash(err.message, true);
      if (/reload/.test(err.message)) setTimeout(() => showSheet(s.id), 2500);
    }
  };
  window.removeEventListener('message', v.onMessage || (() => {}));
  v.onMessage = onMessage;
  window.addEventListener('message', onMessage);

  const title = $('#sh-title');
  if (editor) {
    title.addEventListener('blur', () => {
      const t = title.textContent.trim().slice(0, 200);
      if (t && t !== s.title) {
        s.title = t;
        api(`/api/sheets/${s.id}`, { method: 'PATCH', body: { title: t, version: v.sheet.version } })
          .then((r) => (v.sheet.version = r.version))
          .catch((err) => flash(err.message, true));
      } else title.textContent = s.title;
    });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        title.blur();
      }
    });
  }
  $('#sh-rebuild')?.addEventListener('click', async () => {
    if (v.gc.dirty && !(await askDialog({ title: 'Unsaved changes in the sheet', text: 'Read again anyway? Press Cancel, then Ctrl+S in the sheet, to keep them.', ok: 'Read again', danger: true }))) return;
    try {
      v.sheet = await api(`/api/sheets/${s.id}/rebuild`, { method: 'POST' });
      v.doc = v.sheet.doc;
      flash('Read from the system again — your saved edits are kept');
      renderSheet();
    } catch (err) {
      flash(err.message, true);
    }
  });
  $('#sh-del')?.addEventListener('click', () => deleteSheetAsked(s));
  drawCraftPending();
}

async function deleteSheetAsked(s) {
  if (!(await askDialog({ title: `Delete the sheet “${s.title}”?`, text: 'The system is not touched — only this sheet goes.', ok: 'Delete the sheet', danger: true }))) return;
  try {
    await api(`/api/sheets/${s.id}`, { method: 'DELETE' });
    if (sheetView.gc) sheetView.gc.dirty = false;
    location.hash = '#/sheets';
  } catch (err) {
    flash(err.message, true);
  }
}

/* Leaving the sheet page with unsaved GridCraft changes: asked first (the frame goes with the page). */
document.addEventListener(
  'click',
  (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || !sheetView.gc?.dirty || !$('#sh-frame')) return;
    e.preventDefault();
    e.stopPropagation();
    const href = a.getAttribute('href');
    askDialog({ title: 'Unsaved changes in the sheet', text: 'Press Ctrl+S in the sheet to keep them. Leave anyway?', ok: 'Leave without saving', danger: true }).then((ok) => {
      if (!ok) return;
      sheetView.gc.dirty = false;
      location.hash = href;
    });
  },
  true
);
/* Leaving the sheet page: the full-screen state goes with it (the body class would otherwise hide the next page). */
window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#/sheet/')) {
    document.body.classList.remove('sheet-full');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.body.classList.contains('sheet-full') && $('#sh-stage')) $('#sh-full-exit')?.click();
});
window.addEventListener('beforeunload', (e) => {
  if (sheetView.gc?.dirty && $('#sh-frame')) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* After a save from GridCraft: the rows whose system cells changed, and the new rows — each with its way into the system. */
function drawCraftPending() {
  const v = sheetView;
  const box = $('#sh-pending');
  if (!box || !can('editor')) return;
  const cols = v.doc.columns || [];
  const bound = (row, k) => Boolean(row.ref && (cols.find((c) => c.key === k)?.bind || row.bind?.[k]));
  const waiting = (v.doc.rows || []).map((row, i) => ({ row, i })).filter(({ row }) => row.manual || Object.keys(row.edited || {}).some((k) => bound(row, k)));
  const last = v.lastSave;
  v.lastSave = null;
  if (!waiting.length) {
    box.innerHTML = last ? `<p class="count sh-wait-note">Saved${last.removed ? ` · ${last.removed} row${last.removed === 1 ? '' : 's'} removed from the sheet` : ''}${last.columnsAdded?.length ? ` · new column${last.columnsAdded.length === 1 ? '' : 's'}: ${esc(last.columnsAdded.join(', '))}` : ''}. Nothing here touches the system.</p>` : '';
    return;
  }
  const first = cols[0]?.key;
  const label = (row) => `${esc(String(row.cells?.[first] ?? row.cells?.stock ?? '') || 'row')}`;
  const what = (row) => {
    if (row.manual) return 'new row';
    const ks = Object.keys(row.edited || {}).filter((k) => bound(row, k));
    return ks.map((k) => cols.find((c) => c.key === k)?.label || k).join(', ');
  };
  box.innerHTML = `<div class="note info sh-ask" style="display:block">
    <div class="row" style="justify-content:space-between">
      <span><b>Put ${waiting.length === 1 ? 'this change' : `these ${waiting.length} changes`} in the system too?</b> ${last ? 'Saved on the sheet. ' : ''}A watch is changed as from its edit form — locked against Chrono Key’s copy, and logged. ${whatItMakes()}</span>
      <span class="row"><button class="btn small primary" type="button" id="sh-yes-all">Yes, all</button><button class="btn small" type="button" id="sh-no-all">Only on the sheet</button></span>
    </div>
    <div class="sh-rows">${waiting
      .map(({ row, i }) => `<div><span><b>${label(row)}</b> · ${esc(what(row))}${row.ref?.watch ? ` · <a href="#/watch/${row.ref.watch}">open</a>` : ''}</span><button class="btn small sh-apply" type="button" data-r="${i}">To system</button></div>`)
      .join('')}</div></div>`;
  $$('.sh-apply', box).forEach((b) => b.addEventListener('click', () => applyCraftRow(Number(b.dataset.r))));
  $('#sh-yes-all').addEventListener('click', async () => {
    for (const { i } of waiting) await applyCraftRow(i, { quiet: true });
    flash('Done — the changes are in the system');
    drawCraftPending();
  });
  $('#sh-no-all').addEventListener('click', () => {
    // Left on the sheet: the marks stay in the document (the rows keep their To-system buttons next time), the bar goes.
    box.innerHTML = '';
  });
}
async function applyCraftRow(r, { quiet = false } = {}) {
  const v = sheetView;
  const row = v.doc.rows[r];
  if (!row) return;
  try {
    const res = await api(`/api/sheets/${v.sheet.id}/apply`, { method: 'POST', body: { row: row.key } });
    Object.assign(row, res.row);
    v.sheet.version += 1;
    if (!quiet) {
      const d = res.done[0];
      flash(d?.what === 'watch' && d.created ? 'A new watch is in the system' : d?.what === 'watch' ? `The watch is changed in the system (${(d.changed || []).join(', ') || 'nothing differed'})` : d?.what === 'expense' && d.created ? 'An expense is in the system' : d?.what === 'expense' ? 'The expense is changed in the system' : d?.what === 'link' ? 'The watch is linked to the client' : 'Done');
      drawCraftPending();
    }
  } catch (err) {
    flash(`${String(row.cells?.[v.doc.columns[0]?.key] ?? 'row')}: ${err.message}`, true);
  }
}

/* The console's own grid: the sheet when GridCraft is not installed on the server. */
function renderSheetGrid() {
  const v = sheetView;
  const s = v.sheet;
  const editor = can('editor');
  $('#app').innerHTML = `
    <a href="#/sheets" class="count back">← Sheets</a>
    <div class="watch-head sh-head">
      <div style="min-width:0;flex:1">
        <h1 class="sh-title" ${editor ? 'contenteditable="plaintext-only" spellcheck="false" title="Click to rename"' : ''} id="sh-title">${esc(s.title || 'Untitled sheet')}</h1>
        <p class="sub" style="margin:0">${esc(SHEET_KIND[s.kind] || s.kind)}${s.built_at ? ` · read from the system ${esc(fmtWhen(s.built_at))}` : ''} · <span id="sh-saved">saved</span></p>
      </div>
      <div class="row sh-tools">
        <input type="search" id="sh-q" placeholder="Find in the sheet" value="${esc(v.q)}" aria-label="Find in the sheet" style="width:200px">
        ${editor ? '<button class="btn" type="button" id="sh-row">+ Row</button><button class="btn" type="button" id="sh-col">+ Column</button>' : ''}
        ${editor && s.kind !== 'blank' ? '<button class="btn" type="button" id="sh-rebuild" title="Read the rows from the system again; your edits are kept">Read again</button>' : ''}
        <a class="btn" href="/api/sheets/${s.id}/export" download>CSV</a>
        <a class="btn" href="/api/sheets/${s.id}/export?format=pdf" target="_blank" rel="noopener">PDF</a>
        ${editor ? '<button class="btn danger" type="button" id="sh-del">Delete</button>' : ''}
      </div>
    </div>
    ${v.doc.note ? `<p class="count sh-note">${esc(v.doc.note)}</p>` : ''}
    <div id="sh-pending"></div>
    <div class="panel sh-panel"><div class="sh-scroll" id="sh-scroll" tabindex="0"></div></div>
    <p class="count sh-help">Click a cell to edit · Enter saves · Esc cancels · a formula starts with = (SUM, AVERAGE, MIN, MAX, COUNT, IF, and + − × ÷ on cells like F2:F9)${editor ? ' · a column with a gold dot is the watch’s own: changing a cell there asks whether to change the system too' : ''}.</p>`;
  drawGrid();
  const title = $('#sh-title');
  if (editor) {
    title.addEventListener('blur', () => {
      const t = title.textContent.trim().slice(0, 200);
      if (t && t !== s.title) {
        s.title = t;
        queueSave({ title: t });
      } else title.textContent = s.title;
    });
    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        title.blur();
      }
    });
  }
  $('#sh-q').addEventListener('input', (e) => {
    v.q = e.target.value;
    drawGrid();
  });
  $('#sh-row')?.addEventListener('click', () => {
    v.doc.rows.push({ key: `m${Date.now().toString(36)}`, cells: {}, manual: true, edited: {} });
    v.sel = { r: v.doc.rows.length - 1, c: 0 };
    markDirty();
    drawGrid();
    startEdit();
  });
  $('#sh-col')?.addEventListener('click', async () => {
    const label = await askDialog({ title: 'New column', ok: 'Add the column', input: { label: 'Name of the column', placeholder: 'e.g. Notes' } });
    if (!label) return;
    let key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'col';
    while (v.doc.columns.some((c) => c.key === key)) key += '_';
    v.doc.columns.push({ key, label: label.slice(0, 120), type: 'text' });
    markDirty();
    drawGrid();
  });
  $('#sh-rebuild')?.addEventListener('click', async () => {
    if (v.dirty) await saveNow();
    try {
      v.sheet = await api(`/api/sheets/${s.id}/rebuild`, { method: 'POST' });
      v.doc = v.sheet.doc;
      flash('Read from the system again — your edits are kept');
      renderSheetGrid();
    } catch (err) {
      flash(err.message, true);
    }
  });
  $('#sh-del')?.addEventListener('click', () => deleteSheetAsked(s));
  drawPending();
}

/* The rows shown: searched, sorted; each with its index in the document. */
function visibleRows() {
  const v = sheetView;
  const q = v.q.trim().toLowerCase();
  let list = v.doc.rows.map((row, i) => ({ row, i }));
  if (q) list = list.filter(({ row, i }) => v.doc.columns.some((c) => String(shownValue(c, row, i)).toLowerCase().includes(q)));
  if (v.sort) {
    const c = v.doc.columns.find((x) => x.key === v.sort.key);
    if (c) {
      const val = ({ row, i }) => shownValue(c, row, i);
      list.sort((a, b) => {
        const x = val(a);
        const y = val(b);
        const nx = typeof x === 'number' ? x : Number(String(x).replace(/[^\d.-]/g, ''));
        const ny = typeof y === 'number' ? y : Number(String(y).replace(/[^\d.-]/g, ''));
        const both = x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny);
        const r = both ? nx - ny : String(x).localeCompare(String(y), 'en', { numeric: true });
        return v.sort.dir === 'desc' ? -r : r;
      });
    }
  }
  return list;
}

/* ── formulas ─────────────────────────────────────────────────────── */

const colLetters = (i) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const colIndex = (letters) => {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
let calcMemo = new Map();
let calcStack = new Set();

/* A cell's value for the grid and for formulas: a formula computed, a number as a number. */
function shownValue(c, row, i) {
  const raw = row.cells[c.key];
  if (isFormula(raw)) return evalFormula(raw, `${c.key}:${row.key}`);
  if (raw === null || raw === undefined) return '';
  if ((c.type === 'money' || c.type === 'number') && typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw.replace(/[^\d.-]/g, ''));
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}
/* A1 → the value of that cell (row 1 is the heading). */
function cellAt(ref) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref);
  if (!m) return '#REF';
  const c = sheetView.doc.columns[colIndex(m[1])];
  const row = sheetView.doc.rows[Number(m[2]) - 2];
  if (!c || !row) return '';
  return shownValue(c, row, Number(m[2]) - 2);
}
function rangeAt(a, b) {
  const ma = /^\$?([A-Z]+)\$?(\d+)$/i.exec(a);
  const mb = /^\$?([A-Z]+)\$?(\d+)$/i.exec(b);
  if (!ma || !mb) return ['#REF'];
  const c0 = Math.min(colIndex(ma[1]), colIndex(mb[1]));
  const c1 = Math.max(colIndex(ma[1]), colIndex(mb[1]));
  const r0 = Math.min(Number(ma[2]), Number(mb[2]));
  const r1 = Math.min(Math.max(Number(ma[2]), Number(mb[2])), sheetView.doc.rows.length + 1);
  const out = [];
  for (let r = Math.max(r0, 2); r <= r1; r++) for (let c = c0; c <= c1; c++) out.push(cellAt(`${colLetters(c)}${r}`));
  return out;
}

function evalFormula(src, id) {
  if (calcMemo.has(id)) return calcMemo.get(id);
  if (calcStack.has(id)) return '#CIRCULAR';
  calcStack.add(id);
  let out;
  try {
    out = formulaValue(src.slice(1));
    if (typeof out === 'number' && !Number.isFinite(out)) out = '#DIV/0';
  } catch (err) {
    out = `#${/^[A-Z/0]+$/.test(err.message) ? err.message : 'ERROR'}`;
  }
  calcStack.delete(id);
  calcMemo.set(id, out);
  return out;
}

/* A small spreadsheet language: numbers, "strings", A1, A1:B9, functions, + - * / ^ &, = <> < > <= >=, parentheses. */
function formulaValue(text) {
  const toks = [];
  const re = /\s*(?:("(?:[^"]|"")*")|(\d+(?:\.\d+)?|\.\d+)|(\$?[A-Za-z]+\$?\d+(?::\$?[A-Za-z]+\$?\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|(<=|>=|<>|[-+*/^&=<>(),:%]))/gy;
  let m;
  let at = 0;
  while (at < text.length && (m = re.exec(text))) {
    at = re.lastIndex;
    if (m[1] !== undefined) toks.push({ t: 'str', v: m[1].slice(1, -1).replace(/""/g, '"') });
    else if (m[2] !== undefined) toks.push({ t: 'num', v: Number(m[2]) });
    else if (m[3] !== undefined) toks.push({ t: 'ref', v: m[3] });
    else if (m[4] !== undefined) toks.push({ t: 'name', v: m[4].toUpperCase() });
    else toks.push({ t: 'op', v: m[5] });
  }
  if (at < text.trim().length && text.trim().slice(at).trim()) throw new Error('NAME');
  let p = 0;
  const peek = () => toks[p];
  const take = (v) => {
    const t = toks[p];
    if (!t || (v !== undefined && t.v !== v)) throw new Error('ERROR');
    p++;
    return t;
  };
  const num = (x) => {
    if (typeof x === 'number') return x;
    if (typeof x === 'boolean') return x ? 1 : 0;
    if (x === '' || x === null || x === undefined) return 0;
    if (typeof x === 'string' && x.startsWith('#')) throw new Error(x.slice(1));
    const n = Number(String(x).replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(n)) throw new Error('VALUE');
    return n;
  };
  const nums = (args) => args.flat().filter((x) => x !== '' && x !== null && x !== undefined && !(typeof x === 'string' && !/^-?[\d.,\s]+$/.test(x))).map(num);
  const FN = {
    SUM: (a) => nums(a).reduce((s, x) => s + x, 0),
    AVERAGE: (a) => (nums(a).length ? nums(a).reduce((s, x) => s + x, 0) / nums(a).length : 0),
    AVG: (a) => FN.AVERAGE(a),
    MIN: (a) => (nums(a).length ? Math.min(...nums(a)) : 0),
    MAX: (a) => (nums(a).length ? Math.max(...nums(a)) : 0),
    COUNT: (a) => nums(a).length,
    COUNTA: (a) => a.flat().filter((x) => x !== '' && x !== null && x !== undefined).length,
    IF: (a) => (truthy(a[0]) ? a[1] ?? '' : a[2] ?? ''),
    AND: (a) => a.flat().every(truthy),
    OR: (a) => a.flat().some(truthy),
    NOT: (a) => !truthy(a[0]),
    ABS: (a) => Math.abs(num(a[0])),
    ROUND: (a) => Math.round(num(a[0]) * 10 ** num(a[1] ?? 0)) / 10 ** num(a[1] ?? 0),
    LEN: (a) => String(a[0] ?? '').length,
    CONCAT: (a) => a.flat().map((x) => (x === null || x === undefined ? '' : String(x))).join(''),
    CONCATENATE: (a) => FN.CONCAT(a),
    TODAY: () => new Date().toISOString().slice(0, 10),
  };
  const truthy = (x) => (typeof x === 'boolean' ? x : typeof x === 'number' ? x !== 0 : x !== '' && x !== null && x !== undefined && String(x).toUpperCase() !== 'FALSE');
  const cmp = (a, b, op) => {
    const bothNum = (typeof a === 'number' || /^-?\d/.test(String(a))) && (typeof b === 'number' || /^-?\d/.test(String(b))) && Number.isFinite(Number(a)) && Number.isFinite(Number(b));
    const x = bothNum ? Number(a) : String(a ?? '').toLowerCase();
    const y = bothNum ? Number(b) : String(b ?? '').toLowerCase();
    return { '=': x === y, '<>': x !== y, '<': x < y, '>': x > y, '<=': x <= y, '>=': x >= y }[op];
  };
  const expr = () => {
    let a = concat();
    while (peek()?.t === 'op' && ['=', '<>', '<', '>', '<=', '>='].includes(peek().v)) a = cmp(a, concat(), take().v);
    return a;
  };
  const concat = () => {
    let a = sum();
    while (peek()?.t === 'op' && peek().v === '&') {
      take();
      a = `${a ?? ''}${sum() ?? ''}`;
    }
    return a;
  };
  const sum = () => {
    let a = prod();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = take().v;
      const b = prod();
      a = op === '+' ? num(a) + num(b) : num(a) - num(b);
    }
    return a;
  };
  const prod = () => {
    let a = pow();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = take().v;
      const b = pow();
      a = op === '*' ? num(a) * num(b) : num(a) / num(b);
    }
    return a;
  };
  const pow = () => {
    let a = unary();
    while (peek()?.t === 'op' && peek().v === '^') {
      take();
      a = num(a) ** num(unary());
    }
    return a;
  };
  const unary = () => {
    if (peek()?.t === 'op' && peek().v === '-') {
      take();
      return -num(unary());
    }
    if (peek()?.t === 'op' && peek().v === '+') {
      take();
      return num(unary());
    }
    let a = atom();
    if (peek()?.t === 'op' && peek().v === '%') {
      take();
      a = num(a) / 100;
    }
    return a;
  };
  const atom = () => {
    const t = take();
    if (t.t === 'num' || t.t === 'str') return t.v;
    if (t.t === 'ref') {
      if (t.v.includes(':')) return rangeAt(...t.v.split(':'));
      const val = cellAt(t.v);
      if (typeof val === 'string' && val.startsWith('#')) throw new Error(val.slice(1));
      return val;
    }
    if (t.t === 'name') {
      if (t.v === 'TRUE') return true;
      if (t.v === 'FALSE') return false;
      const fn = FN[t.v];
      if (!fn) throw new Error('NAME');
      take('(');
      const args = [];
      if (!(peek()?.t === 'op' && peek().v === ')')) {
        args.push(expr());
        while (peek()?.t === 'op' && peek().v === ',') {
          take();
          args.push(expr());
        }
      }
      take(')');
      return fn(args);
    }
    if (t.t === 'op' && t.v === '(') {
      const a = expr();
      take(')');
      return a;
    }
    throw new Error('ERROR');
  };
  const out = expr();
  if (p < toks.length) throw new Error('ERROR');
  return Array.isArray(out) ? out[0] ?? '' : out;
}

/* ── the grid ─────────────────────────────────────────────────────── */

function drawGrid() {
  const v = sheetView;
  calcMemo = new Map();
  const cols = v.doc.columns;
  const rows = visibleRows();
  const editor = can('editor');
  const sums = cols.map((c) => {
    if (c.type !== 'money' && c.type !== 'number') return '';
    // Money adds up only within one currency: with a currency column beside it, one figure per currency.
    const curCol = cols.find((x) => x.type === 'currency');
    const by = new Map();
    for (const { row, i } of rows) {
      const val = shownValue(c, row, i);
      if (typeof val !== 'number') continue;
      const cur = c.type === 'money' && curCol && !/EUR/.test(c.label) ? String(row.cells[curCol.key] || '') : '';
      by.set(cur, (by.get(cur) || 0) + val);
    }
    if (!by.size) return '';
    return [...by].map(([cur, n]) => `${cur ? `${esc(cur)} ` : ''}${esc(n.toLocaleString('en-GB', { maximumFractionDigits: 2 }))}`).join('<br>');
  });
  const head = `<tr><th class="sh-n"></th>${cols
    .map((c, ci) => {
      const on = v.sort?.key === c.key ? ` sort-${v.sort.dir}` : '';
      return `<th class="sh-th${on}" data-col="${ci}" title="${esc(c.label)} (${colLetters(ci)})${c.bind ? ' · a field of the system' : ''}"><span class="sh-letter">${colLetters(ci)}</span>${esc(c.label)}${c.bind ? '<span class="sh-bound" aria-hidden="true"></span>' : ''}</th>`;
    })
    .join('')}${editor ? '<th class="sh-act"></th>' : ''}</tr>`;
  const body = rows
    .map(({ row, i }) => {
      const pending = row.manual || Object.keys(row.edited || {}).length;
      const cells = cols
        .map((c, ci) => {
          const raw = row.cells[c.key];
          const val = shownValue(c, row, i);
          const err = typeof val === 'string' && val.startsWith('#');
          const cls = ['sh-td', c.type === 'money' || c.type === 'number' ? 'num' : '', isFormula(raw) ? 'formula' : '', err ? 'bad' : '', row.edited?.[c.key] ? 'edited' : '', (c.bind || row.bind?.[c.key]) && row.ref ? 'bound' : '', v.sel && v.sel.r === i && v.sel.c === ci ? 'sel' : '']
            .filter(Boolean)
            .join(' ');
          return `<td class="${cls}" data-r="${i}" data-c="${ci}">${esc(cellText(c, val))}</td>`;
        })
        .join('');
      const link = row.ref?.watch ? `<a class="sh-open" href="#/watch/${row.ref.watch}" title="Open the watch">↗</a>` : row.ref?.expense ? `<a class="sh-open" href="#/expense/${row.ref.expense}" title="Open the expense">↗</a>` : '';
      return `<tr data-r="${i}" class="${pending ? 'pending' : ''}"><td class="sh-n">${i + 2}</td>${cells}${editor ? `<td class="sh-act">${pending ? `<button class="btn small sh-apply" type="button" data-r="${i}" title="Put this row's changes into the system">To system</button>` : link}<button class="sh-x" type="button" data-r="${i}" title="Remove this row from the sheet" aria-label="Remove row">×</button></td>` : ''}</tr>`;
    })
    .join('');
  const foot = `<tr class="sh-foot"><td class="sh-n">Σ</td>${sums.map((s, ci) => `<td class="${cols[ci].type === 'money' || cols[ci].type === 'number' ? 'num' : ''}">${s}</td>`).join('')}${editor ? '<td></td>' : ''}</tr>`;
  $('#sh-scroll').innerHTML = `<table class="sh-grid" id="sh-grid"><thead>${head}</thead><tbody>${body || `<tr><td class="sh-empty" colspan="${cols.length + 2}">${v.q ? 'Nothing on the sheet matches that.' : 'An empty sheet. Add a row to start.'}</td></tr>`}</tbody><tfoot>${foot}</tfoot></table>`;
  const grid = $('#sh-grid');
  grid.addEventListener('click', (e) => {
    const th = e.target.closest('th.sh-th');
    if (th) {
      const key = cols[Number(th.dataset.col)].key;
      v.sort = v.sort?.key === key ? (v.sort.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' };
      return drawGrid();
    }
    const x = e.target.closest('.sh-x');
    if (x) return removeRow(Number(x.dataset.r));
    const ap = e.target.closest('.sh-apply');
    if (ap) return applyRow(Number(ap.dataset.r));
    const td = e.target.closest('td.sh-td');
    if (!td) return;
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    if (v.editing && v.sel && v.sel.r === r && v.sel.c === c) return;
    if (v.editing) commitEdit();
    select(r, c);
  });
  grid.addEventListener('dblclick', (e) => {
    if (e.target.closest('td.sh-td') && editor && !v.editing) startEdit();
  });
  const scroll = $('#sh-scroll');
  scroll.onkeydown = (e) => {
    if (!v.sel || v.editing) return;
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], Tab: [0, e.shiftKey ? -1 : 1] };
    if (moves[e.key]) {
      e.preventDefault();
      const order = rows.map((x) => x.i);
      const pos = order.indexOf(v.sel.r);
      const nr = order[Math.min(Math.max(pos + moves[e.key][0], 0), order.length - 1)] ?? v.sel.r;
      const nc = Math.min(Math.max(v.sel.c + moves[e.key][1], 0), cols.length - 1);
      return select(nr, nc);
    }
    if (!editor) return;
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      return startEdit();
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      return setCell(v.sel.r, v.sel.c, '');
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      startEdit(e.key);
    }
  };
}

function select(r, c) {
  const v = sheetView;
  v.sel = { r, c };
  $$('#sh-grid td.sel').forEach((td) => td.classList.remove('sel'));
  const td = $(`#sh-grid td[data-r="${r}"][data-c="${c}"]`);
  td?.classList.add('sel');
  td?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  $('#sh-scroll')?.focus({ preventScroll: true });
}

function startEdit(firstKey) {
  const v = sheetView;
  if (!v.sel || !can('editor')) return;
  const td = $(`#sh-grid td[data-r="${v.sel.r}"][data-c="${v.sel.c}"]`);
  if (!td) return;
  const row = v.doc.rows[v.sel.r];
  const c = v.doc.columns[v.sel.c];
  const raw = row.cells[c.key];
  v.editing = true;
  td.classList.add('editing');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sh-input';
  input.value = firstKey !== undefined ? firstKey : raw === null || raw === undefined ? '' : String(raw);
  td.textContent = '';
  td.append(input);
  input.focus();
  if (firstKey === undefined) input.select();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
      const next = Math.min(v.sel.r + 1, v.doc.rows.length - 1);
      select(next, v.sel.c);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      commitEdit();
      select(v.sel.r, Math.min(Math.max(v.sel.c + (e.shiftKey ? -1 : 1), 0), v.doc.columns.length - 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      v.editing = false;
      drawGrid();
      select(v.sel.r, v.sel.c);
    }
  });
  input.addEventListener('blur', () => {
    if (v.editing) commitEdit();
  });
}

function commitEdit() {
  const v = sheetView;
  const input = $('#sh-grid .sh-input');
  v.editing = false;
  if (!input) return;
  setCell(v.sel.r, v.sel.c, input.value);
}

/* A typed value into its cell: a number for a money or number column, else text; a formula stays a formula. */
function setCell(r, c, text) {
  const v = sheetView;
  const row = v.doc.rows[r];
  const col = v.doc.columns[c];
  if (!row || !col) return;
  let value = text;
  if (!isFormula(text)) {
    if (text === '') value = col.type === 'money' || col.type === 'number' ? null : '';
    else if (col.type === 'money' || col.type === 'number') {
      const n = Number(String(text).replace(/[^\d.-]/g, ''));
      value = Number.isFinite(n) ? n : text;
    } else if (col.type === 'currency') value = text.trim().toUpperCase();
    else if (col.type === 'date') value = parseTypedDate(text);
  }
  const before = row.cells[col.key];
  if ((before ?? '') === (value ?? '')) return drawGrid();
  row.cells[col.key] = value;
  (row.edited ||= {})[col.key] = true;
  // A cell of the system's? Then the question: into the system too? (asked 7 Nov 2026)
  const bound = Boolean(row.ref && (col.bind || row.bind?.[col.key]));
  if (bound || row.manual) v.pending = { r, label: col.label, value };
  markDirty();
  drawGrid();
  drawPending();
}
function parseTypedDate(s) {
  const t = s.trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return m[0].slice(0, 10);
  return t;
}

async function removeRow(r) {
  const v = sheetView;
  const row = v.doc.rows[r];
  if (!row) return;
  if (!(await askDialog({ title: `Remove row ${r + 2} from the sheet?`, text: row.ref ? 'The watch or expense itself stays in the system.' : '', ok: 'Remove the row', danger: true }))) return;
  if (v.doc.rows[r] !== row) return;
  v.doc.rows.splice(r, 1);
  v.sel = null;
  markDirty();
  drawGrid();
  drawPending();
}

/* The bar under the head: an edit that could go into the system, and the rows whose changes are not there yet. */
function drawPending() {
  const v = sheetView;
  const box = $('#sh-pending');
  if (!box) return;
  if (!can('editor')) return (box.innerHTML = '');
  const waiting = v.doc.rows.map((row, i) => ({ row, i })).filter(({ row }) => row.manual || Object.keys(row.edited || {}).some((k) => row.ref && (v.doc.columns.find((c) => c.key === k)?.bind || row.bind?.[k])));
  if (v.pending) {
    const row = v.doc.rows[v.pending.r];
    const what = row?.manual ? `Row ${v.pending.r + 2} is new on the sheet.` : `${esc(v.pending.label)} changed on the sheet.`;
    box.innerHTML = `<div class="note info sh-ask"><span>${what} <b>Put it in the system too?</b> ${row?.manual ? whatItMakes() : 'The watch is changed as from its edit form — locked against Chrono Key’s copy, and logged.'}</span>
      <span class="row"><button class="btn small primary" type="button" id="sh-yes">Yes, into the system</button><button class="btn small" type="button" id="sh-no">Only on the sheet</button></span></div>`;
    $('#sh-yes').addEventListener('click', () => applyRow(v.pending.r));
    $('#sh-no').addEventListener('click', () => {
      v.pending = null;
      drawPending();
    });
    return;
  }
  if (waiting.length) {
    box.innerHTML = `<p class="count sh-wait">${waiting.length} row${waiting.length === 1 ? '' : 's'} on this sheet ${waiting.length === 1 ? 'has' : 'have'} changes that are not in the system — each has a <b>To system</b> button.</p>`;
    return;
  }
  box.innerHTML = '';
}
function whatItMakes() {
  const k = sheetView.sheet.kind;
  return { stock: 'A new watch is made from the row (it needs a stock number).', client: 'The watch of that stock number is linked to this client.', accounting: 'An expense is made from the row (Out, Currency, What, Stock).', logistics: 'An expense is made from the row (Amount, Currency, What, Stock) — the logistics app itself is not written to.', blank: 'An expense is made from the row (Out or Amount, Currency, What).' }[k] || '';
}

async function applyRow(r) {
  const v = sheetView;
  const row = v.doc.rows[r];
  if (!row) return;
  v.pending = null;
  try {
    await saveNow();
    const res = await api(`/api/sheets/${v.sheet.id}/apply`, { method: 'POST', body: { row: row.key } });
    Object.assign(row, res.row);
    v.sheet.version += 1;
    const d = res.done[0];
    const said = d?.what === 'watch' && d.created ? 'A new watch is in the system' : d?.what === 'watch' ? `The watch is changed in the system (${(d.changed || []).join(', ') || 'nothing differed'})` : d?.what === 'expense' && d.created ? 'An expense is in the system' : d?.what === 'expense' ? 'The expense is changed in the system' : d?.what === 'link' ? 'The watch is linked to the client' : 'Done';
    flash(said);
    drawGrid();
    drawPending();
  } catch (err) {
    flash(err.message, true);
    drawPending();
  }
}

/* ── saving ───────────────────────────────────────────────────────── */

function markDirty() {
  const v = sheetView;
  v.dirty = true;
  const el = $('#sh-saved');
  if (el) el.textContent = 'saving…';
  clearTimeout(v.saveTimer);
  v.saveTimer = setTimeout(() => saveNow(), 1200);
}
function queueSave(extra) {
  sheetView.extra = { ...(sheetView.extra || {}), ...extra };
  markDirty();
}
/* The computed value of every formula goes with the save, so the CSV and the PDF (made on the server) print figures, not formulas. */
function withCalc(doc) {
  calcMemo = new Map();
  return {
    ...doc,
    rows: doc.rows.map((row, i) => {
      const calc = {};
      for (const c of doc.columns) if (isFormula(row.cells[c.key])) calc[c.key] = shownValue(c, row, i);
      return Object.keys(calc).length ? { ...row, calc } : { ...row, calc: undefined };
    }),
  };
}
async function saveNow() {
  const v = sheetView;
  clearTimeout(v.saveTimer);
  if (!v.dirty || !v.sheet) return;
  const body = { doc: withCalc(v.doc), version: v.sheet.version, ...(v.extra || {}) };
  v.dirty = false;
  v.extra = null;
  try {
    const r = await api(`/api/sheets/${v.sheet.id}`, { method: 'PATCH', body });
    v.sheet.version = r.version;
    const el = $('#sh-saved');
    if (el && !v.dirty) el.textContent = `saved ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (err) {
    v.dirty = true;
    const el = $('#sh-saved');
    if (el) el.textContent = 'not saved';
    flash(err.message, true);
    if (/reload/.test(err.message)) setTimeout(() => showSheet(v.sheet.id), 2500);
    throw err;
  }
}
window.addEventListener('beforeunload', (e) => {
  if (sheetView.dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});
window.addEventListener('hashchange', () => {
  if (sheetView.dirty) saveNow().catch(() => {});
});

/* ── Ask ──────────────────────────────────────────────────────────── */

const askView = { thread: null, threads: [], busy: false, steps: [] };

async function showAsk(threadId) {
  const enabled = state.meta?.ai?.enabled;
  $('#app').innerHTML = `
    <div class="ask">
      <aside class="ask-side panel">
        <div class="row" style="justify-content:space-between"><h3 style="margin:0">Conversations</h3><a class="btn small" href="#/ask">+ New</a></div>
        <div id="ask-threads" class="ask-threads"><p class="count">Loading…</p></div>
      </aside>
      <section class="ask-main panel">
        <div id="ask-log" class="ask-log"></div>
        <form id="ask-form" class="ask-form">
          <textarea id="ask-q" rows="2" placeholder="${enabled ? 'Ask anything about the stock, clients, money, logistics… or for a CSV or a PDF' : 'Ask is not set up'}" ${enabled ? '' : 'disabled'} aria-label="Your question"></textarea>
          <button class="btn primary" type="submit" ${enabled ? '' : 'disabled'} id="ask-send">Ask</button>
        </form>
      </section>
    </div>`;
  if (!enabled) {
    $('#ask-log').innerHTML = `<div class="note">Ask is not set up on this server: it needs <code>ANTHROPIC_API_KEY</code> in the environment (HOSTING.md says where). Sheets work without it.</div>`;
  }
  loadThreads(threadId);
  if (threadId) await openThread(threadId);
  else {
    askView.thread = null;
    if (enabled) renderAskLog();
  }
  $('#ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendAsk();
  });
  $('#ask-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAsk();
    }
  });
  $('#ask-q').focus();
}

async function loadThreads(current) {
  try {
    askView.threads = (await api('/api/ask/threads')).threads;
  } catch {
    askView.threads = [];
  }
  const box = $('#ask-threads');
  if (!box) return;
  box.innerHTML = askView.threads.length
    ? askView.threads
        .map((t) => `<a class="ask-thread${t.id === current ? ' on' : ''}" href="#/ask/${t.id}"><span>${esc(t.title || 'Untitled')}</span><small>${esc(fmtWhen(t.updated_at))}</small></a>`)
        .join('')
    : '<p class="count">No conversations yet. Ask something — the answer and what it did are kept here.</p>';
}

async function openThread(id) {
  try {
    askView.thread = await api(`/api/ask/threads/${id}`);
  } catch (err) {
    $('#ask-log').innerHTML = `<p class="err">${esc(err.message)}</p>`;
    return;
  }
  renderAskLog();
}

/* Markdown as the assistant writes it — headings, bold, lists, tables, links, code — escaped first, so nothing in an answer becomes markup. */
function md(text) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
      .replace(/\[([^\]]+)\]\(((?:#\/|\/api\/|https?:\/\/)[^)\s]+)\)/g, (m, label, href) => {
        const ext = /^https?:/.test(href);
        const file = href.startsWith('/api/ask/files/');
        return `<a href="${href}"${ext ? ' target="_blank" rel="noopener"' : file ? (href.endsWith && /\.pdf$|pdf/i.test(label) ? ' target="_blank" rel="noopener"' : ' download') : ''}>${label}</a>`;
      });
  const lines = String(text || '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre>${esc(buf.join('\n'))}</pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) {
      const cells = (s) => s.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      const numeric = head.map((_, c) => rows.length && rows.every((r) => /^[-+]?[\d.,\s]*\d[\d.,\s]*%?$|^$/.test(r[c] || '')));
      out.push(`<div class="tscroll"><table class="list ask-table"><thead><tr>${head.map((h, c) => `<th${numeric[c] ? ' class="num"' : ''}>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows
        .map((r) => `<tr>${head.map((_, c) => `<td${numeric[c] ? ' class="num"' : ''}>${inline(r[c] || '')}</td>`).join('')}</tr>`)
        .join('')}</tbody></table></div>`);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      out.push(`<h${Math.min(h[1].length + 2, 5)} class="ask-h">${inline(h[2])}</h${Math.min(h[1].length + 2, 5)}>`);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (!l.trim()) {
      i++;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*]|\d+\.)\s+|\s*\|.*\|\s*$)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('');
}

function renderAskLog(live) {
  const t = askView.thread;
  const log = $('#ask-log');
  if (!log) return;
  if (!t && !live) {
    log.innerHTML = `<div class="ask-hello"><h2>Ask the system</h2><p class="sub">It reads everything the ERP holds — watches, clients, expenses, our copy of the logistics app, the Chrono Key and vault records, every change — and answers with figures, a table, a sheet, a CSV or a PDF. It never changes anything.</p>
      <div class="pills" id="ask-eg">${['Which watches in stock have been there longest?', 'What did we pay in logistics for stock 1617?', 'Money in and out with our biggest client this year', 'A PDF of everything sold in October 2026, by currency', 'CSV of every incoming watch with its supplier'].map((q) => `<button class="pill" type="button">${esc(q)}</button>`).join('')}</div></div>`;
    $$('#ask-eg .pill').forEach((b) =>
      b.addEventListener('click', () => {
        $('#ask-q').value = b.textContent;
        sendAsk();
      })
    );
    return;
  }
  const turns = [...(t?.turns || [])];
  const steps = t?.steps || [];
  let html = '';
  let stepAt = 0;
  // Steps go under the answer they led to: each assistant turn takes the steps made since the one before.
  const stepsPerAnswer = [];
  {
    const answers = turns.filter((x) => x.role === 'assistant').length;
    const per = Math.ceil(steps.length / Math.max(answers, 1));
    for (let a = 0; a < answers; a++) stepsPerAnswer.push(steps.slice(a * per, (a + 1) * per));
  }
  let a = 0;
  for (const turn of turns) {
    if (turn.role === 'user') html += `<div class="ask-u">${esc(turn.text).replace(/\n/g, '<br>')}</div>`;
    else {
      const mine = stepsPerAnswer[a++] || [];
      html += `<div class="ask-a">${md(turn.text)}${mine.length ? askSteps(mine) : ''}</div>`;
    }
  }
  if (live) html += `<div class="ask-u">${esc(live.question).replace(/\n/g, '<br>')}</div><div class="ask-a ask-live"><p class="count ask-working"><span class="ask-dot"></span>${esc(live.now || 'Thinking…')}</p>${live.steps.length ? askSteps(live.steps, true) : ''}</div>`;
  if (t?.status === 'error' && t.error && !live) html += `<div class="note">${esc(t.error)}</div>`;
  if (t?.files?.length && !live) {
    html += `<div class="ask-files"><h3>Files from this conversation</h3>${t.files
      .map((f) => `<a class="btn small" href="/api/ask/files/${esc(f.id)}${f.type.startsWith('application/pdf') ? '" target="_blank" rel="noopener' : '" download'}">${esc(f.name)}</a>`)
      .join(' ')}</div>`;
  }
  log.innerHTML = html;
  void stepAt;
  log.scrollTop = log.scrollHeight;
}
function askSteps(steps, open = false) {
  return `<details class="ask-steps"${open ? ' open' : ''}><summary>What it did · ${steps.length} step${steps.length === 1 ? '' : 's'}</summary><ol>${steps
    .map((s) => `<li class="${s.error ? 'bad' : ''}">${esc(s.summary || s.tool)}${s.error ? ` — <span class="err">${esc(s.error)}</span>` : ''}${s.sheet ? ` · <a href="#/sheet/${s.sheet.id}">open the sheet</a>` : ''}${s.file ? ` · <a href="${esc(s.file.link)}"${/\.pdf$/i.test(s.file.name) ? ' target="_blank" rel="noopener"' : ' download'}>${esc(s.file.name)}</a>` : ''}</li>`)
    .join('')}</ol></details>`;
}

async function sendAsk() {
  const q = $('#ask-q').value.trim();
  if (!q || askView.busy) return;
  askView.busy = true;
  $('#ask-q').value = '';
  $('#ask-send').disabled = true;
  const live = { question: q, steps: [], now: 'Thinking…' };
  renderAskLog(live);
  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'masterapp' },
      body: JSON.stringify({ question: q, thread: askView.thread?.id || null }),
    });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let final = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.step) {
          live.steps.push(msg.step);
          live.now = msg.step.error ? 'Trying another way…' : `${msg.step.summary} — writing the answer…`;
          renderAskLog(live);
        } else if (msg.thread) final = msg.thread;
        else if (msg.error) throw new Error(msg.error);
      }
    }
    if (!final) throw new Error('The answer did not arrive whole — open the conversation again');
    askView.thread = final;
    if (location.hash !== `#/ask/${final.id}`) history.replaceState(null, '', `#/ask/${final.id}`);
    renderAskLog();
    loadThreads(final.id);
  } catch (err) {
    flash(err.message, true);
    if (askView.thread) openThread(askView.thread.id);
    else {
      renderAskLog();
      $('#ask-q').value = q;
    }
  } finally {
    askView.busy = false;
    $('#ask-send').disabled = false;
    $('#ask-q').focus();
  }
}
