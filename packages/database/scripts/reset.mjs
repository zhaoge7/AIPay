import { resetDatabase } from './database-admin.mjs';
import { runMigrations } from './migration-runner.mjs';
import { loadDatabaseUrl } from './script-config.mjs';

const databaseUrl = loadDatabaseUrl();
await resetDatabase(databaseUrl);
await runMigrations(databaseUrl);
