import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config, ROOT } from '../config.js';
import * as auth from '../auth/index.js';
import * as watches from '../watches/index.js';
import { FIELDS, STATUSES, LOCATIONS, CURRENCIES, PAYMENT_KINDS } from '../watches/fields.js';
import { query } from '../db/index.js';
import { importProductCsv } from '../import/listimport.js';
import { startJob, running } from '../import/jobs.js';

const PUBLIC = path.join(ROOT, 'src', 'web', 'public');

/* Uploads are held in memory only long enough to store them. */
const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 20 } });
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024, files: 1 } });

const cookieOf = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
};

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/* Sign-in attempts per address: ten in ten minutes. */
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  attempts.set(ip, list);
  return list.length >= 10;
}

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '1mb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
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
      if (tooMany(req.ip)) return res.status(429).json({ error: 'Too many attempts — wait ten minutes' });
      const r = await auth.signIn(req.body?.email, req.body?.password);
      if (!r) {
        attempts.get(req.ip).push(Date.now());
        return res.status(401).json({ error: 'Wrong email or password' });
      }
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
      storage: config.r2.configured ? 'r2' : 'disk',
      sync: {
        enabled: config.sync.enabled,
        chronokey: config.chronokey.configured,
        vault: config.vault.configured && Boolean(config.vault.token),
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

  app.get('/api/watches/:id', need('viewer'), wrap(async (req, res) => res.json(await watches.getWatch(req.params.id))));

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
                 (SELECT count(*)::int FROM watch_photos WHERE deleted_at IS NULL) AS photos,
                 (SELECT count(*)::int FROM watches WHERE deleted_at IS NULL AND purchase_price IS NOT NULL
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
        },
      });
    })
  );

  app.post(
    '/api/import/csv',
    need('admin'),
    csvUpload.single('file'),
    wrap(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'No file was sent' });
      if (running()) return res.status(409).json({ error: `An import is already running (${running().name})` });
      res.json({ stats: await importProductCsv(req.file.buffer.toString('utf8'), { user: req.user }) });
    })
  );

  app.post(
    '/api/import/run',
    need('admin'),
    wrap(async (req, res) => {
      const job = String(req.body?.job || '');
      if (job.startsWith('chronokey') && !config.chronokey.configured) {
        return res.status(400).json({ error: 'Chrono Key is not configured — set CHRONOKEY_USERNAME and CHRONOKEY_PASSWORD' });
      }
      if (job === 'vault' && !(config.vault.configured && config.vault.token)) {
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

  app.use(express.static(PUBLIC, { index: false, maxAge: 0 }));
  app.get('/{*page}', (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUBLIC, 'index.html'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 && config.production ? 'Something went wrong on the server' : err.message });
  });

  return app;
}
