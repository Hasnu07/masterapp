/*
 * Record actions — the logistics app's Clients, Companies, Shipment
 * Documents, Other Receiving Pics and Watch Vault Activity workflows, done
 * here, each `run` the app's own function ported record for record
 * (saveClient, addCompanyLocation, deleteClient, saveCompany, deleteCompany,
 * saveShipDoc, deleteShipDoc, saveOtherPics, deleteOtherPics,
 * approveVaultNotif, dismissVaultNotif, and the vault's saveTrackStatus).
 *
 * Our rule: a stock number is OUR watch (named in the message); a client is
 * one of our logistics clients by its id (`clientId`), its name written
 * beside it where the app's record carries a typed name (`clientName`).
 * Nothing is matched by name.
 *
 * Files — a document's PDF or picture, an entry's pictures — come through the
 * files route once the record exists (the pages offer the control); a
 * document then takes the uploaded file as ITS file (`doc-attach`), since the
 * app's record holds one `fileUrl`, not a list.
 */
import { query } from '../../db/index.js';
import { insertItem, patchItem, softDelete, logActivity, loadItem, text, dayOf, localToday, bad } from '../write.js';
import { CLIENT_ID, oursByNumber } from '../shared.js';
import { stockList } from '../kinds.js';
import { DOC_TYPES } from '../pages/shipmentdocs.js';

/* The app's lists a document's stock number must be on (stockExistsInSystem), and the vault's places. */
const SYSTEM_KINDS = ['londonStock', 'dubaiStock', 'hkSituation', 'incomings', 'soldStocks', 'readyForDelivery'];
const STOCK_KINDS = ['londonStock', 'dubaiStock', 'hkStock', 'hkSituation'];
const LOC_OF_KIND = { dubaiStock: 'dubai', londonStock: 'london', hkStock: 'hk', hkSituation: 'hk' };
/* The vault's own five places (vault.html, TS_META); the first two clear the holder (TS_BACK). */
export const VAULT_STATUS = ['In Office', 'In Home', 'Gold Souk', 'Out for Photography', 'Out with Client'];
const VAULT_BACK = ['In Office', 'In Home'];

const isTrue = (v) => v === true || /^(true|yes|1|on)$/i.test(String(v ?? ''));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

async function clientsById(db = { query }) {
  const { rows } = await db.query(`SELECT ${CLIENT_ID} AS id, data->>'name' AS name, data->>'country' AS country, data->>'isCompany' AS company FROM logistics_items WHERE kind = 'clients' AND deleted_at IS NULL`);
  return new Map(rows.map((r) => [String(r.id), { id: String(r.id), name: text(r.name), country: text(r.country), isCompany: r.company === 'true' }]));
}

