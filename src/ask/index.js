/*
 * Ask — the assistant over the whole system (asked 7 Nov 2026: "the api
 * should work all system around … has access of the whole system I can ask
 * it for any pdf I want any csv any info it tells us").
 *
 * Claude (the Anthropic API, `@anthropic-ai/sdk`, the key and model of
 * `config.ai` — the same as the watch's brief and the Ask button) with tools of ours:
 *   schema        every table and column it may read, with what each holds
 *   sql           ONE read-only SELECT, in a READ ONLY transaction with a
 *                 15-second limit, through the extended protocol (so a second
 *                 statement is refused by Postgres itself); users, sessions and
 *                 the other people's conversations are off limits by name — the
 *                 `people` view stands for users
 *   watch         a watch whole: fields, clients, photos' ids, history, its
 *                 logistics from our copy (what the watch page shows)
 *   build_sheet   a sheet of a kind (logistics / accounting / client / stock),
 *                 kept, so the answer can open it
 *   make_csv      a CSV from rows → a file to download
 *   make_pdf      a PDF: title, text, tables → a file to download
 * It never writes to the system: a change is somebody's decision, made on the
 * pages or from a sheet. Every step is kept on the thread (what SQL it ran),
 * so an answer can be checked.
 */
import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { pool, query } from '../db/index.js';
import * as watches from '../watches/index.js';
import * as clients from '../clients/index.js';
import { passport } from '../logistics/passport.js';
import { costs as lgCosts } from '../logistics/situation.js';
import { createSheet, getSheet, toCsv } from '../sheets/index.js';
import { renderPdf, tableBlock } from '../pdf/index.js';

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

export const enabled = () => Boolean(config.ai.enabled);
const SQL_TIMEOUT_MS = Number(process.env.ASK_SQL_TIMEOUT_MS || 15_000);

/* ── what it may read ─────────────────────────────────────────────── */

/* Named, never guessed: a table not here is not read, whatever information_schema says. */
const TABLES = {
  watches: 'OUR record of every watch (one row = one STOCK NUMBER = one purchase). status: incoming|in_stock|reserved|sold|returned|other. Prices in the deal’s own currency (purchase_price + purchase_currency; sale_price + sale_currency; "" = currency not stated — never assume). purchase_price_eur / sale_price_eur are Chrono Key’s own euro figures. purchased_from_client_id / sold_to_client_id → clients.id (the real link; purchased_from / sold_to are typed names). deleted_at IS NULL for live rows. ck_product_id links the same physical watch bought back again.',
  watch_photos: 'Photos of a watch (watch_id). deleted_at IS NULL and duplicate_of IS NULL for the ones shown. Served at /api/photos/:id.',
  watch_events: 'Every change to a watch: at, user_id (→ people.id), source (user|chronokey|vault), action, changes jsonb {field: [old, new]}.',
  clients: 'People and dealers we buy from and sell to. Name = forename + surname, else nickname, else company. type: dealer|retail|retail_company. deleted_at IS NULL.',
  client_events: 'Changes to a client.',
  expenses: 'Business expenses: expense_date, title, type (e.g. SALARY, Logistics Expense), amount + currency (own currency), cost_eur (Chrono Key’s euro figure), payment_method, description, exclude_from_profit. deleted_at IS NULL.',
  expense_events: 'Changes to an expense.',
  expense_files: 'Payment copies of an expense (name, content_type) — the files themselves are in storage.',
  logistics_items: 'Our copy of the logistics app’s records: kind = its list (shipments, incomings, londonStock, dubaiStock, hkStock, hkSituation, safeStock, checkoutStock, soldStocks, readyForDelivery, logisticCosts, personTrips, transactions, thirdPartyShipments, thirdPartyMovers, externalPolish, accCollect, accGive, clients, activity …); data jsonb as the app keeps it; stock_nos text[] = every stock number it names (use stock_nos @> ARRAY[\'1617\']); happened_at; deleted_at IS NULL. Costs: logisticCosts.data {title, amount, currency, stockNumber, fromName, toName, date, tripId, shipmentId}; shipments.data {costAmount, costCurrency, stockNumber, tracking, status, items}; personTrips.data {personName, costs: [{category, label, amount, currency}], stockIds}.',
  logistics_events: 'Changes to logistics items.',
  logistics_client_links: 'Which of OUR clients a logistics client is (a person’s choice).',
  ck_records: 'Chrono Key’s own record as last read (stock_no, list_row jsonb = the grid row, detail jsonb = the watch page, ck_lists jsonb = which of its lists hold it, lists_at). Raw; never edited here. Do not select html (gzipped bytes).',
  ck_clients: 'Chrono Key’s client list as read (data jsonb).',
  ck_expenses: 'Chrono Key’s expense list and pages as read.',
  vault_records: 'The Watch vault’s records as read (vault_id, list, stock_no, data jsonb).',
  import_runs: 'Every sync pass: source, mode, started_at, finished_at, ok, stats, error.',
  sheets: 'Sheets built here: kind, title, subject, doc jsonb {columns, rows}, built_at, updated_at.',
  people: 'Users without passwords: id, name, email, role.',
};
const FORBIDDEN = /\b(users|sessions|ask_files|ask_threads|schema_migrations|pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink|copy)\b/i;

