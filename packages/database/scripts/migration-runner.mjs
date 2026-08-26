import console from 'node:console';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runner as migrate } from 'node-pg-migrate';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function runMigrations(databaseUrl, logger = console.log, options = {}) {
  return migrate({
    databaseUrl,
    dir: path.join(packageDirectory, 'migrations'),
    direction: options.direction ?? 'up',
    count: options.count ?? Infinity,
    migrationsTable: 'aipay_migrations',
    checkOrder: true,
    noLock: false,
    log: logger,
  });
}
