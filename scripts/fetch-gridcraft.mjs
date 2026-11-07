#!/usr/bin/env node
/*
 * Fetches GridCraft's web build (storytold/gridcraft, MIT / Apache-2.0) into
 * vendor/gridcraft, the folder the ERP serves at /gridcraft/ (src/web/gridcraft.js).
 *
 *   node scripts/fetch-gridcraft.mjs            # the version pinned in package.json ("gridcraft")
 *   node scripts/fetch-gridcraft.mjs 0.17.0     # another release
 *
 * The release zip (gridcraft-web-<version>.zip, ~10 MB) is downloaded from
 * GitHub, checked to be a zip holding an index.html, and unpacked with the
 * ERP's own zip reader (src/xlsx). Nothing in it is run here. The licence
 * files are written beside it (LICENSE-MIT, LICENSE-APACHE, NOTICE,
 * ATTRIBUTION.md from the same tag), as the licence asks.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzip } from '../src/xlsx/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = (process.argv[2] || pkg.gridcraft?.version || '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Which version? e.g. node scripts/fetch-gridcraft.mjs 0.17.0 (or set "gridcraft": {"version": "…"} in package.json)');
  process.exit(1);
}
const REPO = 'https://github.com/storytold/gridcraft';
const RAW = `https://raw.githubusercontent.com/storytold/gridcraft/v${version}`;
const dest = path.join(ROOT, 'vendor', 'gridcraft');

async function get(url) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'masterapp-fetch-gridcraft' } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const url = `${REPO}/releases/download/v${version}/gridcraft-web-${version}.zip`;
console.log(`fetching ${url} …`);
const zipBytes = await get(url);
console.log(`  ${(zipBytes.length / 1048576).toFixed(1)} MB`);
const z = unzip(zipBytes);
// The zip may hold the files at its root or under one folder.
const index = z.names.find((n) => /(^|\/)index\.html$/.test(n));
if (!index) throw new Error('The zip holds no index.html — not GridCraft’s web build?');
const prefix = index.slice(0, index.length - 'index.html'.length);
fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
let n = 0;
let bytes = 0;
for (const name of z.names) {
  if (!name.startsWith(prefix) || name.endsWith('/')) continue;
  const rel = name.slice(prefix.length);
  // Only plain relative paths are written: nothing above the folder, no absolute paths.
  if (!rel || rel.split('/').some((p) => p === '..' || p === '' || p.includes('\\')) || path.isAbsolute(rel)) continue;
  const out = path.join(dest, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const data = z.read(name);
  fs.writeFileSync(out, data);
  n += 1;
  bytes += data.length;
}
console.log(`  unpacked ${n} files, ${(bytes / 1048576).toFixed(1)} MB, into ${path.relative(ROOT, dest)}`);
for (const f of ['LICENSE-MIT', 'LICENSE-APACHE', 'NOTICE', 'ATTRIBUTION.md']) {
  try {
    fs.writeFileSync(path.join(dest, f), await get(`${RAW}/${f}`));
  } catch (err) {
    console.warn(`  (no ${f} at that tag: ${err.message})`);
  }
}
fs.writeFileSync(path.join(dest, 'VERSION'), `${version}\n${url}\n`);
console.log(`done: GridCraft ${version}. The ERP serves it at /gridcraft/ after a restart.`);