async function schemaText() {
  const { rows } = await query(
    `SELECT table_name, column_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name, ordinal_position`,
    [Object.keys(TABLES)]
  );
  const by = new Map();
  for (const r of rows) {
    if (r.table_name === 'ck_records' && r.column_name === 'html') continue;
    if (!by.has(r.table_name)) by.set(r.table_name, []);
    by.get(r.table_name).push(`${r.column_name} ${r.data_type.replace('timestamp with time zone', 'timestamptz').replace('character varying', 'text')}`);
  }
  return [...by].map(([t, cols]) => `## ${t}\n${TABLES[t]}\nColumns: ${cols.join(', ')}`).join('\n\n');
}

/** One read-only statement, bounded; rows as objects, at most `limit`. */
export async function readOnlySql(sql, { limit = 500 } = {}) {
  const text = String(sql || '').trim().replace(/;\s*$/, '');
  if (!text) throw bad('Empty SQL');
  if (!/^\s*(select|with|explain)\b/i.test(text)) throw bad('Only a SELECT (or WITH … SELECT) is run here');
  if (FORBIDDEN.test(text)) throw bad('That table or function is not readable from here (users, sessions and other people’s conversations are off limits; `people` stands for users)');
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${Math.max(1000, Math.min(SQL_TIMEOUT_MS || 15000, 60000))}`);
    // The extended protocol takes exactly one statement: a second one after a semicolon is a syntax error from Postgres.
    const r = await client.query({ text, values: [], queryMode: 'extended', rowMode: 'array' });
    await client.query('COMMIT');
    const fields = (r.fields || []).map((f) => f.name);
    const rows = (r.rows || []).slice(0, limit).map((a) => Object.fromEntries(fields.map((f, i) => [f, trim(a[i])])));
    return { fields, rows, total: r.rowCount ?? rows.length, truncated: (r.rows || []).length > limit };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.status) throw err;
    throw bad(`Postgres: ${err.message}`);
  } finally {
    client.release();
  }
}
/* A value as the model should see it: bytes never, long text cut, dates as days. */
function trim(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return `<${v.length} bytes>`;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
  if (typeof v === 'object') {
    const s = JSON.stringify(v);
    return s.length > 4000 ? JSON.parse(JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 300 ? `${x.slice(0, 300)}…` : x))) : v;
  }
  return v;
}

/* ── the tools ────────────────────────────────────────────────────── */

const TOOLS = [
  {
    name: 'schema',
    description: 'The tables and columns you may read, with what each holds. Call this first in a conversation before writing SQL.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: 'sql',
    description:
      'Runs ONE read-only SELECT on the ERP’s Postgres and returns rows (at most `limit`, default 200). Use ILIKE for names, stock_nos @> ARRAY[\'1617\'] for logistics. Money is in each deal’s own currency: never add amounts across currencies — group by currency, or use the *_eur columns and say so.',
    input_schema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'One SELECT or WITH … SELECT statement' }, limit: { type: 'integer', minimum: 1, maximum: 2000 } },
      required: ['sql', 'limit'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'watch',
    description: 'One watch, whole, by stock number: its fields, its clients, its photos’ ids, its history of changes, and its logistics (where it is, what moving it cost, its shipments) from our copy of the logistics app.',
    input_schema: { type: 'object', properties: { stock_no: { type: 'string' } }, required: ['stock_no'], additionalProperties: false },
    strict: true,
  },
  {
    name: 'build_sheet',
    description:
      'Builds and keeps a sheet (an editable spreadsheet page in the ERP) of a kind: logistics (costs by area, for stock numbers or every stock), accounting (money in and out for stock numbers, or for a client), client (a client’s whole situation), stock (the situation of stock numbers, or of a status: in_stock, incoming, sold, reserved, returned, other, all). Returns its id and link (#/sheet/<id>) and its rows, so you can also answer from it.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['logistics', 'accounting', 'client', 'stock'] },
        stock: { type: 'array', items: { type: 'string' }, description: 'Stock numbers, when the sheet is about particular watches' },
        client: { type: ['integer', 'null'], description: 'clients.id, for a client’s accounting or situation' },
        status: { type: ['string', 'null'], description: 'For a stock sheet with no stock numbers: in_stock (default), incoming, sold, reserved, returned, other, all' },
      },
      required: ['kind', 'stock', 'client', 'status'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'make_csv',
    description: 'Makes a CSV file the person can download, from the rows of a query you ran (give the SQL again; it is re-run, so the file holds every row, not just the ones you saw). Returns the file’s link.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'File name without extension' }, sql: { type: 'string' } },
      required: ['name', 'sql'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'make_pdf',
    description:
      'Makes a PDF the person can download: a title, then blocks in order — headings, paragraphs, and tables. A table is either rows you write out, or `sql` to run (every row goes in). Returns the file’s link. Keep tables to the columns that matter; name currencies.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'File name without extension' },
        title: { type: 'string' },
        subtitle: { type: ['string', 'null'] },
        blocks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['heading', 'text', 'table'] },
              text: { type: ['string', 'null'], description: 'For heading and text' },
              title: { type: ['string', 'null'], description: 'For a table: a caption' },
              columns: { type: ['array', 'null'], items: { type: 'string' }, description: 'For a table of written rows: the headings' },
              rows: { type: ['array', 'null'], items: { type: 'array', items: { type: ['string', 'number', 'null'] } }, description: 'For a table: the cells, row by row' },
              sql: { type: ['string', 'null'], description: 'For a table: a SELECT to fill it instead' },
            },
            required: ['type', 'text', 'title', 'columns', 'rows', 'sql'],
            additionalProperties: false,
          },
        },
      },
      required: ['name', 'title', 'subtitle', 'blocks'],
      additionalProperties: false,
    },
    strict: true,
  },
];

const SYSTEM = `You are the assistant inside Purosangue ERP (masterapp), the watch business of Jhonny: Purosangue and Kashi — Dubai, UK, Europe and Hong Kong. The person asking is a signed-in member of the business. You have read access to the whole system through the tools: watches (one record per stock number), clients, expenses, our copy of the logistics app, Chrono Key's and the vault's raw records, and the change history. You can build sheets, CSVs and PDFs for them. You cannot change anything: say so if asked, and point them to the page or a sheet.

How to work:
- Call \`schema\` once before your first SQL in a conversation. Prefer SQL for figures and lists; \`watch\` for one watch's whole story.
- Money stays in its own currency. Never add amounts across currencies; group by currency, or use the euro figures (*_eur, Chrono Key's own) and say they are Chrono Key's euro figures. A blank currency means "not stated" — say so, never assume.
- A watch's status is where Chrono Key's own lists put it; "returned" means returned to its client.
- Stock numbers are text. Live records have deleted_at IS NULL. Names: use ILIKE.
- Answer in plain English, briefly, with the figures; use a markdown table when a list helps (at most ~30 rows in the answer — for more, make a CSV or PDF). When you made a file or a sheet, give its link in markdown exactly as the tool returned it.
- When the question is ambiguous (which client? which period?), make the most useful reading and say what you took it as; ask only when you truly cannot proceed.
- Dates: today is {today}. Say when a figure is from our copy (the logistics app's, Chrono Key's) and how old the copy is if it matters.`;

async function runTool(name, input, ctx) {
  switch (name) {
    case 'schema':
      return { text: await schemaText(), summary: 'Read the schema' };
    case 'sql': {
      const r = await readOnlySql(input.sql, { limit: input.limit || 200 });
      return { json: r, summary: `SQL: ${oneLine(input.sql)} → ${r.total} row${r.total === 1 ? '' : 's'}` };
    }
    case 'watch': {
      const no = String(input.stock_no || '').trim();
      const { rows } = await query('SELECT id FROM watches WHERE deleted_at IS NULL AND stock_no = $1', [no]);
      if (!rows[0]) return { json: { error: `No watch of ours has stock number ${no}` }, summary: `Watch ${no}: none` };
      const w = await watches.getWatch(rows[0].id);
      const [links, events, lg, sold] = await Promise.all([clients.linksOf(w), watches.watchEvents(w.id, 60), passport(no), watches.soldFor(w.id, 5)]);
      const { rows: items } = await query(`SELECT id, kind, data, stock_nos, deleted_at FROM logistics_items WHERE deleted_at IS NULL AND stock_nos @> ARRAY[$1]::text[]`, [no]);
      const costs = lgCosts(no, items);
      w.photos = (w.photos || []).map((p) => ({ id: p.id, link: `/api/photos/${p.id}`, caption: p.caption, source: p.source }));
      return {
        json: { watch: w, clients: links, history: events, logistics: { ...lg, meta: undefined }, logisticsCosts: costs, soldFor: sold, link: `#/watch/${w.id}` },
        summary: `Read watch ${no}`,
      };
    }
    case 'build_sheet': {
      const subject = {};
      if (input.stock?.length) subject.stock = input.stock;
      if (input.client) subject.client = input.client;
      if (input.status) subject.status = input.status;
      const id = await createSheet(input.kind, subject, ctx.user);
      const s = await getSheet(id);
      const rows = s.doc.rows.slice(0, 200).map((r) => r.cells);
      return { json: { id, title: s.title, link: `#/sheet/${id}`, columns: s.doc.columns.map((c) => c.label), rows, row_count: s.doc.rows.length, note: s.doc.note }, summary: `Built the sheet “${s.title}”`, sheet: { id, title: s.title } };
    }
    case 'make_csv': {
      const r = await readOnlySql(input.sql, { limit: 50000 });
      const doc = { columns: r.fields.map((f) => ({ key: f, label: f })), rows: r.rows.map((row, i) => ({ key: String(i), cells: row })) };
      const f = await keepFile(ctx, `${safeName(input.name)}.csv`, 'text/csv; charset=utf-8', Buffer.from(toCsv(doc), 'utf8'));
      return { json: { link: f.link, name: f.name, rows: r.total }, summary: `Made ${f.name} (${r.total} rows)`, file: f };
    }
    case 'make_pdf': {
      const blocks = [];
      for (const b of input.blocks || []) {
        if (b.type === 'table') {
          if (b.sql) {
            const r = await readOnlySql(b.sql, { limit: 5000 });
            blocks.push(tableBlock(r.rows, { title: b.title || undefined, columns: r.fields }));
          } else blocks.push({ type: 'table', title: b.title || undefined, columns: b.columns || [], rows: (b.rows || []).map((row) => row.map((v) => (v === null ? '' : typeof v === 'number' ? v.toLocaleString('en-GB', { maximumFractionDigits: 2 }) : String(v)))) });
        } else blocks.push({ type: b.type, text: b.text || '' });
      }
      const buf = renderPdf({ title: input.title, subtitle: input.subtitle || '', blocks });
      const f = await keepFile(ctx, `${safeName(input.name)}.pdf`, 'application/pdf', buf);
      return { json: { link: f.link, name: f.name, pages: (buf.toString('latin1').match(/\/Type \/Page\b/g) || []).length }, summary: `Made ${f.name}`, file: f };
    }
    default:
      throw bad(`No such tool: ${name}`);
  }
}
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);
const safeName = (s) => (String(s || 'file').replace(/[^\w.\- ]+/g, '_').replace(/\.(csv|pdf)$/i, '').trim().slice(0, 80) || 'file');

