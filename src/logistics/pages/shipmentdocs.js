/*
 * Shipment Documents: the logistics app's "Shipment Documents" page — the
 * invoices, labels, delivery notes and purchase agreements it holds, each
 * for one stock number, one client and the company it was issued through
 * (`shipmentDocs`: { id, companyId, companyName, clientId, clientName,
 * stockNumber, docType, fileUrl, fileName, fileType, date, notes, ts }).
 *
 * Linked as everywhere: the stock number to OUR watch and its clients (by
 * Chrono Key's ids); the app's own client id through linksByClientId, a
 * typed name through linksByName; the company to its record here.
 *
 * The file: the app kept early ones inline and later ones on its storage.
 * A copy held here ("lgfile:<id>") is served from /api/logistics/files; one
 * still on the app's worker through /api/logistics/worker-file; one on a
 * host the sync does not copy from (its Supabase bucket) is only a link —
 * said so, never fetched into the page.
 */
import { query } from '../../db/index.js';
import { text, iso, dayOf, oursByNumber, photoPrefix } from '../shared.js';
import { linksByName, linksByClientId } from '../clients.js';

/* The app's own four, in its order; any other type typed into a record follows them. */
export const DOC_TYPES = ['Invoice', 'Label', 'Delivery Note', 'Purchase Agreement'];

/** How a document's file can be reached from here. */
export function fileOf(d) {
  const ref = text(d.fileUrl);
  const name = text(d.fileName);
  const type = text(d.fileType).toLowerCase();
  const picture = type.startsWith('image/') || /\.(jpe?g|png|webp|gif)$/i.test(name) || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(ref);
  if (!ref) return null;
  if (ref === 'lgfile:unreadable') return { kind: 'unreadable', name, type, picture: false };
  if (/^lgfile:\d+$/.test(ref)) return { kind: 'copy', ref, name, type, picture };
  const prefix = photoPrefix();
  if (prefix && ref.startsWith(prefix)) return { kind: 'worker', ref, name, type, picture };
  if (/^https:\/\//i.test(ref)) return { kind: 'external', url: ref, name, type, picture };
  return { kind: 'unreadable', name, type, picture: false };
}

const docView = (r, ours, byCid, byName, companies) => {
  const d = r.data || {};
  const stock = text(d.stockNumber);
  const cid = text(d.clientId);
  const clientName = text(d.clientName);
  const company = companies.get(text(d.companyId)) || null;
  return {
    id: r.id,
    ts: iso(d.ts) || new Date(r.created_at).toISOString(),
    date: dayOf(d.date) || dayOf(d.ts),
    doc_type: text(d.docType) || 'Document',
    notes: text(d.notes),
    locked: (r.locked_fields || []).length > 0,
    stock_no: stock,
    watch: (r.stock_nos || []).map((s) => ours.get(s)).find(Boolean) || null,
    client: { name: clientName || (cid && byCid.get(cid)?.name) || '', cid, link: (cid && byCid.get(cid)) || (clientName && byName.get(clientName)) || null },
    company: { name: text(d.companyName) || company?.name || '', cid: text(d.companyId), id: company?.id || null },
    file: fileOf(d),
  };
};

/** The page's data (GET /api/logistics/page/shipmentdocs). */
export async function page() {
  const [{ rows }, { rows: cos }] = await Promise.all([
    query("SELECT * FROM logistics_items WHERE kind = 'shipmentDocs' AND deleted_at IS NULL ORDER BY id"),
    query("SELECT id, source_id, data->>'name' AS name FROM logistics_items WHERE kind = 'companies' AND deleted_at IS NULL"),
  ]);
  const companies = new Map(cos.map((c) => [text(c.source_id), { id: c.id, name: text(c.name) }]));
  const [ours, byCid] = await Promise.all([oursByNumber(rows.flatMap((r) => r.stock_nos || [])), linksByClientId(rows.map((r) => r.data?.clientId))]);
  // A typed name links only where the app's own id did not.
  const byName = await linksByName(rows.filter((r) => !byCid.has(text(r.data?.clientId))).map((r) => text(r.data?.clientName)));
  const docs = rows.map((r) => docView(r, ours, byCid, byName, companies)).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.id - a.id);
  const seen = new Set(docs.map((x) => x.doc_type));
  return {
    docs,
    types: [...DOC_TYPES, ...[...seen].filter((t) => !DOC_TYPES.includes(t)).sort()],
    clients: [...new Set(docs.map((x) => x.client.name).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    companies: [...new Set(docs.map((x) => x.company.name).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    stock_nos: [...new Set(docs.map((x) => x.stock_no).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  };
}

/**
 * On the watch's card and page: how many documents the app holds for it,
 * which kinds, and through which company — "2 documents: invoice, label ·
 * via Estival Habitual LDA".
 */
export function forStock(stockNo, rows) {
  const docs = rows.filter((r) => r.kind === 'shipmentDocs');
  if (!docs.length) return [];
  // The kinds in the app's own order: invoice, label, delivery note, purchase agreement, then anything else typed.
  const order = (t) => {
    const i = DOC_TYPES.findIndex((x) => x.toLowerCase() === t);
    return i < 0 ? DOC_TYPES.length : i;
  };
  const types = [...new Set(docs.map((r) => text(r.data?.docType).toLowerCase()).filter(Boolean))].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const via = [...new Set(docs.map((r) => text(r.data?.companyName)).filter(Boolean))];
  return [
    {
      text: `${docs.length} document${docs.length === 1 ? '' : 's'}${types.length ? `: ${types.join(', ')}` : ''}${via.length ? ` · via ${via.join(', ')}` : ''}`,
      link: '#/logistics/shipmentdocs',
      tone: '',
    },
  ];
}
