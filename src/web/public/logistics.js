/*
 * Logistics IS the logistics app (asked 30 Oct 2026: "put the whole logistics
 * app on the ERP, same how it already is"): the app's own page, served by the
 * ERP at /lg-app/ behind the sign-in, in one frame under the bar. The frame is
 * made once and kept while other pages show, so coming back costs nothing.
 * #/logistics/<tab>/<what> opens the app's tab and finds <what> there — a stock
 * number on most tabs, a client's name on Clients (the bridge inside the frame
 * does it — lgapp-bridge.js). The ERP's own logistics pages were removed the
 * same day; only the app is left.
 */
const lgApp = { frame: null };
const lgGroups = () => state.meta?.logistics?.groups || [];
const lgAppOn = () => Boolean(state.meta?.logistics?.app_embedded);
const lgAppHost = () => document.getElementById('lg-app-host');
/* The app's tab for one of our links: a key of GROUPS (kinds.js), or the app's own tab name. */
const lgAppTab = (group) => lgGroups().find((x) => x.key === group)?.app || group || 'dashboard';

/* The frame fills the screen under the bar, whatever height the bar wraps to. */
function lgAppFit() {
  const host = lgAppHost();
  if (!host || host.classList.contains('hide')) return;
  const bar = document.getElementById('bar');
  host.style.height = `${Math.max(240, window.innerHeight - (bar ? bar.getBoundingClientRect().bottom : 0))}px`;
}
window.addEventListener('resize', lgAppFit);
function lgAppHide() {
  lgAppHost()?.classList.add('hide');
  $('#app').classList.remove('hide');
}
/* Signed out: the app goes too — its page holds the key to its records. */
function lgAppDrop() {
  lgAppHide();
  lgApp.frame?.remove();
  lgApp.frame = null;
}
function showLogistics(group, q) {
  if (!lgAppOn()) {
    $('#app').innerHTML = `<h1>Logistics</h1><p class="count" style="max-width:560px">The logistics app is not set up here (LOGISTICS_APP_URL).</p>`;
    return;
  }
  if (!can('editor')) {
    $('#app').innerHTML = `<h1>Logistics</h1><p class="count" style="max-width:560px">The logistics app saves straight into its own records, so it is for editors. Ask an admin for the editor role.</p>`;
    return;
  }
  const tab = lgAppTab(group);
  const what = q ? decodeURIComponent(q) : '';
  const host = lgAppHost();
  $('#app').classList.add('hide');
  $('#app').innerHTML = '';
  host.classList.remove('hide');
  lgAppFit();
  if (!lgApp.frame) {
    lgApp.frame = document.createElement('iframe');
    lgApp.frame.title = 'Purosangue Watches Logistics';
    lgApp.frame.src = `/lg-app/#tab=${encodeURIComponent(tab)}${what ? `&q=${encodeURIComponent(what)}` : ''}`;
    host.appendChild(lgApp.frame);
  } else {
    lgApp.frame.contentWindow?.postMessage({ erp: 'tab', tab, q: what }, location.origin);
  }
}
/* A link of ours into the app: a watch by its stock number, a client by name. */
const lgAppLink = (group, what) => `#/logistics/${encodeURIComponent(group)}${what ? `/${encodeURIComponent(what)}` : ''}`;
