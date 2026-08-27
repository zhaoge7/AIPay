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

test('passes Gate P4 without allowing 25 concurrent requests to exceed budget', async (context) => {
  const container = {
    name: `aipay-gate-p4-${process.pid}`,
    database: 'aipay_gate_p4_test',
    user: 'aipay',
    password: 'gate-p4-only',
  };
  let database;
  context.after(async () => {
    await database?.destroy();
    removePostgresContainer(container.name);
  });

  const { databaseUrl } = await startPostgresContainer(container);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 16 });
  const developer = await database
    .insertInto('developers')
    .values({
      email: 'gate-p4@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Gate P4 Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const key = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'system',
      developerId: null,
      agentId: null,
      merchantId: null,
      publicKey: Buffer.alloc(32, 20),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandate = await database
    .insertInto('mandates')
    .values({
      principalId: developer.id,
      agentId: agent.id,
      purpose: 'Gate P4 concurrency proof',
      maxPerTransactionAmountMinor: '100',
      totalBudgetAmountMinor: '1000',
      approvalRequiredAboveAmountMinor: '100',
      maxTransactions: 10,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 21),
      proofKeyId: key.id,
      proofValue: Buffer.alloc(64, 22),
      status: 'active',
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const service = new BudgetReservationService(database);
  const mandateId = parseResourceId(`mdt_${mandate.id}`, 'mdt');
  const agentId = parseResourceId(`agt_${agent.id}`, 'agt');

  const outcomes = await Promise.allSettled(
    Array.from({ length: 25 }, () => service.reserve(mandateId, agentId, '100')),
  );
  const successes = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const denials = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(successes.length, 10);
  assert.equal(denials.length, 15);
  assert.equal(
    denials.every(
      ({ reason }) =>
        reason instanceof BudgetReservationError && reason.code === 'transaction_count_exceeded',
    ),
    true,
  );
  assert.equal(new Set(successes.map(({ value }) => value.reservationId)).size, 10);

  const counters = await database
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
    reservedTransactionCount: 10,
  });
  const heldCount = await database
    .selectFrom('budgetReservations')
    .select(({ fn }) => fn.countAll().as('count'))
    .where('status', '=', 'held')
    .executeTakeFirstOrThrow();
  assert.equal(Number(heldCount.count), 10);

  await Promise.all(
    successes.map(({ value }) => service.release(value.reservationId, 'cancelled')),
  );
  const releasedCounters = await database
    .selectFrom('mandates')
    .select(['reservedAmountMinor', 'reservedTransactionCount'])
    .where('id', '=', mandate.id)
    .executeTakeFirstOrThrow();
  assert.deepEqual(releasedCounters, {
    reservedAmountMinor: '0',
    reservedTransactionCount: 0,
  });
});
