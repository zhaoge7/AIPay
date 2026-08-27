import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import test from 'node:test';

import { parseResourceId } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';
import { FakePaymentProvider } from '@aipay/payment';

import { PaymentExecutionError, PaymentExecutionService } from '../dist/payments/execution.js';
import { TransactionCreationService } from '../dist/transactions/create.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

test('runs Fake Provider success, failure, timeout recovery and duplicate requests end to end', async (context) => {
  const container = {
    name: `aipay-fake-provider-e2e-${process.pid}`,
    database: 'aipay_fake_provider_e2e_test',
    user: 'aipay',
    password: 'fake-provider-e2e-only',
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
      email: 'fake-provider-e2e@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Fake Provider E2E Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'Fake Provider E2E Merchant',
      callbackUrl: 'https://fake-provider-e2e.example.com/webhook',
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
      publicKey: Buffer.alloc(32, 70),
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
      publicKey: Buffer.alloc(32, 71),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const catalogService = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Fake Provider E2E Service',
      category: 'data.fake_e2e',
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
      purpose: 'Fake Provider end-to-end state machine',
      maxPerTransactionAmountMinor: '1000',
      totalBudgetAmountMinor: '5000',
      approvalRequiredAboveAmountMinor: '1000',
      maxTransactions: 10,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 72),
      proofKeyId: systemKey.id,
      proofValue: Buffer.alloc(64, 73),
      status: 'active',
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await database
    .insertInto('mandateAllowedMerchants')
    .values({ mandateId: mandate.id, merchantId: merchant.id })
    .execute();
  await database
    .insertInto('mandateAllowedCategories')
    .values({ mandateId: mandate.id, category: 'data.fake_e2e' })
    .execute();

  async function quote(label) {
    return database
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
  }

  const creation = new TransactionCreationService(database);
  const execution = new PaymentExecutionService(
    database,
    'https://aipay.example.com/provider-webhooks/fake',
  );
  const provider = new FakePaymentProvider({ webhookSecret: 'fake-provider-e2e-secret' });
  const agentId = parseResourceId(`agt_${agent.id}`, 'agt');
  const mandateId = parseResourceId(`mdt_${mandate.id}`, 'mdt');

  const successQuote = await quote(74);
  const createSuccess = () =>
    creation.create(
      agentId,
      parseResourceId(`qte_${successQuote.id}`, 'qte'),
      mandateId,
      'fake-e2e-success-key',
    );
  const [successTransaction, concurrentDuplicate] = await Promise.all([
    createSuccess(),
    createSuccess(),
  ]);
  assert.deepEqual(concurrentDuplicate, successTransaction);
  provider.enqueuePaymentOutcome('succeeded');
  const successAttempt = await execution.create(successTransaction.transactionId, provider);
  assert.equal(successAttempt.status, 'succeeded');
  await assert.rejects(
    execution.create(successTransaction.transactionId, provider),
    (error) => error instanceof PaymentExecutionError && error.code === 'invalid_state',
  );
  const postPaymentDuplicate = await createSuccess();
  assert.equal(postPaymentDuplicate.transactionId, successTransaction.transactionId);
  assert.equal(postPaymentDuplicate.status, 'paid');

  const failedQuote = await quote(75);
  const failedTransaction = await creation.create(
    agentId,
    parseResourceId(`qte_${failedQuote.id}`, 'qte'),
    mandateId,
    'fake-e2e-failed-key',
  );
  provider.enqueuePaymentOutcome('failed');
  const failedAttempt = await execution.create(failedTransaction.transactionId, provider);
  assert.equal(failedAttempt.status, 'failed');
  assert.equal(failedAttempt.errorCode, 'FAKE_PAYMENT_FAILED');

  const timeoutQuote = await quote(76);
  const timeoutTransaction = await creation.create(
    agentId,
    parseResourceId(`qte_${timeoutQuote.id}`, 'qte'),
    mandateId,
    'fake-e2e-timeout-key',
  );
  provider.enqueuePaymentOutcome('timeout');
  await assert.rejects(
    execution.create(timeoutTransaction.transactionId, provider),
    (error) =>
      error instanceof PaymentExecutionError &&
      error.code === 'provider_error' &&
      error.providerCode === 'TIMEOUT',
  );
  const timeoutAttemptRow = await database
    .selectFrom('paymentAttempts')
    .select('id')
    .where('transactionId', '=', timeoutTransaction.transactionId.slice(4))
    .executeTakeFirstOrThrow();
  const timeoutAttemptId = parseResourceId(`pat_${timeoutAttemptRow.id}`, 'pat');
  const firstRetry = await execution.retryCreate(timeoutAttemptId, provider);
  const repeatedRetry = await execution.retryCreate(timeoutAttemptId, provider);
  assert.equal(firstRetry.status, 'unknown');
  assert.equal(repeatedRetry.providerReference, firstRetry.providerReference);
  provider.setPaymentStatus(firstRetry.providerReference, 'succeeded');
  const recovered = await execution.query(timeoutAttemptId, provider);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.providerReference, firstRetry.providerReference);

  const duplicateWebhook = provider.paymentWebhook(
    firstRetry.providerReference,
    'fake-event-repeat',
  );
  const firstEvent = await provider.verifyWebhook(duplicateWebhook);
  const repeatedEvent = await provider.verifyWebhook(duplicateWebhook);
  assert.deepEqual(repeatedEvent, firstEvent);
  assert.equal(firstEvent.eventId, 'fake-event-repeat');
  assert.equal(provider.acknowledgeWebhook(firstEvent).statusCode, 200);

  const transactions = await database
    .selectFrom('transactions')
    .select(['id', 'status'])
    .orderBy('createdAt', 'asc')
    .execute();
  assert.deepEqual(
    transactions.map(({ status }) => status),
    ['paid', 'failed', 'paid'],
  );
  const attempts = await database
    .selectFrom('paymentAttempts')
    .select(['transactionId', 'providerReference', 'status'])
    .orderBy('createdAt', 'asc')
    .execute();
  assert.equal(attempts.length, 3);
  assert.deepEqual(
    attempts.map(({ status }) => status),
    ['succeeded', 'failed', 'succeeded'],
  );
  assert.equal(new Set(attempts.map(({ providerReference }) => providerReference)).size, 3);
  const calls = await database
    .selectFrom('paymentProviderCalls')
    .select(['operation', 'outcome', 'providerReference', 'errorCode'])
    .orderBy('startedAt', 'asc')
    .execute();
  assert.deepEqual(
    calls.map(({ operation }) => operation),
    [
      'payment.create',
      'payment.create',
      'payment.create',
      'payment.create',
      'payment.create',
      'payment.query',
    ],
  );
  assert.equal(calls.filter(({ errorCode }) => errorCode === 'TIMEOUT').length, 1);
  assert.equal(
    calls.filter(({ providerReference }) => providerReference === firstRetry.providerReference)
      .length,
    3,
  );
});
