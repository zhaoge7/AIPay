import { spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { developmentContainer } from './postgres-container.mjs';

const backupMagic = Buffer.from('AIPAYBK1', 'ascii');
const maximumBackupBytes = 256 * 1024 * 1024;
const databaseNamePattern = /^[a-z][a-z0-9_]{0,62}$/u;

function runDocker(args, input) {
  const result = spawnSync('docker', args, {
    input,
    maxBuffer: maximumBackupBytes,
    encoding: null,
  });

  if (result.error !== undefined) throw result.error;

  if (result.status !== 0) {
    throw new Error('PostgreSQL backup command failed');
  }

  return Buffer.from(result.stdout);
}

function parseBackupKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    throw new Error('AIPAY_BACKUP_KEY must be canonical base64 for 32 bytes');
  }

  const key = Buffer.from(value, 'base64');

  if (key.byteLength !== 32 || key.toString('base64') !== value) {
    throw new Error('AIPAY_BACKUP_KEY must be canonical base64 for 32 bytes');
  }

  return key;
}

function assertDatabaseName(value, label) {
  if (!databaseNamePattern.test(value)) {
    throw new Error(`${label} database name is invalid`);
  }
}

function encryptedBackup(plain, key) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([backupMagic, nonce, tag, ciphertext]);
}

function decryptedBackup(encrypted, key) {
  if (
    encrypted.byteLength <= backupMagic.byteLength + 12 + 16 ||
    !encrypted.subarray(0, backupMagic.byteLength).equals(backupMagic)
  ) {
    throw new Error('AIPay backup file is invalid');
  }

  const nonceStart = backupMagic.byteLength;
  const tagStart = nonceStart + 12;
  const contentStart = tagStart + 16;
  const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(nonceStart, tagStart));
  decipher.setAuthTag(encrypted.subarray(tagStart, contentStart));

  try {
    return Buffer.concat([decipher.update(encrypted.subarray(contentStart)), decipher.final()]);
  } catch {
    throw new Error('AIPay backup authentication failed');
  }
}

export async function createEncryptedBackup(config, outputPath, backupKeyBase64) {
  assertDatabaseName(config.database, 'Source');
  const key = parseBackupKey(backupKeyBase64);
  const dump = runDocker([
    'exec',
    config.name,
    'pg_dump',
    '--username',
    config.user,
    '--dbname',
    config.database,
    '--format=custom',
    '--no-owner',
    '--no-acl',
  ]);

  if (!dump.subarray(0, 5).equals(Buffer.from('PGDMP', 'ascii'))) {
    throw new Error('PostgreSQL did not produce a custom-format backup');
  }

  const encrypted = encryptedBackup(dump, key);
  await writeFile(outputPath, encrypted, { flag: 'wx', mode: 0o600 });
  const metadata = await lstat(outputPath);

  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
    throw new Error('Backup file permissions are not restricted');
  }

  return Object.freeze({
    bytes: encrypted.byteLength,
    sha256: createHash('sha256').update(encrypted).digest('hex'),
  });
}

export async function restoreEncryptedBackup(config, inputPath, targetDatabase, backupKeyBase64) {
  assertDatabaseName(config.database, 'Source');
  assertDatabaseName(targetDatabase, 'Target');

  if (targetDatabase === config.database || !targetDatabase.endsWith('_test')) {
    throw new Error('Restore target must be a different database ending in _test');
  }

  const encrypted = await readFile(inputPath);
  const dump = decryptedBackup(encrypted, parseBackupKey(backupKeyBase64));
  runDocker([
    'exec',
    config.name,
    'psql',
    '--username',
    config.user,
    '--dbname',
    'postgres',
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `CREATE DATABASE "${targetDatabase}" OWNER "${config.user}"`,
  ]);
  runDocker(
    [
      'exec',
      '--interactive',
      config.name,
      'pg_restore',
      '--username',
      config.user,
      '--dbname',
      targetDatabase,
      '--exit-on-error',
      '--no-owner',
      '--no-acl',
    ],
    dump,
  );
  return Object.freeze({ targetDatabase, restoredBytes: dump.byteLength });
}

async function main() {
  const [command, path] = process.argv.slice(2);

  if (command !== 'backup' || path === undefined) {
    throw new Error('Usage: backup-restore.mjs backup <new-output-path>');
  }

  const result = await createEncryptedBackup(
    developmentContainer,
    path,
    process.env.AIPAY_BACKUP_KEY,
  );
  process.stdout.write(
    `Encrypted PostgreSQL backup created (${String(result.bytes)} bytes, sha256=${result.sha256})\n`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
