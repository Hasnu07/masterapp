import { tx } from '../../db/index.js';
import { chronokey } from './client.js';
import { dataTableForm } from './parse.js';
import { startRun, finishRun } from '../listimport.js';
import { applyClientList } from '../../clients/index.js';

/*
 * Chrono Key's client list → our clients, and every watch's two client links.
 *
 * The list page (/User/ClientList) is a server-side DataTable: its rows come
 * from POST /User/ClientListDatatable, which takes the grid's own paging
 * fields (PageSize, PageNumber, SearchBy, roleType=Client). First read 23 Oct
 * 2026: 646 clients, every one in a single answer of PageSize 1000, an object
 * per row (id a GUID, firstName, lastName, nickName, email, phoneNumber,
 * clientType D / I, companyName, bill… and ship… address, isActive …). Every
 * clientId and soldToId on the 1,665 product-grid rows was one of them.
 *
 * Read-only, one request. The path is fixed here, never read out of the page:
 * the same page's script names /User/Delete and /User/Merge.
 */

const DATA = '/User/ClientListDatatable';
const PAGE = 1000;

export async function syncClients({ user } = {}) {
  const run = await startRun('chronokey', 'clients', user);
  try {
    const rows = [];
    let total = null;
    for (let page = 1; page <= 5; page += 1) {
      const res = await chronokey().postForm(DATA, {
        ...dataTableForm({ start: rows.length, length: PAGE, columns: 13 }),
        PageSize: PAGE,
        PageNumber: page,
        SearchBy: '',
        orderByColumn: 0,
        orderDir: 'asc',
        roleType: 'Client',
      });
      let json;
      try {
        json = JSON.parse(res.body);
      } catch {
        throw new Error(`${DATA} answered ${res.status} ${res.type || ''}, not JSON: ${String(res.body || '').replace(/\s+/g, ' ').slice(0, 160)}`);
      }
      total ??= Number(json.recordsTotal ?? json.recordsFiltered) || null;
      const got = Array.isArray(json.data) ? json.data.filter((r) => r && typeof r === 'object' && r.id) : [];
      if (!got.length) break;
      rows.push(...got);
      if ((total && rows.length >= total) || got.length < PAGE) break;
    }
    // An empty list is never taken as "no clients": it is how a lapsed
    // session or a redesigned page answers.
    if (!rows.length) throw new Error(`${DATA} answered with no clients${total ? ` (it says ${total})` : ''}`);

    const stats = await tx((db) => applyClientList(db, rows));
    await finishRun(run, { ok: true, stats: { ...stats, total } });
    return stats;
  } catch (err) {
    await finishRun(run, { ok: false, error: err.message });
    throw err;
  }
}
