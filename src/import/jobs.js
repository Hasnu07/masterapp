import { query, pool } from '../db/index.js';
import { config } from '../config.js';
import { syncList, syncDetails } from './chronokey/sync.js';
import { syncVault, fetchVersion, forgetState } from './vault/sync.js';
import { syncClients } from './chronokey/clients.js';
import { syncExpenses } from './chronokey/expenses.js';
import { syncLogistics } from './logistics/sync.js';

/*
 * The copy from Chrono Key and the vault, run on a timer until the
 * switch-over (SYNC=off then stops it), and on request from the Import page.
 *
 * One job at a time, across processes too (a Postgres advisory lock): two
 * passes over Chrono Key at once would be twice the load on somebody else's
 * server, and two writers racing on one watch.
 */

const LOCK = 727002;
let current = null;

export const running = () => current;

export async function runJob(name, fn) {
  if (current) throw Object.assign(new Error(`An import is already running (${current.name})`), { status: 409 });
  const client = await pool.connect();
  const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK]);
  if (!rows[0].ok) {
    client.release();
    throw Object.assign(new Error('An import is already running in another process'), { status: 409 });
  }
  current = { name, startedAt: new Date().toISOString() };
  try {
    return await fn();
  } finally {
    // The worker's document, kept for the job's second reading of it, is not kept past the job.
    forgetState();
    current = null;
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    client.release();
  }
}

/** Starts a job and returns at once; its progress is in import_runs. */
export function startJob(name, user) {
  const jobs = {
    'chronokey-list': () => syncList({ user }),
    'chronokey-clients': () => syncClients({ user }),
    'chronokey-expenses': () => syncExpenses({ user }),
    'chronokey-new': () => syncDetails({ mode: 'new', user }),
    'chronokey-active': () => syncDetails({ mode: 'active', user }),
    'chronokey-full': () => syncDetails({ mode: 'full', user }),
    vault: () => syncVault({ user }),
    logistics: () => syncLogistics({ user }),
    everything: async () => {
      await syncList({ user });
      await syncClients({ user });
      await syncDetails({ mode: 'new', user });
      await syncVault({ user });
      await syncLogistics({ user, reuse: true });
    },
  };
  const fn = Object.hasOwn(jobs, name) ? jobs[name] : null;
  if (!fn) throw Object.assign(new Error(`Unknown job ${name}`), { status: 400 });
  if (current) throw Object.assign(new Error(`An import is already running (${current.name})`), { status: 409 });
  runJob(name, fn).catch((err) => console.error(`[import] ${name}: ${err.message}`));
}

/*
 * The daily re-read of unsold and recent watch pages is due when none went
 * through in the last day. A pass that read its pages with a few failing
 * (`ok` false, no error of its own) counts: those pages are retried by the
 * rolling pass. Counting only a pass with no failure at all ran the ~200 pages
 * every 15 minutes while any one page kept failing. One that stopped (a
 * rejected sign-in) or lost most of its pages (Chrono Key down) does not count.
 */
export async function activeDetailsDue(now = Date.now()) {
  // The counts are read only where they are numbers: a cast that failed here would stop every pass.
  const { rows } = await query(
    `SELECT max(started_at) AS at FROM import_runs
      WHERE source = 'chronokey' AND mode = 'details-active' AND finished_at IS NOT NULL AND error IS NULL
        AND COALESCE(CASE WHEN jsonb_typeof(stats->'failed') = 'number' THEN (stats->>'failed')::numeric END, 0) * 10
            <= COALESCE(CASE WHEN jsonb_typeof(stats->'todo') = 'number' THEN (stats->>'todo')::numeric END, 0)`
  );
  const last = rows[0]?.at ? new Date(rows[0].at).getTime() : 0;
  return now - last > config.sync.fullEveryHours * 3600_000;
}

const vaultOn = () => config.vault.configured && Boolean(config.vault.token);

/** The light pass: what is new on Chrono Key, the vault, and the logistics app. */
async function cycle() {
  const steps = [];
  if (config.sync.enabled && config.chronokey.configured) {
    steps.push(['list', () => syncList()]);
    // One request: the client list, then every watch's two client links from the list just read.
    steps.push(['clients', () => syncClients()]);
    // The expense list (one request), the pages of new or changed expenses — at most 200 a pass —
    // and the 40 read longest ago, so every expense page is re-read every few hours.
    steps.push(['expenses', () => syncExpenses({ limit: 200, rolling: 40 })]);
    steps.push(['new details', () => syncDetails({ mode: 'new', limit: 200 })]);
    // 40 watch pages a pass, the longest unread first: every page refreshed within about ten hours.
    steps.push(['rolling details', () => syncDetails({ mode: 'rolling', limit: 40 })]);
    if (await activeDetailsDue()) steps.push(['active details', () => syncDetails({ mode: 'active' })]);
  }
  // One download of the worker's document serves both: the second step reuses the first one's copy.
  if (vaultOn() && config.sync.enabled) steps.push(['vault', () => syncVault({ reuse: true })]);
  if (vaultOn() && config.logistics.enabled) steps.push(['logistics', () => syncLogistics({ reuse: true })]);
  for (const [name, fn] of steps) {
    try {
      await fn();
    } catch (err) {
      console.error(`[sync] ${name}: ${err.message}`);
    }
  }
}

/*
 * Between passes: the worker's version stamp, every LOGISTICS_POLL_SEC. When
 * it moved, the logistics records are read again — the document is several
 * megabytes, the stamp a few bytes. The first stamp is only noted: the pass a
 * minute after start-up reads the document anyway.
 */
let lastVersion = null;
async function checkVersion() {
  if (current) return;
  let v;
  try {
    v = await fetchVersion();
  } catch (err) {
    console.warn(`[logistics] version not read: ${err.message}`);
    return;
  }
  if (v === null || v === lastVersion) return;
  const first = lastVersion === null;
  lastVersion = v;
  if (first) return;
  runJob('logistics', () => syncLogistics()).catch((err) => {
    if (err.status !== 409) console.error(`[logistics] ${err.message}`);
  });
}

export function startScheduler(log = console.log) {
  const logistics = config.logistics.enabled && vaultOn();
  if (!config.sync.enabled && !logistics) {
    log('[sync] off (SYNC=off) — masterapp is the master; nothing is copied from Chrono Key, the vault or the logistics app');
    return;
  }
  if (!(config.sync.enabled && (config.chronokey.configured || vaultOn())) && !logistics) {
    log('[sync] nothing to copy from — set CHRONOKEY_USERNAME/PASSWORD and/or VAULT_TOKEN');
    return;
  }
  const every = Math.max(5, config.sync.intervalMin) * 60_000;
  const tick = () => {
    if (current) return;
    runJob('scheduled', cycle).catch((err) => {
      if (err.status !== 409) console.error(`[sync] ${err.message}`);
    });
  };
  // A minute after start-up, not at once: a deploy should come up first.
  setTimeout(tick, 60_000).unref();
  setInterval(tick, every).unref();
  const what = [config.sync.enabled && 'Chrono Key and the vault', logistics && 'the logistics app'].filter(Boolean).join(' and ');
  log(`[sync] copying from ${what} every ${every / 60_000} min`);
  if (logistics && config.logistics.pollSec > 0) {
    setInterval(checkVersion, Math.max(15, config.logistics.pollSec) * 1000).unref();
    log(`[logistics] checking the logistics app for changes every ${Math.max(15, config.logistics.pollSec)} s`);
  }
}
