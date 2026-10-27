/*
 * Shipment Documents: the logistics app's page of invoices, labels, delivery
 * notes and purchase agreements, by client / company / stock — its five
 * filters and four sort orders kept (grouped by client, by company, by
 * type, newest first). Every stock number is our watch with its clients; a
 * client links as far as the app's id or the typed name goes; the company
 * to its record. The file opens or downloads from our copy; one the app kept
 * on its own storage is a link there. Add / delete are the app's own
 * buttons, done here (actions/records.js); the file goes on the document
 * through the upload control, and becomes its file.
 */
'use strict';
const sd = { q: '', client: '', company: '', type: '', stock: '', sort: 'client', data: null };

LG_PAGES.shipmentdocs = async function () {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('shipmentdocs')}
    <p class="sub" style="margin:0 0 12px">Invoices, labels, delivery notes and agreements, by client, company and stock. Each stock number is our watch. Add the document, then its file.</p>
    ${lgActionBar('shipmentdocs')}
    <div class="lg-toolbar sd-toolbar">
      <input class="q" type="search" id="sdq" placeholder="Stock number, client, company, file name, notes…" value="${esc(sd.q)}" aria-label="Search documents">
      <select id="sd-client" aria-label="Client"><option value="">All clients</option></select>
      <select id="sd-company" aria-label="Company"><option value="">All companies</option></select>
      <select id="sd-type" aria-label="Document type"><option value="">All document types</option></select>
      <select id="sd-stock" aria-label="Stock number"><option value="">All stock numbers</option></select>
      <select id="sd-sort" aria-label="Order">
        <option value="client">By client</option>
        <option value="company">By company</option>
        <option value="type">By document type</option>
        <option value="date_desc">Newest first</option>
      </select>
    </div>
    <div class="count" id="sd-count">Reading the documents…</div>
    <div id="sd-out"></div>`;
  let timer;
  $('#sdq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      sd.q = e.target.value;
      drawShipmentDocs();
    }, 150);
  });
  for (const [id, key] of [['sd-client', 'client'], ['sd-company', 'company'], ['sd-type', 'type'], ['sd-stock', 'stock'], ['sd-sort', 'sort']]) {
    $(`#${id}`).addEventListener('change', (e) => {
      sd[key] = e.target.value;
      drawShipmentDocs();
    });
  }
  lgOpenOnClick($('#sd-out'));
  let r;
  try {
    r = await api('/api/logistics/page/shipmentdocs');
  } catch (err) {
    if (seq === lgPage && $('#sd-count')) $('#sd-count').textContent = `Could not read the documents: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#sd-out')) return;
  sd.data = r;
  const fill = (id, values, key) => {
    const s = $(`#${id}`);
    s.innerHTML = s.options[0].outerHTML + values.map((v) => `<option value="${esc(v)}">${esc(key === 'stock' ? `#${v}` : v)}</option>`).join('');
    if (!values.includes(sd[key])) sd[key] = '';
    s.value = sd[key];
  };
  fill('sd-client', r.clients, 'client');
  fill('sd-company', r.companies, 'company');
  fill('sd-type', r.types, 'type');
  fill('sd-stock', r.stock_nos, 'stock');
  $('#sd-sort').value = sd.sort;
  drawShipmentDocs();
};

/* The file: a thumbnail of our copy that opens it, and a download; a file on the app's own storage is a link there. */
function sdFile(d) {
  const f = d.file;
  if (!f) return '<span class="blank">No file</span>';
  const name = f.name || (f.picture ? 'picture' : 'document');
  if (f.kind === 'copy' || f.kind === 'worker') {
    return `<div class="sd-file"><a href="${esc(fileUrl(f.ref))}" target="_blank" rel="noopener" title="Open ${esc(name)}"><img src="${esc(fileUrl(f.ref, true))}" alt="" loading="lazy"></a>
      <div class="sd-fname"><a href="${esc(fileUrl(f.ref))}" target="_blank" rel="noopener">${esc(name)}</a>${f.kind === 'copy' ? ` · <a href="${esc(fileUrl(f.ref))}${fileUrl(f.ref).includes('?') ? '&' : '?'}download=1">Download</a>` : ''}</div></div>`;
  }
  if (f.kind === 'external') {
    return `<div class="sd-file"><a class="sd-ext" href="${esc(f.url)}" target="_blank" rel="noopener noreferrer" title="On the logistics app's own storage — not copied here">${esc(name)} ↗</a><div class="count" style="margin:2px 0 0">On the logistics app's storage</div></div>`;
  }
  return `<span class="blank">${esc(name)} — could not be read</span>`;
}
const sdOurs = (d) =>
  d.watch
    ? `<a href="#/watch/${d.watch.id}"><b>#${esc(d.stock_no)}</b></a> ${chip(d.watch.status)}<div class="count" style="margin:2px 0 0">${esc(d.watch.title)}</div>${
        d.watch.bought_from ? `<div class="count" style="margin:0">Bought from <a href="#/client/${d.watch.bought_from.id}">${esc(d.watch.bought_from.name)}</a></div>` : ''
      }${d.watch.sold_to ? `<div class="count" style="margin:0">Sold to <a href="#/client/${d.watch.sold_to.id}">${esc(d.watch.sold_to.name)}</a></div>` : ''}`
    : d.stock_no
      ? `<b>#${esc(d.stock_no)}</b><div class="count" style="margin:2px 0 0">Not one of our watches</div>`
      : '<span class="blank">—</span>';
