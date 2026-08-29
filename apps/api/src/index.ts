import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadApiConfig, loadDatabaseConfig, loadMandateIssuerConfig } from '@aipay/config';
import { createDatabase } from '@aipay/database';
import { AlipayA2MClient } from '@aipay/payment';

import { buildApp } from './app.js';
import { loadA2MRuntimeConfig } from './a2m/config.js';
import { A2MService } from './a2m/service.js';
import { MandateIssuer } from './mandates/issuer.js';

export const config = loadApiConfig(process.env);

export async function startApi() {
  const databaseConfig = loadDatabaseConfig(process.env);
  const database = createDatabase(databaseConfig.url);
  const mandateIssuer = new MandateIssuer(database, loadMandateIssuerConfig(process.env));
  const a2mConfig = await loadA2MRuntimeConfig(process.env);
  const a2mService = new A2MService(database, new AlipayA2MClient(a2mConfig), a2mConfig);
  const app = await buildApp({
    database,
    secureCookies: config.environment === 'production',
    logger: true,
    mandateIssuer,
    a2mService,
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
export { PaymentWebhookError, PaymentWebhookService } from './payments/webhook.js';
export { RefundExecutionError, RefundExecutionService } from './payments/refunds.js';
export { PaymentProofError, PaymentProofIssuer } from './payments/proofs.js';
export { DeliveryReceiptError, DeliveryReceiptService } from './deliveries/receipts.js';
export { DeliveryTimeoutService } from './deliveries/timeouts.js';
export { ReconciliationService } from './reconciliation/service.js';
export { TimelineError, TransactionTimelineService } from './timeline/service.js';
export { loadA2MRuntimeConfig, type A2MRuntimeConfig } from './a2m/config.js';
export { A2MError, A2MService, type A2MClientPort } from './a2m/service.js';
export { ARGON2ID_OPTIONS, hashPassword, verifyPassword } from './auth/password.js';
