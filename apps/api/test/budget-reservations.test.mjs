import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import test from 'node:test';

import { parseResourceId } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';

import { BudgetReservationError, BudgetReservationService } from '../dist/mandates/reservations.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

test('atomically reserves budget so concurrent requests cannot exceed limits', async (context) => {
  const container = {
    name: `aipay-budget-reservation-test-${process.pid}`,
    database: 'aipay_budget_reservation_test',
    user: 'aipay',
    password: 'budget-reservation-test-only',
  };
  let database;
  context.after(async () => {
    await database?.destroy();
    removePostgresContainer(container.name);
  });

  const { databaseUrl } = await startPostgresContainer(container);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 6 });
  const developer = await database
    .insertInto('developers')
    .values({
      email: 'reservation@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Reservation Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const issuerKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'system',
      developerId: null,
      agentId: null,
      merchantId: null,
      publicKey: Buffer.alloc(32, 4),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandate = await database
    .insertInto('mandates')
    .values({
      principalId: developer.id,
      agentId: agent.id,
      purpose: 'Atomic reservation integration test',
      maxPerTransactionAmountMinor: '600',
      totalBudgetAmountMinor: '1000',
      approvalRequiredAboveAmountMinor: '500',
      maxTransactions: 2,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 5),
      proofKeyId: issuerKey.id,
      proofValue: Buffer.alloc(64, 6),
      status: 'active',
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandateId = parseResourceId(`mdt_${mandate.id}`, 'mdt');
  const agentId = parseResourceId(`agt_${agent.id}`, 'agt');
  const service = new BudgetReservationService(database);

  const concurrent = await Promise.allSettled([
    service.reserve(mandateId, agentId, '600'),
    service.reserve(mandateId, agentId, '600'),
  ]);
  const fulfilled = concurrent.filter((result) => result.status === 'fulfilled');
  const rejected = concurrent.find((result) => result.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.match(fulfilled[0].value.reservationId, /^rsv_[0-9a-f-]{36}$/u);
  assert.equal(fulfilled[0].value.status, 'held');
  assert.equal(rejected?.reason instanceof BudgetReservationError, true);
  assert.equal(rejected?.reason.code, 'total_budget_exceeded');

  let counters = await database
    .selectFrom('mandates')
    .select([
      'spentAmountMinor',
      'completedTransactionCount',
      'reservedAmountMinor',
      'reservedTransactionCount',
    ])
    .where('id', '=', mandate.id)
    .executeTakeFirstOrThrow();
  assert.deepEqual(counters, {
    spentAmountMinor: '0',
    completedTransactionCount: 0,
    reservedAmountMinor: '600',
    reservedTransactionCount: 1,
  });

  const exactBoundary = await service.reserve(mandateId, agentId, '400');
  assert.equal(exactBoundary.amount.amountMinor, '400');
  counters = await database
    .selectFrom('mandates')
    .select([
      'spentAmountMinor',
      'completedTransactionCount',
      'reservedAmountMinor',
      'reservedTransactionCount',
    ])
    .where('id', '=', mandate.id)
    .executeTakeFirstOrThrow();
  assert.deepEqual(counters, {
    spentAmountMinor: '0',
    completedTransactionCount: 0,
    reservedAmountMinor: '1000',
    reservedTransactionCount: 2,
  });

  await assert.rejects(
    service.reserve(mandateId, agentId, '1'),
    (error) =>
      error instanceof BudgetReservationError && error.code === 'transaction_count_exceeded',
  );
  await assert.rejects(
    service.reserve(mandateId, agentId, '1', 999),
    (error) => error instanceof BudgetReservationError && error.code === 'invalid_ttl',
  );

  const reservations = await database
    .selectFrom('budgetReservations')
    .select(['status', 'amountMinor', 'finalizedAt'])
    .orderBy('amountMinor', 'desc')
    .execute();
  assert.deepEqual(
    reservations.map((row) => ({
      status: row.status,
      amountMinor: row.amountMinor,
      finalizedAt: row.finalizedAt,
    })),
    [
      { status: 'held', amountMinor: '600', finalizedAt: null },
      { status: 'held', amountMinor: '400', finalizedAt: null },
    ],
  );

  await assert.rejects(
    database
      .updateTable('mandates')
      .set({ reservedAmountMinor: '1001' })
      .where('id', '=', mandate.id)
      .executeTakeFirst(),
    (error) => error.code === '23514' && error.constraint === 'mandates_usage_amount_check',
  );
});