const sdClient = (d) => (d.client.name ? lgPerson(d.client.name, d.client.link) : '<span class="blank">not written</span>');
const sdCompany = (d) => (d.company.name ? (d.company.id ? `<a href="#/lg/${d.company.id}">${esc(d.company.name)}</a>` : esc(d.company.name)) : '<span class="blank">—</span>');
const sdRow = (d) => `<tr data-id="${d.id}" tabindex="0">
    <td>${sdClient(d)}</td>
    <td>${sdCompany(d)}</td>
    <td>${sdOurs(d)}</td>
    <td style="white-space:nowrap"><a href="#/lg/${d.id}"><b>${esc(d.doc_type)}</b></a>${d.locked ? ' <span class="lock" title="Edited here">✎</span>' : ''}</td>
    <td style="white-space:nowrap">${esc(d.date ? dayWords(d.date) : '')}</td>
    <td>${sdFile(d)}${!d.file || d.file.kind === 'unreadable' ? lgUploadCtl(d.id, 'files', 'Add the file', { multiple: false, then: 'doc-attach' }) : ''}</td>
    <td>${esc(d.notes || '')}${lgActBtn('doc-delete', d.id) ? `<div class="lg-rowacts">${lgActBtn('doc-delete', d.id)}</div>` : ''}</td>
  </tr>`;
const sdTable = (rows) => `<div class="panel tscroll" style="padding:0"><table class="list lg sd-table"><thead><tr>
    <th>Client</th><th>Company</th><th>Stock · our watch</th><th>Type</th><th>Date</th><th>Document</th><th>Notes</th>
  </tr></thead><tbody>${rows.map(sdRow).join('')}</tbody></table></div>`;

function drawShipmentDocs() {
  const r = sd.data;
  if (!r || !$('#sd-out')) return;
  const words = sd.q.toLowerCase().split(/\s+/).filter(Boolean);
  let rows = r.docs.filter(
    (d) =>
      (!sd.client || d.client.name === sd.client) &&
      (!sd.company || d.company.name === sd.company) &&
      (!sd.type || d.doc_type === sd.type) &&
      (!sd.stock || d.stock_no === sd.stock) &&
      sfMatch(words, d.client.name, d.company.name, d.stock_no, d.doc_type, d.file?.name, d.notes, d.watch?.title, d.watch?.bought_from?.name, d.watch?.sold_to?.name)
  );
  const byType = new Map();
  for (const d of rows) byType.set(d.doc_type, (byType.get(d.doc_type) || 0) + 1);
  const n = rows.length;
  $('#sd-count').textContent = `${n} document${n === 1 ? '' : 's'}${n !== r.docs.length ? ` of ${r.docs.length}` : ''}${
    n ? ` · ${[...byType].map(([t, k]) => `${k} ${t.toLowerCase()}${k === 1 ? '' : 's'}`).join(', ')}` : ''
  }`;
  if (!n) {
    $('#sd-out').innerHTML = `<p class="sub">${r.docs.length ? 'No document matches.' : 'No shipment documents yet.'}</p>`;
    return;
  }
  const by = (k) => (a, b) => String(a[k] || '').localeCompare(String(b[k] || ''));
  const name = (d) => d.client.name || '';
  if (sd.sort === 'client') {
    // The app's own grouping: by client, each saying which companies dealt with them.
    const groups = new Map();
    for (const d of rows) {
      const key = name(d) || '(no client)';
      groups.set(key, [...(groups.get(key) || []), d]);
    }
    $('#sd-out').innerHTML = [...groups]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([client, items]) => {
        items.sort((a, b) => String(a.company.name).localeCompare(String(b.company.name)) || String(b.date || '').localeCompare(String(a.date || '')));
        const companies = [...new Set(items.map((d) => d.company.name).filter(Boolean))];
        return `<section class="sd-group"><div class="sd-ghead"><b>${items[0].client.name ? lgPerson(items[0].client.name, items[0].client.link) : esc(client)}</b>
            <span class="count" style="margin:0">${items.length} doc${items.length === 1 ? '' : 's'} · via ${esc(companies.join(', ') || '—')}</span></div>${sdTable(items)}</section>`;
      })
      .join('');
    return;
  }
  rows =
    sd.sort === 'company'
      ? [...rows].sort((a, b) => String(a.company.name).localeCompare(String(b.company.name)) || name(a).localeCompare(name(b)))
      : sd.sort === 'type'
        ? [...rows].sort((a, b) => by('doc_type')(a, b) || name(a).localeCompare(name(b)))
        : [...rows].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.id - a.id);
  $('#sd-out').innerHTML = sdTable(rows);
}
