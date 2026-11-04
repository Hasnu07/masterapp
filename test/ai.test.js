import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import pg from 'pg';

/*
 * Claude in the ERP: the watch's brief and the Ask window, against a stand-in
 * Anthropic API (ANTHROPIC_BASE_URL) that records what the model was given and
 * answers in shape — a JSON brief, a tool call then an answer. What the model
 * reads (ai/context.js) is checked: the three apps together, no pictures or
 * files. Against a real Postgres (TEST_DATABASE_URL), EMPTIED.
 */

const DB = process.env.TEST_DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp_test';
let server, base, pool, dataDir, anthropic, anthropicBase;
const seen = []; // every request body the stand-in received

const BRIEF = { headline: 'Rolex Lady-Datejust, stock #1668: bought from Dealer One, sold to Omar F, USD 4,000 still owed.', lines: ['Bought 5 Sept 2026 for AED 46,000, paid in full', 'Sold 25 Sept 2026 for USD 14,000; USD 10,000 received'], money: 'USD 4,000 outstanding from Omar F.', where: 'In London stock since 1 Oct 2026.', attention: ['The ERP says in stock; the accounts app has it sold.'], missing: ['No sale currency on the ERP record.'] };

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-ai-'));
  anthropic = http
    .createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        seen.push({ path: req.url, headers: req.headers, body });
        const reply = (content, stop_reason) => {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ id: `msg_${seen.length}`, type: 'message', role: 'assistant', model: body.model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }));
        };
        if (req.headers['x-api-key'] !== 'test-key' && req.headers.authorization !== 'Bearer test-key') {
          res.statusCode = 401;
          return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }));
        }
        if (body.output_config?.format) return reply([{ type: 'text', text: JSON.stringify(BRIEF) }], 'end_turn');
        const last = body.messages[body.messages.length - 1];
        const answered = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_result');
        if (body.tools && !answered) return reply([{ type: 'tool_use', id: 'tu_1', name: 'watch_picture', input: { stock_no_or_id: '1668' } }], 'tool_use');
        return reply([{ type: 'text', text: 'Stock #1668 was bought from Dealer One for AED 46,000 and sold to Omar F.\n- USD 4,000 still owed\n- In London stock' }], 'end_turn');
      });
    })
    .listen(0);
  anthropicBase = `http://127.0.0.1:${anthropic.address().port}`;
  Object.assign(process.env, {
    DATABASE_URL: DB,
    DATA_DIR: dataDir,
    ADMIN_EMAIL: 'boss@example.com',
    ADMIN_PASSWORD: 'admin-password-1',
    SYNC: 'off',
    LOGISTICS_APP_URL: 'off',
    ACCOUNTS_APP_URL: 'http://127.0.0.1:9',
    ACCOUNTS_USERNAME: 'erp@example.com',
    ACCOUNTS_PASSWORD: 'erp-password-1',
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: anthropicBase,
    AI_MODEL: 'claude-opus-5-5',
  });
  const reset = new pg.Client({ connectionString: DB });
  await reset.connect();
  await reset.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await reset.end();
  await (await import('../src/db/migrate.js')).migrate({ log: () => {} });
  await (await import('../src/auth/index.js')).ensureFirstAdmin(() => {});
  pool = (await import('../src/db/index.js')).pool;
  const app = (await import('../src/web/server.js')).createServer();
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  anthropic.close();
  await pool.end();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const headers = { 'X-Requested-With': 'masterapp' };
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: (res.headers.get('content-type') || '').includes('json') ? JSON.parse(text || 'null') : text };
  };
  return { call, login: (email, password) => call('POST', '/api/login', { email, password }) };
}

let admin, watchId;

