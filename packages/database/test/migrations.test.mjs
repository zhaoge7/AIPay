import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import pg from 'pg';

import { assertResettableDatabaseUrl, resetDatabase } from '../scripts/database-admin.mjs';
import { runMigrations } from '../scripts/migration-runner.mjs';
import {
  POSTGRES_IMAGE,
  removePostgresContainer,
  startPostgresContainer,
} from '../scripts/postgres-container.mjs';

const { Client } = pg;
const discardLog = () => undefined;

test('creates, migrates and rebuilds an isolated PostgreSQL test database', async (context) => {
  const config = {
    name: `aipay-postgres-test-${process.pid}`,
    database: 'aipay_test',
    user: 'aipay',
    password: 'integration-test-only',
  };
  context.after(() => removePostgresContainer(config.name));

  const { databaseUrl } = await startPostgresContainer(config);
  assert.equal(POSTGRES_IMAGE.startsWith('postgres:18.6-alpine@sha256:'), true);

  const firstRun = await runMigrations(databaseUrl, discardLog);
  const secondRun = await runMigrations(databaseUrl, discardLog);
  assert.equal(firstRun.length >= 1, true);
  assert.equal(secondRun.length, 0);

  let client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const schema = await client.query(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'aipay'",
  );
  const migrations = await client.query('SELECT name FROM aipay_migrations ORDER BY run_on');
  await client.end();

  assert.equal(schema.rowCount, 1);
  assert.equal(migrations.rowCount, firstRun.length);
  assert.equal(
    migrations.rows.some((row) => /create_aipay_schema/.test(row.name)),
    true,
  );

  const rolledBack = await runMigrations(databaseUrl, discardLog, {
    direction: 'down',
    count: 1,
  });
  assert.equal(rolledBack.length, 1);

  client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const migrationsAfterRollback = await client.query(
    'SELECT count(*)::INTEGER AS count FROM aipay_migrations',
  );
  await client.end();
  assert.equal(migrationsAfterRollback.rows[0].count, firstRun.length - 1);

  const reapplied = await runMigrations(databaseUrl, discardLog);
  assert.equal(reapplied.length, 1);

  await resetDatabase(databaseUrl);
  await runMigrations(databaseUrl, discardLog);

  client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const rebuilt = await client.query(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'aipay'",
  );
  await client.end();
  assert.equal(rebuilt.rowCount, 1);
});

test('refuses to reset remote or non-development database names', () => {
  assert.throws(
    () => assertResettableDatabaseUrl('postgresql://aipay:secret@db.example.com/aipay_test'),
    /loopback/,
  );
  assert.throws(
    () => assertResettableDatabaseUrl('postgresql://aipay:secret@127.0.0.1/aipay'),
    /_dev or _test/,
  );
});
