import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { config } from '../config.js';
import { watchPicture, clientPicture, searchWatches, searchClients, accountsOpen, logisticsWhere } from './context.js';

/*
 * Claude in the ERP (asked 4 Nov 2026: "add api to the tool so it can read
 * through everything easily and be smart about what and how to show the data
 * combined and in a good manner"). Two things, both read-only:
 *
 *  - the watch's BRIEF: the whole picture of one watch (ai/context.js) read
 *    once, and written back as a few lines a person reads first — where it
 *    stands across the ERP, the logistics app and the accounts app, the money,
 *    what needs attention, what is missing. Held ten minutes per watch while
 *    nothing about it changed (the picture's hash).
 *  - ASK: a question in plain words, answered with tools over everything —
 *    a watch's picture, a client's, the watches found by words, the open
 *    ledger, where the logistics app has a watch. The model chooses which to
 *    read; the answer names stock numbers and clients so the page can link
 *    them. A conversation is kept by the page and sent back each turn.
 *
 * ANTHROPIC_API_KEY turns it on; without it the buttons are not shown. The
 * model is AI_MODEL (Claude Opus 5.5 unless set), effort AI_EFFORT (medium).
 * A refusal falls back to another model server-side (`fallbacks: "default"`).
 * Nothing the model says is written anywhere.
 */

let anthropic = null;
const client = () => {
  if (!config.ai.apiKey) throw Object.assign(new Error('The assistant is not set up here (ANTHROPIC_API_KEY)'), { status: 404 });
  if (!anthropic) anthropic = new Anthropic({ apiKey: config.ai.apiKey, maxRetries: 2, timeout: 120_000 });
  return anthropic;
};
export const forgetClient = () => {
  anthropic = null;
};

const HOUSE = `You are the assistant inside Purosangue ERP, a watch dealer's system (Purosangue Watches; offices in London, Dubai and Hong Kong; people in Pakistan and Dubai).
The ERP holds three things about every watch, kept apart and given to you as JSON:
- "watch", "clients", "history", "reference_sold_for": the ERP's own record (copied from Chrono Key, the inventory system, and the Watch vault; edited here). One record = one stock number = one purchase. Status is one of incoming, in_stock, reserved, sold, returned (to its client), other. Prices are in the deal's own currency; "purchase_currency" empty means the currency is not stated — never assume one. "*_eur" figures are Chrono Key's euro figures.
- "logistics": the logistics app's story (where it physically is: incomings, the London/Dubai/HK/safe stock rows with movements, shipments, couriers, polish, consignment, sales awaiting delivery, sold).
- "accounts": the accounts app's ledger (a PAYABLE is a purchase leg — what we owe the seller; a RECEIVABLE is a sale leg — what the buyer owes us; each with payments, their wallets, paid, outstanding; quick sales, invoices, expenses, commission). "source" says whether it came from the ERP's copy, live from the app, or could not be read.
Write for the people who run the business: plain, exact, short. Money always with its currency, as given (no conversion unless both figures are given). Dates as "5 Sept 2026". Name people and companies as the data names them. Say when the three apps disagree (a watch sold in the accounts app but in stock in the ERP; a payment outstanding on a watch already delivered). Say what is missing or unclear instead of guessing. Never invent a figure, a date or a name.`;

const money = (what) => ({
  type: 'object',
  additionalProperties: false,
  required: ['amount', 'ccy'],
  properties: { amount: { type: 'number', description: `${what}; 0 when there is none.` }, ccy: { type: 'string', description: 'Its currency code as the data gives it; empty when none or not stated.' } },
});
/*
 * The brief as DATA for a picture, not prose (asked 4 Nov 2026: "instead of
 * showing this overwhelming data show diagrams and a timeline, easy to
 * understand"): the watch's journey as stages, the money as figures the page
 * draws as bars, the key moments only, and at most a few flags.
 */
