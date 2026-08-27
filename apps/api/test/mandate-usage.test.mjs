import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import test from 'node:test';

import { parseResourceId } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';

import { MandateUsageError, MandateUsageService } from '../dist/mandates/usage.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

test('atomically enforces single, cumulative and count limits under concurrency', async (context) => {
  const container = {
    name: `aipay-mandate-usage-test-${process.pid}`,
    database: 'aipay_mandate_usage_test',
    user: 'aipay',
    password: 'mandate-usage-test-only',
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
      email: 'usage@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Usage Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const issuerKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'system',
      developerId: null,
      agentId: null,
      merchantId: null,
      publicKey: Buffer.alloc(32, 1),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandate = await database
    .insertInto('mandates')
    .values({
      principalId: developer.id,
      agentId: agent.id,
      purpose: 'Usage limit integration test',
      maxPerTransactionAmountMinor: '600',
      totalBudgetAmountMinor: '1000',
      approvalRequiredAboveAmountMinor: '500',
      maxTransactions: 2,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 2),
      proofKeyId: issuerKey.id,
      proofValue: Buffer.alloc(64, 3),
      status: 'active',
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandateId = parseResourceId(`mdt_${mandate.id}`, 'mdt');
  const agentId = parseResourceId(`agt_${agent.id}`, 'agt');
  const service = new MandateUsageService(database);

  await assert.rejects(
    service.recordCompletedSpend(mandateId, agentId, '0'),
    (error) => error instanceof MandateUsageError && error.code === 'non_positive_amount',
  );
  await assert.rejects(
    service.recordCompletedSpend(mandateId, agentId, '601'),
    (error) => error instanceof MandateUsageError && error.code === 'per_transaction_exceeded',
  );

  const concurrent = await Promise.allSettled([
    service.recordCompletedSpend(mandateId, agentId, '600'),
    service.recordCompletedSpend(mandateId, agentId, '600'),
  ]);
  assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
  const rejection = concurrent.find((result) => result.status === 'rejected');
  assert.equal(rejection?.reason instanceof MandateUsageError, true);
  assert.equal(rejection?.reason.code, 'total_budget_exceeded');

  let stored = await database
    .selectFrom('mandates')
    .select(['spentAmountMinor', 'completedTransactionCount'])
    .where('id', '=', mandate.id)
    .executeTakeFirstOrThrow();
  assert.deepEqual(stored, { spentAmountMinor: '600', completedTransactionCount: 1 });

  const filled = await service.recordCompletedSpend(mandateId, agentId, '400');
  assert.deepEqual(filled, {
    mandateId,
    spentAmountMinor: '1000',
    completedTransactionCount: 2,
  });
  await assert.rejects(
    service.recordCompletedSpend(mandateId, agentId, '1'),
    (error) => error instanceof MandateUsageError && error.code === 'transaction_count_exceeded',
  );

  const wrongAgentId = parseResourceId('agt_01890f3e-9f00-7cc2-98c5-7f6a1b2c3d4e', 'agt');
  await assert.rejects(
    service.recordCompletedSpend(mandateId, wrongAgentId, '1'),
    (error) => error instanceof MandateUsageError && error.code === 'agent_unavailable',
  );

  stored = await database
    .selectFrom('mandates')
    .select(['spentAmountMinor', 'completedTransactionCount'])
    .where('id', '=', mandate.id)
    .executeTakeFirstOrThrow();
  assert.deepEqual(stored, { spentAmountMinor: '1000', completedTransactionCount: 2 });
});
