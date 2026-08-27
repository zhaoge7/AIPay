import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import test from 'node:test';

import { parseResourceId } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';

import {
  ManualApprovalError,
  ManualApprovalService,
} from '../dist/transactions/manual-approval.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

test('creates pending transactions above threshold without executing payment', async (context) => {
  const container = {
    name: `aipay-manual-approval-test-${process.pid}`,
    database: 'aipay_manual_approval_test',
    user: 'aipay',
    password: 'manual-approval-test-only',
  };
  let database;
  context.after(async () => {
    await database?.destroy();
    removePostgresContainer(container.name);
  });

  const { databaseUrl } = await startPostgresContainer(container);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 4 });
  const developer = await database
    .insertInto('developers')
    .values({
      email: 'approval@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const otherDeveloper = await database
    .insertInto('developers')
    .values({
      email: 'approval-other@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Approval Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'Approval Merchant',
      callbackUrl: 'https://approval.example.com/webhook',
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
      publicKey: Buffer.alloc(32, 10),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const service = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Approval Service',
      category: 'data.approval',
      unit: 'request',
      unitPriceAmountMinor: '600',
      refundPolicy: 'full_on_delivery_failure',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandate = await database
    .insertInto('mandates')
    .values({
      principalId: developer.id,
      agentId: agent.id,
      purpose: 'Manual approval integration test',
      maxPerTransactionAmountMinor: '1000',
      totalBudgetAmountMinor: '5000',
      approvalRequiredAboveAmountMinor: '500',
      maxTransactions: 10,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 11),
      proofKeyId: key.id,
      proofValue: Buffer.alloc(64, 12),
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
    .values({ mandateId: mandate.id, category: 'data.approval' })
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
        proofKeyId: key.id,
        proofValue: Buffer.alloc(64, Number(amountMinor) % 255),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  const approval = new ManualApprovalService(database);
  const mandateId = parseResourceId(`mdt_${mandate.id}`, 'mdt');
  const agentId = parseResourceId(`agt_${agent.id}`, 'agt');
  const quote600 = await quote('600');
  const pending = await approval.createPendingIntent(
    mandateId,
    parseResourceId(`qte_${quote600.id}`, 'qte'),
    agentId,
  );
  assert.equal(pending.status, 'requires_confirmation');
  assert.equal(pending.amount.amountMinor, '600');

  const attemptsBefore = await database
    .selectFrom('paymentAttempts')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  const reservationsBefore = await database
    .selectFrom('budgetReservations')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(Number(attemptsBefore.count), 0);
  assert.equal(Number(reservationsBefore.count), 0);

  await database
    .updateTable('mandates')
    .set({ status: 'paused', statusChangedAt: new Date() })
    .where('id', '=', mandate.id)
    .executeTakeFirstOrThrow();
  await assert.rejects(
    approval.decide(
      parseResourceId(`dev_${developer.id}`, 'dev'),
      pending.transactionId,
      'approve',
    ),
    (error) => error instanceof ManualApprovalError && error.code === 'inactive_mandate',
  );
  await database
    .updateTable('mandates')
    .set({ status: 'active', statusChangedAt: new Date() })
    .where('id', '=', mandate.id)
    .executeTakeFirstOrThrow();
  await assert.rejects(
    approval.decide(
      parseResourceId(`dev_${otherDeveloper.id}`, 'dev'),
      pending.transactionId,
      'approve',
    ),
    (error) => error instanceof ManualApprovalError && error.code === 'not_found',
  );
  const authorized = await approval.decide(
    parseResourceId(`dev_${developer.id}`, 'dev'),
    pending.transactionId,
    'approve',
  );
  assert.equal(authorized.status, 'authorized');
  assert.deepEqual(
    await approval.decide(
      parseResourceId(`dev_${developer.id}`, 'dev'),
      pending.transactionId,
      'approve',
    ),
    authorized,
  );

  const quote700 = await quote('700');
  const pendingRejected = await approval.createPendingIntent(
    mandateId,
    parseResourceId(`qte_${quote700.id}`, 'qte'),
    agentId,
  );
  const cancelled = await approval.decide(
    parseResourceId(`dev_${developer.id}`, 'dev'),
    pendingRejected.transactionId,
    'reject',
  );
  assert.equal(cancelled.status, 'cancelled');

  const quote500 = await quote('500');
  await assert.rejects(
    approval.createPendingIntent(mandateId, parseResourceId(`qte_${quote500.id}`, 'qte'), agentId),
    (error) => error instanceof ManualApprovalError && error.code === 'approval_not_required',
  );

  const transactionCount = await database
    .selectFrom('transactions')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  const attemptsAfter = await database
    .selectFrom('paymentAttempts')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  const reservationsAfter = await database
    .selectFrom('budgetReservations')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(Number(transactionCount.count), 2);
  assert.equal(Number(attemptsAfter.count), 0);
  assert.equal(Number(reservationsAfter.count), 0);
});