const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'journey', 'money', 'moments', 'attention', 'missing'],
  properties: {
    headline: { type: 'string', description: 'One short sentence, at most 18 words: what it is and where it stands now.' },
    journey: {
      type: 'array',
      description: 'The watch\'s path, one entry per stage in this order: bought, paid (we paid the seller), shipped, arrived, in_stock, sold, delivered (to the buyer), received (the buyer\'s money). Every stage once.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['stage', 'state', 'date', 'label'],
        properties: {
          stage: { type: 'string', enum: ['bought', 'paid', 'shipped', 'arrived', 'in_stock', 'sold', 'delivered', 'received'] },
          state: { type: 'string', enum: ['done', 'partial', 'pending', 'not_yet', 'unknown'], description: 'done: happened; partial: part way (part paid); pending: expected or in progress; not_yet: not reached; unknown: the data does not say.' },
          date: { type: 'string', description: 'YYYY-MM-DD when known, else empty.' },
          label: { type: 'string', description: 'At most 6 words under the stage: who, where or how much ("from Gaetano", "Dubai, by FedEx", "EUR 130,000"). Empty when nothing to say.' },
        },
      },
    },
    money: {
      type: 'object',
      additionalProperties: false,
      required: ['bought', 'paid', 'sold', 'received', 'costs', 'note'],
      properties: {
        bought: money('The purchase price'),
        paid: money('What we have paid the seller so far'),
        sold: money('The sale price'),
        received: money('What the buyer has paid us so far'),
        costs: { type: 'array', items: money('A cost on this watch (shipping, customs, polish)'), description: 'At most 5, each with its currency; the label goes in note.' },
        note: { type: 'string', description: 'At most 25 words on anything the bars cannot show: a part payment, two currencies, a cost still pending. Empty when nothing.' },
      },
    },
    moments: {
      type: 'array',
      description: 'The 5 to 10 moments that matter, in date order: what happened, where it came from. Not every record — the turning points.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['date', 'source', 'title', 'detail', 'tone'],
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD, or empty when unknown.' },
          source: { type: 'string', enum: ['erp', 'chronokey', 'logistics', 'accounts'] },
          title: { type: 'string', description: 'At most 7 words.' },
          detail: { type: 'string', description: 'At most 16 words. Empty when the title says it all.' },
          tone: { type: 'string', enum: ['here', 'moving', 'sold', 'warn', 'quiet'], description: 'here: arrived/in stock/paid; moving: shipped/incoming; sold: a sale; warn: something owed or odd; quiet: plain.' },
        },
      },
    },
    attention: { type: 'array', items: { type: 'string' }, description: 'At most 4 lines, each at most 20 words: money outstanding, the apps disagreeing on something that matters, a status that looks wrong. The most important first. Empty if nothing.' },
    missing: { type: 'array', items: { type: 'string' }, description: 'At most 3 lines, each at most 12 words: what the data should say and does not. Empty if nothing.' },
  },
};

const held = new Map();
const hash = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');
export const forgetBriefs = () => held.clear();

/** The watch's brief, written by the model from its whole picture; held ten minutes while the picture is the same. */
export async function briefWatch(id, { cookie = '' } = {}) {
  const picture = await watchPicture(id, { cookie });
  if (!picture) throw Object.assign(new Error('No such watch'), { status: 404 });
  const key = `${id}`;
  const h = hash(picture);
  const have = held.get(key);
  if (have && have.hash === h && Date.now() - have.at < 10 * 60_000) return { ...have.brief, cached: true };
  const res = await client().beta.messages.create({
    model: config.ai.model,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: config.ai.effort, format: { type: 'json_schema', schema: BRIEF_SCHEMA } },
    system: [{ type: 'text', text: HOUSE, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: `Here is everything the ERP holds on one watch, as JSON. Fill in its brief: the journey's eight stages, the money as figures, the five to ten moments that matter, and at most a few flags — short, for a picture, not an essay.\n\n${JSON.stringify(picture)}`,
      },
    ],
  });
  if (res.stop_reason === 'refusal') throw new Error('The assistant declined to write this brief');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let brief;
  try {
    brief = JSON.parse(text);
  } catch {
    throw new Error('The assistant answered in a shape the page cannot read');
  }
  const out = { ...brief, model: res.model, at: new Date().toISOString(), source: picture.accounts?.source || null };
  held.set(key, { hash: h, at: Date.now(), brief: out });
  if (held.size > 500) held.delete(held.keys().next().value);
  return out;
}

/* ── the tools the model reads with ── */

const asText = (v) => {
  const s = JSON.stringify(v ?? null);
  return s.length > 60_000 ? `${s.slice(0, 60_000)}… (cut: ask for less)` : s;
};

