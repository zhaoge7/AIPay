import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createSign, generateKeyPairSync } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';
import { URLSearchParams } from 'node:url';

import { createDatabase } from '@aipay/database';
import { AlipayWebPaymentProvider } from '@aipay/payment';

import { buildApp } from '../dist/app.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

function chinaTime(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function notification(privateKey, outTradeNo, overrides = {}) {
  const now = chinaTime(new Date());
  const parameters = {
    notify_time: now,
    notify_type: 'trade_status_sync',
    notify_id: 'notify_integration_001',
    app_id: '2024001234567890',
    auth_app_id: '2024001234567890',
    trade_no: '2026082822001234567890123456',
    out_trade_no: outTradeNo,
    seller_id: '2088123456789012',
    total_amount: '12.34',
    trade_status: 'TRADE_SUCCESS',
    gmt_payment: now,
    sign_type: 'RSA2',
    ...overrides,
  };
  const content = Object.entries(parameters)
    .filter(([name]) => name !== 'sign_type')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const signature = createSign('RSA-SHA256').update(content, 'utf8').sign(privateKey, 'base64');
  return new URLSearchParams({ ...parameters, sign: signature }).toString();
}

test('applies only authentic, bound and non-duplicate Alipay notifications', async (context) => {
  const container = {
    name: `aipay-alipay-webhook-${process.pid}`,
    database: 'aipay_alipay_webhook_test',
    user: 'aipay',
    password: 'alipay-webhook-only',
  };
  let app;
  let database;
  context.after(async () => {
    await app?.close();
    await database?.destroy();
    removePostgresContainer(container.name);
  });

  const { databaseUrl } = await startPostgresContainer(container);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 8 });
  const developer = await database
    .insertInto('developers')
    .values({
      email: 'alipay-webhook@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Alipay Webhook Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'Alipay Webhook Merchant',
      callbackUrl: 'https://merchant.example.com/webhook',
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
      publicKey: Buffer.alloc(32, 81),
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
      publicKey: Buffer.alloc(32, 82),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const catalogService = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Alipay Webhook Service',
      category: 'data.alipay',
      unit: 'request',
      unitPriceAmountMinor: '1234',
      refundPolicy: 'full_on_delivery_failure',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandate = await database
    .insertInto('mandates')
    .values({
      principalId: developer.id,
      agentId: agent.id,
      purpose: 'Alipay callback binding',
      maxPerTransactionAmountMinor: '5000',
      totalBudgetAmountMinor: '10000',
      approvalRequiredAboveAmountMinor: '5000',
      maxTransactions: 10,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 83),
      proofKeyId: systemKey.id,
      proofValue: Buffer.alloc(64, 84),
      status: 'active',
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const quote = await database
    .insertInto('quotes')
    .values({
      merchantId: merchant.id,
      serviceId: catalogService.id,
      unit: 'request',
      quantity: 1,
      unitPriceAmountMinor: '1234',
      subtotalAmountMinor: '1234',
      taxBehavior: 'inclusive',
      taxAmountMinor: '0',
      totalAmountMinor: '1234',
      issuedAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 60_000),
      proofKeyId: merchantKey.id,
      proofValue: Buffer.alloc(64, 85),
      status: 'active',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const paymentTransaction = await database
    .insertInto('transactions')
    .values({
      quoteId: quote.id,
      mandateId: mandate.id,
      principalId: developer.id,
      agentId: agent.id,
      merchantId: merchant.id,
      serviceId: catalogService.id,
      amountMinor: '1234',
      status: 'payment_pending',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const attempt = await database
    .insertInto('paymentAttempts')
    .values({
      transactionId: paymentTransaction.id,
      attemptNumber: 1,
      provider: 'alipay_web',
      providerReference: null,
      amountMinor: '1234',
      status: 'pending',
      errorCode: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const outTradeNo = `AIPAY${attempt.id.replaceAll('-', '').toUpperCase()}`;
  const providerReference = `alipay_out_${outTradeNo}`;
  await database
    .updateTable('paymentAttempts')
    .set({ providerReference })
    .where('id', '=', attempt.id)
    .executeTakeFirstOrThrow();

  const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platformKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const provider = new AlipayWebPaymentProvider({
    appId: '2024001234567890',
    sellerId: '2088123456789012',
    privateKeyPkcs8Base64: appKeys.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    alipayPublicKeySpkiBase64: platformKeys.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
    gatewayUrl: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
  });
  app = await buildApp({ database, alipayProvider: provider });
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  const body = notification(platformKeys.privateKey, outTradeNo);
  const [first, duplicate] = await Promise.all([
    app.inject({ method: 'POST', url: '/v1/provider-webhooks/alipay', headers, payload: body }),
    app.inject({ method: 'POST', url: '/v1/provider-webhooks/alipay', headers, payload: body }),
  ]);
  assert.deepEqual(
    [first, duplicate].map(({ statusCode, body: responseBody }) => ({
      statusCode,
      body: responseBody,
    })),
    [
      { statusCode: 200, body: 'success' },
      { statusCode: 200, body: 'success' },
    ],
  );

  const ignored = await app.inject({
    method: 'POST',
    url: '/v1/provider-webhooks/alipay',
    headers,
    payload: notification(platformKeys.privateKey, outTradeNo, {
      notify_id: 'notify_integration_closed',
      trade_status: 'TRADE_CLOSED',
    }),
  });
  assert.equal(ignored.statusCode, 200);
  assert.equal(ignored.body, 'success');

  const rejectedBodies = [
    notification(platformKeys.privateKey, outTradeNo, {
      notify_id: 'notify_wrong_amount',
      total_amount: '12.35',
    }),
    notification(platformKeys.privateKey, 'AIPAY01890F3EB9997CC2A8C57F6A1B2C3D4E', {
      notify_id: 'notify_wrong_order',
    }),
    body.replace('total_amount=12.34', 'total_amount=12.35'),
  ];

  for (const rejectedBody of rejectedBodies) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/provider-webhooks/alipay',
      headers,
      payload: rejectedBody,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.body, 'failure');
  }

  const storedTransaction = await database
    .selectFrom('transactions')
    .select('status')
    .where('id', '=', paymentTransaction.id)
    .executeTakeFirstOrThrow();
  const storedAttempt = await database
    .selectFrom('paymentAttempts')
    .select(['status', 'errorCode'])
    .where('id', '=', attempt.id)
    .executeTakeFirstOrThrow();
  assert.equal(storedTransaction.status, 'paid');
  assert.deepEqual(storedAttempt, { status: 'succeeded', errorCode: null });
  const events = await database
    .selectFrom('providerWebhookEvents')
    .select(['providerEventId', 'outcome', 'paymentAttemptId'])
    .orderBy('createdAt', 'asc')
    .execute();
  assert.deepEqual(
    events.map(({ providerEventId, outcome }) => ({ providerEventId, outcome })),
    [
      { providerEventId: 'notify_integration_001', outcome: 'applied' },
      { providerEventId: 'notify_integration_closed', outcome: 'ignored' },
    ],
  );
  assert.equal(
    events.every(({ paymentAttemptId }) => paymentAttemptId === attempt.id),
    true,
  );
  const outbox = await database
    .selectFrom('outboxEvents')
    .select(['eventType', 'payload', 'status'])
    .execute();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].eventType, 'transaction.paid');
  assert.equal(outbox[0].status, 'pending');
  assert.deepEqual(outbox[0].payload, {
    merchantId: `mch_${merchant.id}`,
    transactionId: `txn_${paymentTransaction.id}`,
    paymentAttemptId: `pat_${attempt.id}`,
    paymentStatus: 'succeeded',
    provider: 'alipay_web',
    providerReference,
    providerTransactionId: '2026082822001234567890123456',
    errorCode: null,
  });
});
