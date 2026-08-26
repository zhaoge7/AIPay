import { loadDatabaseUrl } from './script-config.mjs';
import { runMigrations } from './migration-runner.mjs';

await runMigrations(loadDatabaseUrl());
