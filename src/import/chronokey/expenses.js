import * as cheerio from 'cheerio';
import { pool, query } from '../../db/index.js';
import { config } from '../../config.js';
import { chronokey } from './client.js';
import { parseMoney } from '../../watches/fields.js';
import { startRun, finishRun, progressRun } from '../listimport.js';
import { fromChronoKey, applyExpense } from '../../expenses/index.js';
import { markGone, settleExpenses } from '../gone.js';

/*
 * Chrono Key's expenses → ours.
 *
 * First read 23 Oct 2026:
 *   - /Stock/ExpenseList is NOT a data grid: the page itself holds every
 *     expense (915 rows, 3.6 MB) — Title, Type, Description, Cost (£),
 *     Created Date (`data-sort` ISO) and an edit link /Stock/AddEditExpense/{id}.
 *   - The list's Cost is Chrono Key's BOOKED figure: the expense's cost times
 *     the rate typed with it (AED 4,300 × 0.24 = "£1,032.00"). Labelled £, it is
 *     euros in practice — the rates typed are to euros (AED 0.24, USD 0.89) —
 *     as on the watch pages. Its form treats GBP as the base (rate fixed at 1).
 *   - Each expense's own page (/Stock/AddEditExpense/{id}, the edit form, a
 *     GET) holds the rest: CurrencyID (GBP, EUR, CHF, HKD, USD, AED — the
 *     `selected` option), ExchangeRate, Cost in that currency, typeId,
 *     PaymentType (0 Cash · 1 Card · 2 Wire · 3 Crypto · 4 PayPal / Chrono24),
 *     ExcludeFromProfit ("Loan Book"), Description.
 *
 * So: the list every pass (one request), and an expense's own page only when
 * it is new or its line on the list has changed — two at a time, with a
 * pause, like the watch pages. Read-only: the form is only ever fetched.
 */

