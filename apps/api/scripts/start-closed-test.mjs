import process from 'node:process';

import {
  loadAlipayConfig,
  loadApiConfig,
  loadDatabaseConfig,
  loadMandateIssuerConfig,
} from '@aipay/config';
import { createDatabase } from '@aipay/database';
import { AlipayA2MClient, AlipayWebPaymentProvider, FakePaymentProvider } from '@aipay/payment';
import { Ed25519WebhookSigner } from '@aipay/worker';

import { buildApp } from '../dist/app.js';
import { loadA2MRuntimeConfig } from '../dist/a2m/config.js';
import { A2MService } from '../dist/a2m/service.js';
import { MandateIssuer } from '../dist/mandates/issuer.js';
import { PaymentProofIssuer } from '../dist/payments/proofs.js';
import { loadDeploymentConfig } from '../../../deploy/config.mjs';

if (process.env.AIPAY_CLOSED_TEST !== 'true' || process.env.NODE_ENV === 'production') {
  throw new Error('Closed-test API requires AIPAY_CLOSED_TEST=true outside production');
}

const apiConfig = loadApiConfig(process.env);
const database = createDatabase(loadDatabaseConfig(process.env).url);
const issuerConfig = loadMandateIssuerConfig(process.env);
const metricsToken = process.env.AIPAY_METRICS_TOKEN;
const deployment = loadDeploymentConfig(process.env);
const publicOrigin = deployment.publicOrigin;
const paymentProviderName = deployment.paymentProvider;

if (metricsToken === undefined) {
  throw new Error('AIPAY_METRICS_TOKEN is required');
}

const callbackUrl =
  paymentProviderName === 'fake'
    ? `${publicOrigin}/internal/closed-test/provider-callback`
    : `${publicOrigin}/v1/payments/alipay/webhook`;
const webPaymentProvider =
  paymentProviderName === 'fake'
    ? new FakePaymentProvider({
        webhookSecret: 'aipay-closed-test-provider-only',
        defaultPaymentOutcome: 'succeeded',
        defaultRefundOutcome: 'succeeded',
      })
    : (() => {
        const alipay = loadAlipayConfig(process.env);

        if (alipay.notifyUrl !== callbackUrl) {
          throw new Error('AIPAY_ALIPAY_NOTIFY_URL must match AIPAY_PUBLIC_ORIGIN');
        }

        return new AlipayWebPaymentProvider(alipay);
      })();

const a2mConfig = await loadA2MRuntimeConfig(process.env);
const signer = new Ed25519WebhookSigner(issuerConfig.keyId, issuerConfig.privateKeyPkcs8Base64);
const app = await buildApp({
  database,
  secureCookies: true,
  logger: true,
  mandateIssuer: new MandateIssuer(database, issuerConfig),
  paymentProofIssuer: new PaymentProofIssuer(database, issuerConfig),
  paymentProvider: webPaymentProvider,
  paymentCallbackUrl: callbackUrl,
  ...(paymentProviderName === 'alipay_web' ? { alipayProvider: webPaymentProvider } : {}),
  a2mService: new A2MService(database, new AlipayA2MClient(a2mConfig), a2mConfig),
  metricsToken,
  closedTestWebhookSigner: signer,
});

app.addHook('onClose', async () => database.destroy());
await app.listen({ host: apiConfig.host, port: apiConfig.port });
