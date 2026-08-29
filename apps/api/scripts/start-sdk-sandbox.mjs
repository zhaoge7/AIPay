import process from 'node:process';

import { loadApiConfig, loadDatabaseConfig, loadMandateIssuerConfig } from '@aipay/config';
import { createDatabase } from '@aipay/database';
import { AlipayA2MClient, FakePaymentProvider } from '@aipay/payment';

import { buildApp } from '../dist/app.js';
import { loadA2MRuntimeConfig } from '../dist/a2m/config.js';
import { A2MService } from '../dist/a2m/service.js';
import { MandateIssuer } from '../dist/mandates/issuer.js';
import { PaymentProofIssuer } from '../dist/payments/proofs.js';

if (process.env.NODE_ENV === 'production') {
  throw new Error('The SDK sandbox is forbidden in production');
}

const apiConfig = loadApiConfig(process.env);
const database = createDatabase(loadDatabaseConfig(process.env).url);
const issuerConfig = loadMandateIssuerConfig(process.env);
const provider = new FakePaymentProvider({
  webhookSecret: 'aipay-sdk-sandbox-local-only',
  defaultPaymentOutcome: 'succeeded',
  defaultRefundOutcome: 'succeeded',
});
const a2mConfig = await loadA2MRuntimeConfig(process.env);
const app = await buildApp({
  database,
  mandateIssuer: new MandateIssuer(database, issuerConfig),
  paymentProofIssuer: new PaymentProofIssuer(database, issuerConfig),
  paymentProvider: provider,
  a2mService: new A2MService(database, new AlipayA2MClient(a2mConfig), a2mConfig),
  paymentCallbackUrl: `http://${apiConfig.host}:${apiConfig.port}/v1/payments/fake/webhook`,
  logger: true,
});

app.addHook('onClose', async () => database.destroy());
await app.listen({ host: apiConfig.host, port: apiConfig.port });
