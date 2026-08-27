import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadApiConfig, loadDatabaseConfig, loadMandateIssuerConfig } from '@aipay/config';
import { createDatabase } from '@aipay/database';

import { buildApp } from './app.js';
import { MandateIssuer } from './mandates/issuer.js';

export const config = loadApiConfig(process.env);

export async function startApi() {
  const databaseConfig = loadDatabaseConfig(process.env);
  const database = createDatabase(databaseConfig.url);
  const mandateIssuer = new MandateIssuer(database, loadMandateIssuerConfig(process.env));
  const app = await buildApp({
    database,
    secureCookies: config.environment === 'production',
    logger: true,
    mandateIssuer,
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
export { AgentSignatureError, AgentSignatureService } from './agent-signatures/service.js';
export { MerchantError, MerchantService } from './merchants/service.js';
export { ServiceCatalogService, ServiceError } from './services/service.js';
export { MandateDraftError, MandateDraftService } from './mandates/service.js';
export { MandateIssuer, MandateIssuerError, MandateVerifier } from './mandates/issuer.js';
export { MandateLifecycleError, MandateLifecycleService } from './mandates/lifecycle.js';
export { MandateUsageError, MandateUsageService } from './mandates/usage.js';
export { BudgetReservationError, BudgetReservationService } from './mandates/reservations.js';
export { ManualApprovalError, ManualApprovalService } from './transactions/manual-approval.js';
export { QuoteDraftError, QuoteDraftService } from './quotes/drafts.js';
export { QuoteSigningError, QuoteSigningService } from './quotes/signing.js';
export { TransactionCreationError, TransactionCreationService } from './transactions/create.js';
export { PaymentExecutionError, PaymentExecutionService } from './payments/execution.js';
export { ARGON2ID_OPTIONS, hashPassword, verifyPassword } from './auth/password.js';
