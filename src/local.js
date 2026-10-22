import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/*
 * `npm run local` — masterapp on this computer, with nothing else to install.
 *
 * It brings its own Postgres (the embedded-postgres package ships the real
 * database binaries for Windows, macOS and Linux through npm), keeps the
 * database and the photos under ./data, makes a first admin account the first
 * time, and opens the browser. Ctrl+C stops both.
 *
 * Port 3300 rather than 3000, because InvoiceWEB's console uses 3000 and both
 * may well be running on the same PC.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const PG_DIR = path.join(DATA, 'pg');
const DB_PORT = Number(process.env.LOCAL_DB_PORT || 5544);
const PORT = Number(process.env.PORT || 3300);

fs.mkdirSync(DATA, { recursive: true });

/* The local database password and the first admin, made once and kept. */
const secretsFile = path.join(DATA, 'local.json');
let secrets = {};
try {
  secrets = JSON.parse(fs.readFileSync(secretsFile, 'utf8'));
} catch {
  // first run
}
if (!secrets.dbPassword) {
  secrets = {
    dbPassword: crypto.randomBytes(18).toString('base64url'),
    adminEmail: 'admin@local',
    adminPassword: crypto.randomBytes(9).toString('base64url'),
  };
  fs.writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
}

const { default: EmbeddedPostgres } = await import('embedded-postgres').catch(() => {
  console.error('The local database is not installed — run `npm install` first.');
  process.exit(1);
});

/*
 * Postgres will not run as root, so on a Linux machine signed in as root it is
 * run as a "postgres" user, made if missing. ONLY there: the library creates
 * that user with groupadd/useradd whenever the option is on, and on Windows
 * those commands do not exist — which is exactly how the first run on a
 * Windows PC failed (22 Oct 2026).
 */
const asRoot = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;

/* The database's own last words, kept so a failure can say what it was. */
const recent = [];
const remember = (m) => {
  for (const line of String(m ?? '').split(/\r?\n/)) {
    if (line.trim()) recent.push(line.trim());
  }
  recent.splice(0, Math.max(0, recent.length - 15));
};

const db = new EmbeddedPostgres({
  databaseDir: PG_DIR,
  user: 'postgres',
  password: secrets.dbPassword,
  port: DB_PORT,
  persistent: true,
  createPostgresUser: asRoot,
  // UTF-8 whatever the PC's region is set to. Left alone, a Windows PC hands
  // the database its own code page (often WIN1252), and an Arabic or Chinese
  // client name then cannot be stored at all.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: remember,
  onError: (m) => remember(m instanceof Error ? m.message : m),
});

/*
 * Why the database did not come up, in words someone at a PC can act on.
 *
 * The Windows build of Postgres needs Microsoft's Visual C++ runtime, which it
 * does not carry. Most PCs already have it; one that does not fails with
 * 0xC0000135 ("a DLL was not found"), which says nothing to anyone.
 */
function explain(stage, err) {
  const text = [err?.message || '', ...recent].join('\n');
  console.error(`\n[local] the database could not ${stage}.`);
  if (/3221225781|-1073741515|c0000135|vcruntime|msvcp|was not found|\.dll/i.test(text)) {
    console.error(`  Windows is missing Microsoft's Visual C++ runtime, which the database needs.
  Install it (free, from Microsoft), then run this again:
    https://aka.ms/vs/17/release/vc_redist.x64.exe`);
  } else if (/administrat/i.test(text)) {
    console.error('  It will not run with administrator rights. Open an ordinary (not "Run as administrator") window and try again.');
  } else if (/address already in use|could not bind|port/i.test(text)) {
    console.error(`  Port ${DB_PORT} is taken — is masterapp already running in another window? (LOCAL_DB_PORT changes it.)`);
  } else if (/lock file|postmaster\.pid/i.test(text)) {
    console.error('  It looks like it is already running in another window. Close that one, or wait a moment and try again.');
  }
  if (recent.length) console.error(`  What it said:\n    ${recent.slice(-8).join('\n    ')}`);
  process.exit(1);
}

/* A folder from a first run that failed part-way holds no database, and
   initdb refuses a folder that is not empty — so it is cleared and redone. */
const fresh = !fs.existsSync(path.join(PG_DIR, 'PG_VERSION'));
if (fresh) {
  fs.rmSync(PG_DIR, { recursive: true, force: true });
  console.log('[local] setting up the database (first run only)…');
  try {
    await db.initialise();
  } catch (err) {
    explain('be set up', err);
  }
}
try {
  await db.start();
} catch (err) {
  explain('start', err);
}
try {
  await db.createDatabase('masterapp');
} catch {
  // already there
}

/*
 * Ctrl+C stops the database too. Never waits more than a few seconds: on
 * Windows Ctrl+C reaches the database at the same moment, it shuts itself
 * down, and the library then waits for an exit that has already happened.
 */
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log('\n[local] stopping…');
  await Promise.race([db.stop().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

/* The database stopping on its own leaves an app that can do nothing: say so. */
db.process?.on('exit', (code) => {
  if (stopping) return;
  console.error(`\n[local] the database stopped${code === null ? "" : ` (code ${code})`}. Close this window and start masterapp again.`);
  if (recent.length) console.error(`  What it said:\n    ${recent.slice(-5).join('\n    ')}`);
  process.exit(1);
});

process.env.DATABASE_URL = `postgres://postgres:${encodeURIComponent(secrets.dbPassword)}@127.0.0.1:${DB_PORT}/masterapp`;
process.env.DATA_DIR = DATA;
process.env.PORT = String(PORT);
// This computer only: nothing on the network can reach it, and Windows does
// not ask whether to let Node through its firewall.
process.env.HOST ||= '127.0.0.1';
process.env.ADMIN_EMAIL ||= secrets.adminEmail;
process.env.ADMIN_PASSWORD ||= secrets.adminPassword;
process.env.ADMIN_NAME ||= 'Admin';

await import('./index.js');

/* Say where it is, and open it, once it answers. */
// 127.0.0.1, not "localhost": the app listens on IPv4 only, and on Windows
// "localhost" can resolve to the IPv6 ::1 first — refused, though it is running.
const url = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 60; i += 1) {
  try {
    if ((await fetch(`${url}/healthz`)).ok) break;
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`
  masterapp is running:  ${url}
  First sign-in:         ${process.env.ADMIN_EMAIL}  /  ${
    process.env.ADMIN_PASSWORD === secrets.adminPassword ? secrets.adminPassword : '(the ADMIN_PASSWORD in your .env)'
  }
                         (kept in ${path.relative(ROOT, secretsFile)}; works until you change it in the app)
  Data and photos:       ${path.relative(ROOT, DATA) || DATA}
  Stop:                  Ctrl+C
`);
if (!process.env.NO_BROWSER) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}
