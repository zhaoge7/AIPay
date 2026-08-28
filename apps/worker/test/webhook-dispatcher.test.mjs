import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';

import { parseResourceId } from '@aipay/contracts';
import { createDatabase, enqueueOutboxEvent } from '@aipay/database';

import { WebhookDispatcher } from '../dist/webhooks/dispatcher.js';
import { Ed25519WebhookSigner } from '../dist/webhooks/signing.js';
import { WebhookTransportError } from '../dist/webhooks/transport.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

class ControlledTransport {
  constructor(outcomes) {
    this.outcomes = [...outcomes];
    this.requests = [];
  }

  async deliver(request) {
    this.requests.push(request);
    const outcome = this.outcomes.shift();

    if (outcome instanceof Error) {
      throw outcome;
    }

    if (outcome === undefined) {
      throw new Error('No controlled Webhook outcome remains');
    }

    return Object.freeze({ statusCode: outcome });
  }
}

function signatureFromHeader(value) {
  const match = /^ed25519=:([A-Za-z0-9_-]+):$/u.exec(value);
  assert.notEqual(match, null);
  return match[1];
}

test('signs Webhooks and records retries, recovery, success and dead letters', async (context) => {
  const container = {
    name: `aipay-webhook-test-${process.pid}`,
    database: 'aipay_webhook_test',
    user: 'aipay',
    password: 'webhook-test-only',
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
      email: 'webhook@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'Webhook Merchant',
      callbackUrl: 'https://merchant.example.com/aipay/webhook',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchantId = parseResourceId(`mch_${merchant.id}`, 'mch');
  const keyPair = generateKeyPairSync('ed25519');
  const privateKey = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' });
  const publicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' });
  const signingKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'system',
      developerId: null,
      agentId: null,
      merchantId: null,
      publicKey: publicKey.subarray(-32),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const signer = new Ed25519WebhookSigner(`key_${signingKey.id}`, privateKey.toString('base64'));
  let now = new Date(Date.now() + 1_000);
  const transport = new ControlledTransport([500, new WebhookTransportError('NETWORK_ERROR'), 204]);
  const dispatcher = new WebhookDispatcher(database, signer, transport, {
    maxAttempts: 3,
    now: () => now,
  });
  const eventId = await database.transaction().execute((transaction) =>
    enqueueOutboxEvent(transaction, {
      aggregateType: 'merchant',
      aggregateId: merchantId,
      eventType: 'transaction.paid',
      payload: { merchantId, transactionId: 'txn_01890f3e-9b65-7cc2-a8c5-7f6a1b2c3d4e' },
      availableAt: now,
    }),
  );

  const firstResult = await dispatcher.claimAndDeliver('webhook-first', 1);
  assert.equal(firstResult.length, 1);
  assert.equal(firstResult[0].outboxEventId, eventId);
  assert.match(firstResult[0].deliveryId, /^whd_/u);
  assert.equal(firstResult[0].status, 'pending');
  assert.equal((await dispatcher.claimAndDeliver('webhook-too-early', 1)).length, 0);
  now = new Date(now.getTime() + 1_000);
  assert.equal((await dispatcher.claimAndDeliver('webhook-second', 1))[0].status, 'pending');
  now = new Date(now.getTime() + 2_000);
  assert.equal((await dispatcher.claimAndDeliver('webhook-third', 1))[0].status, 'delivered');

  assert.equal(transport.requests.length, 3);
  for (const request of transport.requests) {
    assert.equal(request.url, 'https://merchant.example.com/aipay/webhook');
    assert.equal(request.headers['content-type'], 'application/json');
    assert.equal(request.headers['x-aipay-event-id'], eventId);
    assert.equal(request.headers['x-aipay-key-id'], `key_${signingKey.id}`);
    assert.equal(
      signer.verify(
        eventId,
        request.headers['x-aipay-timestamp'],
        request.body,
        signatureFromHeader(request.headers['x-aipay-signature']),
      ),
      true,
    );
  }
  const lastRequest = transport.requests.at(-1);
  assert.equal(
    signer.verify(
      eventId,
      lastRequest.headers['x-aipay-timestamp'],
      Buffer.from(`${lastRequest.body.toString('utf8')} `),
      signatureFromHeader(lastRequest.headers['x-aipay-signature']),
    ),
    false,
  );
  const body = JSON.parse(lastRequest.body.toString('utf8'));
  assert.equal(body.eventId, eventId);
  assert.equal(body.eventType, 'transaction.paid');
  assert.equal(body.data.merchantId, merchantId);

  const delivery = await database
    .selectFrom('webhookDeliveries')
    .selectAll()
    .where('outboxEventId', '=', eventId.slice(4))
    .executeTakeFirstOrThrow();
  assert.deepEqual(
    {
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      lastStatusCode: delivery.lastStatusCode,
      lastErrorCode: delivery.lastErrorCode,
      targetUrl: delivery.targetUrl,
      delivered: delivery.deliveredAt !== null,
    },
    {
      status: 'delivered',
      attemptCount: 3,
      lastStatusCode: 204,
      lastErrorCode: null,
      targetUrl: 'https://merchant.example.com/aipay/webhook',
      delivered: true,
    },
  );
  const attempts = await database
    .selectFrom('webhookDeliveryAttempts')
    .selectAll()
    .where('deliveryId', '=', delivery.id)
    .orderBy('attemptNumber', 'asc')
    .execute();
  assert.deepEqual(
    attempts.map(({ outcome, responseStatusCode, errorCode }) => ({
      outcome,
      responseStatusCode,
      errorCode,
    })),
    [
      { outcome: 'failed', responseStatusCode: 500, errorCode: 'HTTP_500' },
      { outcome: 'failed', responseStatusCode: null, errorCode: 'NETWORK_ERROR' },
      { outcome: 'delivered', responseStatusCode: 204, errorCode: null },
    ],
  );
  assert.equal(
    attempts.every(
      ({ requestDigest }) =>
        Buffer.compare(requestDigest, createHash('sha256').update(lastRequest.body).digest()) === 0,
    ),
    true,
  );
  assert.equal(
    attempts.every(({ signingKeyId }) => signingKeyId === signingKey.id),
    true,
  );

  await database
    .updateTable('outboxEvents')
    .set({
      status: 'pending',
      availableAt: now,
      publishedAt: null,
      lockedAt: null,
      lockedBy: null,
    })
    .where('id', '=', eventId.slice(4))
    .executeTakeFirstOrThrow();
  await database
    .updateTable('merchants')
    .set({ status: 'suspended', updatedAt: now })
    .where('id', '=', merchant.id)
    .executeTakeFirstOrThrow();
  assert.equal((await dispatcher.claimAndDeliver('webhook-recovery', 1))[0].status, 'delivered');
  assert.equal(transport.requests.length, 3);

  await database
    .updateTable('merchants')
    .set({ status: 'active', updatedAt: now })
    .where('id', '=', merchant.id)
    .executeTakeFirstOrThrow();
  const deadEventId = await database.transaction().execute((transaction) =>
    enqueueOutboxEvent(transaction, {
      aggregateType: 'merchant',
      aggregateId: merchantId,
      eventType: 'transaction.failed',
      payload: { merchantId },
      availableAt: now,
    }),
  );
  const deadTransport = new ControlledTransport([503, 429]);
  const deadDispatcher = new WebhookDispatcher(database, signer, deadTransport, {
    maxAttempts: 2,
    now: () => now,
  });
  assert.equal((await deadDispatcher.claimAndDeliver('webhook-dead-one', 1))[0].status, 'pending');
  now = new Date(now.getTime() + 1_000);
  assert.equal(
    (await deadDispatcher.claimAndDeliver('webhook-dead-two', 1))[0].status,
    'dead_letter',
  );
  const deadStates = await database
    .selectFrom('outboxEvents')
    .innerJoin('webhookDeliveries', 'webhookDeliveries.outboxEventId', 'outboxEvents.id')
    .select([
      'outboxEvents.status as outboxStatus',
      'outboxEvents.attemptCount as outboxAttempts',
      'webhookDeliveries.status as deliveryStatus',
      'webhookDeliveries.attemptCount as deliveryAttempts',
      'webhookDeliveries.lastStatusCode',
      'webhookDeliveries.lastErrorCode',
    ])
    .where('outboxEvents.id', '=', deadEventId.slice(4))
    .executeTakeFirstOrThrow();
  assert.deepEqual(deadStates, {
    outboxStatus: 'dead_letter',
    outboxAttempts: 2,
    deliveryStatus: 'dead_letter',
    deliveryAttempts: 2,
    lastStatusCode: 429,
    lastErrorCode: 'HTTP_429',
  });
});
