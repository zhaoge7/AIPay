import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import test from 'node:test';

import { createDatabase } from '@aipay/database';
import { PaymentProviderError } from '@aipay/payment';

import { ReconciliationService } from '../dist/reconciliation/service.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

test('finds, repairs and records daily payment and refund discrepancies', async (context) => {
  const container = {
    name: `aipay-reconciliation-${process.pid}`,
    database: 'aipay_reconciliation_test',
    user: 'aipay',
    password: 'reconciliation-only',
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
      email: 'reconciliation@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Reconciliation Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'Reconciliation Merchant',
      callbackUrl: 'https://reconciliation.example.com/webhook',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const systemKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'system',
      developerId: null,
      agentId: null,
      merchantId: null,
      publicKey: Buffer.alloc(32, 101),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchantKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'merchant',
      developerId: null,
      agentId: null,
      merchantId: merchant.id,
      publicKey: Buffer.alloc(32, 102),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const catalogService = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Reconciliation API',
      category: 'data.reconciliation',
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
      purpose: 'Daily channel reconciliation',
      maxPerTransactionAmountMinor: '1000',
      totalBudgetAmountMinor: '10000',
      approvalRequiredAboveAmountMinor: '1000',
      maxTransactions: 100,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 103),
      proofKeyId: systemKey.id,
      proofValue: Buffer.alloc(64, 104),
      status: 'active',
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  async function payment(label, transactionStatus, attemptStatus, providerReference) {
    const quote = await database
      .insertInto('quotes')
      .values({
        merchantId: merchant.id,
        serviceId: catalogService.id,
        unit: 'request',
        quantity: 1,
        unitPriceAmountMinor: '200',
        subtotalAmountMinor: '200',
        taxBehavior: 'inclusive',
        taxAmountMinor: '0',
        totalAmountMinor: '200',
        issuedAt: new Date(Date.now() - 1_000),
        expiresAt: new Date(Date.now() + 60_000),
        proofKeyId: merchantKey.id,
        proofValue: Buffer.alloc(64, label),
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
        serviceId: catalogService.id,
        amountMinor: '200',
        status: transactionStatus,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const attempt = await database
      .insertInto('paymentAttempts')
      .values({
        transactionId: paymentTransaction.id,
        attemptNumber: 1,
        provider: 'reconciliation_fake',
        providerReference,
        amountMinor: '200',
        status: attemptStatus,
        errorCode: attemptStatus === 'failed' ? 'OLD_FAILURE' : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { transactionId: paymentTransaction.id, attemptId: attempt.id };
  }

  const repairPayment = await payment(105, 'payment_pending', 'pending', 'pay_repair');
  const manualPayment = await payment(106, 'paid', 'succeeded', 'pay_manual');
  const refundPayment = await payment(107, 'refund_review', 'succeeded', 'pay_refund');
  const failedQueryPayment = await payment(108, 'payment_pending', 'pending', 'pay_query_error');
  const refund = await database
    .insertInto('refunds')
    .values({
      transactionId: refundPayment.transactionId,
      paymentAttemptId: refundPayment.attemptId,
      amountMinor: '200',
      status: 'unknown',
      providerReference: 'refund_repair',
      errorCode: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const queryCalls = [];
  const provider = {
    name: 'reconciliation_fake',
    capabilities: {
      supportsActiveQuery: true,
      supportsRefunds: true,
      supportsWebhookSignatures: true,
    },
    async queryPayment(request) {
      queryCalls.push(['payment', request.providerPaymentId]);

      if (request.providerPaymentId === 'pay_query_error') {
        throw new PaymentProviderError({
          provider: 'reconciliation_fake',
          kind: 'retryable',
          code: 'CHANNEL_UNAVAILABLE',
        });
      }

      const status = request.providerPaymentId === 'pay_manual' ? 'failed' : 'succeeded';
      return {
        providerPaymentId: request.providerPaymentId,
        providerTransactionId: `external_${request.providerPaymentId}`,
        status,
        occurredAt: new Date().toISOString(),
        failureCode: status === 'failed' ? 'PROVIDER_REPORTED_FAILED' : null,
        action: null,
      };
    },
    async queryRefund(request) {
      queryCalls.push(['refund', request.providerRefundId]);
      return {
        providerRefundId: request.providerRefundId,
        status: 'succeeded',
        occurredAt: new Date().toISOString(),
        failureCode: null,
      };
    },
  };
  const now = new Date(Date.now() + 1_000);
  const businessDate = now.toISOString().slice(0, 10);
  const reconciliation = new ReconciliationService(database, () => now);
  const run = await reconciliation.run(provider, businessDate);

  assert.match(run.runId, /^rcn_/u);
  assert.deepEqual(
    {
      status: run.status,
      checkedCount: run.checkedCount,
      discrepancyCount: run.discrepancyCount,
      repairedCount: run.repairedCount,
    },
    { status: 'completed', checkedCount: 5, discrepancyCount: 4, repairedCount: 2 },
  );
  const callCount = queryCalls.length;
  assert.deepEqual(await reconciliation.run(provider, businessDate), run);
  assert.equal(queryCalls.length, callCount);

  const items = await database
    .selectFrom('reconciliationItems')
    .select([
      'entityType',
      'internalStatusBefore',
      'providerStatus',
      'internalStatusAfter',
      'resolution',
      'errorCode',
    ])
    .orderBy('entityType', 'asc')
    .orderBy('internalStatusBefore', 'asc')
    .execute();
  assert.deepEqual(items.map(({ resolution }) => resolution).sort(), [
    'consistent',
    'manual_review',
    'query_failed',
    'repaired',
    'repaired',
  ]);
  assert.deepEqual(
    items.find(({ resolution }) => resolution === 'manual_review'),
    {
      entityType: 'payment',
      internalStatusBefore: 'succeeded',
      providerStatus: 'failed',
      internalStatusAfter: 'succeeded',
      resolution: 'manual_review',
      errorCode: null,
    },
  );
  assert.equal(
    items.find(({ resolution }) => resolution === 'query_failed')?.errorCode,
    'CHANNEL_UNAVAILABLE',
  );
  const repairedStates = await database
    .selectFrom('transactions')
    .select(['id', 'status'])
    .where('id', 'in', [
      repairPayment.transactionId,
      manualPayment.transactionId,
      failedQueryPayment.transactionId,
      refundPayment.transactionId,
    ])
    .execute();
  const states = new Map(repairedStates.map(({ id, status }) => [id, status]));
  assert.equal(states.get(repairPayment.transactionId), 'paid');
  assert.equal(states.get(manualPayment.transactionId), 'paid');
  assert.equal(states.get(failedQueryPayment.transactionId), 'payment_review');
  assert.equal(states.get(refundPayment.transactionId), 'refunded');
  const storedRefund = await database
    .selectFrom('refunds')
    .select('status')
    .where('id', '=', refund.id)
    .executeTakeFirstOrThrow();
  assert.equal(storedRefund.status, 'succeeded');
  assert.equal(
    Number(
      (
        await database
          .selectFrom('paymentProviderCalls')
          .select(({ fn }) => fn.countAll().as('count'))
          .executeTakeFirstOrThrow()
      ).count,
    ),
    4,
  );
  assert.equal(
    Number(
      (
        await database
          .selectFrom('refundProviderCalls')
          .select(({ fn }) => fn.countAll().as('count'))
          .executeTakeFirstOrThrow()
      ).count,
    ),
    1,
  );
});