test('the watch’s brief: the model reads the three apps together — no pictures, no files — and the page gets it in shape; held while nothing changed', async () => {
  admin = client();
  assert.equal((await admin.login('boss@example.com', 'admin-password-1')).status, 200);
  const made = await admin.call('POST', '/api/watches', { brand: 'Rolex', model: 'Lady-Datejust', reference: '278274', serial: 'S1668', stock_no: '1668', purchase_date: '2026-09-05', purchase_price: 46000, purchase_currency: 'AED' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  watchId = made.body.id;
  const dealer = (await admin.call('POST', '/api/clients', { forename: 'Dealer', surname: 'One', type: 'dealer' })).body;
  assert.equal((await admin.call('PUT', `/api/watches/${watchId}/client`, { role: 'purchase', client_id: dealer.id })).status, 200);
  // The two apps' copies: one ledger leg with an inline picture and a proof, one London stock row with a photo.
  const { syncAccounts } = await import('../src/import/accounts/sync.js');
  await syncAccounts({
    state: {
      clients: [{ id: 'CL-001', name: 'Dealer One' }, { id: 'CL-002', name: 'Omar F' }],
      entries: [
        { id: 'e1', type: 'PAYABLE', clientId: 'CL-001', stock: '1668', amount: 46000, ccy: 'AED', date: '2026-09-05', payments: [{ id: 'p1', date: '2026-09-06', amount: 46000, method: 'Cash', proofs: [{ name: 'r.pdf', type: 'application/pdf', url: '/uploads/x/r.pdf' }] }], invoiceProof: { dataUrl: `data:image/jpeg;base64,${'A'.repeat(400)}` } },
        { id: 'e2', type: 'RECEIVABLE', clientId: 'CL-002', stock: '1668', amount: 14000, ccy: 'USD', date: '2026-09-25', payments: [{ id: 'p2', date: '2026-09-26', amount: 10000, applied: 10000, method: 'Crypto' }] },
      ],
      accounts: [],
    },
  });
  const { syncLogistics } = await import('../src/import/logistics/sync.js');
  await syncLogistics({ state: { clients: [], londonStock: [{ id: 'L1', stockNumber: '1668', brand: 'Rolex', status: 'current', receivedAt: '2026-10-01', photos: ['https://puro-sync.purosangue.workers.dev/photos/a.jpg'] }], dubaiStock: [], incomings: [], shipments: [], soldStocks: [] } });

  const meta = await admin.call('GET', '/api/meta');
  assert.deepEqual(meta.body.ai, { enabled: true, model: 'claude-opus-5-5' });

  const r = await admin.call('GET', `/api/ai/watch/${watchId}/brief`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.headline, BRIEF.headline);
  assert.deepEqual(r.body.attention, BRIEF.attention);
  assert.equal(r.body.model, 'claude-opus-5-5');
  assert.equal(r.body.cached, undefined);

  const req = seen[seen.length - 1];
  assert.equal(req.path, '/v1/messages');
  assert.equal(req.body.model, 'claude-opus-5-5');
  assert.equal(req.body.fallbacks, 'default');
  assert.match(req.headers['anthropic-beta'] || '', /server-side-fallback-2026-07-01/);
  assert.equal(req.body.output_config.effort, 'medium');
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.ok(req.body.system[0].cache_control, 'the house prompt is cached');
  const given = req.body.messages[0].content;
  const picture = JSON.parse(given.slice(given.indexOf('{')));
  assert.equal(picture.watch.stock_no, '1668');
  assert.equal(picture.clients.bought_from.name, 'Dealer One');
  assert.equal(picture.accounts.entries.length, 2, 'the ledger');
  assert.equal(picture.accounts.entries[1].outstanding, 0);
  assert.equal(picture.logistics.london.length, 1, 'the logistics row');
  assert.ok(!given.includes('base64,AAAA') && !given.includes('acfile:') && !given.includes('/photos/a.jpg') && !given.includes('r.pdf'), 'no pictures, files or papers go to the model');
  assert.ok(!given.includes('_history'));

  const again = await admin.call('GET', `/api/ai/watch/${watchId}/brief`);
  assert.equal(again.body.cached, true);
  assert.equal(seen.length, 1, 'held: the model was not asked twice');
});

test('ask: the model reads with its tools and answers; the conversation goes back with the next question', async () => {
  const before = seen.length;
  const r = await admin.call('POST', '/api/ai/ask', { question: 'Is 1668 paid?' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.answer, /^Stock #1668 was bought from Dealer One/);
  assert.deepEqual(r.body.tools, ['watch_picture']);
  assert.equal(seen.length, before + 2, 'one call for the tool, one for the answer');
  const first = seen[before].body;
  assert.ok(first.tools.some((t) => t.name === 'watch_picture') && first.tools.some((t) => t.name === 'accounts_open'));
  assert.equal(first.tool_choice, undefined, 'never forced');
  const second = seen[before + 1].body;
  const result = second.messages[second.messages.length - 1].content.find((b) => b.type === 'tool_result');
  assert.ok(result, 'the tool’s answer went back');
  const text = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
  assert.match(text, /"stock_no":"1668"/);
  assert.match(text, /Dealer One/);

  // The next question carries the conversation; about a watch, its picture opens the first turn only.
  const follow = await admin.call('POST', '/api/ai/ask', { question: 'And where is it?', history: [{ role: 'user', content: 'Is 1668 paid?' }, { role: 'assistant', content: r.body.answer }], watch_id: watchId });
  assert.equal(follow.status, 200);
  const sent = seen[seen.length - 2].body.messages;
  assert.equal(sent[0].content, 'Is 1668 paid?');
  assert.equal(sent[2].content, 'And where is it?');
  assert.equal((await admin.call('POST', '/api/ai/ask', { question: '' })).status, 400);
  assert.equal((await client().call('POST', '/api/ai/ask', { question: 'x' })).status, 401);
});

test('trim: what never goes to the model', async () => {
  const { trim } = await import('../src/ai/context.js');
  assert.deepEqual(
    trim({ a: 'data:image/png;base64,xxxx', photos: ['p'], note: 'kept', nested: { proof: 'x', amount: 5, _history: [1] }, list: Array.from({ length: 70 }, (_, i) => i), password: 'no' }),
    { note: 'kept', nested: { amount: 5 }, list: [...Array.from({ length: 60 }, (_, i) => i), '… 10 more'] }
  );
});
