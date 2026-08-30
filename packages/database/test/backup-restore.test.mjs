import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { URL } from 'node:url';

import pg from 'pg';

import { createEncryptedBackup, restoreEncryptedBackup } from '../scripts/backup-restore.mjs';
import { runMigrations } from '../scripts/migration-runner.mjs';
import { removePostgresContainer, startPostgresContainer } from '../scripts/postgres-container.mjs';

const { Client } = pg;
const discardLog = () => undefined;

test('creates an authenticated encrypted backup and restores it into an independent database', async (context) => {
  const config = {
    name: `aipay-backup-${process.pid}`,
    database: 'aipay_backup_source_test',
    user: 'aipay',
    password: 'backup-test-only',
  };
  const targetDatabase = 'aipay_backup_restored_test';
  const temporary = await mkdtemp(join(tmpdir(), 'aipay-backup-'));
  const backupPath = join(temporary, 'aipay.backup');
  const backupKey = randomBytes(32).toString('base64');
  let source;
  let restored;
  context.after(async () => {
    await source?.end();
    await restored?.end();
    removePostgresContainer(config.name);
    await rm(temporary, { recursive: true, force: true });
  });

  const { databaseUrl } = await startPostgresContainer(config);
  await runMigrations(databaseUrl, discardLog);
  source = new Client({ connectionString: databaseUrl });
  await source.connect();
  await source.query(
    `INSERT INTO aipay.developers (email, password_hash)
      VALUES ('before-backup@example.com', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj')`,
  );
  const created = await createEncryptedBackup(config, backupPath, backupKey);
  assert.ok(created.bytes > 1_000);
  assert.match(created.sha256, /^[0-9a-f]{64}$/u);
  const backup = await readFile(backupPath);
  assert.equal(backup.subarray(0, 8).toString('ascii'), 'AIPAYBK1');
  assert.equal(backup.includes(Buffer.from('PGDMP', 'ascii')), false);
  assert.equal((await lstat(backupPath)).mode & 0o077, 0);
  await source.query(
    `INSERT INTO aipay.developers (email, password_hash)
      VALUES ('after-backup@example.com', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj')`,
  );

  const restoredResult = await restoreEncryptedBackup(
    config,
    backupPath,
    targetDatabase,
    backupKey,
  );
  assert.equal(restoredResult.targetDatabase, targetDatabase);
  assert.ok(restoredResult.restoredBytes > 1_000);
  const restoredUrl = new URL(databaseUrl);
  restoredUrl.pathname = `/${targetDatabase}`;
  restored = new Client({ connectionString: restoredUrl.toString() });
  await restored.connect();
  const restoredDevelopers = await restored.query(
    'SELECT email FROM aipay.developers ORDER BY email',
  );
  assert.deepEqual(restoredDevelopers.rows, [{ email: 'before-backup@example.com' }]);
  const restoredTables = await restored.query(
    "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'aipay'",
  );
  const sourceTables = await source.query(
    "SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'aipay'",
  );
  assert.equal(restoredTables.rows[0].count, sourceTables.rows[0].count);
  const migrations = await restored.query(
    'SELECT count(*)::int AS count FROM public.aipay_migrations',
  );
  assert.ok(migrations.rows[0].count > 0);
  await assert.rejects(
    restoreEncryptedBackup(config, backupPath, config.database, backupKey),
    /different database/u,
  );
  await assert.rejects(
    restoreEncryptedBackup(
      config,
      backupPath,
      'aipay_backup_other_test',
      randomBytes(32).toString('base64'),
    ),
    /authentication failed/u,
  );
});
