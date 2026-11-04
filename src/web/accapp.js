import { config } from '../config.js';

/*
 * The accounts app itself, inside the ERP (asked 4 Nov 2026: "add accountancy
 * app to the ERP same way as how we did logistic"). Its page is read from its
 * own address (Railway) and served here at /acc-app/, behind the ERP's
 * sign-in, so the Accounts menu shows the app exactly as it is — with the
 * ERP's bridge script (public/accapp-bridge.js) put first in its <head>, which
 * links every stock number and client name it shows to OUR watch and OUR
 * client. Its data stays in its own database: the app saves there as before,
 * and the ERP keeps copying it (import/accounts/sync.js).
 *
 * The app is a React build, so unlike the logistics app's single page:
 *  - its page names its script and stylesheet by absolute paths (/assets/…),
 *    and the script calls its API by absolute paths too (`/api`, the axios base
 *    and a few fetches). Both are rewritten to /acc-app/… — in the page as it
 *    is served, and in the script as it is served (held, so the 2.5 MB bundle
 *    is rewritten once a minute at most, not on every visit);
 *  - it signs people in itself (express-session, a cookie named connect.sid)
 *    and stamps who did what on every record. That stays: its API calls are
 *    passed on with the browser's accounts cookie and its Set-Cookie comes
 *    back, scoped to this origin — so each person signs in to the accounts
 *    app once, inside the frame, with their own accounts account. The ERP's
 *    own session cookie is never sent on;
 *  - its router keeps the frame's address at the app's own routes (/clients …),
 *    so a reload of the frame would ask the ERP for /clients: a page asked for
 *    BY A FRAME (Sec-Fetch-Dest: iframe) at any address of the app's is
 *    answered with the app's page. The ERP's console is never framed.
 *  - its uploads (/uploads/…, the proof pictures and invoices on records) are
 *    asked for by absolute path as well: served through /acc-app/uploads/…
 *    and /uploads/… alike, with the accounts cookie.
 *
 * Editors only, like the logistics app. A write must come from the ERP's own
 * page. The held copies serve when Railway does not answer.
 */

export const HOLD = { ms: 60_000 };
const UPSTREAM_TIMEOUT_MS = 30_000;
const BODY_LIMIT = 30 * 1024 * 1024;
const ERP_COOKIE = 'ma_session';
const PREFIX = '/acc-app';

/* The app's page: its own scripts (and one inline one that sets the theme), Google's fonts, the rate feeds it reads, Google Maps for addresses; framed by the ERP only. */
export const appPolicy = () =>
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://maps.googleapis.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "connect-src 'self' https://latest.currency-api.pages.dev https://cdn.jsdelivr.net https://maps.googleapis.com",
    "frame-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');

