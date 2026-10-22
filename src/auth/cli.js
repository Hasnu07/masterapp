import { pool } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { createUser, updateUser, listUsers } from './index.js';
import { query } from '../db/index.js';

/*
 * npm run user -- add <email> <role> <password> [name…]
 * npm run user -- password <email> <new password>
 * npm run user -- list
 */
const [cmd, ...args] = process.argv.slice(2);

try {
  await migrate({ log: () => {} });
  if (cmd === 'add') {
    const [email, role, password, ...name] = args;
    const u = await createUser({ email, role, password, name: name.join(' ') });
    console.log(`added ${u.email} (${u.role})`);
  } else if (cmd === 'password') {
    const [email, password] = args;
    const { rows } = await query('SELECT id FROM users WHERE email = $1', [String(email).toLowerCase()]);
    if (!rows[0]) throw new Error(`no account ${email}`);
    await updateUser(rows[0].id, { password });
    console.log(`password changed for ${email}`);
  } else if (cmd === 'list') {
    for (const u of await listUsers()) console.log(`${u.email}\t${u.role}${u.disabled ? '\tdisabled' : ''}`);
  } else {
    console.log('usage: npm run user -- add <email> <admin|editor|viewer> <password> [name]');
    console.log('       npm run user -- password <email> <new password>');
    console.log('       npm run user -- list');
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
