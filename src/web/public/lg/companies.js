/*
 * Companies: the logistics app's "Companies" page — the firms we buy and
 * sell through, each with the block of details people paste into invoices
 * and labels, searched as the app searches (name and details), and under
 * each the shipment documents issued through it (every stock number our
 * watch, every client linked as far as the name goes). The app's "Company ·
 * Dubai" client rows — our own places as a shipment's from / to — are listed
 * apart. Add / edit / delete are the app's own buttons, done here
 * (actions/records.js). Copy details is the app's own button, kept.
 */
'use strict';
const cp = { q: '', data: null };

LG_PAGES.companies = async function () {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('companies')}
    <p class="sub" style="margin:0 0 12px">The companies we buy and sell through — their details for invoices and labels, and the shipment documents issued through each.</p>
    ${lgActionBar('companies')}
    <div class="lg-toolbar cp-toolbar">
      <input class="q" type="search" id="cpq" placeholder="Company name, address, TRN, bank, contact…" value="${esc(cp.q)}" aria-label="Search companies">
      <a class="btn" href="#/logistics/companies-all">All records</a>
    </div>
    <div class="count" id="cp-count">Reading the companies…</div>
    <div id="cp-out" class="cp-list"></div>
    <div id="cp-places"></div>`;
  let timer;
  $('#cpq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      cp.q = e.target.value;
      drawCompanies();
    }, 150);
  });
  $('#cp-out').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-copy]');
    if (!b) return;
    const c = cp.data?.companies.find((x) => x.id === Number(b.dataset.copy));
    if (!c) return;
    try {
      await navigator.clipboard.writeText(`${c.name}\n${c.details}`.trim());
      flash('Company details copied');
    } catch {
      flash('Could not copy — select the details and copy them by hand', true);
    }
  });
  let r;
  try {
    r = await api('/api/logistics/page/companies');
  } catch (err) {
    if (seq === lgPage && $('#cp-count')) $('#cp-count').textContent = `Could not read the companies: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#cp-out')) return;
  cp.data = r;
  drawCompanies();
};

const cpDoc = (d) =>
  `<li><a href="#/lg/${d.id}">${esc(d.doc_type)}</a>${d.date ? ` · ${esc(dayWords(d.date))}` : ''}${
    d.stock_no ? ` · ${d.watch ? `<a href="#/watch/${d.watch.id}"><b>#${esc(d.stock_no)}</b></a> ${chip(d.watch.status)}` : `<b>#${esc(d.stock_no)}</b>`}` : ''
  }${d.client_name ? ` · ${esc(d.client_name)}` : ''}${d.file_name ? ` <span class="count" style="margin:0">${esc(d.file_name)}</span>` : ''}</li>`;

function drawCompanies() {
  const r = cp.data;
  if (!r || !$('#cp-out')) return;
  const words = cp.q.toLowerCase().split(/\s+/).filter(Boolean);
  // The app's rule: the name and the details, as one text.
  const list = r.companies.filter((c) => sfMatch(words, c.name, c.details, ...c.clients));
  const n = list.length;
  $('#cp-count').textContent = `${n} compan${n === 1 ? 'y' : 'ies'}${words.length ? ` of ${r.companies.length}` : ''} · ${r.documents} shipment document${r.documents === 1 ? '' : 's'} issued through them`;
  if (!n) {
    $('#cp-out').innerHTML = `<p class="sub">${words.length ? 'No company matches.' : 'No companies yet. Add the first with "Add company".'}</p>`;
  } else {
    $('#cp-out').innerHTML = list
      .map(
        (c) => `<article class="panel cp-card" data-id="${c.id}">
          <div class="cp-head">
            <h3>${esc(c.name)}${c.locked ? ' <span class="lock" title="Edited here">✎</span>' : ''}</h3>
            <div class="cp-acts">
              <button type="button" class="btn small" data-copy="${c.id}">Copy details</button>
              ${lgActBtn('co-edit', c.id, { cls: 'small' })}${lgActBtn('co-delete', c.id, { cls: 'small' })}
              <a class="btn small" href="#/lg/${c.id}">Open record</a>
            </div>
          </div>
          ${c.link ? `<div class="count" style="margin:0 0 8px">Also a client: ${lgPerson(c.name, c.link)}</div>` : ''}
          ${c.details ? `<pre class="cp-details">${esc(c.details)}</pre>` : '<p class="count" style="margin:0 0 8px">No details added.</p>'}
          <div class="cp-docs">${
            c.docs.length
              ? `<div class="count" style="margin:0 0 4px">${c.docs.length} document${c.docs.length === 1 ? '' : 's'} issued through it · ${esc(c.doc_types.map((t) => `${t.n} ${t.type.toLowerCase()}${t.n === 1 ? '' : 's'}`).join(', '))}${
                  c.last_used ? ` · last ${esc(dayWords(c.last_used))}` : ''
                }</div><ul class="cp-doclist">${c.docs.map(cpDoc).join('')}</ul>`
              : '<div class="count" style="margin:0">No shipment document names it yet.</div>'
          }</div>
        </article>`
      )
      .join('');
  }
  $('#cp-places').innerHTML = r.places.length
    ? `<div class="panel cp-places"><h3 style="margin:0 0 6px">Our own places in the logistics app</h3>
        <p class="count" style="margin:0 0 8px">The app's client list carries one "Company" row per place we ship from or to — these are us, not a client.</p>
        <div class="lg-subtabs" style="margin:0">${r.places.map((p) => `<a class="pill" href="#/lg/${p.id}">${esc(p.name)}<b>${esc(p.country || '—')}</b></a>`).join('')}</div></div>`
    : '';
}
