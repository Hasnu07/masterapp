/*
 * Claude in the console (asked 4 Nov 2026: "add api to the tool so it can
 * read through everything easily and be smart about what and how to show the
 * data combined"). Two places, both read-only:
 *  - the watch's BRIEF at the top of its Timeline: a few lines the model
 *    wrote from the watch's whole picture — the ERP, the logistics app and
 *    the accounts app together — with what needs attention and what is missing;
 *  - ASK: a question in plain words — on the Timeline, about that watch; from
 *    the ☆ Ask button in the bar, about anything — answered with the model's
 *    tools over every watch, client, ledger entry and logistics record. Stock
 *    numbers ("#1668") and our clients' names in an answer are links.
 * Shown only when the server has ANTHROPIC_API_KEY (meta.ai.enabled).
 */
const aiOn = () => Boolean(state.meta?.ai?.enabled);

/* An answer as the page shows it: escaped, "- " lines as a list, **bold**, "#1668" and our clients' names as links. */
function aiText(text, links = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let list = null;
  const inline = (s) => {
    let h = esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/#(\d{1,6}[A-Za-z]?)(?![\w.])/g, (m, no) => (links.watches?.[no] ? `<a href="#/watch/${links.watches[no].id}">#${esc(no)}</a>` : m));
    for (const [name, c] of Object.entries(links.clients || {})) {
      const re = new RegExp(`(^|[^\\w>])(${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\w<])`, 'g');
      h = h.replace(re, (m, pre, hit) => `${pre}<a href="#/client/${c.id}">${esc(hit)}</a>`);
    }
    return h;
  };
  for (const raw of lines) {
    const m = raw.match(/^\s*[-•*]\s+(.*)$/);
    if (m) {
      if (!list) {
        list = [];
        out.push(list);
      }
      list.push(`<li>${inline(m[1])}</li>`);
    } else {
      list = null;
      if (raw.trim()) out.push(`<p>${inline(raw.trim())}</p>`);
    }
  }
  return out.map((x) => (Array.isArray(x) ? `<ul>${x.join('')}</ul>` : x)).join('');
}
/* Which stock numbers and names in an answer are ours — the same question the apps' bridges ask. */
async function aiLinks(text) {
  const nos = [...new Set([...String(text).matchAll(/#(\d{1,6}[A-Za-z]?)(?![\w.])/g)].map((m) => m[1]))];
  const names = [...new Set([...String(text).matchAll(/\b([A-Z][\p{L}'.-]+(?:\s+[A-Z][\p{L}'.-]+){1,3})\b/gu)].map((m) => m[1]))].slice(0, 60);
  if (!nos.length && !names.length) return {};
  try {
    return await api('/api/acc-app/links', { method: 'POST', body: { stock: nos, clients: names } });
  } catch {
    return {};
  }
}

/* ── the brief, drawn: the journey as a stepper, the money as bars, the key moments, a few flags ── */
const AIB_STAGES = [
  ['bought', 'Bought'], ['paid', 'Paid'], ['shipped', 'Shipped'], ['arrived', 'Arrived'], ['in_stock', 'In stock'], ['sold', 'Sold'], ['delivered', 'Delivered'], ['received', 'Received'],
];
const aibDay = (d) => (d && /^\d{4}-\d{2}-\d{2}/.test(d) ? new Date(`${d.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const aibAmt = (m) => (m && Number(m.amount) ? `${esc(m.ccy || '')} ${Number(m.amount).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`.trim() : '');
function aibJourney(journey) {
  const by = Object.fromEntries((journey || []).map((j) => [j.stage, j]));
  return `<ol class="aib-journey">${AIB_STAGES.map(([key, name]) => {
    const j = by[key] || { state: 'unknown', date: '', label: '' };
    return `<li class="st-${esc(j.state)}"><span class="dot"></span><b>${name}</b><time>${esc(aibDay(j.date)) || (j.state === 'not_yet' ? '—' : j.state === 'pending' ? 'pending' : j.state === 'partial' ? 'part' : '')}</time>${j.label ? `<small>${esc(j.label)}</small>` : ''}</li>`;
  }).join('')}</ol>`;
}
/* One bar per side of the deal: how much of the price has moved, in its own currency. */
function aibBar(label, price, paid, verb) {
  const p = Number(price?.amount) || 0;
  if (!p) return `<div class="aib-bar none"><span class="k">${label}</span><span class="count" style="margin:0">—</span></div>`;
  const done = Math.min(Number(paid?.amount) || 0, p);
  const pct = Math.round((done / p) * 100);
  const left = Math.max(0, p - done);
  return `<div class="aib-bar"><span class="k">${label}</span>
    <div class="track"><i style="width:${pct}%"></i></div>
    <span class="fig">${aibAmt(price)} · ${pct === 100 ? `${verb} in full` : pct === 0 ? `nothing ${verb}` : `${verb} ${aibAmt({ amount: done, ccy: price.ccy })}, <b>${aibAmt({ amount: left, ccy: price.ccy })} left</b>`}</span></div>`;
}
async function aiBrief(watchId, box) {
  if (!aiOn() || !box) return;
  box.innerHTML = '<div class="aib"><div class="lgw-eyebrow">In one read</div><p class="count aib-wait">Reading the three apps…</p></div>';
  let b;
  try {
    b = await api(`/api/ai/watch/${watchId}/brief`);
  } catch (err) {
    box.innerHTML = `<div class="aib"><div class="lgw-eyebrow">In one read</div><p class="count" style="margin:0">${esc(err.message)}</p></div>`;
    return;
  }
  if (!box.isConnected) return;
  const links = await aiLinks([b.headline, ...(b.moments || []).map((m) => `${m.title} ${m.detail}`), ...(b.attention || []), ...(b.missing || [])].join('\n'));
  const inl = (t) => aiText(t, links).replace(/^<p>|<\/p>$/g, '');
  const m = b.money || {};
  const costs = (m.costs || []).filter((c) => Number(c.amount));
  const SRC = { erp: 'ERP', chronokey: 'Chrono Key', logistics: 'Logistics', accounts: 'Accounts' };
  box.innerHTML = `<div class="aib">
    <div class="lgw-eyebrow">In one read</div>
    <p class="aib-head">${inl(b.headline || '')}</p>
    ${aibJourney(b.journey)}
    <div class="aib-money">
      ${aibBar('Bought', m.bought, m.paid, 'paid')}
      ${aibBar('Sold', m.sold, m.received, 'received')}
      ${costs.length ? `<div class="aib-costs"><span class="k">Costs</span> ${costs.map((c) => aibAmt(c)).join(' · ')}</div>` : ''}
      ${m.note ? `<div class="count aib-note">${inl(m.note)}</div>` : ''}
    </div>
    ${
      (b.moments || []).length
        ? `<ol class="lgw-tl aib-moments">${b.moments
            .map((x) => `<li class="${esc(x.tone || '')}"><time>${esc(aibDay(x.date)) || '<span class="blank">—</span>'}</time><div><div class="lgw-ev"><span class="tl-src tl-${esc(x.source)}">${esc(SRC[x.source] || x.source)}</span>${inl(x.title)}</div>${x.detail ? `<div class="lgw-d">${inl(x.detail)}</div>` : ''}</div></li>`)
            .join('')}</ol>`
        : ''
    }
    ${(b.attention || []).length ? `<div class="aib-att"><div class="k">Needs attention</div><ul>${b.attention.slice(0, 4).map((x) => `<li>${inl(x)}</li>`).join('')}</ul></div>` : ''}
    ${(b.missing || []).length ? `<div class="aib-miss"><div class="k">Not in the data</div><ul>${b.missing.slice(0, 3).map((x) => `<li>${inl(x)}</li>`).join('')}</ul></div>` : ''}
    <div class="count aib-foot">Drawn by ${esc(b.model || 'Claude')}${b.cached ? ' a few minutes ago' : ''} from the ERP, the logistics app and the accounts app — the full story is below; check a figure before acting on it.</div>
  </div>`;
}

/* ── ask: a thread of questions and answers, on the Timeline (about the watch) or in the bar (about anything) ── */
function aiAskPanel(host, { watchId = null, placeholder = 'Ask about anything — a watch, a client, who owes us…' } = {}) {
  if (!aiOn() || !host) return;
  const thread = [];
  host.innerHTML = `<div class="aia">
    <div class="aia-thread"></div>
    <form class="aia-form"><input type="text" name="q" placeholder="${esc(placeholder)}" autocomplete="off" maxlength="4000"><button class="btn primary" type="submit">Ask</button></form>
  </div>`;
  const log = host.querySelector('.aia-thread');
  const form = host.querySelector('form');
  const input = form.querySelector('input');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    const qEl = document.createElement('div');
    qEl.className = 'aia-q';
    qEl.textContent = q;
    const aEl = document.createElement('div');
    aEl.className = 'aia-a';
    aEl.innerHTML = '<span class="count">Reading…</span>';
    log.append(qEl, aEl);
    aEl.scrollIntoView({ block: 'nearest' });
    form.querySelector('button').disabled = true;
    try {
      const r = await api('/api/ai/ask', { method: 'POST', body: { question: q, history: thread.slice(-12), watch_id: watchId } });
      const links = await aiLinks(r.answer);
      aEl.innerHTML = aiText(r.answer, links) + (r.tools?.length ? `<div class="count aia-tools">Read: ${r.tools.map(esc).join(', ')}</div>` : '');
      thread.push({ role: 'user', content: q }, { role: 'assistant', content: r.answer });
    } catch (err) {
      aEl.innerHTML = `<p class="err" style="margin:0">${esc(err.message)}</p>`;
    } finally {
      form.querySelector('button').disabled = false;
      aEl.scrollIntoView({ block: 'nearest' });
      input.focus();
    }
  });
}

/* The Ask window from the bar: about anything. */
function showAskWindow() {
  if (!aiOn()) return;
  let d = document.getElementById('ask-win');
  if (!d) {
    d = document.createElement('dialog');
    d.id = 'ask-win';
    d.className = 'lgw';
    d.innerHTML = `
      <div class="lgw-head">
        <div><div class="lgw-eyebrow">Ask</div><h2>Across the ERP, the logistics app and the accounts app</h2>
          <div class="count" style="margin:0">Try: “Who still owes us money and on which watches?” · “Where is #1705 and is it paid?” · “What have we sold to Omar F?”</div></div>
        <button type="button" class="btn" id="askw-close">Close</button>
      </div>
      <div class="lgw-body" id="askw-body"></div>`;
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
    });
    d.querySelector('#askw-close').addEventListener('click', () => d.close());
    document.body.appendChild(d);
    aiAskPanel(d.querySelector('#askw-body'));
  }
  if (!d.open) d.showModal();
  d.querySelector('input')?.focus();
}
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('ask-open')?.addEventListener('click', showAskWindow);
});
