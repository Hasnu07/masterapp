import { config } from '../../config.js';

/*
 * The accounts app's API, signed in as the ERP (ACCOUNTS_USERNAME /
 * ACCOUNTS_PASSWORD — an account made for the ERP in the app itself, approved
 * there). The app keeps a session cookie (express-session, 30 days); it is
 * held here and sent back, and a 401 signs in again once. Read-only: only
 * /api/state (the whole document, or named collections) and /api/state/revs
 * (a version number per collection) are ever asked for.
 */

let cookie = ''; // the app's session cookie, name=value
export const forgetSession = () => {
  cookie = '';
};

const url = (path) => `${config.accounts.appUrl}${path}`;

async function call(path, init = {}) {
  const headers = { Accept: 'application/json', ...(init.headers || {}) };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url(path), { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(config.accounts.timeoutMs) });
  // Node's fetch keeps every Set-Cookie: the session is the one named connect.sid.
  for (const c of typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []) {
    const pair = c.split(';')[0].trim();
    if (pair.startsWith('connect.sid=')) cookie = pair;
  }
  return res;
}

const describe = async (res) => {
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON
  }
  return body?.error ? `${body.error} (HTTP ${res.status})` : `HTTP ${res.status}`;
};

export async function login() {
  if (!config.accounts.configured) throw new Error('The accounts app is not configured — set ACCOUNTS_USERNAME and ACCOUNTS_PASSWORD (an account made for the ERP in the app)');
  cookie = '';
  const res = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: config.accounts.username, password: config.accounts.password }),
  });
  if (res.status === 401) throw new Error('The accounts app rejected the ERP’s sign-in — check ACCOUNTS_USERNAME and ACCOUNTS_PASSWORD');
  if (res.status === 423) throw new Error(`The accounts app has locked the ERP’s account for now: ${await describe(res)}`);
  if (!res.ok) throw new Error(`The accounts app’s sign-in answered ${await describe(res)}`);
  if (!cookie) throw new Error('The accounts app signed the ERP in but gave no session cookie');
  await res.arrayBuffer();
}

/** GET as the ERP: a dead session is renewed once. */
async function getJson(path) {
  if (!config.accounts.configured) throw new Error('The accounts app is not configured — set ACCOUNTS_USERNAME and ACCOUNTS_PASSWORD');
  if (!cookie) await login();
  let res = await call(path);
  if (res.status === 401) {
    await res.arrayBuffer();
    await login();
    res = await call(path);
  }
  if (res.status === 403) {
    // Its own gates: a new account waiting for approval, or a password it wants changed.
    throw new Error(`The accounts app will not serve the ERP’s account yet: ${await describe(res)} — approve it (or set its password) in the app’s Admin → Team`);
  }
  if (res.status === 503) throw new Error('The accounts app’s database is unavailable (HTTP 503)');
  if (!res.ok) throw new Error(`The accounts app answered ${await describe(res)} for ${path}`);
  return res.json();
}

/** Every collection, or the named ones: { entries: [...], clients: [...], … }. */
export const fetchAccountsState = (only = null) => getJson(only?.length ? `/api/state?only=${only.map(encodeURIComponent).join(',')}` : '/api/state');

/** A version number per collection — a few bytes, asked for between passes. */
export const fetchAccountsRevs = () => getJson('/api/state/revs');