async function keepFile(ctx, name, type, bytes) {
  if (bytes.length > 40 * 1024 * 1024) throw bad('That file would be over 40 MB — narrow it down');
  const id = crypto.randomBytes(18).toString('base64url');
  await query('INSERT INTO ask_files(id, thread_id, user_id, name, type, bytes) VALUES ($1, $2, $3, $4, $5, $6)', [id, ctx.threadId, ctx.user?.id ?? null, name, type, bytes]);
  return { id, name, type, bytes: bytes.length, link: `/api/ask/files/${id}` };
}

export async function askFile(id, user) {
  const { rows } = await query('SELECT * FROM ask_files WHERE id = $1', [String(id || '')]);
  const f = rows[0];
  if (!f) return null;
  // A file is the asker's; an admin may open any.
  if (f.user_id !== user?.id && user?.role !== 'admin') return null;
  return f;
}

/* ── threads ──────────────────────────────────────────────────────── */

export async function listThreads(user) {
  const { rows } = await query('SELECT id, title, status, created_at, updated_at FROM ask_threads WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100', [user.id]);
  return { threads: rows };
}

export async function getThread(id, user) {
  const { rows } = await query('SELECT * FROM ask_threads WHERE id = $1 AND user_id = $2', [Number(id) || 0, user.id]);
  if (!rows[0]) throw Object.assign(new Error('No such conversation'), { status: 404 });
  const t = rows[0];
  const { rows: files } = await query('SELECT id, name, type, octet_length(bytes) AS bytes, created_at FROM ask_files WHERE thread_id = $1 ORDER BY created_at', [t.id]);
  return { ...t, messages: undefined, turns: turnsOf(t.messages), files };
}

