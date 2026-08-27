import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
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
const nonexistentIds = {
  agent: 'agt_01890f3e-9c90-7cc2-98c5-7f6a1b2c3d4e',
  merchant: 'mch_01890f3e-9c91-7cc2-a8c5-7f6a1b2c3d4e',
  service: 'svc_01890f3e-9c92-7cc2-b8c5-7f6a1b2c3d4e',
};

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

function publicKey() {
  const pair = generateKeyPairSync('ed25519');
  const der = pair.publicKey.export({ type: 'spki', format: 'der' });
  return Buffer.from(der).subarray(-32).toString('base64url');
}

async function createResources(app, cookie, suffix) {
  const agentResponse = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { cookie },
    payload: { name: `Agent ${suffix}`, publicKey: publicKey() },
  });
  const merchantResponse = await app.inject({
    method: 'POST',
    url: '/v1/merchants',
    headers: { cookie },
    payload: {
      name: `Merchant ${suffix}`,
      callbackUrl: `https://merchant-${suffix.toLowerCase()}.example.com/webhook`,
    },
  });
  const merchant = parseBody(merchantResponse).data;
  const serviceResponse = await app.inject({
    method: 'POST',
    url: `/v1/merchants/${merchant.merchantId}/services`,
    headers: { cookie },
    payload: {
      type: 'api',
      name: `Service ${suffix}`,
      category: 'data.test',
      unit: 'request',
      unitPrice: { currency: 'CNY', amountMinor: '100' },
      refundPolicy: 'full_on_delivery_failure',
    },
  });
  const apiKeyResponse = await app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: { cookie },
    payload: { name: `Key ${suffix}` },
  });

  assert.equal(agentResponse.statusCode, 201);
  assert.equal(merchantResponse.statusCode, 201);
  assert.equal(serviceResponse.statusCode, 201);
  assert.equal(apiKeyResponse.statusCode, 201);
  return Object.freeze({
    agent: parseBody(agentResponse).data,
    merchant,
    service: parseBody(serviceResponse).data,
    apiKey: parseBody(apiKeyResponse).data.apiKey,
  });
}

function assertDenied(response) {
  assert.equal(response.statusCode, 403);
  const problem = parseBody(response);
  assert.equal(problem.code, 'AUTHORIZATION_DENIED');
  assert.equal(problem.kind, 'rejected');
  return problem;
}

test('prevents cross-developer Agent, merchant, service and API Key operations', async (context) => {
  const container = {
    name: `aipay-authorization-test-${process.pid}`,
    database: 'aipay_authorization_test',
    user: 'aipay',
    password: 'authorization-test-only',
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
  const aliceCookie = await register(app, 'alice@example.com');
  const bobCookie = await register(app, 'bob@example.com');
  const alice = await createResources(app, aliceCookie, 'Alice');
  const bob = await createResources(app, bobCookie, 'Bob');

  const deniedResponses = await Promise.all([
    app.inject({
      method: 'PATCH',
      url: `/v1/agents/${alice.agent.agentId}/status`,
      headers: { cookie: bobCookie },
      payload: { status: 'disabled' },
    }),
    app.inject({
      method: 'PATCH',
      url: `/v1/merchants/${alice.merchant.merchantId}`,
      headers: { cookie: bobCookie },
      payload: { status: 'suspended' },
    }),
    app.inject({
      method: 'GET',
      url: `/v1/merchants/${alice.merchant.merchantId}/services`,
      headers: { cookie: bobCookie },
    }),
    app.inject({
      method: 'POST',
      url: `/v1/merchants/${alice.merchant.merchantId}/services`,
      headers: { cookie: bobCookie },
      payload: {
        type: 'api',
        name: 'Injected Service',
        category: 'data.test',
        unit: 'request',
        unitPrice: { currency: 'CNY', amountMinor: '100' },
        refundPolicy: 'non_refundable',
      },
    }),
    app.inject({
      method: 'PATCH',
      url: `/v1/merchants/${alice.merchant.merchantId}/services/${alice.service.serviceId}`,
      headers: { cookie: bobCookie },
      payload: { status: 'disabled' },
    }),
    app.inject({
      method: 'PATCH',
      url: `/v1/merchants/${bob.merchant.merchantId}/services/${alice.service.serviceId}`,
      headers: { cookie: bobCookie },
      payload: { status: 'disabled' },
    }),
    app.inject({
      method: 'DELETE',
      url: `/v1/api-keys/${alice.apiKey.apiKeyId}`,
      headers: { cookie: bobCookie },
    }),
  ]);
  deniedResponses.forEach(assertDenied);

  const existingAgentProblem = assertDenied(
    await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${alice.agent.agentId}/status`,
      headers: { cookie: bobCookie },
      payload: { status: 'disabled' },
    }),
  );
  const missingAgentProblem = assertDenied(
    await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${nonexistentIds.agent}/status`,
      headers: { cookie: bobCookie },
      payload: { status: 'disabled' },
    }),
  );
  assert.deepEqual(
    [existingAgentProblem.code, existingAgentProblem.title, existingAgentProblem.status],
    [missingAgentProblem.code, missingAgentProblem.title, missingAgentProblem.status],
  );

  const missingMerchantProblem = assertDenied(
    await app.inject({
      method: 'PATCH',
      url: `/v1/merchants/${nonexistentIds.merchant}`,
      headers: { cookie: bobCookie },
      payload: { status: 'suspended' },
    }),
  );
  const missingServiceProblem = assertDenied(
    await app.inject({
      method: 'PATCH',
      url: `/v1/merchants/${bob.merchant.merchantId}/services/${nonexistentIds.service}`,
      headers: { cookie: bobCookie },
      payload: { status: 'disabled' },
    }),
  );
  assert.equal(missingMerchantProblem.code, 'AUTHORIZATION_DENIED');
  assert.equal(missingServiceProblem.code, 'AUTHORIZATION_DENIED');

  const aliceAgent = await database
    .selectFrom('agents')
    .select('status')
    .where('name', '=', 'Agent Alice')
    .executeTakeFirstOrThrow();
  const aliceMerchant = await database
    .selectFrom('merchants')
    .select('status')
    .where('name', '=', 'Merchant Alice')
    .executeTakeFirstOrThrow();
  const aliceService = await database
    .selectFrom('services')
    .select('status')
    .where('name', '=', 'Service Alice')
    .executeTakeFirstOrThrow();
  const aliceKey = await database
    .selectFrom('apiKeys')
    .select('status')
    .where('name', '=', 'Key Alice')
    .executeTakeFirstOrThrow();
  assert.deepEqual(
    [aliceAgent.status, aliceMerchant.status, aliceService.status, aliceKey.status],
    ['enabled', 'active', 'enabled', 'active'],
  );

  const bobAgents = parseBody(
    await app.inject({ method: 'GET', url: '/v1/agents', headers: { cookie: bobCookie } }),
  ).data;
  const bobMerchants = parseBody(
    await app.inject({ method: 'GET', url: '/v1/merchants', headers: { cookie: bobCookie } }),
  ).data;
  assert.deepEqual(
    bobAgents.map((agent) => agent.agentId),
    [bob.agent.agentId],
  );
  assert.deepEqual(
    bobMerchants.map((merchant) => merchant.merchantId),
    [bob.merchant.merchantId],
  );
});
