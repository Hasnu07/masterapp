import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config, ROOT } from '../config.js';
import * as auth from '../auth/index.js';
import * as watches from '../watches/index.js';
import * as rates from '../rates/index.js';
import * as clients from '../clients/index.js';
import * as expenses from '../expenses/index.js';
import * as logistics from '../logistics/index.js';
import * as lgClients from '../logistics/clients.js';
import { FIELDS, STATUSES, LOCATIONS, CURRENCIES, PAYMENT_KINDS } from '../watches/fields.js';
import { query } from '../db/index.js';
import { importProductCsv } from '../import/listimport.js';
import { startJob, running, runJob } from '../import/jobs.js';

const PUBLIC = path.join(ROOT, 'src', 'web', 'public');

/* Uploads are held in memory only long enough to store them. */
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1 } });
const UPLOAD_REFUSED = {
  LIMIT_FILE_SIZE: 'A file is too large',
  LIMIT_FILE_COUNT: 'Too many files at once',
  LIMIT_UNEXPECTED_FILE: 'Too many files at once',
};

const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      // A mangled cookie is no session — not an error on every page until it is cleared.
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/*
 * The console's build: one fingerprint of its files, taken at start-up.
 *
 * Reported 24 Oct 2026: after a deploy, a tab showed the new Overview's
 * script on the old page — no styles for any of it. A page open across a
 * deploy (or loaded while the old and new copies both answered) mixes the
 * two, and the platform stamps every file 1 Jan 1980, so neither the date nor
 * express's size-and-date ETag tells one version from the next (a fix that
 * kept a file's size would never have reached a browser). So: the page asks
 * for its scripts by this fingerprint (/app.js?v=…), kept for good under it;
 * the page itself is never kept; and every API answer carries it, so a page
 * left open sees a newer one and offers to reload.
 */
