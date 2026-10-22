import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { query } from '../db/index.js';
import { config } from '../config.js';

const scrypt = promisify(crypto.scrypt);

/*
 * Accounts and sessions.
 *
 * An ERP needs to know WHO changed a price, so there is no shared password:
 * each person has an account, and every edit is written down against it.
 * Three roles, in order of what they can do:
 *   viewer  reads everything
 *   editor  also adds, edits and deletes watches and their photos
 *   admin   also manages accounts and runs the import
 */

export const ROLES = ['viewer', 'editor', 'admin'];
export const can = (user, role) => Boolean(user) && ROLES.indexOf(user.role) >= ROLES.indexOf(role);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function checkPassword(password, stored) {
  const [scheme, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(String(password), Buffer.from(salt, 'base64'), want.length);
  return crypto.timingSafeEqual(want, got);
}

export function validPassword(password) {
  return typeof password === 'string' && password.length >= 10;
}

const SESSION_DAYS = 30;
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
export const COOKIE = 'ma_session';

export async function createUser({ email, name = '', role = 'viewer', password }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw Object.assign(new Error('That is not an email address'), { status: 400 });
  if (!ROLES.includes(role)) throw Object.assign(new Error(`Role must be one of ${ROLES.join(', ')}`), { status: 400 });
  if (!validPassword(password)) {
    throw Object.assign(new Error('The password must be at least 10 characters'), { status: 400 });
  }
  try {
    const { rows } = await query(
      'INSERT INTO users(email, name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role, disabled, created_at',
      [email, String(name).trim(), role, await hashPassword(password)]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw Object.assign(new Error('There is already an account with that email'), { status: 409 });
    throw err;
  }
}

/** Creates ADMIN_EMAIL / ADMIN_PASSWORD as the first admin, only if there are no users yet. */
export async function ensureFirstAdmin(log = console.log) {
  const { rows } = await query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n > 0) return;
  if (!config.admin.email || !config.admin.password) {
    log('[auth] no accounts yet — set ADMIN_EMAIL and ADMIN_PASSWORD, or run `npm run user -- add …`');
    return;
  }
  await createUser({ email: config.admin.email, name: config.admin.name, role: 'admin', password: config.admin.password });
  log(`[auth] created the first admin, ${config.admin.email}`);
}

export async function signIn(email, password) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [String(email || '').trim().toLowerCase()]);
  const user = rows[0];
  // The password is checked even when there is no such user, so the time a
  // refusal takes does not say whether the email exists.
  const ok = await checkPassword(password, user?.password_hash || 'scrypt$AAAA$AAAA');
  if (!user || !ok || user.disabled) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`,
    [sha(token), user.id]
  );
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  return { token, user: publicUser(user) };
}

export async function signOut(token) {
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
}

export async function userForToken(token) {
  if (!token) return null;
  const { rows } = await query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`,
    [sha(token)]
  );
  return rows[0] ? publicUser(rows[0]) : null;
}

export const publicUser = (u) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  role: u.role,
  disabled: u.disabled,
  created_at: u.created_at,
  last_login_at: u.last_login_at,
});

export async function listUsers() {
  const { rows } = await query('SELECT * FROM users ORDER BY created_at');
  return rows.map(publicUser);
}

export async function updateUser(id, patch) {
  const sets = [];
  const vals = [];
  const set = (col, v) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.name !== undefined) set('name', String(patch.name).trim());
  if (patch.role !== undefined) {
    if (!ROLES.includes(patch.role)) throw Object.assign(new Error('Unknown role'), { status: 400 });
    set('role', patch.role);
  }
  if (patch.disabled !== undefined) set('disabled', Boolean(patch.disabled));
  if (patch.password !== undefined) {
    if (!validPassword(patch.password)) {
      throw Object.assign(new Error('The password must be at least 10 characters'), { status: 400 });
    }
    set('password_hash', await hashPassword(patch.password));
  }
  if (!sets.length) return null;
  vals.push(id);
  const { rows } = await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  // A disabled account or a new password ends that person's sessions.
  if (patch.disabled || patch.password !== undefined) await query('DELETE FROM sessions WHERE user_id = $1', [id]);
  return rows[0] ? publicUser(rows[0]) : null;
}

export async function pruneSessions() {
  await query('DELETE FROM sessions WHERE expires_at < now()');
}
