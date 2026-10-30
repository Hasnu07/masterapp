import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (v, dflt) => (v === undefined || v === '' ? dflt : !/^(0|off|false|no)$/i.test(String(v)));

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || undefined, // all interfaces unless set
  production: process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT),

  /* Postgres. Railway's Postgres plugin sets DATABASE_URL. */
  databaseUrl: process.env.DATABASE_URL || 'postgres://postgres@localhost:5433/masterapp',

  /* Where photos and scratch files live when R2 is not configured. On Railway
     this is the volume's mount point. */
  dataDir: path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data')),

  /*
   * Cloudflare R2, through its S3 API. When all four are set, photos go there;
   * otherwise they go to DATA_DIR. The bucket stays PRIVATE: every photo is
   * served through this app behind the sign-in, because a watch's papers and
   * serial are in these pictures.
   */
  r2: {
    accountId: process.env.R2_ACCOUNT_ID || '',
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || '',
    endpoint: process.env.R2_ENDPOINT || '',
    get configured() {
      return Boolean((this.accountId || this.endpoint) && this.accessKeyId && this.secretAccessKey && this.bucket);
    },
  },

  /* The first admin, created at start-up only when there are no users at all. */
  admin: {
    email: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
    password: process.env.ADMIN_PASSWORD || '',
    name: process.env.ADMIN_NAME || 'Admin',
  },

  /*
   * Chrono Key — no API, a login form and a session cookie, so these are the
   * real inventory credentials and stay on the server. masterapp only ever
   * READS Chrono Key; nothing here writes to it.
   */
  chronokey: {
    url: (process.env.CHRONOKEY_URL || 'https://fobcheck.azurewebsites.net').replace(/\/+$/, ''),
    username: process.env.CHRONOKEY_USERNAME || '',
    password: process.env.CHRONOKEY_PASSWORD || '',
    get configured() {
      return Boolean(this.username && this.password);
    },
  },

  /* The Watch vault — the puro-sync worker. VAULT_TOKEN is its WORKER_TOKEN. */
  vault: {
    url: (process.env.VAULT_URL ?? 'https://puro-sync.purosangue.workers.dev/api/state').replace(/\/+$/, ''),
    token: (process.env.VAULT_TOKEN || '').trim(),
    timeoutMs: Number(process.env.VAULT_TIMEOUT_MS || 60_000),
    get configured() {
      return Boolean(this.url);
    },
  },

  /* Exchange rates for the converter under every price. Public, no key; the
     same two sources InvoiceWEB uses. Held a minute. */
  rates: {
    liveUrl: process.env.RATES_LIVE_URL || 'https://api.coinbase.com/v2/exchange-rates?currency=USD',
    dailyUrl: process.env.RATES_DAILY_URL || 'https://open.er-api.com/v6/latest/USD',
    ttlMs: Number(process.env.RATES_TTL_MS || 60_000),
    timeoutMs: Number(process.env.RATES_TIMEOUT_MS || 8_000),
  },

  /*
   * The copy from Chrono Key and the vault keeps running until the switch-over.
   * SYNC=off stops it (the day masterapp becomes the master). The interval is
   * for the light "what's new" pass; a full re-read of every record runs once
   * a day.
   */
  sync: {
    enabled: bool(process.env.SYNC, true),
    intervalMin: Number(process.env.SYNC_INTERVAL_MIN || 15),
    fullEveryHours: Number(process.env.SYNC_FULL_EVERY_HOURS || 24),
    // Chrono Key is somebody else's server: two at a time, with a pause.
    concurrency: Number(process.env.SYNC_CONCURRENCY || 2),
    pauseMs: Number(process.env.SYNC_PAUSE_MS || 400),
  },

  /*
   * The logistics app's records (shipments, incomings, places, trips, costs …),
   * read from the same worker document as the vault. Its own switch, because
   * its switch-over need not be Chrono Key's: LOGISTICS_SYNC=off stops it, and
   * it follows SYNC when not set. Besides the pass every SYNC_INTERVAL_MIN, the
   * worker's version stamp (a few bytes) is checked every LOGISTICS_POLL_SEC
   * and the document read again when it moved — so a watch page is about a
   * minute behind the logistics app, not fifteen. 0 turns the check off. Its
   * pictures on the worker are copied LOGISTICS_PHOTOS_PER_PASS a pass, four
   * at a time (a page that shows one first copies it then).
   */
  logistics: {
    // Off by default since 30 Oct 2026 ("stop the sync for logistics for now"): the app itself is Logistics in the ERP.
    enabled: bool(process.env.LOGISTICS_SYNC, false),
    pollSec: Number(process.env.LOGISTICS_POLL_SEC ?? 60),
    photosPerPass: Number(process.env.LOGISTICS_PHOTOS_PER_PASS || 400),
    // Where the logistics app itself is (its Vercel address). The ERP serves it from there at /lg-app/, inside the
    // Logistics menu (asked 30 Oct 2026), and its vault page is the tabs' "Watch Vault ↗" link. `off`: neither.
    appUrl: (process.env.LOGISTICS_APP_URL ?? 'https://purosangue-watches.vercel.app').trim().replace(/^off$/i, '').replace(/\/+$/, ''),
  },
};
