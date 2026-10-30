import { config } from '../config.js';

/*
 * The logistics app itself, inside the ERP (asked 30 Oct 2026: "put the whole
 * logistics app on the ERP, same how it already is … linked with my clients
 * and stock"). Its page is read from its own address (Vercel) and served here
 * at /lg-app/, behind the ERP's sign-in, so the Logistics menu shows the app
 * exactly as it is — with the ERP's bridge script (public/lgapp-bridge.js) put
 * first in its <head>, which links every stock number and client name it shows
 * to OUR watch and OUR client. Its data still lives on its worker: the app
 * saves there as before, and the ERP keeps copying it (both apps keep running,
 * decided the same day).
 *
 *  - The app calls its own Vercel functions root-relative (fetch('/api/claude'),
 *    /api/whatsapp, /api/dhl-track …). Those are rewritten to /lg-app/api/… and
 *    passed on to Vercel as they are — method, query, body — never the ERP's
 *    cookie. Its worker calls (CF_URL + '/api/state') are not touched.
 *  - A copy of each file is held HOLD.ms and then asked for again with its
 *    ETag, so the 2 MB page is not fetched on every visit; when Vercel does not
 *    answer, the copy held is served.
 *  - Editors only: the app has no roles of its own, and anyone who can load it
 *    can write to its records.
 */

export const HOLD = { ms: 60_000 };
const UPSTREAM_TIMEOUT_MS = 30_000;
const BODY_LIMIT = 30 * 1024 * 1024;

export const workerOrigin = () => {
  try {
    return new URL(config.vault.url).origin;
  } catch {
    return 'https://puro-sync.purosangue.workers.dev';
  }
};

/* The app's page runs inline scripts and talks to its worker, OpenAI, Anthropic and GitHub; it may only be framed by the ERP. */
export const appPolicy = () =>
  [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    `connect-src 'self' ${workerOrigin()} ${workerOrigin().replace(/^https?/, 'wss')} https://api.openai.com https://api.anthropic.com https://api.github.com https://nominatim.openstreetmap.org`,
    "frame-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
  ].join('; ');

/* What the ERP changes in the app's page before serving it. */
export function rewritePage(html, { bridge = true } = {}) {
  // Its own Vercel functions, through the ERP. Only a call written fetch('/api/…') — the worker's are CF_URL + '/api/…'.
  let out = html.replace(/fetch\((['"])\/api\//g, 'fetch($1/lg-app/api/');
  // The ERP's bridge, first in <head>, so it runs before the app's own scripts.
  if (bridge) out = out.replace(/<head[^>]*>/i, (m) => `${m}\n<script src="/lgapp-bridge.js"></script>`);
  return out;
}

const upstream = (path, init = {}) =>
  fetch(config.logistics.appUrl + path, { ...init, redirect: 'follow', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });

/* The copies held: path → { at, etag, status, type, body }. */
const held = new Map();
export const forgetHeld = () => held.clear();

async function fileOf(pathname) {
  const have = held.get(pathname);
  if (have && Date.now() - have.at < HOLD.ms) return have;
  try {
    const headers = have?.etag ? { 'If-None-Match': have.etag } : {};
    const r = await upstream(pathname, { headers });
    if (r.status === 304 && have) {
      have.at = Date.now();
      return have;
    }
    const entry = {
      at: Date.now(),
      etag: r.headers.get('etag'),
      status: r.status,
      type: r.headers.get('content-type') || 'application/octet-stream',
      body: Buffer.from(await r.arrayBuffer()),
    };
    if (r.ok) held.set(pathname, entry);
    return entry;
  } catch (err) {
    // Vercel did not answer: the copy held, if there is one, marked as such.
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
        reject(Object.assign(new Error('The request is too large for the logistics app'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function mountLogisticsApp(app, need) {
  const configured = (req, res, next) =>
    config.logistics.appUrl ? next() : res.status(404).json({ error: 'The logistics app is not set up here (LOGISTICS_APP_URL)' });

  /* A write to the app's functions must come from the ERP's own page — the cookie is SameSite=Lax, and the page's origin says so too. */
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

  // Express matches '/lg-app' with or without the slash: only the bare path is sent on, so the page's own address is not a loop.
  app.get('/lg-app', (req, res, next) => (req.path === '/lg-app' ? res.redirect('/lg-app/') : next()));

  /* The app's own Vercel functions, passed on as they are. */
  app.all(
    '/lg-app/api/{*rest}',
    configured,
    need('editor'),
    sameOrigin,
    wrap(async (req, res) => {
      const path = req.originalUrl.slice('/lg-app'.length);
      const headers = {};
      for (const h of ['content-type', 'accept']) if (req.get(h)) headers[h] = req.get(h);
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req);
      let r;
      try {
        r = await upstream(path, { method: req.method, headers, body });
      } catch {
        return res.status(502).json({ error: 'The logistics app did not answer' });
      }
      res.status(r.status);
      res.set('Cache-Control', 'no-store');
      if (r.headers.get('content-type')) res.type(r.headers.get('content-type'));
      res.send(Buffer.from(await r.arrayBuffer()));
    })
  );

  /* The page, and any file beside it (vault.html, manifest.json …). */
  app.get(
    '/lg-app/{*rest}',
    configured,
    need('editor'),
    wrap(async (req, res) => {
      const pathname = '/' + req.path.slice('/lg-app/'.length);
      let file;
      try {
        file = await fileOf(pathname);
      } catch {
        res.set('Cache-Control', 'no-store');
        return res.status(502).type('html').send(
          '<!doctype html><meta charset="utf-8"><title>Logistics</title><body style="font:15px/1.5 system-ui;padding:24px;color:#1d1b18">' +
            '<p>The logistics app did not answer. Try again in a moment.</p>'
        );
      }
      res.set('Cache-Control', 'no-store');
      res.set('Content-Security-Policy', appPolicy());
      res.set('X-Frame-Options', 'SAMEORIGIN');
      if (file.stale) res.set('X-Masterapp-Stale', '1');
      res.status(file.status);
      if (/text\/html/i.test(file.type)) return res.type('html').send(rewritePage(file.body.toString('utf8'), { bridge: pathname === '/' }));
      res.type(file.type);
      res.send(file.body);
    })
  );
}