/* "our watch #1668" / "#1668 not one of our watches" — said in every message that names a stock number. */
async function ourWatchWords(stockNumber) {
  const nos = stockList(stockNumber);
  if (!nos.length) return '';
  const ours = await oursByNumber(nos);
  const found = nos.filter((n) => ours.has(n));
  const missing = nos.filter((n) => !ours.has(n));
  return [found.length && `our watch${found.length > 1 ? 'es' : ''} ${found.map((n) => `#${n}`).join(', ')}`, missing.length && `${missing.map((n) => `#${n}`).join(', ')} not one of our watches`].filter(Boolean).join(' · ');
}

/* ── clients ───────────────────────────────────────────────────────── */

const CLIENT_FORM = [
  { key: 'name', label: 'Name', type: 'text', required: true },
  { key: 'country', label: 'Country', type: 'text', required: true },
  { key: 'phone', label: 'Phone', type: 'text' },
  { key: 'isCompany', label: 'One of our own places (Company)', type: 'bool' },
  { key: 'notes', label: 'Notes', type: 'longtext' },
];
function clientFields(input) {
  const name = text(input.name, 200);
  const country = text(input.country, 100);
  if (!name || !country) throw bad('Name and country required');
  return { name, country, phone: text(input.phone, 60), notes: text(input.notes, 2000), isCompany: isTrue(input.isCompany) };
}

/* ── companies ─────────────────────────────────────────────────────── */

const COMPANY_FORM = [
  { key: 'name', label: 'Company name', type: 'text', required: true },
  { key: 'description', label: 'Details', type: 'longtext', hint: 'address, TRN, bank, contact — as pasted into invoices and labels' },
];

/* ── shipment documents ────────────────────────────────────────────── */

async function companyChoices() {
  const { rows } = await query("SELECT id, source_id, data->>'id' AS app_id, data->>'name' AS name FROM logistics_items WHERE kind = 'companies' AND deleted_at IS NULL ORDER BY lower(data->>'name')");
  return rows.map((r) => ({ value: text(r.app_id) || text(r.source_id) || `ma-${r.id}`, label: text(r.name) || 'Company' }));
}
async function companyById(db, id) {
  const cid = text(id);
  if (!cid) throw bad('Select the company you used');
  const { rows } = await db.query("SELECT id, data->>'name' AS name FROM logistics_items WHERE kind = 'companies' AND deleted_at IS NULL AND (data->>'id' = $1 OR source_id = $1 OR 'ma-' || id = $1) LIMIT 1", [cid]);
  if (!rows[0]) throw bad('That company is not in the list');
  return { id: cid, name: text(rows[0].name) };
}
/* The app's stockExistsInSystem — here our own watches count too. */
async function stockInSystem(db, sn) {
  const nos = stockList(sn);
  if (!nos.length) return false;
  if ((await oursByNumber(nos)).size) return true;
  const { rows } = await db.query("SELECT 1 FROM logistics_items WHERE kind = ANY($1) AND deleted_at IS NULL AND stock_nos && $2::text[] LIMIT 1", [SYSTEM_KINDS, nos]);
  return rows.length > 0;
}

/* ── vault activity ────────────────────────────────────────────────── */

/* The stock row a vault notification or tracking key names, as the app finds it (its loc list, by the row's id). */
async function vaultRow(db, loc, watchId, { any = false } = {}) {
  const kinds = loc === 'hk' ? ['hkSituation', 'hkStock'] : loc === 'dubai' ? ['dubaiStock'] : loc === 'london' ? ['londonStock'] : STOCK_KINDS;
  const { rows } = await db.query(
    `SELECT id FROM logistics_items WHERE kind = ANY($1) AND source_id = $2 ${any ? '' : 'AND deleted_at IS NULL'} ORDER BY (deleted_at IS NULL) DESC, array_position($1::text[], kind), id DESC LIMIT 1`,
    [kinds, text(watchId)]
  );
  return rows[0] ? loadItem(db, rows[0].id, { deleted: any }) : null;
}

export const ACTIONS = [
  /* ── clients ── */
  {
    key: 'cl-add',
    label: 'Add client',
    kinds: null,
    page: 'contacts',
    form: CLIENT_FORM,
    run: async ({ db, input, user }) => {
      const f = clientFields(input);
      // The app files one of our own places under the name "Company".
      const row = await insertItem(db, 'clients', { name: f.isCompany ? 'Company' : f.name, country: f.country, phone: f.phone, notes: f.notes, isCompany: f.isCompany }, user);
      await logActivity(db, `Added ${f.isCompany ? `🏢 Company · ${f.country}` : `client ${f.name} (${f.country})`}`, user);
      return { message: `Client saved: ${f.isCompany ? `Company · ${f.country}` : f.name}`, created: [row.id] };
    },
  },
  {
    key: 'cl-company-location',
    label: 'Add company location',
    kinds: null,
    page: 'contacts',
    form: [{ key: 'country', label: 'Country or city', type: 'text', required: true, hint: 'e.g. Dubai, HK, Spain, Switzerland, Italy, United Kingdom' }],
    run: async ({ db, input, user }) => {
      const c = text(input.country, 100);
      if (!c) throw bad('Say the country or city');
      if ([...(await clientsById(db)).values()].some((x) => x.isCompany && x.country.toLowerCase() === c.toLowerCase())) throw bad('Company location already exists');
      const row = await insertItem(db, 'clients', { name: 'Company', country: c, isCompany: true, notes: 'Company location · this represents us' }, user);
      await logActivity(db, `Added Company location: ${c}`, user);
      return { message: `Added Company · ${c}`, created: [row.id] };
    },
  },
  {
    key: 'cl-edit',
    label: 'Edit client',
    kinds: ['clients'],
    form: CLIENT_FORM,
    prefill: async (it) => ({ ...it.data }),
    run: async ({ db, item, input, user }) => {
      const f = clientFields(input);
      await patchItem(db, item, { ...item.data, ...f }, user);
      await logActivity(db, `Updated client ${f.name}${f.isCompany ? ` (Company · ${f.country})` : ''}`, user);
      return { message: 'Client saved' };
    },
  },
  {
    key: 'cl-delete',
    label: 'Delete client',
    kinds: ['clients'],
    danger: true,
    run: async ({ db, item, user }) => {
      // A client's id as every record names it: the app's own, or "ma-" and our row's id for one added here (shared.js CLIENT_ID).
      const id = text(item.source_id) || `ma-${item.id}`;
      // The app deletes the client's accessory transactions with it (after a confirm that names how many).
      const { rows: txs } = await db.query("SELECT id FROM logistics_items WHERE kind = 'transactions' AND deleted_at IS NULL AND data->>'clientId' = $1", [id]);
      for (const t of txs) await softDelete(db, t.id, user);
      await softDelete(db, item.id, user);
      await logActivity(db, `Deleted client ${text(item.data.name)}`, user);
      return { message: `Client deleted${txs.length ? ` with ${plural(txs.length, 'transaction')}` : ''}`, open: '#/logistics/contacts' };
    },
  },

  /* ── companies ── */
  {
    key: 'co-add',
    label: 'Add company',
    kinds: null,
    page: 'companies',
    form: COMPANY_FORM,
    run: async ({ db, input, user }) => {
      const name = text(input.name, 200);
      if (!name) throw bad('Company name is required');
      const row = await insertItem(db, 'companies', { name, description: String(input.description ?? '').slice(0, 20000), ts: Date.now() }, user);
      await logActivity(db, `🏢 Added company ${name}`, user);
      return { message: `Company saved: ${name}`, created: [row.id] };
    },
  },
  {
    key: 'co-edit',
    label: 'Edit company',
    kinds: ['companies'],
    form: COMPANY_FORM,
    prefill: async (it) => ({ ...it.data }),
    run: async ({ db, item, input, user }) => {
      const name = text(input.name, 200);
      if (!name) throw bad('Company name is required');
      await patchItem(db, item, { ...item.data, name, description: String(input.description ?? '').slice(0, 20000) }, user);
      await logActivity(db, `🏢 Updated company ${name}`, user);
      return { message: 'Company saved' };
    },
  },
  {
    key: 'co-delete',
    label: 'Delete company',
    kinds: ['companies'],
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      await logActivity(db, `🏢 Deleted company ${text(item.data.name)}`, user);
      return { message: 'Company deleted', open: '#/logistics/companies' };
    },
  },

  /* ── shipment documents ── */
  {
    key: 'doc-add',
    label: 'Add document',
    kinds: null,
    page: 'shipmentdocs',
    form: async () => [
      { key: 'companyId', label: 'Company used', type: 'choice', options: await companyChoices(), required: true },
      { key: 'clientId', label: 'Client', type: 'client', required: true },
      { key: 'stockNumber', label: 'Stock number', type: 'stock', required: true, hint: 'our watch, or one on the logistics lists' },
      { key: 'docType', label: 'Document type', type: 'enum', options: DOC_TYPES },
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'notes', label: 'Notes', type: 'longtext', hint: 'the file itself is added right after, on the document (Add the file)' },
    ],
    prefill: async () => ({ docType: 'Invoice', date: localToday() }),
    run: async ({ db, input, user }) => {
      const company = await companyById(db, input.companyId);
      const client = (await clientsById(db)).get(text(input.clientId));
      if (!client) throw bad('Enter the client');
      const stockNumber = text(input.stockNumber, 100);
      if (!stockNumber) throw bad('Enter the stock #');
      if (!(await stockInSystem(db, stockNumber))) throw bad(`Stock #${stockNumber} is not in the system — you can only add a document for a stock number that exists in inventory`);
      const docType = text(input.docType, 60) || 'Invoice';
      const row = await insertItem(
        db,
        'shipmentDocs',
        { companyId: company.id, companyName: company.name, clientId: client.id, clientName: client.name, stockNumber, docType, fileUrl: '', fileName: '', fileType: '', date: dayOf(input.date, 'Date'), notes: text(input.notes, 2000), ts: Date.now() },
        user
      );
      await logActivity(db, `📄 ${docType} added for ${client.name} · stock ${stockNumber} · via ${company.name}`, user);
      const ours = await ourWatchWords(stockNumber);
      return { message: `${docType} saved — now add the file${ours ? ` · ${ours}` : ''}`, created: [row.id], open: '#/logistics/shipmentdocs' };
    },
  },
  {
    key: 'doc-attach',
    label: 'Use the uploaded file',
    kinds: ['shipmentDocs'],
    form: async (it) => [
      { key: 'ref', label: 'File', type: 'choice', options: (Array.isArray(it.data.files) ? it.data.files : []).filter((f) => /^lgfile:\d+$/.test(String(f))).map((f) => ({ value: f, label: f })), required: true, hint: 'a file added with "Add the file"' },
      { key: 'name', label: 'File name', type: 'text' },
      { key: 'type', label: 'File type', type: 'text', hint: 'image/jpeg, application/pdf …' },
    ],
    run: async ({ db, item, input, user }) => {
      const ref = text(input.ref, 40);
      const files = Array.isArray(item.data.files) ? item.data.files.map(String) : [];
      if (!/^lgfile:\d+$/.test(ref) || !files.includes(ref)) throw bad('Add the file to the document first');
      await patchItem(db, item, { ...item.data, fileUrl: ref, fileName: text(input.name, 200), fileType: text(input.type, 100) }, user);
      return { message: 'The document has its file' };
    },
  },
  {
    key: 'doc-delete',
    label: 'Delete document',
    kinds: ['shipmentDocs'],
    danger: true,
    run: async ({ db, item, user }) => {
      await softDelete(db, item.id, user);
      await logActivity(db, `🗑️ ${text(item.data.docType) || 'Document'} deleted · stock ${text(item.data.stockNumber)}`, user);
      return { message: 'Document deleted', open: '#/logistics/shipmentdocs' };
    },
  },

  /* ── other receiving pics ── */
  ...picActions(),

  /* ── watch vault activity ── */
  {
    key: 'va-approve',
    label: 'Approve and apply',
    kinds: ['vaultNotifications'],
    run: async ({ db, item, user }) => {
      const n = item.data;
      if (text(n.status) !== 'pending') throw bad(`This update is already ${text(n.status) || 'handled'}`);
      const r = await vaultRow(db, text(n.loc), n.watchId);
      if (r) {
        const next = { ...r.data };
        if (n.type === 'price') {
          if (n.newB2BPrice !== undefined) {
            next.b2bPrice = n.newB2BPrice;
            next.b2bCurrency = n.newB2BCurrency || 'USD';
          }
          if (n.newB2CPrice !== undefined) {
            next.b2cPrice = n.newB2CPrice;
            next.b2cCurrency = n.newB2CCurrency || 'USD';
          }
        } else {
          next.accessoriesPresent = n.newPresent;
          next.accessoriesMissing = n.newMissing;
        }
        await patchItem(db, r, next, user);
      }
      await patchItem(db, item, { ...n, status: 'approved' }, user);
      const what = n.type === 'price' ? 'price' : 'accessory';
      await logActivity(db, `✏️ WatchVault ${what} update approved — ${text(n.brand)}${n.stockNumber ? ` #${text(n.stockNumber)}` : ''}`, user);
      return { message: `${n.type === 'price' ? 'Price' : 'Accessory'} update applied${r ? '' : ' — the stock row is not here, the notification alone is marked'}` };
    },
  },
  {
    key: 'va-dismiss',
    label: 'Dismiss',
    kinds: ['vaultNotifications'],
    danger: true,
    run: async ({ db, item, user }) => {
      const n = item.data;
      if (text(n.status) !== 'pending') throw bad(`This update is already ${text(n.status) || 'handled'}`);
      await patchItem(db, item, { ...n, status: 'dismissed' }, user);
      await logActivity(db, `🚫 WatchVault accessory update dismissed — ${text(n.brand)}${n.stockNumber ? ` #${text(n.stockNumber)}` : ''}`, user);
      return { message: 'Update dismissed' };
    },
  },
  {
    key: 'va-holder',
    label: 'Set holder',
    kinds: ['vaultTracking'],
    form: [
      { key: 'status', label: 'Where', type: 'enum', options: VAULT_STATUS, required: true },
      { key: 'holder', label: 'With / notes', type: 'text', hint: 'required for Out with Client — any name' },
    ],
    prefill: async (it) => ({ status: text(it.data.status) || 'In Office', holder: text(it.data.holder) }),
    run: async ({ db, item, input, user }) => {
      const status = text(input.status, 40);
      if (!VAULT_STATUS.includes(status)) throw bad(`Where: one of ${VAULT_STATUS.join(', ')}`);
      // "Back" places clear the holder, as the vault's form does.
      const holder = VAULT_BACK.includes(status) ? '' : text(input.holder, 200);
      if (status === 'Out with Client' && !holder) throw bad('Who has the watch? Required for Out with Client');
      const old = item.data || {};
      await patchItem(db, item, { ...old, status, holder, updatedAt: localToday() }, user);
      // The vault logs the move for the app's Watch Vault Activity tab; here it is read on sight, so it needs no approval.
      const r = await vaultRow(db, '', item.source_id, { any: true });
      const rd = r?.data || {};
      const locLabel = holder ? `${status} · ${holder}` : status;
      const prevLabel = old.holder ? `${text(old.status)} · ${text(old.holder)}` : text(old.status) || '—';
      const note = await insertItem(
        db,
        'vaultNotifications',
        { ts: Date.now(), type: 'location', loc: LOC_OF_KIND[r?.kind] || '', watchId: text(item.source_id), stockNumber: text(rd.stockNumber), brand: text(rd.brand), watchRef: text(rd.watchReference), from: prevLabel, to: locLabel, status: 'approved' },
        user
      );
      await logActivity(db, `🔐 Vault: ${rd.stockNumber ? `Stock #${text(rd.stockNumber)}` : 'a watch'} ${prevLabel} → ${locLabel}`, user);
      return { message: `Now ${locLabel}`, created: [note.id] };
    },
  },
];

function picActions() {
  const FORM = [
    { key: 'clientId', label: 'Client', type: 'client', hint: 'one of the logistics clients' },
    { key: 'clientNameOther', label: 'Or a name not in the list', type: 'text' },
    { key: 'stockNumber', label: 'Stock number', type: 'stock', hint: 'optional — our watch' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
  ];
  const values = async (db, input) => {
    const c = text(input.clientId) ? (await clientsById(db)).get(text(input.clientId)) : null;
    if (text(input.clientId) && !c) throw bad('That client is not in the logistics clients');
    const clientName = c ? c.name : text(input.clientNameOther, 200);
    if (!clientName) throw bad('Client name is required');
    return { clientName, clientId: c ? c.id : '', stockNumber: text(input.stockNumber, 100), notes: text(input.notes, 2000) };
  };
  return [
    {
      key: 'pic-add',
      label: 'Add entry',
      kinds: null,
      page: 'otherreceiving',
      form: FORM,
      run: async ({ db, input, user }) => {
        const v = await values(db, input);
        const row = await insertItem(db, 'otherReceivingPics', { ...v, photos: [] }, user);
        await logActivity(db, `📷 Receiving pictures entry added for ${v.clientName}${v.stockNumber ? ` · stock ${v.stockNumber}` : ''}`, user);
        const ours = await ourWatchWords(v.stockNumber);
        return { message: `Entry saved for ${v.clientName} — now add the pictures${ours ? ` · ${ours}` : ''}`, created: [row.id], open: '#/logistics/otherreceiving' };
      },
    },
    {
      key: 'pic-edit',
      label: 'Edit entry',
      kinds: ['otherReceivingPics'],
      form: FORM,
      prefill: async (it) => ({ ...it.data, clientNameOther: text(it.data.clientId) ? '' : text(it.data.clientName) }),
      run: async ({ db, item, input, user }) => {
        const v = await values(db, input);
        await patchItem(db, item, { ...item.data, ...v }, user);
        return { message: 'Entry saved' };
      },
    },
    {
      key: 'pic-delete',
      label: 'Delete entry',
      kinds: ['otherReceivingPics'],
      danger: true,
      run: async ({ db, item, user }) => {
        await softDelete(db, item.id, user);
        await logActivity(db, `🗑️ Receiving pictures entry deleted for ${text(item.data.clientName)}`, user);
        return { message: 'Entry deleted', open: '#/logistics/otherreceiving' };
      },
    },
  ];
}

/* Extra typed fields for the record pages' Add / Edit forms of kinds the catalog types thinly. */
export const FIELDS = {
  clients: [{ key: 'phone', label: 'Phone', type: 'text' }],
  companies: [
    { key: 'name', label: 'Company name', type: 'text' },
    { key: 'description', label: 'Details', type: 'longtext' },
  ],
  shipmentDocs: [
    { key: 'docType', label: 'Document type', type: 'enum', options: DOC_TYPES },
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'clientName', label: 'Client (as written)', type: 'text' },
    { key: 'clientId', label: 'Client', type: 'client' },
    { key: 'companyName', label: 'Company', type: 'text' },
    { key: 'stockNumber', label: 'Stock number', type: 'stock' },
    { key: 'fileName', label: 'File name', type: 'text' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
  ],
  otherReceivingPics: [
    { key: 'clientName', label: 'Client', type: 'text' },
    { key: 'stockNumber', label: 'Stock number', type: 'stock' },
    { key: 'notes', label: 'Notes', type: 'longtext' },
  ],
  vaultNotifications: [{ key: 'status', label: 'Status', type: 'enum', options: ['pending', 'approved', 'dismissed'] }],
};
