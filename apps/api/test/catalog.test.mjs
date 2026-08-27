import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';

import { buildSignatureBase, signatureBaseToBytes } from '@peac/http-signatures';
import { createDatabase } from '@aipay/database';

import { buildApp } from '../dist/app.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;
const password = 'Correct horse battery staple 2026!';
const coveredComponents = [
  '@method',
  '@target-uri',
  'content-digest',
  'content-type',
  'x-aipay-agent-id',
];

function parseBody(response) {
  return JSON.parse(response.body);
}

function cookieHeader(response) {
  const value = response.headers['set-cookie'];
  assert.equal(typeof value, 'string');
  return value.split(';', 1)[0];
}

function signCatalogRequest(path, agent, privateKey) {
  const created = Math.floor(Date.now() / 1_000);
  const expires = created + 300;
  const nonce = randomBytes(16).toString('base64url');
  const targetUrl = `http://api.aipay.test${path}`;
  const headers = {
    host: 'api.aipay.test',
    'content-type': 'application/json',
    'content-digest': `sha-256=:${createHash('sha256').update('').digest('base64')}:`,
    'x-aipay-agent-id': agent.agentId,
  };
  const params = {
    keyid: agent.signingKey.keyId,
    alg: 'ed25519',
    created,
    expires,
    nonce,
    tag: 'aipay-agent-v1',
    coveredComponents,
  };
  const base = buildSignatureBase({ method: 'GET', url: targetUrl, headers, body: '' }, params);
  const signature = sign(null, signatureBaseToBytes(base), privateKey).toString('base64');
  const components = coveredComponents.map((component) => `"${component}"`).join(' ');
  headers['signature-input'] =
    `aipay=(${components});created=${created};expires=${expires};nonce="${nonce}";` +
    `keyid="${agent.signingKey.keyId}";alg="ed25519";tag="aipay-agent-v1"`;
  headers.signature = `aipay=:${signature}:`;
  return headers;
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
    payload: { name, callbackUrl: `https://${name.toLowerCase()}.example.com/webhook` },
  });
  assert.equal(response.statusCode, 201);
  return parseBody(response).data;
}

async function createService(app, cookie, merchantId, definition) {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/merchants/${merchantId}/services`,
    headers: { cookie },
    payload: definition,
  });
  assert.equal(response.statusCode, 201);
  return parseBody(response).data;
}

test('lets a signed Agent query only active machine-readable paid services', async (context) => {
  const container = {
    name: `aipay-catalog-test-${process.pid}`,
    database: 'aipay_catalog_test',
    user: 'aipay',
    password: 'catalog-test-only',
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
  const cookie = await register(app, 'catalog-owner@example.com');
  const keyPair = generateKeyPairSync('ed25519');
  const publicDer = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  const publicKey = Buffer.from(publicDer).subarray(-32).toString('base64url');
  const agentResponse = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { cookie },
    payload: { name: 'Catalog Agent', publicKey },
  });
  const agent = parseBody(agentResponse).data;
  const activeMerchant = await createMerchant(app, cookie, 'ActiveMerchant');
  const suspendedMerchant = await createMerchant(app, cookie, 'SuspendedMerchant');
  const apiService = await createService(app, cookie, activeMerchant.merchantId, {
    type: 'api',
    name: 'Weather API',
    category: 'data.weather',
    unit: 'request',
    unitPrice: { currency: 'CNY', amountMinor: '200' },
    refundPolicy: 'full_on_delivery_failure',
  });
  const skillService = await createService(app, cookie, activeMerchant.merchantId, {
    type: 'skill',
    name: 'Forecast Skill',
    category: 'agent.weather',
    unit: 'execution',
    unitPrice: { currency: 'CNY', amountMinor: '500' },
    refundPolicy: 'non_refundable',
  });
  const disabledService = await createService(app, cookie, activeMerchant.merchantId, {
    type: 'mcp',
    name: 'Disabled MCP',
    category: 'data.weather',
    unit: 'tool_call',
    unitPrice: { currency: 'CNY', amountMinor: '300' },
    refundPolicy: 'non_refundable',
  });
  await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${activeMerchant.merchantId}/services/${disabledService.serviceId}`,
    headers: { cookie },
    payload: { status: 'disabled' },
  });
  await createService(app, cookie, suspendedMerchant.merchantId, {
    type: 'api',
    name: 'Hidden API',
    category: 'data.hidden',
    unit: 'request',
    unitPrice: { currency: 'CNY', amountMinor: '999' },
    refundPolicy: 'non_refundable',
  });
  await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${suspendedMerchant.merchantId}`,
    headers: { cookie },
    payload: { status: 'suspended' },
  });

  const unsigned = await app.inject({ method: 'GET', url: '/v1/catalog/services' });
  assert.equal(unsigned.statusCode, 401);

  const path = '/v1/catalog/services';
  const response = await app.inject({
    method: 'GET',
    url: path,
    headers: signCatalogRequest(path, agent, keyPair.privateKey),
  });
  assert.equal(response.statusCode, 200);
  const page = parseBody(response).data;
  assert.equal(page.items.length, 2);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(
    new Set(page.items.map((item) => item.serviceId)),
    new Set([apiService.serviceId, skillService.serviceId]),
  );
  for (const item of page.items) {
    assert.equal(typeof item.unitPrice.amountMinor, 'string');
    assert.equal(item.merchantName, 'ActiveMerchant');
    assert.equal('callbackUrl' in item, false);
    assert.equal(item.status, 'enabled');
  }

  const filterPath = '/v1/catalog/services?type=api&category=data.weather';
  const filtered = await app.inject({
    method: 'GET',
    url: filterPath,
    headers: signCatalogRequest(filterPath, agent, keyPair.privateKey),
  });
  assert.deepEqual(
    parseBody(filtered).data.items.map((item) => item.serviceId),
    [apiService.serviceId],
  );

  const firstPath = '/v1/catalog/services?limit=1';
  const firstPage = parseBody(
    await app.inject({
      method: 'GET',
      url: firstPath,
      headers: signCatalogRequest(firstPath, agent, keyPair.privateKey),
    }),
  ).data;
  assert.equal(firstPage.items.length, 1);
  assert.match(firstPage.nextCursor, /^svc_/u);
  const secondPath = `/v1/catalog/services?limit=1&cursor=${firstPage.nextCursor}`;
  const secondPage = parseBody(
    await app.inject({
      method: 'GET',
      url: secondPath,
      headers: signCatalogRequest(secondPath, agent, keyPair.privateKey),
    }),
  ).data;
  assert.equal(secondPage.items.length, 1);
  assert.notEqual(secondPage.items[0].serviceId, firstPage.items[0].serviceId);
  assert.equal(secondPage.nextCursor, null);

  await app.inject({
    method: 'PATCH',
    url: `/v1/agents/${agent.agentId}/status`,
    headers: { cookie },
    payload: { status: 'disabled' },
  });
  const disabledPath = '/v1/catalog/services?type=skill';
  const disabledAgent = await app.inject({
    method: 'GET',
    url: disabledPath,
    headers: signCatalogRequest(disabledPath, agent, keyPair.privateKey),
  });
  assert.equal(disabledAgent.statusCode, 403);
  assert.equal(parseBody(disabledAgent).code, 'AUTHORIZATION_DENIED');
});
