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

const db = new EmbeddedPostgres({
  databaseDir: PG_DIR,
  user: 'postgres',
  password: secrets.dbPassword,
  port: DB_PORT,
  persistent: true,
  // Postgres refuses to run as root (Linux containers); it then runs as a
  // "postgres" user, made if missing. Never the case on a Windows PC.
  createPostgresUser: true,
  // UTF-8 whatever the PC's region is set to. Left alone, a Windows PC hands
  // the database its own code page (often WIN1252), and an Arabic or Chinese
  // client name then cannot be stored at all.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
  onError: (m) => {
    const text = String(m instanceof Error ? m.message : m).trim();
    if (text) console.error(`[db] ${text}`);
  },
});

const fresh = !fs.existsSync(path.join(PG_DIR, 'PG_VERSION'));
if (fresh) {
  console.log('[local] setting up the database (first run only)…');
  await db.initialise();
}
try {
  await db.start();
} catch (err) {
  console.error(`[local] the database would not start: ${err.message || err}`);
  console.error(`        Is another masterapp already running? Port ${DB_PORT} may be taken (set LOCAL_DB_PORT to change it).`);
  process.exit(1);
}
try {
  await db.createDatabase('masterapp');
} catch {
  // already there
}

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  console.log('\n[local] stopping…');
  await db.stop().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

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
const url = `http://localhost:${PORT}`;
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
