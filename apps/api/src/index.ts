import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadApiConfig, loadDatabaseConfig } from '@aipay/config';
import { createDatabase } from '@aipay/database';

import { buildApp } from './app.js';

export const config = loadApiConfig(process.env);

export async function startApi() {
  const databaseConfig = loadDatabaseConfig(process.env);
  const database = createDatabase(databaseConfig.url);
  const app = await buildApp({
    database,
    secureCookies: config.environment === 'production',
    logger: true,
  });

  app.addHook('onClose', async () => database.destroy());
  await app.listen({ host: config.host, port: config.port });
  return app;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startApi();
}

export { buildApp } from './app.js';
export { AuthError, AuthService, type AuthResult } from './auth/service.js';
export { ApiKeyError, ApiKeyService } from './api-keys/service.js';
export { AgentError, AgentService } from './agents/service.js';
export { ARGON2ID_OPTIONS, hashPassword, verifyPassword } from './auth/password.js';
