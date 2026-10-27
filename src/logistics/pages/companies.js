/*
 * Companies: the logistics app's "Companies" page (asked 27 Oct 2026, "all
 * these tabs … keep each page how it is"), read from our copy of its records.
 *
 * In the app a company is one of the firms we buy and sell THROUGH — a
 * name and a block of pasted details (address, TRN, bank, contact), kept in
 * `state.companies` ({ id, name, description, ts }). It is used in one
 * place: a shipment document names the company it was issued through
 * (`shipmentDocs.companyId` / `companyName`). Not to be confused with the
 * app's "company clients" — the rows of its client list ticked `isCompany`
 * ("Company · Dubai", `companyLabel`), which stand for OUR OWN places as the
 * from / to of a shipment. Both are shown here, apart.
 *
 * A company named like one of our clients, or a logistics client, is linked
 * as far as the name goes (`linksByName`) — never guessed.
 */
import { query } from '../../db/index.js';
import { text, iso, dayOf, oursByNumber } from '../shared.js';
import { linksByName } from '../clients.js';

const msOf = (v) => Date.parse(v || '') || 0;

/** The page's data (GET /api/logistics/page/companies). */
export async function page() {
  const [{ rows }, { rows: docRows }, { rows: places }] = await Promise.all([
    query("SELECT * FROM logistics_items WHERE kind = 'companies' AND deleted_at IS NULL ORDER BY id"),
    query("SELECT * FROM logistics_items WHERE kind = 'shipmentDocs' AND deleted_at IS NULL ORDER BY id"),
    query("SELECT id, source_id, data FROM logistics_items WHERE kind = 'clients' AND deleted_at IS NULL AND data->>'isCompany' = 'true' ORDER BY id"),
  ]);
  const [links, ours] = await Promise.all([linksByName(rows.map((r) => text(r.data?.name))), oursByNumber(docRows.flatMap((r) => r.stock_nos || []))]);

  // The documents issued through each company, by the app's own company id (else its typed name).
  const docsOf = new Map();
  for (const r of docRows) {
    const d = r.data || {};
    const key = text(d.companyId) || `name:${text(d.companyName).toLowerCase()}`;
    const list = docsOf.get(key) || [];
    list.push({
      id: r.id,
      doc_type: text(d.docType) || 'Document',
      date: dayOf(d.date) || dayOf(d.ts),
      client_name: text(d.clientName),
      stock_no: text(d.stockNumber),
      watch: (r.stock_nos || []).map((s) => ours.get(s)).find(Boolean) || null,
      file_name: text(d.fileName),
    });
    docsOf.set(key, list);
  }

  const companies = rows
    .map((r) => {
      const d = r.data || {};
      const name = text(d.name) || 'Company';
      const docs = [...(docsOf.get(text(r.source_id)) || []), ...(docsOf.get(`name:${name.toLowerCase()}`) || [])]
        .filter((x, i, a) => a.findIndex((y) => y.id === x.id) === i)
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.id - a.id);
      const types = new Map();
      for (const x of docs) types.set(x.doc_type, (types.get(x.doc_type) || 0) + 1);
      return {
        id: r.id,
        name,
        details: text(d.description),
        added: iso(d.ts) || new Date(r.created_at).toISOString(),
        locked: (r.locked_fields || []).length > 0,
        link: links.get(name) || null,
        docs,
        doc_types: [...types].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n || a.type.localeCompare(b.type)),
        clients: [...new Set(docs.map((x) => x.client_name).filter(Boolean))],
        last_used: docs[0]?.date || null,
      };
    })
    // The app puts the newest first (unshift).
    .sort((a, b) => msOf(b.added) - msOf(a.added) || b.id - a.id);

  return {
    companies,
    documents: docRows.length,
    // The app's "Company · <country>" clients: our own places as a shipment's from / to.
    places: places.map((p) => ({ id: p.id, cid: text(p.source_id), name: text(p.data?.name) || 'Company', country: text(p.data?.country) })),
  };
}

/**
 * A company is tied to a watch only through its shipment documents, and the
 * Shipment Documents page says that (its forStock names the company): nothing
 * to add here.
 */
export function forStock() {
  return [];
}
