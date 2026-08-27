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

test('releases, expires and confirms reservations with exact budget transfers', async (context) => {
  const container = {
    name: `aipay-reservation-finalization-test-${process.pid}`,
    database: 'aipay_reservation_finalization_test',
    user: 'aipay',
    password: 'reservation-finalization-only',
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
      email: 'finalization@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Finalization Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const issuerKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'system',
      developerId: null,
      agentId: null,
      merchantId: null,
      publicKey: Buffer.alloc(32, 7),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandate = await database
    .insertInto('mandates')
    .values({
      principalId: developer.id,
      agentId: agent.id,
      purpose: 'Reservation finalization integration test',
      maxPerTransactionAmountMinor: '600',
      totalBudgetAmountMinor: '2000',
      approvalRequiredAboveAmountMinor: '500',
      maxTransactions: 5,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 8),
      proofKeyId: issuerKey.id,
      proofValue: Buffer.alloc(64, 9),
      status: 'active',
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandateId = parseResourceId(`mdt_${mandate.id}`, 'mdt');
  const agentId = parseResourceId(`agt_${agent.id}`, 'agt');
  const service = new BudgetReservationService(database);

  const failedPayment = await service.reserve(mandateId, agentId, '600');
  const released = await service.release(failedPayment.reservationId, 'payment_failed');
  assert.equal(released.status, 'released');
  assert.equal(released.finalizationReason, 'payment_failed');
  assert.match(released.finalizedAt, /Z$/u);
  assert.deepEqual(await service.release(failedPayment.reservationId, 'payment_failed'), released);
  await assert.rejects(
    service.confirm(failedPayment.reservationId),
    (error) => error instanceof BudgetReservationError && error.code === 'invalid_state',
  );

  const baseTime = new Date(Date.now() + 100);
  const timedService = new BudgetReservationService(database, () => baseTime);
  const timed = await timedService.reserve(mandateId, agentId, '500', 1_000);
  await assert.rejects(
    timedService.expire(timed.reservationId),
    (error) => error instanceof BudgetReservationError && error.code === 'not_expired',
  );
  const timeoutTime = new Date(baseTime.getTime() + 2_000);
  const timeoutService = new BudgetReservationService(database, () => timeoutTime);
  assert.equal(await timeoutService.expireDue(), 1);
  const expired = await timeoutService.expire(timed.reservationId);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.finalizationReason, 'timeout');
  assert.equal(expired.finalizedAt, timeoutTime.toISOString());

  const successful = await service.reserve(mandateId, agentId, '400');
  const confirmed = await service.confirm(successful.reservationId);
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.finalizationReason, 'payment_succeeded');
  assert.deepEqual(await service.confirm(successful.reservationId), confirmed);

  const concurrentReservation = await service.reserve(mandateId, agentId, '300');
  const concurrentConfirm = await Promise.all([
    service.confirm(concurrentReservation.reservationId),
    service.confirm(concurrentReservation.reservationId),
  ]);
  assert.equal(concurrentConfirm[0].status, 'confirmed');
  assert.deepEqual(concurrentConfirm[0], concurrentConfirm[1]);

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
    spentAmountMinor: '700',
    completedTransactionCount: 2,
    reservedAmountMinor: '0',
    reservedTransactionCount: 0,
  });

  const rows = await database
    .selectFrom('budgetReservations')
    .select(['status', 'finalizationReason', 'amountMinor'])
    .orderBy('amountMinor', 'desc')
    .execute();
  assert.deepEqual(
    rows.map((row) => [row.amountMinor, row.status, row.finalizationReason]),
    [
      ['600', 'released', 'payment_failed'],
      ['500', 'expired', 'timeout'],
      ['400', 'confirmed', 'payment_succeeded'],
      ['300', 'confirmed', 'payment_succeeded'],
    ],
  );
});
