import http from 'node:http';
import https from 'node:https';
import { config } from '../../config.js';

/*
 * Chrono Key inventory client.
 *
 * Chrono Key has no API key — it has a login form and a session cookie, so
 * this signs in the way a browser would and keeps the cookie. That is why the
 * credentials live here on the server and never reach the browser: anyone
 * holding them can see and change the real inventory, whereas the console only
 * ever sends back parsed, read-only JSON.
 *
 * Ported from InvoiceWEB (src/stock/chronokey.js), which ported it from the
 * standalone lookup app. The cookie handling and the signed-in checks are
 * deliberately unchanged — that is the part already proven against the live
 * site. masterapp only READS Chrono Key: nothing here posts to anything but
 * the sign-in form and the list grid's own data endpoint.
 */

export const BASE_URL = () => config.chronokey.url;

class ChronoKeyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ChronoKeyError';
    this.status = status;
  }
}

class ChronoKeyClient {
  constructor(username, password) {
    this.username = username;
    this.password = password;
    this.cookies = {};
    this.loggedIn = false;
    this.loginPromise = null;
  }

  fetch(url, opts = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const cookieStr = Object.entries(this.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
      const headers = {
        ...opts.headers,
        ...(cookieStr ? { Cookie: cookieStr } : {}),
      };

      const req = (u.protocol === 'http:' ? http : https).request(u, { method: opts.method || 'GET', headers, timeout: 25000 }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          for (const sc of res.headers['set-cookie'] || []) {
            const [pair] = sc.split(';');
            const eq = pair.indexOf('=');
            if (eq > 0) this.cookies[pair.slice(0, eq)] = pair.slice(eq + 1);
          }
          const buffer = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            buffer,
            // Binary responses (images) are read through `buffer`; everything
            // else wants the text, so both are offered rather than guessed at.
            get body() {
              return buffer.toString('utf8');
            },
          });
        });
      });

      req.on('timeout', () => req.destroy(new ChronoKeyError('Chrono Key timed out')));
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  async login() {
    // One login at a time: three searches arriving together would otherwise
    // each start their own, and the last cookie set would win at random.
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = (async () => {
      const base = BASE_URL();
      let r = await this.fetch(`${base}/`);
      const token = r.body.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
      if (!token) throw new ChronoKeyError('Chrono Key did not show a login form');

      const body = new URLSearchParams({
        UserName: this.username,
        PasswordHash: this.password,
        __RequestVerificationToken: token[1],
      }).toString();

      r = await this.fetch(`${base}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        body,
      });

      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        const loc = r.headers.location.startsWith('http')
          ? r.headers.location
          : `${base}${r.headers.location}`;
        // Every cookie this client holds goes with the next request: only to Chrono Key's own host.
        // A 401, as a rejected password: a pass stops at the first page, not signing in again for each.
        const host = new URL(loc).host;
        if (host !== new URL(base).host) throw new ChronoKeyError(`Chrono Key sent the sign-in to another site (${host})`, 401);
        r = await this.fetch(loc);
      }

      /*
       * Prove the sign-in actually took.
       *
       * A REJECTED login also answers 302 — back to the login form — so the
       * redirect proves nothing on its own. Without this check the client set
       * loggedIn = true either way, and every call then came back empty rather
       * than failing: the autocomplete answers a genuine `[]` with a JSON
       * content-type, the stock page answers a zero-length body, and `doctor`
       * reported "signed in (0 matches for a test search)". An inventory that
       * looks merely empty is far worse than one that says it is locked out —
       * "no watches match" is a normal answer, and nothing anywhere said the
       * password was wrong.
       */
      if (/name="PasswordHash"/i.test(r.body)) {
        throw new ChronoKeyError(
          'Chrono Key rejected the sign-in — check CHRONOKEY_USERNAME and CHRONOKEY_PASSWORD',
          401
        );
      }

      this.loggedIn = true;
    })();

    try {
      await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  /** Any request, signing in first and once more if the session has lapsed. */
  async request(path, opts = {}) {
    if (!this.loggedIn) await this.login();
    let r = await this.fetch(`${BASE_URL()}${path}`, opts);

    if (r.status === 401 || (r.status === 200 && r.body.includes('Sign In'))) {
      this.loggedIn = false;
      await this.login();
      r = await this.fetch(`${BASE_URL()}${path}`, opts);
    }
    return r;
  }

  /**
   * Is this session still signed in?
   *
   * Costs one small request, so it is only asked when an answer came back
   * EMPTY — which is the one case where a dead session and a real "no matches"
   * are indistinguishable.
   */
  async signedIn() {
    const r = await this.fetch(`${BASE_URL()}/`);
    return !/name="PasswordHash"/i.test(r.body);
  }

  /*
   * Runs a call, and does not believe an empty answer until the session has
   * been checked.
   *
   * Verifying at login time is not enough: a session that dies LATER leaves
   * loggedIn true, and every call then returns an empty result rather than an
   * error — the autocomplete answers `[]` with a JSON content-type and the
   * stock page answers a zero-length body, neither of which looks like a
   * failure. That state is permanent for the life of the process, which is
   * how a live server can sit there reporting "0 matches" for a watch that
   * plainly exists, with the right password in its variables the whole time.
   */
  async retryIfLoggedOut(run, isEmpty) {
    const first = await run();
    if (!isEmpty(first)) return first;
    if (await this.signedIn()) return first; // genuinely nothing to find
    this.loggedIn = false;
    await this.login();
    return run();
  }

  searchProducts(term) {
    const run = () =>
      this.request(`/api/cms/AutoCompleteProduct?term=${encodeURIComponent(term)}`).then((r) => {
        try {
          const parsed = JSON.parse(r.body);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      });
    return this.retryIfLoggedOut(run, (rows) => !rows.length);
  }

  /*
   * `filterBy`: the Inventory page itself asks with 'A' (ALL — its default);
   * '0' answered the same 134 cards on 23 Oct 2026. The status sync uses 'A',
   * so its count matches the one the page declares.
   */
  getInventoryCards(searchText, pageSize = 24, pageNumber = 1, { filterBy = '0' } = {}) {
    const params = new URLSearchParams({
      searchText,
      filterBy,
      PageSize: String(pageSize),
      PageNumber: String(pageNumber),
      sortColumnNo: '0',
      order: 'asc',
      categoryId: '0',
      shelfBox: '',
    });
    // A zero-length body is what this page returns when signed out; a real
    // "nothing in stock matches" still comes back as a page.
    return this.retryIfLoggedOut(
      () => this.request(`/stock/FilterInstock?${params}`).then((r) => r.body),
      (html) => !String(html || '').trim()
    );
  }

  /*
   * One of Chrono Key's table listings: the sold items, the incoming
   * inventory or the whole product list.
   *
   * Full HTML pages rather than the partial the in-stock grid fetches, and
   * long ones — 1,363 sold and 1,583 products when this was written, ten to
   * a page. Whether a page renders every row and only PAGES the display, or
   * genuinely returns ten, is not something a screenshot can settle, so the
   * loader ASKS for a large page and then counts: see `listState` in the
   * server.
   *
   * `PageSize` and `PageNumber` are this application's own parameter names —
   * they are what `FilterInstock` takes — so passing them here is following
   * the app's convention rather than guessing at a framework's. Whether a
   * page honours them is verified rather than assumed: the caller checks
   * that the rows actually changed between requests.
   */
  getListHtml(path, { pageSize, pageNumber } = {}) {
    const params = new URLSearchParams();
    if (pageSize) params.set('PageSize', String(pageSize));
    if (pageNumber) params.set('PageNumber', String(pageNumber));
    const qs = params.toString();
    return this.retryIfLoggedOut(
      () => this.request(`${path}${qs ? `?${qs}` : ''}`).then((r) => r.body),
      (html) => !String(html || '').trim()
    );
  }

  /*
   * A DataTables grid's own data endpoint.
   *
   * The Sold and All-products pages hold ONLY a header row — checked on the
   * live site, `tbody rows: 0, td anywhere: 0`, and the same byte count
   * whatever PageSize is asked for. Their rows come from
   * `/Stock/SoldListDataTable` and `/Stock/ProductsDataTable`, which the
   * page's own inline script names. So there was never anything to page:
   * eight fetches of 209 KB of page furniture were reading a table that was
   * not in it.
   *
   * POST, form-encoded, with `X-Requested-With` — that is how a DataTable
   * asks, and an ASP.NET controller commonly checks for it before answering
   * as an AJAX request rather than a page.
   *
   * The path is passed in from a hard-coded list in the server and is never
   * taken from the scraped page, however tempting it is that the script
   * names it. That same script names `/Stock/SellProduct/`,
   * `/Stock/DeleteProductForDealer/` and `/Stock/ReturnSale` — POSTing to a
   * URL read out of someone's HTML is how a read turns into a write.
   */
  postForm(path, form) {
    const body = new URLSearchParams(form).toString();
    const run = () =>
      this.request(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01',
        },
        body,
      }).then((r) => ({
        status: r.status,
        type: String(r.headers['content-type'] || ''),
        body: r.body,
      }));

    // An empty body is the shape a lapsed session answers with, exactly as
    // the HTML pages do.
    return this.retryIfLoggedOut(run, (r) => !String(r.body || '').trim());
  }

  getWatchDetailHtml(purchaseId) {
    return this.request(`/Stock/InstockDetailPage/${encodeURIComponent(purchaseId)}`).then((r) => r.body);
  }

  /**
   * Fetches an inventory photo. Chrono Key serves images from behind the same
   * login, so the browser cannot load them directly — they come through here.
   */
  getImage(pathname) {
    return this.request(pathname);
  }
}

/* One client, so one session cookie is shared rather than a login per request. */
let client = null;

export function chronokey() {
  if (!config.chronokey.configured) {
    throw new ChronoKeyError('Chrono Key is not configured', 503);
  }
  if (!client) {
    client = new ChronoKeyClient(config.chronokey.username, config.chronokey.password);
  }
  return client;
}

export { ChronoKeyClient, ChronoKeyError };
