import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import { createDatabase } from '@aipay/database';

import { buildApp } from '../dist/app.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;
const password = 'Correct horse battery staple 2026!';

function body(response) {
  return JSON.parse(response.body);
}

function cookie(response) {
  const value = response.headers['set-cookie'];
  assert.equal(typeof value, 'string');
  return value.split(';', 1)[0];
}

async function register(app, email) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password },
  });
  assert.equal(response.statusCode, 201);
  return cookie(response);
}

async function merchant(app, session, name) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/merchants',
    headers: { cookie: session },
    payload: { name, callbackUrl: 'https://quote-merchant.example.com/webhook' },
  });
  return body(response).data;
}

async function service(app, session, merchantId, name, amountMinor = '200') {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/merchants/${merchantId}/services`,
    headers: { cookie: session },
    payload: {
      type: 'api',
      name,
      category: 'data.quote',
      unit: 'request',
      unitPrice: { currency: 'CNY', amountMinor },
      refundPolicy: 'full_on_delivery_failure',
    },
  });
  assert.equal(response.statusCode, 201);
  return body(response).data;
}

function quoteRequest(app, session, merchantId, payload) {
  return app.inject({
    method: 'POST',
    url: `/v1/merchants/${merchantId}/quotes`,
    headers: { cookie: session },
    payload,
  });
}

test('creates server-priced inclusive and exclusive Quote drafts', async (context) => {
  const container = {
    name: `aipay-quote-draft-test-${process.pid}`,
    database: 'aipay_quote_draft_test',
    user: 'aipay',
    password: 'quote-draft-test-only',
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
  database = createDatabase(databaseUrl, { maxConnections: 4 });
  app = await buildApp({ database });
  const owner = await register(app, 'quote-owner@example.com');
  const other = await register(app, 'quote-other@example.com');
  const profile = await merchant(app, owner, 'Quote Merchant');
  const catalogService = await service(app, owner, profile.merchantId, 'Weather Quote API');
  const base = {
    serviceId: catalogService.serviceId,
    quantity: 3,
    taxBehavior: 'inclusive',
    taxAmount: { currency: 'CNY', amountMinor: '34' },
    expiresInSeconds: 300,
  };

  const inclusiveResponse = await quoteRequest(app, owner, profile.merchantId, base);
  assert.equal(inclusiveResponse.statusCode, 201);
  const inclusive = body(inclusiveResponse).data;
  assert.match(inclusive.quoteId, /^qte_[0-9a-f-]{36}$/u);
  assert.equal(inclusive.merchantId, profile.merchantId);
  assert.equal(inclusive.serviceId, catalogService.serviceId);
  assert.equal(inclusive.unit, 'request');
  assert.equal(inclusive.quantity, 3);
  assert.deepEqual(inclusive.unitPrice, { currency: 'CNY', amountMinor: '200' });
  assert.deepEqual(inclusive.subtotal, { currency: 'CNY', amountMinor: '600' });
  assert.deepEqual(inclusive.total, { currency: 'CNY', amountMinor: '600' });
  assert.equal(inclusive.status, 'draft');
  assert.equal('proof' in inclusive, false);
  assert.equal(Date.parse(inclusive.expiresAt) - Date.parse(inclusive.issuedAt), 300_000);

  const exclusiveResponse = await quoteRequest(app, owner, profile.merchantId, {
    ...base,
    taxBehavior: 'exclusive',
    taxAmount: { currency: 'CNY', amountMinor: '36' },
  });
  assert.equal(exclusiveResponse.statusCode, 201);
  assert.deepEqual(body(exclusiveResponse).data.total, {
    currency: 'CNY',
    amountMinor: '636',
  });

  const stored = await database
    .selectFrom('quotes')
    .select(['status', 'proofKeyId', 'proofValue', 'unitPriceAmountMinor', 'subtotalAmountMinor'])
    .orderBy('createdAt', 'asc')
    .execute();
  assert.equal(stored.length, 2);
  assert.equal(
    stored.every((row) => row.status === 'draft'),
    true,
  );
  assert.equal(
    stored.every((row) => row.proofKeyId === null && row.proofValue === null),
    true,
  );
  assert.equal(
    stored.every((row) => row.unitPriceAmountMinor === '200'),
    true,
  );
  assert.equal(
    stored.every((row) => row.subtotalAmountMinor === '600'),
    true,
  );

  const invalidTax = await quoteRequest(app, owner, profile.merchantId, {
    ...base,
    taxAmount: { currency: 'CNY', amountMinor: '601' },
  });
  assert.equal(invalidTax.statusCode, 400);

  const clientTotal = await quoteRequest(app, owner, profile.merchantId, {
    ...base,
    total: { currency: 'CNY', amountMinor: '1' },
  });
  assert.equal(clientTotal.statusCode, 400);

  const maxPriceService = await service(
    app,
    owner,
    profile.merchantId,
    'Maximum Price API',
    '9223372036854775807',
  );
  const overflow = await quoteRequest(app, owner, profile.merchantId, {
    ...base,
    serviceId: maxPriceService.serviceId,
    quantity: 2,
    taxAmount: { currency: 'CNY', amountMinor: '0' },
  });
  assert.equal(overflow.statusCode, 400);
  assert.equal(body(overflow).errors[0].code, 'amount_overflow');

  const crossAccount = await quoteRequest(app, other, profile.merchantId, base);
  assert.equal(crossAccount.statusCode, 403);

  await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${profile.merchantId}/services/${catalogService.serviceId}`,
    headers: { cookie: owner },
    payload: { status: 'disabled' },
  });
  assert.equal((await quoteRequest(app, owner, profile.merchantId, base)).statusCode, 403);
  await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${profile.merchantId}/services/${catalogService.serviceId}`,
    headers: { cookie: owner },
    payload: { status: 'enabled' },
  });
  await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${profile.merchantId}`,
    headers: { cookie: owner },
    payload: { status: 'suspended' },
  });
  assert.equal((await quoteRequest(app, owner, profile.merchantId, base)).statusCode, 403);
});