const LIST = '/Stock/ExpenseList';
const PAGE = (id) => `/Stock/AddEditExpense/${Number(id)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The same list row whatever order its keys come back in — Postgres's jsonb reorders them.
const sig = (row) => JSON.stringify(Object.keys(row || {}).sort().map((k) => [k, row[k] ?? null]));
const t = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
// The description keeps its lines: the trips are itemised one per line.
const lines = (v) =>
  String(v ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');

/** The list page → one row per expense, or an error if it does not look like the list. */
export function parseExpenseList(html) {
  const $ = cheerio.load(html);
  const heads = $('thead th')
    .map((_, th) => t($(th).text()).toLowerCase())
    .get();
  const at = (name) => heads.findIndex((h) => h === name || h.startsWith(name));
  const col = { title: at('title'), type: at('type'), description: at('description'), cost: at('cost'), date: at('created') };
  if (Object.values(col).some((i) => i === -1)) {
    throw new Error(`${LIST} has no Title / Type / Description / Cost / Created Date headings — signed out, or redesigned`);
  }
  const rows = [];
  $('tbody tr').each((_, tr) => {
    const td = $(tr).children('td');
    const id = Number($(tr).find('a[href*="/Stock/AddEditExpense/"]').attr('href')?.match(/AddEditExpense\/(\d+)/)?.[1]);
    if (!id) return;
    const cell = (i) => td.eq(i);
    const iso = cell(col.date).attr('data-sort') || '';
    rows.push({
      ckId: id,
      title: t(cell(col.title).text()),
      type: t(cell(col.type).text()),
      description: lines(cell(col.description).text()),
      cost: parseMoney(cell(col.cost).text()),
      date: /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : null,
    });
  });
  return rows;
}

/** An expense's own page (its edit form) → what it holds. */
export function parseExpensePage(html) {
  const $ = cheerio.load(html);
  if (!$('input[name="Title"]').length || !$('select[name="CurrencyID"]').length) {
    throw new Error('the expense page has no form — signed out, or redesigned');
  }
  const picked = (name) => $(`select[name="${name}"] option[selected]`).first();
  const currency = t(picked('CurrencyID').text()).split(' ')[0].toUpperCase();
  const pay = picked('PaymentType').attr('value');
  const num = (v) => {
    const n = Number(String(v ?? '').replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  return {
    title: t($('input[name="Title"]').attr('value')),
    date: /^\d{4}-\d{2}-\d{2}$/.test($('input[name="InsertedDT"]').attr('value') || '') ? $('input[name="InsertedDT"]').attr('value') : null,
    cost: num($('input[name="Cost"]').attr('value')),
    rate: num($('input[name="ExchangeRate"]').attr('value')),
    currency: /^[A-Z]{3,4}$/.test(currency) ? currency : '',
    type: picked('typeId').attr('value') ? t(picked('typeId').text()) : '',
    paymentType: pay === undefined || pay === '' ? null : Number(pay),
    excludeFromProfit: $('input[type="checkbox"][name="ExcludeFromProfit"]').is('[checked]'),
    description: lines($('textarea[name="Description"]').text()),
  };
}

/**
 * @param limit    at most this many new or changed expense pages this run (the first full read is ~915)
 * @param rolling  and this many more of the pages read longest ago
 */
export async function syncExpenses({ user, limit = Infinity, rolling = 0 } = {}) {
  const run = await startRun('chronokey', 'expenses', user);
  const stats = { listed: 0, created: 0, updated: 0, pages: 0, failed: 0, errors: [] };
  try {
    const html = await chronokey().getListHtml(LIST);
    const list = parseExpenseList(html);
    // An empty list is never "no expenses": a lapsed session answers like that.
    if (!list.length) throw new Error(`${LIST} listed no expenses`);
    stats.listed = list.length;

    // Store the list; queue a page read for what is new, changed, or failed over a day ago.
    const { rows: held } = await query('SELECT ck_id, list_row, detail, detail_at, error FROM ck_expenses');
    const before = new Map(held.map((r) => [r.ck_id, r]));
    const todo = [];
    for (const row of list) {
      const old = before.get(row.ckId);
      const changed = !old || sig(old.list_row) !== sig(row);
      const retry = old && !old.detail && (!old.detail_at || Date.now() - new Date(old.detail_at).getTime() > 86400_000);
      await query(
        `INSERT INTO ck_expenses(ck_id, list_row, list_at) VALUES ($1, $2, now())
         ON CONFLICT (ck_id) DO UPDATE SET list_row = EXCLUDED.list_row, list_at = now()`,
        [row.ckId, row]
      );
      if (changed || retry) todo.push(row.ckId);
    }

    // The list alone already makes every expense; its page adds the currency and the rest.
    for (const row of list) {
      const old = before.get(row.ckId);
      await write(row, old?.detail && sig(old.list_row) === sig(row) ? old.detail : null, stats);
    }

    // What the list no longer holds: deleted on Chrono Key.
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      stats.goneFromList = await markGone(db, 'ck_expenses', 'ck_id', list.map((r) => r.ckId));
      stats.expensesGone = await settleExpenses(db);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      db.release();
    }

    // Then, beside the new and the changed, the pages read longest ago — a
    // payment type or a currency changed on Chrono Key without touching its
    // line on the list still comes across, within hours.
    const queue = todo.slice(0, Number.isFinite(limit) ? limit : undefined);
    if (rolling > 0) {
      const { rows: oldest } = await query(
        `SELECT ck_id FROM ck_expenses WHERE gone_at IS NULL AND detail IS NOT NULL AND NOT (ck_id = ANY($1))
          ORDER BY detail_at NULLS FIRST, ck_id DESC LIMIT $2`,
        [queue, rolling]
      );
      const listed = new Set(list.map((r) => r.ckId));
      queue.push(...oldest.map((r) => r.ck_id).filter((id) => listed.has(id)));
    }
    stats.todo = queue.length;
    const byId = new Map(list.map((r) => [r.ckId, r]));
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const id = queue[next];
        next += 1;
        try {
          const detail = parseExpensePage(await chronokey().getListHtml(PAGE(id)));
          await query('UPDATE ck_expenses SET detail = $2, detail_at = now(), error = NULL WHERE ck_id = $1', [id, detail]);
          await write(byId.get(id), detail, stats);
          stats.pages += 1;
        } catch (err) {
          stats.failed += 1;
          if (stats.errors.length < 20) stats.errors.push(`${id}: ${err.message}`);
          await query('UPDATE ck_expenses SET error = $2, detail_at = now() WHERE ck_id = $1', [id, err.message]);
          if (err.status === 401) throw err;
        }
        if ((stats.pages + stats.failed) % 20 === 0) await progressRun(run, stats);
        await sleep(config.sync.pauseMs);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, config.sync.concurrency) }, worker));
    await finishRun(run, { ok: stats.failed === 0, stats });
    return stats;
  } catch (err) {
    await finishRun(run, { ok: false, stats, error: err.message });
    throw err;
  }
}

async function write(row, detail, stats) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const r = await applyExpense(db, row.ckId, fromChronoKey(row, detail));
    await db.query('UPDATE ck_expenses SET expense_id = $2 WHERE ck_id = $1', [row.ckId, r.id]);
    await db.query('COMMIT');
    if (r.created) stats.created += 1;
    else if (r.changed.length) stats.updated += 1;
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}
