import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import { parseResourceId } from '@aipay/contracts';

import {
  claimOutboxEvents,
  createDatabase,
  enqueueOutboxEvent,
  markOutboxFailed,
  markOutboxPublished,
  releaseStaleOutboxClaims,
} from '../dist/index.js';
import { runMigrations } from '../scripts/migration-runner.mjs';
import { removePostgresContainer, startPostgresContainer } from '../scripts/postgres-container.mjs';

const discardLog = () => undefined;

test('commits business state and Outbox together and dispatches with leases', async (context) => {
  const config = {
    name: `aipay-outbox-test-${process.pid}`,
    database: 'aipay_outbox_test',
    user: 'aipay',
    password: 'outbox-test-only',
  };
  let database;
  context.after(async () => {
    await database?.destroy();
    removePostgresContainer(config.name);
  });

  const { databaseUrl } = await startPostgresContainer(config);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 8 });
  const developer = await database
    .insertInto('developers')
    .values({
      email: 'outbox@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const developerId = parseResourceId(`dev_${developer.id}`, 'dev');

  await assert.rejects(
    database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('developers')
        .set({ status: 'suspended' })
        .where('id', '=', developer.id)
        .executeTakeFirstOrThrow();
      await enqueueOutboxEvent(transaction, {
        aggregateType: 'developer',
        aggregateId: developerId,
        eventType: 'developer.suspended',
        payload: { developerId },
      });
      throw new Error('force rollback');
    }),
    /force rollback/u,
  );
  let developerState = await database
    .selectFrom('developers')
    .select('status')
    .where('id', '=', developer.id)
    .executeTakeFirstOrThrow();
  let outboxCount = await database
    .selectFrom('outboxEvents')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(developerState.status, 'active');
  assert.equal(Number(outboxCount.count), 0);

  let committedEventId;
  await database.transaction().execute(async (transaction) => {
    await transaction
      .updateTable('developers')
      .set({ status: 'suspended' })
      .where('id', '=', developer.id)
      .executeTakeFirstOrThrow();
    committedEventId = await enqueueOutboxEvent(transaction, {
      aggregateType: 'developer',
      aggregateId: developerId,
      eventType: 'developer.suspended',
      payload: { developerId, status: 'suspended' },
    });
  });
  developerState = await database
    .selectFrom('developers')
    .select('status')
    .where('id', '=', developer.id)
    .executeTakeFirstOrThrow();
  outboxCount = await database
    .selectFrom('outboxEvents')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(developerState.status, 'suspended');
  assert.equal(Number(outboxCount.count), 1);

  const initialClaim = await claimOutboxEvents(database, 'worker-initial', 1);
  assert.equal(initialClaim.length, 1);
  assert.equal(initialClaim[0].outboxEventId, committedEventId);
  assert.deepEqual(initialClaim[0].payload, { developerId, status: 'suspended' });
  await assert.rejects(
    markOutboxPublished(database, committedEventId, 'worker-wrong'),
    /not claimed/u,
  );
  await markOutboxPublished(database, committedEventId, 'worker-initial');

  await database.transaction().execute(async (transaction) => {
    for (let index = 0; index < 10; index += 1) {
      await enqueueOutboxEvent(transaction, {
        aggregateType: 'developer',
        aggregateId: developerId,
        eventType: 'developer.test_event',
        payload: { index },
      });
    }
  });
  const [workerA, workerB] = await Promise.all([
    claimOutboxEvents(database, 'worker-a', 5),
    claimOutboxEvents(database, 'worker-b', 5),
  ]);
  assert.equal(workerA.length, 5);
  assert.equal(workerB.length, 5);
  const claimedIds = [...workerA, ...workerB].map(({ outboxEventId }) => outboxEventId);
  assert.equal(new Set(claimedIds).size, 10);

  const retryEvent = workerA[0];
  const failureTime = new Date();
  assert.equal(
    await markOutboxFailed(database, retryEvent.outboxEventId, 'worker-a', 'DELIVERY_FAILED', {
      maxAttempts: 2,
      now: failureTime,
    }),
    'pending',
  );
  assert.equal((await claimOutboxEvents(database, 'worker-early', 1, failureTime)).length, 0);
  const retryClaim = await claimOutboxEvents(
    database,
    'worker-retry',
    1,
    new Date(failureTime.getTime() + 1_000),
  );
  assert.equal(retryClaim[0].outboxEventId, retryEvent.outboxEventId);
  assert.equal(
    await markOutboxFailed(database, retryEvent.outboxEventId, 'worker-retry', 'DELIVERY_FAILED', {
      maxAttempts: 2,
      now: new Date(failureTime.getTime() + 1_000),
    }),
    'dead_letter',
  );

  for (const event of workerA.slice(1)) {
    await markOutboxPublished(database, event.outboxEventId, 'worker-a');
  }
  for (const event of workerB) {
    await markOutboxPublished(database, event.outboxEventId, 'worker-b');
  }

  const staleId = await database.transaction().execute((transaction) =>
    enqueueOutboxEvent(transaction, {
      aggregateType: 'developer',
      aggregateId: developerId,
      eventType: 'developer.stale_test',
      payload: { stale: true },
    }),
  );
  const claimTime = new Date();
  const staleClaim = await claimOutboxEvents(database, 'worker-stale', 1, claimTime);
  assert.equal(staleClaim[0].outboxEventId, staleId);
  assert.equal(
    await releaseStaleOutboxClaims(
      database,
      new Date(claimTime.getTime() + 1),
      new Date(claimTime.getTime() + 2),
    ),
    1,
  );
  const recoveredClaim = await claimOutboxEvents(
    database,
    'worker-recovered',
    1,
    new Date(claimTime.getTime() + 2),
  );
  assert.equal(recoveredClaim[0].outboxEventId, staleId);
  await markOutboxPublished(database, staleId, 'worker-recovered');

  const states = await database
    .selectFrom('outboxEvents')
    .select(['status', 'attemptCount'])
    .execute();
  assert.equal(states.filter(({ status }) => status === 'published').length, 11);
  assert.equal(states.filter(({ status }) => status === 'dead_letter').length, 1);
  assert.deepEqual(
    states.find(({ status }) => status === 'dead_letter'),
    { status: 'dead_letter', attemptCount: 2 },
  );
});
