import pg from 'pg';
import { URL } from 'node:url';

const { Client } = pg;

const allowedHosts = new Set(['127.0.0.1', 'localhost', '::1']);

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function assertResettableDatabaseUrl(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));

  if (!allowedHosts.has(parsed.hostname)) {
    throw new Error('Database reset is restricted to loopback hosts');
  }

  if (!databaseName.endsWith('_dev') && !databaseName.endsWith('_test')) {
    throw new Error('Database reset requires a name ending in _dev or _test');
  }

  if (parsed.username.length === 0 || databaseName.length === 0) {
    throw new Error('Database reset requires an explicit user and database');
  }

  return Object.freeze({ parsed, databaseName });
}

export async function resetDatabase(databaseUrl) {
  const { parsed, databaseName } = assertResettableDatabaseUrl(databaseUrl);
  const adminUrl = new URL(parsed);
  adminUrl.pathname = '/postgres';
  const client = new Client({ connectionString: adminUrl.toString() });

  await client.connect();

  try {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [databaseName],
    );
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await client.query(
      `CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier(decodeURIComponent(parsed.username))}`,
    );
  } finally {
    await client.end();
  }
}
