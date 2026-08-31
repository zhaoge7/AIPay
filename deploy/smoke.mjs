/* global fetch */

import { setTimeout } from 'node:timers/promises';
import process from 'node:process';

import { loadDatabaseConfig } from '../packages/config/dist/index.js';
import { parseResourceId } from '../packages/contracts/dist/index.js';
import { createDatabase, enqueueOutboxEvent } from '../packages/database/dist/index.js';

const origin = 'https://aipay.localhost:8443';
const metricsToken = process.env.AIPAY_METRICS_TOKEN;

if (metricsToken === undefined) {
  throw new Error('AIPAY_METRICS_TOKEN is required');
}

const health = await fetch(`${origin}/internal/health`);

if (!health.ok || (await health.json()).status !== 'ok') {
  throw new Error('Closed-test health check failed');
}

const web = await fetch(origin);

if (
  !web.ok ||
  !(await web.text()).includes('AIPay Console') ||
  web.headers.get('strict-transport-security') !== 'max-age=31536000' ||
  !web.headers.get('content-security-policy')?.includes("default-src 'self'") ||
  web.headers.get('x-content-type-options') !== 'nosniff'
) {
  throw new Error('Closed-test Web console failed');
}

const metrics = await fetch(`${origin}/internal/metrics`, {
  headers: { authorization: `Bearer ${metricsToken}` },
});

if (!metrics.ok || !(await metrics.text()).includes('aipay_payment_failure_ratio')) {
  throw new Error('Closed-test metrics failed');
}

const registration = await fetch(`${origin}/v1/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: `closed-smoke-${String(Date.now())}@example.test`,
    password: 'Closed test smoke password 2026!',
  }),
});

if (!registration.ok || !registration.headers.get('set-cookie')?.includes('Secure')) {
  throw new Error('Closed-test secure Cookie failed');
}

const database = createDatabase(loadDatabaseConfig(process.env).url, { maxConnections: 2 });

try {
  const developer = await database
    .insertInto('developers')
    .values({
      email: `closed-callback-${String(Date.now())}@example.test`,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: `Closed Callback ${String(Date.now())}`,
      callbackUrl: `${origin}/internal/closed-test/callback`,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchantId = parseResourceId(`mch_${merchant.id}`, 'mch');
  const eventId = await database.transaction().execute((transaction) =>
    enqueueOutboxEvent(transaction, {
      aggregateType: 'merchant',
      aggregateId: merchantId,
      eventType: 'closed_test.callback',
      payload: { merchantId },
    }),
  );
  let delivered = false;

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await database
      .selectFrom('outboxEvents')
      .leftJoin('webhookDeliveries', 'webhookDeliveries.outboxEventId', 'outboxEvents.id')
      .select(['outboxEvents.status as outboxStatus', 'webhookDeliveries.status as deliveryStatus'])
      .where('outboxEvents.id', '=', eventId.slice(4))
      .executeTakeFirstOrThrow();

    if (state.outboxStatus === 'published' && state.deliveryStatus === 'delivered') {
      delivered = true;
      break;
    }

    await setTimeout(250);
  }

  if (!delivered) {
    throw new Error('Closed-test signed callback was not delivered');
  }
} finally {
  await database.destroy();
}

process.stdout.write('Closed-test HTTPS, Web, database, secrets, metrics, and callback passed.\n');