/* The conversation for the page: the person's questions and the assistant's answers, the tool traffic left out. */
function turnsOf(messages) {
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'user' && typeof m.content === 'string') out.push({ role: 'user', text: m.content });
    else if (m.role === 'assistant' && Array.isArray(m.content)) {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (text) out.push({ role: 'assistant', text });
    }
  }
  return out;
}

export async function deleteThread(id, user) {
  await query('DELETE FROM ask_threads WHERE id = $1 AND user_id = $2', [Number(id) || 0, user.id]);
}

/**
 * Asks: one question on a thread (a new one when `threadId` is null). Runs
 * the tool loop to the end and keeps every step; returns the thread as the
 * page shows it. `onStep` is told of each step as it happens (for the page's
 * live "working…" line).
 */
export async function ask({ threadId = null, question, user, onStep = () => {} }) {
  if (!enabled()) throw Object.assign(new Error('Ask is not set up: set ANTHROPIC_API_KEY'), { status: 503 });
  const q = String(question || '').trim();
  if (!q) throw bad('Ask something');
  if (q.length > 20000) throw bad('That is too long to ask in one go');

  let t;
  if (threadId) {
    const { rows } = await query('SELECT * FROM ask_threads WHERE id = $1 AND user_id = $2', [Number(threadId) || 0, user.id]);
    t = rows[0];
    if (!t) throw Object.assign(new Error('No such conversation'), { status: 404 });
    if (t.status === 'running') throw Object.assign(new Error('Still working on the last question — a moment'), { status: 409 });
  } else {
    const { rows } = await query('INSERT INTO ask_threads(user_id, title, messages) VALUES ($1, $2, $3) RETURNING *', [user.id, q.slice(0, 80), '[]']);
    t = rows[0];
  }
  const messages = Array.isArray(t.messages) ? t.messages : [];
  const steps = Array.isArray(t.steps) ? t.steps : [];
  messages.push({ role: 'user', content: q });
  await query('UPDATE ask_threads SET messages = $1, status = $2, error = NULL, updated_at = now() WHERE id = $3', [JSON.stringify(messages), 'running', t.id]);

  const client = new Anthropic({ apiKey: config.ai.apiKey });
  const ctx = { user, threadId: t.id };
  const usage = { input_tokens: 0, output_tokens: 0, ...(t.usage || {}) };
  const step = async (s) => {
    const entry = { at: new Date().toISOString(), ...s };
    steps.push(entry);
    onStep(entry);
    await query('UPDATE ask_threads SET steps = $1, updated_at = now() WHERE id = $2', [JSON.stringify(steps.slice(-400)), t.id]).catch(() => {});
  };

  try {
    for (let turn = 0; turn < 25; turn++) {
      const response = await client.beta.messages.create({
        model: config.ai.model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: SYSTEM.replace('{today}', new Date().toISOString().slice(0, 10)), cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
      });
      usage.input_tokens += response.usage?.input_tokens || 0;
      usage.output_tokens += response.usage?.output_tokens || 0;
      messages.push({ role: 'assistant', content: response.content });
      if (response.stop_reason === 'refusal') {
        await step({ tool: 'answer', summary: 'The assistant declined to answer that', error: response.stop_details?.explanation || null });
        break;
      }
      if (response.stop_reason === 'pause_turn') continue;
      const calls = response.content.filter((b) => b.type === 'tool_use');
      if (!calls.length) break;
      const results = [];
      for (const c of calls) {
        let out;
        try {
          const r = await runTool(c.name, c.input, ctx);
          await step({ tool: c.name, summary: r.summary, sheet: r.sheet, file: r.file && { id: r.file.id, name: r.file.name, link: r.file.link } });
          out = { type: 'tool_result', tool_use_id: c.id, content: r.text ?? JSON.stringify(r.json) };
        } catch (err) {
          await step({ tool: c.name, summary: `${c.name} failed`, error: err.message });
          out = { type: 'tool_result', tool_use_id: c.id, content: `Error: ${err.message}`, is_error: true };
        }
        results.push(out);
      }
      messages.push({ role: 'user', content: results });
      if (response.stop_reason === 'max_tokens') break;
    }
    await query('UPDATE ask_threads SET messages = $1, steps = $2, status = $3, usage = $4, updated_at = now() WHERE id = $5', [
      JSON.stringify(messages),
      JSON.stringify(steps.slice(-400)),
      'idle',
      JSON.stringify(usage),
      t.id,
    ]);
  } catch (err) {
    const msg = err instanceof Anthropic.AuthenticationError ? 'The Anthropic API key is not accepted' : err instanceof Anthropic.RateLimitError ? 'The Anthropic API is rate-limiting us — try again in a minute' : err.message;
    // The question stays on the thread; the assistant's half-turn (a tool call never answered) is dropped so the next question can be sent.
    while (messages.length && messages[messages.length - 1].role !== 'user') messages.pop();
    if (messages.length && Array.isArray(messages[messages.length - 1].content)) messages.pop(), messages.pop();
    await query('UPDATE ask_threads SET messages = $1, steps = $2, status = $3, error = $4, updated_at = now() WHERE id = $5', [JSON.stringify(messages), JSON.stringify(steps.slice(-400)), 'error', msg, t.id]);
    throw Object.assign(new Error(msg), { status: err.status && err.status < 500 ? err.status : 502 });
  }
  return getThread(t.id, user);
}
