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

async function createMerchant(app, cookie, name) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/merchants',
    headers: { cookie },
    payload: { name, callbackUrl: 'https://merchant.example.com/aipay/webhook' },
  });
  assert.equal(response.statusCode, 201);
  return parseBody(response).data;
}

test('registers API, MCP and Skill services with fixed prices and refund rules', async (context) => {
  const container = {
    name: `aipay-service-test-${process.pid}`,
    database: 'aipay_service_test',
    user: 'aipay',
    password: 'service-test-only',
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
  const ownerCookie = await register(app, 'service-owner@example.com');
  const merchant = await createMerchant(app, ownerCookie, 'Service Merchant');

  const definitions = [
    {
      type: 'api',
      name: 'Weather API',
      category: 'data.weather',
      unit: 'request',
      unitPrice: { currency: 'CNY', amountMinor: '200' },
      refundPolicy: 'full_on_delivery_failure',
    },
    {
      type: 'mcp',
      name: 'Weather MCP',
      category: 'data.weather',
      unit: 'tool_call',
      unitPrice: { currency: 'CNY', amountMinor: '300' },
      refundPolicy: 'non_refundable',
    },
    {
      type: 'skill',
      name: 'Forecast Skill',
      category: 'agent.weather',
      unit: 'execution',
      unitPrice: { currency: 'CNY', amountMinor: '500' },
      refundPolicy: 'full_on_delivery_failure',
    },
  ];
  const createdServices = [];

  for (const definition of definitions) {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/merchants/${merchant.merchantId}/services`,
      headers: { cookie: ownerCookie },
      payload: definition,
    });
    assert.equal(response.statusCode, 201);
    const service = parseBody(response).data;
    assert.match(service.serviceId, /^svc_[0-9a-f-]{36}$/u);
    assert.equal(service.merchantId, merchant.merchantId);
    assert.equal(service.type, definition.type);
    assert.deepEqual(service.unitPrice, definition.unitPrice);
    assert.equal(service.refundPolicy, definition.refundPolicy);
    assert.equal(service.status, 'enabled');
    createdServices.push(service);
  }

  const stored = await database
    .selectFrom('services')
    .select(['serviceType', 'unit', 'unitPriceAmountMinor', 'currency', 'refundPolicy'])
    .orderBy('unitPriceAmountMinor')
    .execute();
  assert.deepEqual(
    stored.map((row) => ({
      type: row.serviceType,
      unit: row.unit,
      amountMinor: row.unitPriceAmountMinor,
      currency: row.currency,
      refundPolicy: row.refundPolicy,
    })),
    [
      {
        type: 'api',
        unit: 'request',
        amountMinor: '200',
        currency: 'CNY',
        refundPolicy: 'full_on_delivery_failure',
      },
      {
        type: 'mcp',
        unit: 'tool_call',
        amountMinor: '300',
        currency: 'CNY',
        refundPolicy: 'non_refundable',
      },
      {
        type: 'skill',
        unit: 'execution',
        amountMinor: '500',
        currency: 'CNY',
        refundPolicy: 'full_on_delivery_failure',
      },
    ],
  );

  const apiService = createdServices[0];
  const updated = await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${merchant.merchantId}/services/${apiService.serviceId}`,
    headers: { cookie: ownerCookie },
    payload: {
      unit: 'api_call',
      unitPrice: { currency: 'CNY', amountMinor: '250' },
      refundPolicy: 'non_refundable',
      status: 'disabled',
    },
  });
  assert.equal(updated.statusCode, 200);
  const updatedService = parseBody(updated).data;
  assert.equal(updatedService.unit, 'api_call');
  assert.equal(updatedService.unitPrice.amountMinor, '250');
  assert.equal(updatedService.refundPolicy, 'non_refundable');
  assert.equal(updatedService.status, 'disabled');

  const listed = await app.inject({
    method: 'GET',
    url: `/v1/merchants/${merchant.merchantId}/services`,
    headers: { cookie: ownerCookie },
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(parseBody(listed).data.length, 3);

  const duplicate = await app.inject({
    method: 'POST',
    url: `/v1/merchants/${merchant.merchantId}/services`,
    headers: { cookie: ownerCookie },
    payload: { ...definitions[1], name: 'weather mcp' },
  });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(parseBody(duplicate).errors[0].code, 'name_unavailable');

  const invalidDefinitions = [
    { ...definitions[0], name: 'Zero Price', unitPrice: { currency: 'CNY', amountMinor: '0' } },
    {
      ...definitions[0],
      name: 'Overflow Price',
      unitPrice: { currency: 'CNY', amountMinor: '9223372036854775808' },
    },
    { ...definitions[0], name: 'Number Price', unitPrice: { currency: 'CNY', amountMinor: 200 } },
    { ...definitions[0], name: 'Bad Category', category: 'Data Weather' },
    { ...definitions[0], name: 'Bad Unit', unit: 'API Call' },
    { ...definitions[0], name: 'Unknown', unexpected: true },
  ];

  for (const definition of invalidDefinitions) {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/merchants/${merchant.merchantId}/services`,
      headers: { cookie: ownerCookie },
      payload: definition,
    });
    assert.equal(response.statusCode, 400, definition.name);
    assert.equal(parseBody(response).code, 'INVALID_REQUEST');
  }

  const suspended = await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${merchant.merchantId}`,
    headers: { cookie: ownerCookie },
    payload: { status: 'suspended' },
  });
  assert.equal(suspended.statusCode, 200);
  const suspendedCreate = await app.inject({
    method: 'POST',
    url: `/v1/merchants/${merchant.merchantId}/services`,
    headers: { cookie: ownerCookie },
    payload: { ...definitions[0], name: 'Suspended Merchant Service' },
  });
  assert.equal(suspendedCreate.statusCode, 403);

  const otherCookie = await register(app, 'other-service-owner@example.com');
  const crossAccountList = await app.inject({
    method: 'GET',
    url: `/v1/merchants/${merchant.merchantId}/services`,
    headers: { cookie: otherCookie },
  });
  assert.equal(crossAccountList.statusCode, 403);
  const crossAccountUpdate = await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${merchant.merchantId}/services/${apiService.serviceId}`,
    headers: { cookie: otherCookie },
    payload: { status: 'enabled' },
  });
  assert.equal(crossAccountUpdate.statusCode, 403);
});
