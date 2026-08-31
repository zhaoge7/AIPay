import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';

import { parseResourceId } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';
import { FakePaymentProvider } from '@aipay/payment';
import { WebhookDispatcher } from '@aipay/worker/dist/webhooks/dispatcher.js';
import { Ed25519WebhookSigner } from '@aipay/worker/dist/webhooks/signing.js';

import { AgentService } from '../dist/agents/service.js';
import { PaymentControlService } from '../dist/controls/service.js';
import { PaymentExecutionError, PaymentExecutionService } from '../dist/payments/execution.js';
import { TransactionTimelineService } from '../dist/timeline/service.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

class NotificationTransport {
  requests = [];

  async deliver(request) {
    this.requests.push(request);
    return { statusCode: 204 };
  }
}

test('drills containment, transaction recovery and signed notification', async (context) => {
  const container = {
    name: `aipay-incident-${process.pid}`,
    database: 'aipay_incident_test',
    user: 'aipay',
    password: 'incident-test-only',
  };
  let database;
  context.after(async () => {
    await database?.destroy();
    removePostgresContainer(container.name);
  });

  const { databaseUrl } = await startPostgresContainer(container);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 8 });
  const developer = await database
    .insertInto('developers')
    .values({
      email: 'incident@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Incident Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agentKeys = generateKeyPairSync('ed25519');
  await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'agent',
      developerId: null,
      agentId: agent.id,
      merchantId: null,
      publicKey: agentKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
      revokedAt: null,
    })
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'Incident Merchant',
      callbackUrl: 'https://incident.example/webhook',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const systemKeys = generateKeyPairSync('ed25519');
  const systemKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'system',
      developerId: null,
      agentId: null,
      merchantId: null,
      publicKey: systemKeys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const service = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Incident Service',
      category: 'data.incident',
      unit: 'request',
      unitPriceAmountMinor: '200',
      refundPolicy: 'full_on_delivery_failure',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandate = await database
    .insertInto('mandates')
    .values({
      principalId: developer.id,
      agentId: agent.id,
      purpose: 'Incident recovery drill',
      maxPerTransactionAmountMinor: '1000',
      totalBudgetAmountMinor: '5000',
      approvalRequiredAboveAmountMinor: '1000',
      maxTransactions: 10,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 90),
      proofKeyId: systemKey.id,
      proofValue: Buffer.alloc(64, 91),
      status: 'active',
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const quote = await database
    .insertInto('quotes')
    .values({
      merchantId: merchant.id,
      serviceId: service.id,
      unit: 'request',
      quantity: 1,
      unitPriceAmountMinor: '200',
      subtotalAmountMinor: '200',
      taxBehavior: 'inclusive',
      taxAmountMinor: '0',
      totalAmountMinor: '200',
      issuedAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 60_000),
      proofKeyId: systemKey.id,
      proofValue: Buffer.alloc(64, 92),
      status: 'active',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const paymentTransaction = await database
    .insertInto('transactions')
    .values({
      quoteId: quote.id,
      mandateId: mandate.id,
      principalId: developer.id,
      agentId: agent.id,
      merchantId: merchant.id,
      serviceId: service.id,
      amountMinor: '200',
      status: 'authorized',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const developerId = parseResourceId(`dev_${developer.id}`, 'dev');
  const agentId = parseResourceId(`agt_${agent.id}`, 'agt');
  const transactionId = parseResourceId(`txn_${paymentTransaction.id}`, 'txn');

  const controls = new PaymentControlService(database);
  assert.equal((await controls.set(developerId, true)).paymentsPaused, true);
  assert.equal(
    (await new AgentService(database).setStatus(developerId, agentId, 'disabled')).status,
    'disabled',
  );

  const provider = new FakePaymentProvider({ webhookSecret: 'incident-provider-secret' });
  provider.enqueuePaymentOutcome('timeout');
  const beforeRestart = new PaymentExecutionService(
    database,
    'https://aipay.example/webhooks/fake',
  );
  await assert.rejects(
    beforeRestart.create(transactionId, provider),
    (error) => error instanceof PaymentExecutionError && error.providerCode === 'TIMEOUT',
  );
  const attempt = await database
    .selectFrom('paymentAttempts')
    .select('id')
    .where('transactionId', '=', paymentTransaction.id)
    .executeTakeFirstOrThrow();
  const attemptId = parseResourceId(`pat_${attempt.id}`, 'pat');
  const afterRestart = new PaymentExecutionService(database, 'https://aipay.example/webhooks/fake');
  const retried = await afterRestart.retryCreate(attemptId, provider);
  provider.setPaymentStatus(retried.providerReference, 'succeeded');
  assert.equal((await afterRestart.query(attemptId, provider)).status, 'succeeded');

  const transport = new NotificationTransport();
  const dispatcher = new WebhookDispatcher(
    database,
    new Ed25519WebhookSigner(
      `key_${systemKey.id}`,
      systemKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    ),
    transport,
  );
  const dispatchResults = await dispatcher.claimAndDeliver('incident-worker', 10);
  assert.ok(dispatchResults.length >= 2);
  assert.equal(
    dispatchResults.every(({ status }) => status === 'delivered'),
    true,
  );
  assert.equal(transport.requests.length, dispatchResults.length);
  const timeline = await new TransactionTimelineService(database).get(developerId, transactionId);
  assert.equal(timeline.transaction.status, 'paid');
  assert.equal(
    timeline.events.some(({ eventType }) => eventType === 'payment.provider_call'),
    true,
  );
  assert.equal((await controls.get(developerId)).paymentsPaused, true);
});
