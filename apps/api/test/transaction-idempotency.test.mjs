import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';

import { parseResourceId } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';

import {
  TransactionCreationError,
  TransactionCreationService,
} from '../dist/transactions/create.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

test('returns one Transaction for concurrent and post-payment retries', async (context) => {
  const container = {
    name: `aipay-transaction-idempotency-test-${process.pid}`,
    database: 'aipay_transaction_idempotency_test',
    user: 'aipay',
    password: 'transaction-idempotency-only',
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
      email: 'idempotency@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Idempotent Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'Idempotent Merchant',
      callbackUrl: 'https://idempotency.example.com/webhook',
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
      publicKey: Buffer.alloc(32, 40),
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
      publicKey: Buffer.alloc(32, 41),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const service = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Idempotent Service',
      category: 'data.idempotent',
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
      purpose: 'End-to-end idempotency test',
      maxPerTransactionAmountMinor: '1000',
      totalBudgetAmountMinor: '5000',
      approvalRequiredAboveAmountMinor: '500',
      maxTransactions: 10,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 42),
      proofKeyId: systemKey.id,
      proofValue: Buffer.alloc(64, 43),
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
    .values({ mandateId: mandate.id, category: 'data.idempotent' })
    .execute();

  async function quote(amountMinor) {
    return database
      .insertInto('quotes')
      .values({
        merchantId: merchant.id,
        serviceId: service.id,
        unit: 'request',
        quantity: 1,
        unitPriceAmountMinor: amountMinor,
        subtotalAmountMinor: amountMinor,
        taxBehavior: 'inclusive',
        taxAmountMinor: '0',
        totalAmountMinor: amountMinor,
        issuedAt: new Date(Date.now() - 1_000),
        expiresAt: new Date(Date.now() + 60_000),
        proofKeyId: merchantKey.id,
        proofValue: Buffer.alloc(64, Number(amountMinor) % 255),
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  const firstQuote = await quote('200');
  const secondQuote = await quote('300');
  const agentId = parseResourceId(`agt_${agent.id}`, 'agt');
  const mandateId = parseResourceId(`mdt_${mandate.id}`, 'mdt');
  const firstQuoteId = parseResourceId(`qte_${firstQuote.id}`, 'qte');
  const secondQuoteId = parseResourceId(`qte_${secondQuote.id}`, 'qte');
  const idempotencyKey = 'txn-create-client-key-0001';
  const creator = new TransactionCreationService(database);
  const concurrent = await Promise.all([
    creator.create(agentId, firstQuoteId, mandateId, idempotencyKey),
    creator.create(agentId, firstQuoteId, mandateId, idempotencyKey),
  ]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  const transactionId = concurrent[0].transactionId;

  let transactionCount = await database
    .selectFrom('transactions')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  let idempotencyCount = await database
    .selectFrom('idempotencyRecords')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(Number(transactionCount.count), 1);
  assert.equal(Number(idempotencyCount.count), 1);

  const record = await database
    .selectFrom('idempotencyRecords')
    .select(['keyHash', 'requestHash', 'transactionId'])
    .executeTakeFirstOrThrow();
  assert.deepEqual(
    Buffer.from(record.keyHash),
    createHash('sha256').update(idempotencyKey).digest(),
  );
  assert.equal(record.requestHash.byteLength, 32);
  assert.equal(record.transactionId, transactionId.slice(4));
  assert.equal(JSON.stringify(record).includes(idempotencyKey), false);

  await database
    .updateTable('transactions')
    .set({ status: 'payment_pending', updatedAt: new Date() })
    .where('id', '=', transactionId.slice(4))
    .executeTakeFirstOrThrow();
  await database
    .insertInto('paymentAttempts')
    .values({
      transactionId: transactionId.slice(4),
      attemptNumber: 1,
      provider: 'fake',
      providerReference: 'fake_once',
      amountMinor: '200',
      status: 'pending',
      errorCode: null,
    })
    .execute();
  const afterPaymentRetry = await creator.create(agentId, firstQuoteId, mandateId, idempotencyKey);
  assert.equal(afterPaymentRetry.transactionId, transactionId);
  assert.equal(afterPaymentRetry.status, 'payment_pending');
  const attempts = await database
    .selectFrom('paymentAttempts')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(Number(attempts.count), 1);

  await assert.rejects(
    creator.create(agentId, secondQuoteId, mandateId, idempotencyKey),
    (error) => error instanceof TransactionCreationError && error.code === 'idempotency_conflict',
  );
  await assert.rejects(
    creator.create(agentId, firstQuoteId, mandateId, 'txn-create-client-key-0002'),
    (error) => error instanceof TransactionCreationError && error.code === 'transaction_exists',
  );
  await assert.rejects(
    creator.create(agentId, secondQuoteId, mandateId, 'short'),
    (error) =>
      error instanceof TransactionCreationError && error.code === 'invalid_idempotency_key',
  );

  transactionCount = await database
    .selectFrom('transactions')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  idempotencyCount = await database
    .selectFrom('idempotencyRecords')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(Number(transactionCount.count), 1);
  assert.equal(Number(idempotencyCount.count), 1);
});
