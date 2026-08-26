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

function parseBody(response) {
  return JSON.parse(response.body);
}

function cookieHeader(response) {
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
  return cookieHeader(response);
}

test('creates and maintains merchant profiles with safe callback URLs and ownership', async (context) => {
  const container = {
    name: `aipay-merchant-test-${process.pid}`,
    database: 'aipay_merchant_test',
    user: 'aipay',
    password: 'merchant-test-only',
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
  database = createDatabase(databaseUrl, { maxConnections: 3 });
  app = await buildApp({ database });
  const ownerCookie = await register(app, 'merchant-owner@example.com');

  const created = await app.inject({
    method: 'POST',
    url: '/v1/merchants',
    headers: { cookie: ownerCookie },
    payload: {
      name: '  Weather Merchant  ',
      callbackUrl: 'https://Merchant.Example.COM/aipay/webhook',
    },
  });
  assert.equal(created.statusCode, 201);
  const merchant = parseBody(created).data;
  assert.match(merchant.merchantId, /^mch_[0-9a-f-]{36}$/u);
  assert.equal(merchant.name, 'Weather Merchant');
  assert.equal(merchant.callbackUrl, 'https://merchant.example.com/aipay/webhook');
  assert.equal(merchant.status, 'active');

  const stored = await database
    .selectFrom('merchants')
    .select(['name', 'callbackUrl', 'status'])
    .executeTakeFirstOrThrow();
  assert.deepEqual(stored, {
    name: 'Weather Merchant',
    callbackUrl: 'https://merchant.example.com/aipay/webhook',
    status: 'active',
  });

  const updated = await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${merchant.merchantId}`,
    headers: { cookie: ownerCookie },
    payload: {
      name: 'Weather Merchant China',
      callbackUrl: 'http://127.0.0.1:4100/webhook',
      status: 'suspended',
    },
  });
  assert.equal(updated.statusCode, 200);
  const updatedMerchant = parseBody(updated).data;
  assert.equal(updatedMerchant.name, 'Weather Merchant China');
  assert.equal(updatedMerchant.callbackUrl, 'http://127.0.0.1:4100/webhook');
  assert.equal(updatedMerchant.status, 'suspended');

  const listed = await app.inject({
    method: 'GET',
    url: '/v1/merchants',
    headers: { cookie: ownerCookie },
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(parseBody(listed).data, [updatedMerchant]);

  const second = await app.inject({
    method: 'POST',
    url: '/v1/merchants',
    headers: { cookie: ownerCookie },
    payload: { name: 'Second Merchant', callbackUrl: 'https://second.example.com/hook' },
  });
  assert.equal(second.statusCode, 201);
  const duplicateName = await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${parseBody(second).data.merchantId}`,
    headers: { cookie: ownerCookie },
    payload: { name: 'weather merchant china' },
  });
  assert.equal(duplicateName.statusCode, 400);
  assert.equal(parseBody(duplicateName).errors[0].code, 'name_unavailable');

  const invalidCallbacks = [
    'http://merchant.example.com/hook',
    'ftp://merchant.example.com/hook',
    'https://user:password@merchant.example.com/hook',
    'https://merchant.example.com/hook#fragment',
    '/relative/hook',
  ];

  for (const callbackUrl of invalidCallbacks) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/merchants',
      headers: { cookie: ownerCookie },
      payload: { name: `Invalid ${invalidCallbacks.indexOf(callbackUrl)}`, callbackUrl },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(parseBody(response).errors[0].code, 'invalid_callback_url');
  }

  const unknownField = await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${merchant.merchantId}`,
    headers: { cookie: ownerCookie },
    payload: { secret: 'must-not-be-accepted' },
  });
  assert.equal(unknownField.statusCode, 400);

  const otherCookie = await register(app, 'other-merchant-owner@example.com');
  const crossAccount = await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${merchant.merchantId}`,
    headers: { cookie: otherCookie },
    payload: { status: 'active' },
  });
  assert.equal(crossAccount.statusCode, 403);
  assert.equal(parseBody(crossAccount).code, 'AUTHORIZATION_DENIED');
  const otherList = await app.inject({
    method: 'GET',
    url: '/v1/merchants',
    headers: { cookie: otherCookie },
  });
  assert.deepEqual(parseBody(otherList).data, []);
});
