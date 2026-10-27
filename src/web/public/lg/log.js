/*
 * Activity: the logistics app's "Activity Log" — the lines it writes as
 * people work in it, newest first, as the app shows them (time and text),
 * grouped here by day and searchable. A stock number in a line is our
 * watch: linked, with the watch named under the line. The app keeps its
 * last 200 lines; our copy keeps the older ones too. The app's to-do items
 * are its notepad's, not this page's — they are among the tab's records.
 */
'use strict';
const al = { q: '', ours: false, shown: 100, data: null };

LG_PAGES.log = async function () {
  const seq = ++lgPage;
  $('#app').innerHTML = `${lgHeader('log')}
    <p class="sub" style="margin:0 0 12px">What people did in the logistics app, newest first. A stock number in a line is our watch.</p>
    <div class="lg-toolbar al-toolbar">
      <input class="q" type="search" id="alq" placeholder="A stock number, a name, a word in the line…" value="${esc(al.q)}" aria-label="Search the activity">
      <label class="count al-only"><input type="checkbox" id="al-ours" ${al.ours ? 'checked' : ''}> Only lines about our watches</label>
      <a class="btn" href="#/logistics/log-all">All records</a>
    </div>
    <div class="count" id="al-count">Reading the activity…</div>
    <div id="al-out" class="al-days"></div>
    <div class="row" style="justify-content:center;margin-top:18px"><button type="button" class="btn hide" id="al-more">Show more</button></div>`;
  let timer;
  $('#alq').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      al.q = e.target.value;
      al.shown = 100;
      drawActivity();
    }, 150);
  });
  $('#al-ours').addEventListener('change', (e) => {
    al.ours = e.target.checked;
    al.shown = 100;
    drawActivity();
  });
  $('#al-more').addEventListener('click', () => {
    al.shown += 100;
    drawActivity();
  });
  let r;
  try {
    r = await api('/api/logistics/page/log');
  } catch (err) {
    if (seq === lgPage && $('#al-count')) $('#al-count').textContent = `Could not read the activity: ${err.message}`;
    return;
  }
  if (seq !== lgPage || !$('#al-out')) return;
  al.data = r;
  drawActivity();
}

/* The line's text with each stock number it names linked to our watch (the first time it appears), bold otherwise. */
function alLine(line, watches) {
  let html = esc(line.text);
  for (const no of line.stock_nos) {
    const w = watches[no];
    const re = new RegExp(`(^|[^\\d])(${no.replace(/\./g, '\\.')})(?![\\d])`);
    html = html.replace(re, (m, before, num) => `${before}${w ? `<a href="#/watch/${w.id}"><b>${num}</b></a>` : `<b>${num}</b>`}`);
  }
  return html;
}
const alTime = (iso) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const alDayLabel = (day) => {
  const today = localDay();
  const yesterday = localDay(Date.now() - 86_400_000);
  return day === today ? 'Today' : day === yesterday ? 'Yesterday' : dayWords(day);
};

function drawActivity() {
  const r = al.data;
  if (!r || !$('#al-out')) return;
  const words = al.q.toLowerCase().split(/\s+/).filter(Boolean);
  const lines = r.lines.filter((l) => (!al.ours || l.stock_nos.some((no) => r.watches[no])) && sfMatch(words, l.text, ...l.stock_nos.map((no) => r.watches[no]?.title || '')));
  const n = lines.length;
  $('#al-count').textContent = `${n} line${n === 1 ? '' : 's'}${n !== r.lines.length ? ` of ${r.lines.length}` : ''} · the logistics app keeps its last ${r.app_keeps}; older lines stay here`;
  if (!n) {
    $('#al-out').innerHTML = `<p class="sub">${r.lines.length ? 'No line matches.' : 'No activity yet.'}</p>`;
    $('#al-more').classList.add('hide');
    return;
  }
  const shown = lines.slice(0, al.shown);
  const days = new Map();
  for (const l of shown) {
    const day = localDay(new Date(l.ts).getTime());
    days.set(day, [...(days.get(day) || []), l]);
  }
  $('#al-out').innerHTML = [...days]
    .map(
      ([day, ls]) => `<section class="panel al-day"><h3>${esc(alDayLabel(day))} <span class="count" style="margin:0;font-weight:400">${ls.length}</span></h3>
        <ol class="al-lines">${ls
          .map((l) => {
            const ours = l.stock_nos.map((no) => r.watches[no]).filter(Boolean);
            return `<li><time datetime="${esc(l.ts)}">${esc(alTime(l.ts))}</time><div class="al-text">${alLine(l, r.watches)}${
              ours.length ? `<div class="count al-ours">${ours.map((w) => `<a href="#/watch/${w.id}">Our watch #${esc(w.stock_no)}</a> ${chip(w.status)} ${esc(w.title)}`).join(' · ')}</div>` : ''
            }</div></li>`;
          })
          .join('')}</ol></section>`
    )
    .join('');
  $('#al-more').classList.toggle('hide', shown.length >= n);
}
