import pg from 'pg';
import { config } from '../config.js';

// numeric comes back as a string by default (it can exceed a JS number). Our
// prices are 14 digits with 2 decimals, well inside a double, so read them as
// numbers rather than have every caller remember to convert.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// A DATE is a calendar day, not an instant: keep it as "YYYY-MM-DD" rather
// than letting it become a midnight in whatever zone the server runs in.
pg.types.setTypeParser(1082, (v) => v);

/*
 * TLS to a managed Postgres. DigitalOcean signs its database certificates
 * with its own CA, so verifying one needs that CA — App Platform hands it
 * over as ${db.CA_CERT}, read here as DATABASE_CA_CERT. Without it the link
 * is still encrypted, only not verified.
 *
 * The sslmode is taken OUT of the url: node-pg reads `sslmode=require` as
 * "verify against the system's CAs" and lets it override the ssl settings
 * given here — the first deploy on DigitalOcean failed on exactly that
 * (SELF_SIGNED_CERT_IN_CHAIN, 23 Oct 2026).
 */
export function connectionOptions(url, ca = process.env.DATABASE_CA_CERT) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { connectionString: url };
  }
  const mode = u.searchParams.get('sslmode');
  if (!mode || mode === 'disable') return { connectionString: url };
  u.searchParams.delete('sslmode');
  return {
    connectionString: u.toString(),
    ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
  };
}

export const pool = new pg.Pool({ ...connectionOptions(config.databaseUrl), max: 10 });

/*
 * A connection the database closes while it sits idle in the pool — a restart
 * of Postgres on Railway, or Ctrl+C reaching the local database first — is
 * an 'error' on the pool, and an unhandled one ends the process with a page
 * of stack trace. The pool has already dropped that connection; the next
 * query simply opens a new one.
 */
pool.on('error', (err) => console.warn(`[db] a database connection closed: ${err.message}`));

export const query = (text, params) => pool.query(text, params);

/** Runs fn(client) inside a transaction. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
