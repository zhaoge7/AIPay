import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import test from 'node:test';
import { URL } from 'node:url';

import { createDatabase } from '@aipay/database';

import { buildApp } from '../dist/app.js';
import { MonitoringService } from '../dist/monitoring/service.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

test('exports aggregate payment safety metrics and defines actionable alerts', async (context) => {
  const container = {
    name: `aipay-monitoring-${process.pid}`,
    database: 'aipay_monitoring_test',
    user: 'aipay',
    password: 'monitoring-test-only',
  };
  let app;
  let database;
  context.after(async () => {
    await app?.close();
    await database?.destroy();
    removePostgresContainer(container.name);
  });

  const { databaseUrl } = await startPostgresContainer(container);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 6 });
  const developer = await database
    .insertInto('developers')
    .values({
      email: 'monitoring-private@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Monitoring Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'Monitoring Merchant',
      callbackUrl: 'https://monitoring.example/webhook',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const key = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'system',
      developerId: null,
      agentId: null,
      merchantId: null,
      publicKey: Buffer.alloc(32, 44),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const service = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Monitoring Service',
      category: 'data.monitoring',
      unit: 'request',
      unitPriceAmountMinor: '10',
      refundPolicy: 'full_on_delivery_failure',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandate = await database
    .insertInto('mandates')
    .values({
      principalId: developer.id,
      agentId: agent.id,
      purpose: 'Monitoring budget',
      maxPerTransactionAmountMinor: '100',
      totalBudgetAmountMinor: '100',
      approvalRequiredAboveAmountMinor: '100',
      maxTransactions: 100,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 45),
      proofKeyId: key.id,
      proofValue: Buffer.alloc(64, 46),
      status: 'active',
      spentAmountMinor: '95',
      completedTransactionCount: 1,
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
      unitPriceAmountMinor: '10',
      subtotalAmountMinor: '10',
      taxBehavior: 'inclusive',
      taxAmountMinor: '0',
      totalAmountMinor: '10',
      issuedAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 60_000),
      proofKeyId: key.id,
      proofValue: Buffer.alloc(64, 47),
      status: 'active',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const transaction = await database
    .insertInto('transactions')
    .values({
      quoteId: quote.id,
      mandateId: mandate.id,
      principalId: developer.id,
      agentId: agent.id,
      merchantId: merchant.id,
      serviceId: service.id,
      amountMinor: '10',
      status: 'paid',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const attempts = await database
    .insertInto('paymentAttempts')
    .values(
      Array.from({ length: 10 }, (_, index) => ({
        transactionId: transaction.id,
        attemptNumber: index + 1,
        provider: 'fake',
        providerReference: `monitoring_${String(index + 1)}`,
        amountMinor: '10',
        status: index < 3 ? 'failed' : 'succeeded',
        errorCode: index < 3 ? 'FAKE_PAYMENT_FAILED' : null,
      })),
    )
    .returning('id')
    .execute();
  const outbox = await database
    .insertInto('outboxEvents')
    .values(
      Array.from({ length: 101 }, (_, index) => ({
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        eventType: 'transaction.monitoring_test',
        payload: { index },
        publishedAt: null,
        lastErrorCode: null,
        lockedAt: null,
        lockedBy: null,
      })),
    )
    .returning('id')
    .execute();
  await database
    .insertInto('webhookDeliveries')
    .values(
      outbox.slice(0, 51).map(({ id }) => ({
        outboxEventId: id,
        merchantId: merchant.id,
        targetUrl: 'https://monitoring.example/webhook',
        nextAttemptAt: new Date(),
        lastStatusCode: null,
        lastErrorCode: null,
        deliveredAt: null,
      })),
    )
    .execute();
  const run = await database
    .insertInto('reconciliationRuns')
    .values({
      provider: 'fake',
      businessDate: '2026-08-30',
      errorCode: null,
      completedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await database
    .insertInto('reconciliationItems')
    .values({
      runId: run.id,
      entityType: 'payment',
      entityId: attempts[0].id,
      internalStatusBefore: 'succeeded',
      providerStatus: 'failed',
      internalStatusAfter: 'succeeded',
      resolution: 'manual_review',
      errorCode: null,
    })
    .executeTakeFirstOrThrow();

  const monitoring = new MonitoringService(database);
  assert.deepEqual(await monitoring.snapshot(), {
    paymentAttempts: 10,
    paymentFailures: 3,
    paymentFailureRatio: 0.3,
    outboxBacklog: 101,
    webhookBacklog: 51,
    reconciliationUnresolved: 1,
    mandatesNearExhaustion: 1,
    maximumBudgetUtilizationRatio: 0.95,
  });

  const metricsToken = 'monitoring-token-with-at-least-32-characters';
  app = await buildApp({ database, metricsToken });
  assert.equal((await app.inject({ method: 'GET', url: '/internal/metrics' })).statusCode, 401);
  const response = await app.inject({
    method: 'GET',
    url: '/internal/metrics',
    headers: { authorization: `Bearer ${metricsToken}` },
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /^text\/plain/u);
  assert.match(response.body, /aipay_payment_failure_ratio 0\.3/u);
  assert.match(response.body, /aipay_outbox_backlog 101/u);
  assert.equal(response.body.includes(developer.id), false);
  assert.equal(response.body.includes('monitoring-private@example.com'), false);

  const rules = await readFile(
    new URL('../../../ops/prometheus/aipay-alerts.yml', import.meta.url),
    'utf8',
  );
  for (const alert of [
    'AIPayHighPaymentFailureRate',
    'AIPayCallbackBacklog',
    'AIPayReconciliationDifference',
    'AIPayAbnormalBudgetConsumption',
    'AIPayMetricsUnavailable',
  ]) {
    assert.match(rules, new RegExp(`alert: ${alert}`, 'u'));
  }
});