/* What the ERP changes in the app's page: its files under /acc-app/, and the bridge first in <head>. */
export function rewritePage(html) {
  let out = html.replace(/(<(?:script|link)\b[^>]*\b(?:src|href)=")\/(assets\/|favicon)/gi, `$1${PREFIX}/$2`);
  out = out.replace(/<head[^>]*>/i, (m) => `${m}\n<script src="/accapp-bridge.js"></script>`);
  return out;
}

/* What the ERP changes in the app's script: its API, written as "/api" or "/api/…", goes through /acc-app/api. Not another host's /api (…googleapis.com/maps/api/js). */
export function rewriteScript(js) {
  return js.replace(/(["'`])\/api(?=[/"'`?])/g, `$1${PREFIX}/api`);
}

const upstream = (path, init = {}) =>
  fetch(config.accounts.appUrl + path, { ...init, redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });

/* The copies held: path → { at, etag, status, type, body }. The page (and the SPA's deep links) under '/'; the scripts rewritten as held. */
const held = new Map();
export const forgetHeld = () => held.clear();

const isAsset = (p) => /\.[a-z0-9]{1,8}$/i.test(p);

async function fileOf(pathname) {
  const key = isAsset(pathname) ? pathname : '/';
  const have = held.get(key);
  if (have && Date.now() - have.at < HOLD.ms) return have;
  try {
    const headers = have?.etag ? { 'If-None-Match': have.etag } : {};
    const r = await upstream(key, { headers });
    if (r.status === 304 && have) {
      have.at = Date.now();
      return have;
    }
    const type = r.headers.get('content-type') || 'application/octet-stream';
    let body = Buffer.from(await r.arrayBuffer());
    if (r.ok && /text\/html/i.test(type)) body = Buffer.from(rewritePage(body.toString('utf8')), 'utf8');
    else if (r.ok && /javascript/i.test(type)) body = Buffer.from(rewriteScript(body.toString('utf8')), 'utf8');
    const entry = { at: Date.now(), etag: r.headers.get('etag'), status: r.status, type, body };
    if (r.ok) held.set(key, entry);
    return entry;
  } catch (err) {
    if (have) return { ...have, stale: true };
    throw err;
  }
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('The request is too large for the accounts app'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

/* The browser's cookies for the accounts app: every one but the ERP's own session. */
export function accountsCookies(header) {
  return String(header || '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith(`${ERP_COOKIE}=`))
    .join('; ');
}

/* The app's Set-Cookie, for this origin: no Domain, for the whole site, Secure only where the ERP is. */
export function rewriteSetCookie(value, { secure = config.production } = {}) {
  const parts = value.split(';').map((s) => s.trim()).filter(Boolean);
  const [pair, ...attrs] = parts;
  const kept = attrs.filter((a) => !/^(domain|path|secure)\b/i.test(a));
  kept.push('Path=/');
  if (secure) kept.push('Secure');
  return [pair, ...kept].join('; ');
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* A call passed on as it came — method, query, body, the accounts cookie — and its answer, cookies included. */
async function passOn(req, res, path) {
  const headers = {};
  for (const h of ['content-type', 'accept', 'accept-language', 'range']) if (req.get(h)) headers[h] = req.get(h);
  const cookie = accountsCookies(req.get('cookie'));
  if (cookie) headers.cookie = cookie;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
  let r;
  try {
    r = await upstream(path, { method: req.method, headers, body });
  } catch {
    return res.status(502).json({ error: 'The accounts app did not answer' });
  }
  res.status(r.status);
  for (const h of ['content-type', 'content-disposition', 'content-range', 'accept-ranges']) if (r.headers.get(h)) res.set(h, r.headers.get(h));
  res.set('Cache-Control', path.startsWith('/uploads/') ? 'private, max-age=86400' : 'no-store');
  const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (cookies.length) res.set('Set-Cookie', cookies.map((c) => rewriteSetCookie(c)));
  res.send(Buffer.from(await r.arrayBuffer()));
}

export function mountAccountsApp(app, need) {
  const configured = (req, res, next) =>
    config.accounts.appUrl ? next() : res.status(404).json({ error: 'The accounts app is not set up here (ACCOUNTS_APP_URL)' });

  const sameOrigin = (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    let from = '';
    try {
      from = new URL(req.get('Origin') || req.get('Referer') || '').host;
    } catch {
      from = '';
    }
    if (!from || from !== req.get('Host')) return res.status(403).json({ error: 'Refused: not sent by masterapp' });
    next();
  };

  const sendPage = async (req, res) => {
    let file;
    try {
      file = await fileOf('/');
    } catch {
      res.set('Cache-Control', 'no-store');
      return res.status(502).type('html').send(
        '<!doctype html><meta charset="utf-8"><title>Accounts</title><body style="font:15px/1.5 system-ui;padding:24px;color:#1d1b18">' +
          '<p>The accounts app did not answer. Try again in a moment.</p>'
      );
    }
    res.set('Cache-Control', 'no-store');
    res.set('Content-Security-Policy', appPolicy());
    res.set('X-Frame-Options', 'SAMEORIGIN');
    if (file.stale) res.set('X-Masterapp-Stale', '1');
    res.status(file.status).type(file.type).send(file.body);
  };

  app.get(`${PREFIX}`, (req, res, next) => (req.path === PREFIX ? res.redirect(`${PREFIX}/`) : next()));

  /* The app's API, and its uploads, passed on as they are. */
  app.all(`${PREFIX}/api/{*rest}`, configured, need('editor'), sameOrigin, wrap((req, res) => passOn(req, res, req.originalUrl.slice(PREFIX.length))));
  app.get(`${PREFIX}/uploads/{*rest}`, configured, need('editor'), wrap((req, res) => passOn(req, res, req.originalUrl.slice(PREFIX.length))));
  app.get('/uploads/{*rest}', configured, need('editor'), wrap((req, res) => passOn(req, res, req.originalUrl)));

  /* The page, its scripts and styles, and the app's own deep links (its router's addresses are all the page). */
  app.get(
    `${PREFIX}/{*rest}`,
    configured,
    need('editor'),
    wrap(async (req, res) => {
      const pathname = '/' + req.path.slice(PREFIX.length + 1);
      if (!isAsset(pathname)) return sendPage(req, res);
      let file;
      try {
        file = await fileOf(pathname);
      } catch {
        return res.status(502).json({ error: 'The accounts app did not answer' });
      }
      // Its files are named by their fingerprint (index-Dlk5CG7T.js): kept for a day.
      res.set('Cache-Control', /^\/assets\//.test(pathname) ? 'private, max-age=86400' : 'no-store');
      if (file.stale) res.set('X-Masterapp-Stale', '1');
      res.status(file.status).type(file.type).send(file.body);
    })
  );

  /* A frame asking for one of the app's routes at the ERP's root (its router put it there): the app's page, never the console. */
  app.get(/^\/(?!api\/|lg-app|acc-app|uploads\/|healthz)[^.]*$/, (req, res, next) => {
    if (!config.accounts.appUrl || req.get('sec-fetch-dest') !== 'iframe') return next();
    return need('editor')(req, res, () => sendPage(req, res));
  });
}
