import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import test from 'node:test';

import { createMoney, parseResourceId } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';
import { evaluateAmountCountPolicy, evaluateMerchantCategoryPolicy } from '@aipay/policy';

import { BudgetReservationError, BudgetReservationService } from '../dist/mandates/reservations.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

test('covers the complete P4 policy allow/deny/expiry/revoke/concurrency/retry matrix', async (context) => {
  const container = {
    name: `aipay-policy-matrix-test-${process.pid}`,
    database: 'aipay_policy_matrix_test',
    user: 'aipay',
    password: 'policy-matrix-test-only',
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
      email: 'matrix@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Matrix Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const key = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'system',
      developerId: null,
      agentId: null,
      merchantId: null,
      publicKey: Buffer.alloc(32, 13),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agentId = parseResourceId(`agt_${agent.id}`, 'agt');

  async function seedMandate({
    purpose,
    total = '1000',
    maxPerTransaction = '600',
    maxTransactions = 3,
    status = 'active',
    validUntil = new Date(Date.now() + 60_000),
  }) {
    const createdAt = new Date();
    const row = await database
      .insertInto('mandates')
      .values({
        principalId: developer.id,
        agentId: agent.id,
        purpose,
        maxPerTransactionAmountMinor: maxPerTransaction,
        totalBudgetAmountMinor: total,
        approvalRequiredAboveAmountMinor: '500',
        maxTransactions,
        issuedAt: new Date(Date.now() - 1_000),
        validUntil,
        instructionHash: Buffer.alloc(32, purpose.length % 255),
        proofKeyId: key.id,
        proofValue: Buffer.alloc(64, (purpose.length + 1) % 255),
        status,
        createdAt,
        statusChangedAt: createdAt,
        revokedAt: status === 'revoked' ? createdAt : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return parseResourceId(`mdt_${row.id}`, 'mdt');
  }

  const results = [];

  const allowedMandate = await seedMandate({ purpose: 'matrix allow and retry' });
  const allowedService = new BudgetReservationService(database);
  const allowedReservation = await allowedService.reserve(allowedMandate, agentId, '300');
  const firstConfirmation = await allowedService.confirm(allowedReservation.reservationId);
  const retriedConfirmation = await allowedService.confirm(allowedReservation.reservationId);
  assert.deepEqual(retriedConfirmation, firstConfirmation);
  results.push(['allow', firstConfirmation.status, firstConfirmation.finalizationReason]);
  results.push([
    'retry-confirm',
    retriedConfirmation.status,
    retriedConfirmation.finalizationReason,
  ]);

  const merchantAllowed = parseResourceId('mch_01890f3e-a000-7cc2-98c5-7f6a1b2c3d4e', 'mch');
  const merchantDenied = parseResourceId('mch_01890f3e-a001-7cc2-a8c5-7f6a1b2c3d4e', 'mch');
  const scope = {
    allowedMerchantIds: [merchantAllowed],
    allowedCategories: ['data.weather'],
  };
  assert.deepEqual(
    evaluateMerchantCategoryPolicy(scope, {
      merchantId: merchantDenied,
      category: 'data.weather',
    }),
    { allowed: false, reason: 'merchant_not_allowed' },
  );
  assert.deepEqual(
    evaluateMerchantCategoryPolicy(scope, {
      merchantId: merchantAllowed,
      category: 'data.finance',
    }),
    { allowed: false, reason: 'category_not_allowed' },
  );
  assert.deepEqual(
    evaluateAmountCountPolicy(
      {
        maxPerTransaction: createMoney('CNY', '600'),
        totalBudget: createMoney('CNY', '1000'),
        maxTransactions: 3,
      },
      { spentAmountMinor: '0', completedTransactionCount: 0 },
      createMoney('CNY', '601'),
    ),
    { allowed: false, reason: 'per_transaction_exceeded' },
  );
  results.push(['deny', 'merchant/category/amount', 'stable-reasons']);

  const expiryBoundary = new Date(Date.now() + 10_000);
  const expiredMandate = await seedMandate({
    purpose: 'matrix expiry',
    validUntil: expiryBoundary,
  });
  const expiredService = new BudgetReservationService(
    database,
    () => new Date(expiryBoundary.getTime()),
  );
  await assert.rejects(
    expiredService.reserve(expiredMandate, agentId, '100'),
    (error) => error instanceof BudgetReservationError && error.code === 'expired',
  );
  const expiredRow = await database
    .selectFrom('mandates')
    .select('status')
    .where('id', '=', expiredMandate.slice(4))
    .executeTakeFirstOrThrow();
  assert.equal(expiredRow.status, 'expired');
  results.push(['expiry', 'rejected', 'persisted-expired']);

  const revokedMandate = await seedMandate({
    purpose: 'matrix revoked',
    status: 'revoked',
  });
  await assert.rejects(
    allowedService.reserve(revokedMandate, agentId, '100'),
    (error) => error instanceof BudgetReservationError && error.code === 'inactive',
  );
  results.push(['revoke', 'rejected', 'inactive']);

  const concurrentMandate = await seedMandate({
    purpose: 'matrix concurrency',
    total: '1000',
    maxPerTransaction: '600',
  });
  const concurrent = await Promise.allSettled([
    allowedService.reserve(concurrentMandate, agentId, '600'),
    allowedService.reserve(concurrentMandate, agentId, '600'),
  ]);
  assert.equal(concurrent.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(({ status }) => status === 'rejected').length, 1);
  results.push(['concurrency', 'one-allowed', 'one-budget-denied']);

  const retryReleaseMandate = await seedMandate({ purpose: 'matrix release retry' });
  const releaseReservation = await allowedService.reserve(retryReleaseMandate, agentId, '200');
  const firstRelease = await allowedService.release(
    releaseReservation.reservationId,
    'payment_failed',
  );
  const retryRelease = await allowedService.release(
    releaseReservation.reservationId,
    'payment_failed',
  );
  assert.deepEqual(retryRelease, firstRelease);
  results.push(['retry-release', retryRelease.status, retryRelease.finalizationReason]);

  assert.deepEqual(results, [
    ['allow', 'confirmed', 'payment_succeeded'],
    ['retry-confirm', 'confirmed', 'payment_succeeded'],
    ['deny', 'merchant/category/amount', 'stable-reasons'],
    ['expiry', 'rejected', 'persisted-expired'],
    ['revoke', 'rejected', 'inactive'],
    ['concurrency', 'one-allowed', 'one-budget-denied'],
    ['retry-release', 'released', 'payment_failed'],
  ]);
});
