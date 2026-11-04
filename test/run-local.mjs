/*
 * `npm run test:local`: the tests against a Postgres of their own.
 *
 * The suite empties its database on every file, so it needs one nobody else
 * uses. This starts a fresh embedded Postgres (the same package `npm run
 * local` uses) in a temporary folder on port 5433, runs `node --test`, and
 * stops it again — nothing to install, nothing left behind. Start it each
 * time: an embedded server kept running across whole suite runs was seen to
 * start refusing connections (4 Nov 2026).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.TEST_DB_PORT || 5433);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'masterapp-testdb-'));
const { default: EmbeddedPostgres } = await import('embedded-postgres').catch(() => {
  console.error('The embedded database is not installed — run `npm install` first.');
  process.exit(1);
});
const db = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'postgres',
  password: 'postgres',
  port: PORT,
  persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
  onError: () => {},
});
let code = 1;
try {
  await db.initialise();
  await db.start();
  await db.createDatabase('masterapp_test');
  const url = `postgres://postgres:postgres@localhost:${PORT}/masterapp_test`;
  console.log(`[test:local] Postgres on :${PORT}, running the tests…`);
  // The files named, else every test file — listed here, not by a shell glob (no shell: a Node path with a space in it breaks there).
  const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync('test').filter((f) => f.endsWith('.test.js')).sort().map((f) => path.join('test', f));
  code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { stdio: 'inherit', env: { ...process.env, TEST_DATABASE_URL: url } });
    child.on('error', (err) => {
      console.error(`[test:local] could not start node: ${err.message}`);
      resolve(1);
    });
    child.on('exit', (c) => resolve(c ?? 1));
  });
} catch (err) {
  console.error(`[test:local] ${err.message}`);
} finally {
  await db.stop().catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(code);
