/*
 * GridCraft inside the ERP (asked 7 Nov 2026: "use storytold/gridcraft as the
 * sheet tool instead, with the same concept"). GridCraft is an open-source
 * Excel-style spreadsheet (Rust, MIT / Apache-2.0) that builds to
 * WebAssembly; its web build is served here at /gridcraft/ from
 * vendor/gridcraft (scripts/fetch-gridcraft.mjs fills it), behind the
 * sign-in, on our own origin — which is what its host mode needs:
 *
 *   /gridcraft/?host=parent&chrome=nofiletab&author=<name>, in an <iframe>
 *   on the sheet page. Same origin, so the app talks to the page over
 *   postMessage (its craft-web-host contract): "gridcraft:ready" once it
 *   listens → the page sends "gridcraft:open" {name, bytes} with the sheet's
 *   .xlsx → every Save or PDF export comes to the page as "gridcraft:save"
 *   {name, bytes} instead of a download → "gridcraft:dirty" {dirty}.
 *
 * Nothing of GridCraft is changed: the bundle is served as released. Its
 * page needs a policy of its own — WebAssembly ('wasm-unsafe-eval'), the
 * module script Trunk writes inline (allowed by its hash, computed at
 * start-up), WebGL/WebGPU on a canvas — and may be framed by our page only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import express from 'express';
import { ROOT } from '../config.js';

export const GRIDCRAFT_DIR = path.resolve(process.env.GRIDCRAFT_DIR || path.join(ROOT, 'vendor', 'gridcraft'));

export function gridcraftInstalled() {
  return fs.existsSync(path.join(GRIDCRAFT_DIR, 'index.html'));
}
export function gridcraftVersion() {
  try {
    return fs.readFileSync(path.join(GRIDCRAFT_DIR, 'VERSION'), 'utf8').split('\n')[0].trim();
  } catch {
    return '';
  }
}

/* The page as served, with the policy its inline scripts need: read once (production) or on each request (a PC). */
function page() {
  const html = fs.readFileSync(path.join(GRIDCRAFT_DIR, 'index.html'), 'utf8');
  const hashes = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/i.test(m[1])) continue;
    hashes.push(`'sha256-${crypto.createHash('sha256').update(m[2]).digest('base64')}'`);
  }
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${hashes.length ? ` ${hashes.join(' ')}` : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
  return { html, policy };
}

/*
 * The app is 25 MB of WebAssembly: a third of that with Brotli (its own
 * HOSTING.md asks for exactly this). Each big file is compressed once, in
 * the background after the first start, to <file>.br and <file>.gz beside
 * it (not committed: made again on a fresh server in a few seconds); a
 * request that accepts the encoding gets the small copy, the bytes otherwise
 * unchanged (the page checks them by their integrity hashes).
 */
const BIG = /\.(wasm|js)$/;
let compressing = null;
export function compressGridcraft({ log = () => {} } = {}) {
  if (compressing) return compressing;
  compressing = (async () => {
    if (!gridcraftInstalled()) return;
    for (const name of fs.readdirSync(GRIDCRAFT_DIR)) {
      const file = path.join(GRIDCRAFT_DIR, name);
      if (!BIG.test(name) || !fs.statSync(file).isFile() || fs.statSync(file).size < 64 * 1024) continue;
      for (const [ext, make] of [
        ['.br', (b) => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } })],
        ['.gz', (b) => zlib.gzipSync(b, { level: 6 })],
      ]) {
        const out = `${file}${ext}`;
        try {
          if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(file).mtimeMs) continue;
          const t = Date.now();
          const data = await new Promise((resolve) => setImmediate(() => resolve(make(fs.readFileSync(file)))));
          fs.writeFileSync(`${out}.tmp`, data);
          fs.renameSync(`${out}.tmp`, out);
          log(`[gridcraft] ${name}${ext}: ${(data.length / 1048576).toFixed(1)} MB in ${Date.now() - t} ms`);
        } catch (err) {
          log(`[gridcraft] could not write ${name}${ext}: ${err.message}`);
        }
      }
    }
  })().finally(() => {
    compressing = null;
  });
  return compressing;
}

const TYPES = { '.wasm': 'application/wasm', '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.ico': 'image/x-icon', '.css': 'text/css; charset=utf-8' };

export function mountGridcraft(app, need, { production = false, log = console.log } = {}) {
  let built = null;
  const current = () => (production ? (built ||= page()) : page());
  if (gridcraftInstalled()) setTimeout(() => compressGridcraft({ log }).catch(() => {}), 1500).unref?.();
  const send = (req, res) => {
    if (!gridcraftInstalled()) return res.status(404).type('text').send('GridCraft is not installed on this server: run `npm run gridcraft` (scripts/fetch-gridcraft.mjs).');
    const { html, policy } = current();
    res.set('Content-Security-Policy', policy);
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'same-origin');
    res.type('html').send(html);
  };
  app.get(['/gridcraft', '/gridcraft/', '/gridcraft/index.html'], need('viewer'), (req, res) => (req.path === '/gridcraft' ? res.redirect('/gridcraft/') : send(req, res)));
  /* A big file with a compressed copy beside it, for a browser that takes the encoding. */
  app.get(
    /^\/gridcraft\/([^/]+\.(?:wasm|js))$/,
    need('viewer'),
    (req, res, next) => {
      const name = req.params[0];
      if (name.includes('..')) return next();
      const file = path.join(GRIDCRAFT_DIR, name);
      const accept = String(req.get('Accept-Encoding') || '');
      const pick = [
        ['br', '.br'],
        ['gzip', '.gz'],
      ].find(([enc, ext]) => new RegExp(`\\b${enc}\\b`).test(accept) && fs.existsSync(`${file}${ext}`));
      if (!pick) return next();
      res.set('Content-Type', TYPES[path.extname(name)] || 'application/octet-stream');
      res.set('Content-Encoding', pick[0]);
      res.set('Vary', 'Accept-Encoding');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Cache-Control', /-[0-9a-f]{16,}[_.]/.test(name) ? 'public, max-age=31536000, immutable' : 'private, max-age=86400');
      res.sendFile(`${file}${pick[1]}`, { dotfiles: 'deny', headers: { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream' } });
    }
  );
  app.use(
    '/gridcraft',
    need('viewer'),
    express.static(GRIDCRAFT_DIR, {
      index: false,
      etag: true,
      fallthrough: true,
      setHeaders: (res, file) => {
        res.set('X-Content-Type-Options', 'nosniff');
        // Trunk names each file by its hash (filehash = true): kept for good; anything else a day.
        res.set('Cache-Control', /-[0-9a-f]{16,}[_.]/.test(path.basename(file)) ? 'public, max-age=31536000, immutable' : 'private, max-age=86400');
        if (file.endsWith('.wasm')) res.type('application/wasm');
        // The compressed copies are served by the route above with their encoding, never as files of their own.
        if (/\.(br|gz)$/.test(file)) res.status(404);
      },
    })
  );
}