const CONSOLE_SCRIPTS = ['app.js', 'logistics.js', 'fxchip.js'];
function consolePage() {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const hash = crypto.createHash('sha256').update(html);
  for (const f of CONSOLE_SCRIPTS) hash.update(fs.readFileSync(path.join(PUBLIC, f)));
  const build = hash.digest('hex').slice(0, 12);
  let page = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta name="build" content="${build}">`);
  for (const f of CONSOLE_SCRIPTS) page = page.replace(`<script src="/${f}">`, `<script src="/${f}?v=${build}">`);
  return { build, page };
}

/*
 * The console page's own policy: scripts only from here, so a value that ever
 * slipped past esc() still cannot run. Styles inline (the page has its own
 * <style> and style="" attributes) and Google's fonts. Only on the page: a
 * payment copy's PDF opens on its own, and a policy there can stop the
 * browser's PDF viewer.
 */
const PAGE_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/*
 * Failed sign-ins, over the last ten minutes:
 *  - ten from one address, and that address waits;
 *  - per account, counted at each address — never one count for the whole
 *    account. A whole-account count let anybody who knew an email (the
 *    admin's) keep its owner out, right password and all, with ten wrong ones
 *    every ten minutes. While an account is failing from everywhere (ten or
 *    more in all) each address gets three tries at it instead of ten: guessing
 *    from many addresses is slowed, and the owner, from their own, still gets in.
 *
 * An attempt is counted BEFORE its password is checked, and handed back when
 * it signs in. Counted after, a burst sent at once all got past the limit
 * while the first ten passwords were still being checked.
 *
 * The address: on App Platform x-forwarded-for carries DigitalOcean's ingress,
 * not the person (DigitalOcean's docs), so req.ip was the same for everybody
 * and ten wrong passwords from anyone locked everyone out. The person's
 * address is in do-connecting-ip.
 */
const attempts = new Map();
const MAX_KEYS = 20_000;
const clientAddress = (req) => (config.production && req.get('do-connecting-ip')) || req.ip;
// Kept as a short hash: an email can be any length, and its key is held for ten minutes.
// JSON, not a separator: an email with a newline in it must not pass for an (account, address) pair.
const keyOf = (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('base64url');
function recent(key, now) {
  const list = (attempts.get(key) || []).filter((t) => now - t < 10 * 60_000);
  // Moved to the back: the front of the map is what was touched longest ago.
  attempts.delete(key);
  if (list.length) attempts.set(key, list);
  return list;
}

/** Counts a sign-in attempt, or returns null when it is over a limit. */
export function reserveAttempt(address, email) {
  const now = Date.now();
  const at = keyOf('address', address);
  const account = keyOf('account', email);
  const here = keyOf('account', email, address);
  if (recent(at, now).length >= 10) return null;
  const failingEverywhere = recent(account, now).length >= 10;
  if (recent(here, now).length >= (failingEverywhere ? 3 : 10)) return null;
  const keys = [at, account, here];
  // Only the newest ten matter: no limit is higher.
  for (const k of keys) attempts.set(k, [...recent(k, now), now].slice(-10));
  // Bounded whatever is sent: the keys touched longest ago go first.
  for (const k of attempts.keys()) {
    if (attempts.size <= MAX_KEYS) break;
    attempts.delete(k);
  }
  return { keys, now };
}

/** A sign-in that went through is not a failure. */
function giveBackAttempt({ keys, now }) {
  for (const k of keys) {
    const list = attempts.get(k) || [];
    const i = list.lastIndexOf(now);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) attempts.delete(k);
  }
}

/* For the tests: what the limit is holding. */
export const attemptKeys = () => [...attempts.keys()];

export function createServer() {
  const CONSOLE = consolePage();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    // Served over https only (App Platform): the browser is told never to try http.
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  /* Who is asking — on every request, so a disabled account stops at once. */
  app.use(
    wrap(async (req, res, next) => {
      req.user = await auth.userForToken(cookieOf(req, auth.COOKIE));
      next();
    })
  );

  /*
   * A write must come from our own page. The session cookie is SameSite=Lax,
   * and on top of that every non-GET API call carries a header a form on
   * another site cannot send.
   */
  app.use('/api', (req, res, next) => {
    res.set('X-Masterapp-Build', CONSOLE.build);
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.get('X-Requested-With') !== 'masterapp') {
      return res.status(403).json({ error: 'Refused: not sent by masterapp' });
    }
    next();
  });

  const need = (role) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in' });
    if (!auth.can(req.user, role)) return res.status(403).json({ error: `This needs the ${role} role` });
    next();
  };

  /* ── sign-in ─────────────────────────────────────────────────── */

  app.post(
    '/api/login',
    wrap(async (req, res) => {
      const held = reserveAttempt(clientAddress(req), String(req.body?.email || '').trim().toLowerCase());
      if (!held) return res.status(429).json({ error: 'Too many attempts — wait ten minutes' });
      let r = null;
      let wrong = false;
      try {
        r = await auth.signIn(req.body?.email, req.body?.password);
        wrong = !r;
      } finally {
        // Kept only for a wrong password — not for one that signed in, nor a check that broke.
        if (!wrong) giveBackAttempt(held);
      }
      if (wrong) return res.status(401).json({ error: 'Wrong email or password' });
      res.cookie(auth.COOKIE, r.token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.production,
        maxAge: 30 * 86400_000,
        path: '/',
      });
      res.json({ user: r.user });
    })
  );

  app.post(
    '/api/logout',
    wrap(async (req, res) => {
      await auth.signOut(cookieOf(req, auth.COOKIE));
      res.clearCookie(auth.COOKIE, { path: '/' });
      res.json({ ok: true });
    })
  );

  app.get('/api/me', (req, res) => res.json({ user: req.user || null }));

  /* ── what the page builds itself from ────────────────────────── */

  app.get('/api/meta', need('viewer'), (req, res) => {
    res.json({
      fields: FIELDS,
      statuses: STATUSES,
      locations: LOCATIONS,
      currencies: CURRENCIES,
      paymentKinds: PAYMENT_KINDS,
      clientFields: clients.CLIENT_FIELDS,
      clientTypes: clients.CLIENT_TYPES,
      expenseFields: expenses.EXPENSE_FIELDS,
      logistics: logistics.catalog(),
      storage: config.r2.configured ? 'r2' : 'disk',
      sync: {
        enabled: config.sync.enabled,
        chronokey: config.chronokey.configured,
        vault: config.vault.configured && Boolean(config.vault.token),
        logistics: config.logistics.enabled && config.vault.configured && Boolean(config.vault.token),
      },
    });
  });

  /* ── watches ─────────────────────────────────────────────────── */

  app.get(
    '/api/watches',
    need('viewer'),
    wrap(async (req, res) => {
      res.json(
        await watches.listWatches({
          q: req.query.q,
          status: req.query.status,
          location: req.query.location,
          brand: req.query.brand,
          sort: req.query.sort,
          limit: req.query.limit,
          offset: req.query.offset,
          deleted: req.query.deleted === '1',
        })
      );
    })
  );

  app.post(
    '/api/watches',
    need('editor'),
    wrap(async (req, res) => {
      try {
        const id = await watches.createWatch(req.body || {}, req.user);
        res.status(201).json({ id });
      } catch (err) {
        if (err.code === '23505') {
          throw Object.assign(new Error('A watch with that stock number already exists (it may be deleted — restore it instead)'), {
            status: 409,
          });
        }
        throw err;
      }
    })
  );

  app.get(
    '/api/watches/:id',
    need('viewer'),
    wrap(async (req, res) => {
      const w = await watches.getWatch(req.params.id);
      res.json({ ...w, clients: await clients.linksOf(w) });
    })
  );

  /* Who a watch was bought from / sold to: { role: purchase|sale, client_id: n | null | "chronokey" }. */
  app.put(
    '/api/watches/:id/client',
    need('editor'),
    wrap(async (req, res) => {
      const { role, client_id: id } = req.body || {};
      res.json(await clients.linkWatch(req.params.id, role, id === 'chronokey' || id === null ? id : Number(id), req.user));
    })
  );

  /* ── expenses ────────────────────────────────────────────────── */

  app.get('/api/expenses', need('viewer'), wrap(async (req, res) => res.json(await expenses.listExpenses(req.query))));
  app.get('/api/expenses/types', need('viewer'), wrap(async (req, res) => res.json({ types: await expenses.expenseTypes() })));
  app.get('/api/expenses/:id', need('viewer'), wrap(async (req, res) => res.json(await expenses.getExpense(req.params.id))));
  app.post(
    '/api/expenses',
    need('editor'),
    wrap(async (req, res) => res.status(201).json({ id: await expenses.createExpense(req.body || {}, req.user) }))
  );
  app.patch(
    '/api/expenses/:id',
    need('editor'),
    wrap(async (req, res) => res.json(await expenses.updateExpense(req.params.id, req.body || {}, req.user)))
  );
  app.delete(
    '/api/expenses/:id',
    need('editor'),
    wrap(async (req, res) => {
      await expenses.deleteExpense(req.params.id, req.user);
      res.json({ ok: true });
    })
  );
  app.post(
    '/api/expenses/:id/restore',
    need('editor'),
    wrap(async (req, res) => {
      await expenses.deleteExpense(req.params.id, req.user, { restore: true });
      res.json({ ok: true });
    })
  );
  /* Payment copies: pictures or PDFs. */
  app.post(
    '/api/expenses/:id/files',
    need('editor'),
    photoUpload.array('files', expenses.MAX_FILES),
    wrap(async (req, res) => {
      const files = (req.files || []).map((f) => ({ buffer: f.buffer, name: f.originalname }));
      if (!files.length) return res.status(400).json({ error: 'No file was sent' });
      res.status(201).json({ ids: await expenses.addFiles(req.params.id, files, req.user) });
    })
  );
  app.delete(
    '/api/expenses/:id/files/:fid',
    need('editor'),
    wrap(async (req, res) => {
      await expenses.removeFile(req.params.id, req.params.fid, req.user);
      res.json({ ok: true });
    })
  );
  /* Behind the sign-in, like the photos: a payment copy carries account numbers. */
  app.get(
    '/api/expense-files/:fid',
    need('viewer'),
    wrap(async (req, res) => {
      const f = await expenses.expenseFile(req.params.fid, { thumb: req.query.thumb === '1' });
      if (!f) return res.status(404).json({ error: 'No such payment copy' });
      res.set('Content-Type', f.type);
      res.set('Cache-Control', 'private, max-age=604800, immutable');
      res.set('X-Content-Type-Options', 'nosniff');
      const name = (f.name || `payment-copy-${Number(req.params.fid)}`).replace(/[^\w.\- ]+/g, '_');
      res.set('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename="${name}"`);
      res.send(f.buffer);
    })
  );

  /* ── clients ─────────────────────────────────────────────────── */

  app.get(
    '/api/clients',
    need('viewer'),
    wrap(async (req, res) => res.json(await clients.listClients(req.query)))
  );
  app.get('/api/clients/:id', need('viewer'), wrap(async (req, res) => res.json(await clients.getClient(req.params.id))));
  app.post(
    '/api/clients',
    need('editor'),
    wrap(async (req, res) => res.status(201).json({ id: await clients.createClient(req.body || {}, req.user) }))
  );
  app.patch(
    '/api/clients/:id',
    need('editor'),
    wrap(async (req, res) => res.json(await clients.updateClient(req.params.id, req.body || {}, req.user)))
  );

  app.get(
    '/api/watches/:id/related',
    need('viewer'),
    wrap(async (req, res) => {
      // The same physical watch, bought and sold on other occasions.
      const { rows } = await query(
        `SELECT o.id, o.stock_no, o.status, o.purchase_date, o.sale_date
           FROM watches w JOIN watches o ON o.ck_product_id = w.ck_product_id AND o.id <> w.id
          WHERE w.id = $1 AND w.ck_product_id IS NOT NULL AND o.deleted_at IS NULL
          ORDER BY o.purchase_date NULLS LAST`,
        [Number(req.params.id) || 0]
      );
      res.json({ related: rows });
    })
  );

  /* Rates for the blue ▾ converter beside every price (public/fxchip.js). */
  app.get(
    '/api/rates',
    need('viewer'),
    wrap(async (req, res) => {
      try {
        const r = await rates.getRates();
        res.json({
          base: 'USD',
          rates: r.rates,
          currencies: rates.CURRENCIES,
          sourceName: r.sourceName,
          kind: r.kind, // "live" or "daily" — printed, so a daily fix is never read as live
          cachedAt: r.cachedAt,
          stale: r.stale,
        });
      } catch (err) {
        res.status(502).json({ error: err.message });
      }
    })
  );

  app.get(
    '/api/watches/:id/sold-for',
    need('viewer'),
    wrap(async (req, res) => res.json(await watches.soldFor(req.params.id)))
  );

  app.patch(
    '/api/watches/:id',
    need('editor'),
    wrap(async (req, res) => {
      try {
        res.json(await watches.updateWatch(req.params.id, req.body || {}, req.user));
      } catch (err) {
        if (err.code === '23505') throw Object.assign(new Error('Another watch already has that stock number'), { status: 409 });
        throw err;
      }
    })
  );

  app.delete(
    '/api/watches/:id',
    need('editor'),
    wrap(async (req, res) => {
      await watches.deleteWatch(req.params.id, req.user);
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/watches/:id/restore',
    need('editor'),
    wrap(async (req, res) => {
      await watches.restoreWatch(req.params.id, req.user);
      res.json({ ok: true });
    })
  );

  app.post(
    '/api/watches/:id/unlock',
    need('editor'),
    wrap(async (req, res) => {
      await watches.unlockField(req.params.id, req.body?.field, req.user);
      res.json({ ok: true });
    })
  );

  app.get(
    '/api/watches/:id/events',
    need('viewer'),
    wrap(async (req, res) => res.json({ events: await watches.watchEvents(req.params.id) }))
  );

  app.post(
    '/api/watches/:id/photos',
    need('editor'),
    photoUpload.array('photos', 20),
    wrap(async (req, res) => {
      const files = (req.files || []).map((f) => ({ buffer: f.buffer, name: f.originalname }));
      if (!files.length) return res.status(400).json({ error: 'No photos were sent' });
      const ids = await watches.addPhotos(req.params.id, files, req.user);
      res.status(201).json({ ids });
    })
  );

  app.post(
    '/api/watches/:id/photos/order',
    need('editor'),
    wrap(async (req, res) => {
      await watches.orderPhotos(req.params.id, req.body?.ids, req.user);
      res.json({ ok: true });
    })
  );

  app.patch(
    '/api/watches/:id/photos/:pid',
    need('editor'),
    wrap(async (req, res) => {
      await watches.captionPhoto(req.params.id, req.params.pid, req.body?.caption, req.user);
      res.json({ ok: true });
    })
  );

  app.delete(
    '/api/watches/:id/photos/:pid',
    need('editor'),
    wrap(async (req, res) => {
      await watches.removePhoto(req.params.id, req.params.pid, req.user);
      res.json({ ok: true });
    })
  );

  /* Photos are behind the sign-in: a watch's papers and serial are in them. */
  app.get(
    '/api/photos/:pid',
    need('viewer'),
    wrap(async (req, res) => {
      const f = await watches.photoFile(req.params.pid, { thumb: req.query.thumb === '1' });
      if (!f) return res.status(404).json({ error: 'No such photo' });
      res.set('Content-Type', f.type);
      // A stored photo never changes under its id.
      res.set('Cache-Control', 'private, max-age=604800, immutable');
      if (req.query.download === '1') res.attachment(`photo-${Number(req.params.pid)}.${f.type.split('/')[1]}`);
      res.send(f.buffer);
    })
  );

  /* ── logistics ───────────────────────────────────────────────── */

  app.get('/api/logistics/overview', need('viewer'), wrap(async (req, res) => res.json(await logistics.overview())));
  app.get('/api/logistics/in-safe', need('viewer'), wrap(async (req, res) => res.json(await logistics.inSafe())));
  app.get('/api/logistics/checked-out', need('viewer'), wrap(async (req, res) => res.json(await logistics.checkedOut())));
  /* Search everything: our watches and clients, and the logistics records — nothing twice. */
  app.get(
    '/api/logistics/search',
    need('viewer'),
    wrap(async (req, res) => res.json(await logistics.search({ q: String(req.query.q || '').slice(0, 200), scope: String(req.query.scope || 'all') })))
  );
  app.post(
    '/api/logistics/items/:id/polish',
    need('editor'),
    wrap(async (req, res) => res.json(await logistics.polishAction(req.params.id, req.body || {}, req.user)))
  );
  app.get('/api/logistics/clients', need('viewer'), wrap(async (req, res) => res.json({ clients: await logistics.clientChoices() })));
  app.get('/api/logistics/items', need('viewer'), wrap(async (req, res) => res.json(await logistics.listItems(req.query))));
  app.get('/api/logistics/items/:id', need('viewer'), wrap(async (req, res) => res.json(await logistics.getItem(req.params.id))));
  app.get(
    '/api/logistics/items/:id/events',
    need('viewer'),
    wrap(async (req, res) => res.json({ events: await logistics.itemEvents(req.params.id) }))
  );
  app.post(
    '/api/logistics/items',
    need('editor'),
    wrap(async (req, res) => res.status(201).json({ id: await logistics.createItem(String(req.body?.kind || ''), req.body?.data || {}, req.user) }))
  );

  // A client's logistics situation: the Logistics → Clients tab, one logistics client, and who of ours it is.
  app.get('/api/logistics/client-list', need('viewer'), wrap(async (req, res) => res.json(await lgClients.listLogisticsClients({ q: String(req.query.q || '') }))));
  app.get('/api/logistics/client-view/:id', need('viewer'), wrap(async (req, res) => res.json(await lgClients.logisticsClient(req.params.id))));
  app.put(
    '/api/logistics/client-view/:id/link',
    need('editor'),
    wrap(async (req, res) => {
      const v = req.body?.client_id;
      if (!(v === null || v === 'auto' || (Number.isInteger(v) && v > 0))) return res.status(400).json({ error: 'client_id must be one of our clients, null (none of ours) or "auto"' });
      res.json({ link: await lgClients.setClientLink(req.params.id, v, req.user) });
    })
  );
  app.get('/api/clients/:id/logistics', need('viewer'), wrap(async (req, res) => res.json(await lgClients.forOurClient(req.params.id))));
  app.patch(
    '/api/logistics/items/:id',
    need('editor'),
    wrap(async (req, res) => res.json(await logistics.updateItem(req.params.id, req.body || {}, req.user)))
  );
  app.post(
    '/api/logistics/items/:id/unlock',
    need('editor'),
    wrap(async (req, res) => {
      await logistics.unlockField(req.params.id, String(req.body?.field || ''), req.user);
      res.json({ ok: true });
    })
  );
  app.delete(
    '/api/logistics/items/:id',
    need('editor'),
    wrap(async (req, res) => {
      await logistics.deleteItem(req.params.id, req.user);
      res.json({ ok: true });
    })
  );
  app.post(
    '/api/logistics/items/:id/restore',
    need('editor'),
    wrap(async (req, res) => {
      await logistics.deleteItem(req.params.id, req.user, { restore: true });
      res.json({ ok: true });
    })
  );
  /* Behind the sign-in: customs papers, passports and serials are in these. */
  app.get(
    '/api/logistics/files/:fid',
    need('viewer'),
    wrap(async (req, res) => {
      const f = await logistics.file(req.params.fid, { thumb: req.query.thumb === '1' });
      if (!f) return res.status(404).json({ error: 'No such file' });
      res.set('Content-Type', f.type);
      res.set('Cache-Control', 'private, max-age=604800, immutable');
      res.set('X-Content-Type-Options', 'nosniff');
      if (req.query.download === '1') res.attachment(`logistics-${Number(req.params.fid)}.${f.type.split('/')[1]}`);
      res.send(f.buffer);
    })
  );
  /* A picture still on the logistics app's worker: copied here on first sight, then served like the rest. */
  app.get(
    '/api/logistics/worker-file',
    need('viewer'),
    wrap(async (req, res) => {
      const f = await logistics.workerFile(String(req.query.u || ''), { thumb: req.query.thumb === '1' });
      if (!f) return res.status(404).json({ error: 'No such file' });
      res.set('Content-Type', f.type);
      res.set('Cache-Control', 'private, max-age=604800, immutable');
      res.set('X-Content-Type-Options', 'nosniff');
      res.send(f.buffer);
    })
  );
  app.get('/api/watches/:id/logistics', need('viewer'), wrap(async (req, res) => res.json(await logistics.forWatch(req.params.id))));

  /* ── import ──────────────────────────────────────────────────── */

  app.get(
    '/api/import/status',
    need('viewer'),
    wrap(async (req, res) => {
      const [runs, counts] = await Promise.all([
        query(
          `SELECT r.*, u.name AS user_name FROM import_runs r LEFT JOIN users u ON u.id = r.started_by
            ORDER BY r.started_at DESC LIMIT 30`
        ),
        query(`SELECT
                 (SELECT count(*)::int FROM watches WHERE deleted_at IS NULL) AS watches,
                 (SELECT count(*)::int FROM ck_records) AS ck_records,
                 (SELECT count(*)::int FROM ck_records WHERE detail_at IS NOT NULL AND error IS NULL) AS ck_details,
                 (SELECT count(*)::int FROM ck_records WHERE error IS NOT NULL) AS ck_errors,
                 (SELECT count(*)::int FROM vault_records) AS vault_records,
                 (SELECT count(*)::int FROM logistics_items WHERE deleted_at IS NULL) AS logistics_items,
                 (SELECT count(*)::int FROM watch_photos WHERE deleted_at IS NULL) AS photos,
                 (SELECT count(*)::int FROM watches WHERE deleted_at IS NULL AND purchase_price > 0
                     AND purchase_currency = '') AS currency_not_stated`),
      ]);
      res.json({
        running: running(),
        runs: runs.rows,
        counts: counts.rows[0],
        configured: {
          chronokey: config.chronokey.configured,
          vault: config.vault.configured && Boolean(config.vault.token),
          sync: config.sync.enabled,
          logistics: config.logistics.enabled,
        },
      });
    })
  );

  /*
   * SYNC=off is the switch-over: masterapp is the master, and a click on the
   * Import page must not copy Chrono Key over it either. (The command line,
   * `npm run import`, still can — deliberately.)
   */
  const syncOn = (req, res, next) => {
    // The logistics app has its own switch (LOGISTICS_SYNC): its switch-over need not be Chrono Key's.
    if (req.body?.job === 'logistics') {
      return config.logistics.enabled
        ? next()
        : res.status(409).json({ error: 'Logistics sync is off (LOGISTICS_SYNC=off): masterapp is the master for logistics' });
    }
    return config.sync.enabled
      ? next()
      : res.status(409).json({ error: 'Sync is off (SYNC=off): masterapp is the master — nothing is copied from Chrono Key or the vault' });
  };

  app.post(
    '/api/import/csv',
    need('admin'),
    syncOn,
    csvUpload.single('file'),
    wrap(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file was sent' });
      // Under the same lock as every other import (409 while one runs, here or in
      // another process), so the 15-minute sync cannot start in the middle of it.
      const stats = await runJob('csv upload', () => importProductCsv(req.file.buffer.toString('utf8'), { user: req.user }));
      res.json({ stats });
    })
  );

  app.post(
    '/api/import/run',
    need('admin'),
    syncOn,
    wrap(async (req, res) => {
      const job = String(req.body?.job || '');
      if (job.startsWith('chronokey') && !config.chronokey.configured) {
        return res.status(400).json({ error: 'Chrono Key is not configured — set CHRONOKEY_USERNAME and CHRONOKEY_PASSWORD' });
      }
      if ((job === 'vault' || job === 'logistics') && !(config.vault.configured && config.vault.token)) {
        return res.status(400).json({ error: 'The Watch vault needs its key — set VAULT_TOKEN' });
      }
      startJob(job, req.user);
      res.status(202).json({ started: job });
    })
  );

  /* ── accounts ────────────────────────────────────────────────── */

  app.get('/api/users', need('admin'), wrap(async (req, res) => res.json({ users: await auth.listUsers() })));

  app.post(
    '/api/users',
    need('admin'),
    wrap(async (req, res) => res.status(201).json({ user: await auth.createUser(req.body || {}) }))
  );

  app.patch(
    '/api/users/:id',
    need('admin'),
    wrap(async (req, res) => {
      const id = Number(req.params.id) || 0;
      // Nobody locks themselves out of their own admin account by accident.
      if (id === req.user.id && (req.body?.disabled || (req.body?.role && req.body.role !== 'admin'))) {
        return res.status(400).json({ error: 'You cannot disable or demote your own account' });
      }
      const u = await auth.updateUser(id, req.body || {});
      if (!u) return res.status(404).json({ error: 'No such account, or nothing to change' });
      res.json({ user: u });
    })
  );

  app.use('/api', (req, res) => res.status(404).json({ error: 'No such endpoint' }));

  /* ── the page ────────────────────────────────────────────────── */

  const page = (res) => res.set('Content-Security-Policy', PAGE_POLICY);
  const sendPage = (req, res) => {
    res.set('Cache-Control', 'no-store');
    page(res);
    res.type('html').send(CONSOLE.page);
  };
  app.get(['/', '/index.html'], sendPage);
  // A script asked for by this build's fingerprint is kept for good; anything else is fetched again every time
  // — no date or size-based ETag to answer "not modified" with an old copy.
  app.use(
    express.static(PUBLIC, {
      index: false,
      etag: false,
      lastModified: false,
      setHeaders: (res) => res.set('Cache-Control', res.req.query.v === CONSOLE.build ? 'public, max-age=31536000, immutable' : 'no-cache'),
    })
  );
  app.get('/{*page}', sendPage);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // An upload over the limits (too large, too many files at once) is the sender's mistake, not a crash.
    if (err instanceof multer.MulterError) {
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: UPLOAD_REFUSED[err.code] || err.message });
    }
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && config.production ? 'Something went wrong on the server' : err.message });
  });

  return app;
}
