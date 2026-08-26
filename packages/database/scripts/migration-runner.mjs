import console from 'node:console';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runner as migrate } from 'node-pg-migrate';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runMigrations(databaseUrl, logger = console.log) {
  return migrate({
    databaseUrl,
    dir: path.join(packageDirectory, 'migrations'),
    direction: 'up',
    migrationsTable: 'aipay_migrations',
    checkOrder: true,
    noLock: false,
    log: logger,
  });
}