function tools({ cookie }) {
  return [
    betaTool({
      name: 'search_watches',
      description: 'Find watches in the ERP by words: a stock number, reference, serial, brand, model, or the name of who it was bought from or sold to. Optional status (incoming, in_stock, reserved, sold, returned, other) and location (Dubai, UK, HK, Europe). Returns up to `limit` matches with the deal on each, and the counts per status, place and brand for the search.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'The words to search for; empty for everything.' },
          status: { type: 'string', enum: ['', 'incoming', 'in_stock', 'reserved', 'sold', 'returned', 'other'] },
          location: { type: 'string' },
          brand: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 100 },
        },
        required: ['q'],
        additionalProperties: false,
      },
      run: async (a) => asText(await searchWatches({ q: a.q, status: a.status || '', location: a.location || '', brand: a.brand || '', limit: a.limit || 20 })),
    }),
    betaTool({
      name: 'watch_picture',
      description: 'Everything on one watch, by its stock number (e.g. "1668") or its ERP id: the record, its clients, its history, what the reference has sold for, the logistics app\'s story on it, the accounts ledger on it with payments and wallets. Read this before answering anything about a particular watch.',
      inputSchema: { type: 'object', properties: { stock_no_or_id: { type: 'string' } }, required: ['stock_no_or_id'], additionalProperties: false },
      run: async (a) => asText((await watchPicture(a.stock_no_or_id, { cookie })) || { error: 'No such watch' }),
    }),
    betaTool({
      name: 'find_clients',
      description: 'Find our clients by name, company, phone or email. Returns matches with how many watches were bought from and sold to each.',
      inputSchema: { type: 'object', properties: { q: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['q'], additionalProperties: false },
      run: async (a) => asText(await searchClients(a.q, a.limit || 20)),
    }),
    betaTool({
      name: 'client_picture',
      description: 'One client of ours, by id or by an exact-enough name: who they are, every watch bought from them and sold to them, and what the accounts app says stands open with them per currency.',
      inputSchema: { type: 'object', properties: { id_or_name: { type: 'string' } }, required: ['id_or_name'], additionalProperties: false },
      run: async (a) => asText(await clientPicture(a.id_or_name)),
    }),
    betaTool({
      name: 'accounts_open',
      description: 'The open ledger from the accounts app: every entry with money outstanding — owed to us (sales not fully received) or owed by us (purchases not fully paid) — with client, stock number, amount, paid, outstanding, due date, and totals per currency. Newest first.',
      inputSchema: {
        type: 'object',
        properties: { direction: { type: 'string', enum: ['both', 'owed_to_us', 'we_owe'] }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
        required: ['direction'],
        additionalProperties: false,
      },
      run: async (a) => asText(await accountsOpen({ direction: a.direction, limit: a.limit || 60 })),
    }),
    betaTool({
      name: 'logistics_where',
      description: 'Where the logistics app has a watch, by stock number: its stock rows in London, Dubai, HK or the safe with movements, incomings, shipments, couriers, polish, consignment, sales awaiting delivery, costs.',
      inputSchema: { type: 'object', properties: { stock_no: { type: 'string' } }, required: ['stock_no'], additionalProperties: false },
      run: async (a) => asText((await logisticsWhere(a.stock_no)) || { error: 'No stock number' }),
    }),
  ];
}

const ASK = `${HOUSE}

You answer questions by reading with the tools. Read before you answer; read a watch's picture before saying anything about that watch; for "who owes us", "what is outstanding" or "overdue" read the open ledger. Keep answers short and shaped for reading on a page: a one-line answer first, then the facts as short lines beginning with "- " where there are several. Write a stock number as "#1668" and a client by their name as the ERP has it, so the page can link them. Do not describe your tools or the JSON; just answer. If the data does not hold the answer, say what is missing in one line.`;

const MAX_TURNS = 12;

/**
 * A question across everything, with the conversation so far ([{role, content}], text only).
 * Returns the answer and which tools were read.
 */
export async function ask({ question, history = [], watchId = null, cookie = '' } = {}) {
  const q = String(question || '').trim().slice(0, 4000);
  if (!q) throw Object.assign(new Error('Ask something'), { status: 400 });
  const past = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_TURNS)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 6000) }));
  const messages = [...past];
  let opening = q;
  if (watchId && !past.length) {
    const picture = await watchPicture(watchId, { cookie });
    if (picture) opening = `About this watch (its whole picture follows as JSON; read it, and read more with the tools only if the question needs it):\n${JSON.stringify(picture)}\n\nQuestion: ${q}`;
  }
  messages.push({ role: 'user', content: opening });
  const used = [];
  const runner = client().beta.messages.toolRunner({
    model: config.ai.model,
    max_tokens: 6000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: config.ai.effort },
    system: [{ type: 'text', text: ASK, cache_control: { type: 'ephemeral' } }],
    tools: tools({ cookie }),
    messages,
    max_iterations: 8,
  });
  for await (const message of runner) {
    for (const b of message.content) if (b.type === 'tool_use') used.push(b.name);
  }
  const final = await runner.done();
  if (final.stop_reason === 'refusal') throw new Error('The assistant declined to answer that');
  const answer = final.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { answer: answer || 'I could not find an answer in the data.', tools: [...new Set(used)], model: final.model };
}
