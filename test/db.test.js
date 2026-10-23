import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionOptions } from '../src/db/index.js';

/* How the database is reached — no database needed. */

test('a local database: the url as it is, no TLS', () => {
  const url = 'postgres://postgres:pw@127.0.0.1:5544/masterapp';
  assert.deepEqual(connectionOptions(url, undefined), { connectionString: url });
});

test("a managed database: verified against the provider's CA when it is given", () => {
  const o = connectionOptions('postgresql://doadmin:pw@db.example.com:25060/defaultdb?sslmode=require', 'CA-PEM');
  assert.equal(o.connectionString, 'postgresql://doadmin:pw@db.example.com:25060/defaultdb', 'sslmode taken out so it cannot override');
  assert.deepEqual(o.ssl, { ca: 'CA-PEM', rejectUnauthorized: true });
});

test('a managed database without its CA: encrypted, not verified', () => {
  const o = connectionOptions('postgresql://u:pw@h:25060/d?sslmode=require&application_name=x', undefined);
  assert.equal(o.connectionString, 'postgresql://u:pw@h:25060/d?application_name=x');
  assert.deepEqual(o.ssl, { rejectUnauthorized: false });
});
