import { hostname } from 'node:os';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';

import { loadDatabaseConfig, loadMandateIssuerConfig, loadWorkerConfig } from '@aipay/config';
import { createDatabase } from '@aipay/database';

import { WebhookDispatcher } from '../dist/webhooks/dispatcher.js';
import { Ed25519WebhookSigner } from '../dist/webhooks/signing.js';
import { SafeWebhookTransport } from '../dist/webhooks/transport.js';
import { loadDeploymentConfig } from '../../../deploy/config.mjs';

if (process.env.AIPAY_CLOSED_TEST !== 'true' || process.env.NODE_ENV === 'production') {
  throw new Error('Closed-test Worker requires AIPAY_CLOSED_TEST=true outside production');
}

const workerConfig = loadWorkerConfig(process.env);
const database = createDatabase(loadDatabaseConfig(process.env).url, {
  maxConnections: Math.max(2, workerConfig.concurrency + 1),
});
const issuer = loadMandateIssuerConfig(process.env);
const deployment = loadDeploymentConfig(process.env);
const dispatcher = new WebhookDispatcher(
  database,
  new Ed25519WebhookSigner(issuer.keyId, issuer.privateKeyPkcs8Base64),
  new SafeWebhookTransport({ allowLoopbackHttp: deployment.allowLoopbackWebhooks }),
);
const workerId = `${hostname()}-${String(process.pid)}`;
let stopping = false;
process.once('SIGTERM', () => {
  stopping = true;
});
process.once('SIGINT', () => {
  stopping = true;
});

try {
  while (!stopping) {
    await Promise.all(
      Array.from({ length: workerConfig.concurrency }, () =>
        dispatcher.claimAndDeliver(workerId, 20),
      ),
    );
    await setTimeout(500);
  }
} finally {
  await database.destroy();
}
