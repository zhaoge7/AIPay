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
const catalogPath = '/v1/catalog/services';

function body(response) {
  return JSON.parse(response.body);
}

function sessionCookie(response) {
  const value = response.headers['set-cookie'];
  assert.equal(typeof value, 'string');
  return value.split(';', 1)[0];
}

function signedCatalogHeaders(agent, privateKey) {
  const coveredComponents = [
    '@method',
    '@target-uri',
    'content-digest',
    'content-type',
    'x-aipay-agent-id',
  ];
  const created = Math.floor(Date.now() / 1_000);
  const expires = created + 300;
  const nonce = randomBytes(16).toString('base64url');
  const headers = {
    host: 'api.aipay.test',
    'content-type': 'application/json',
    'content-digest': `sha-256=:${createHash('sha256').update('').digest('base64')}:`,
    'x-aipay-agent-id': agent.agentId,
  };
  const parameters = {
    keyid: agent.signingKey.keyId,
    alg: 'ed25519',
    created,
    expires,
    nonce,
    tag: 'aipay-agent-v1',
    coveredComponents,
  };
  const signatureBase = buildSignatureBase(
    {
      method: 'GET',
      url: `http://api.aipay.test${catalogPath}`,
      headers,
      body: '',
    },
    parameters,
  );
  const signature = sign(null, signatureBaseToBytes(signatureBase), privateKey).toString('base64');
  const components = coveredComponents.map((component) => `"${component}"`).join(' ');
  headers['signature-input'] =
    `aipay=(${components});created=${created};expires=${expires};nonce="${nonce}";` +
    `keyid="${agent.signingKey.keyId}";alg="ed25519";tag="aipay-agent-v1"`;
  headers.signature = `aipay=:${signature}:`;
  return headers;
}

test('passes Gate P3 with a signed Agent querying an enabled paid service', async (context) => {
  const container = {
    name: `aipay-gate-p3-${process.pid}`,
    database: 'aipay_gate_p3_test',
    user: 'aipay',
    password: 'gate-p3-only',
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

  const registration = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: 'gate-p3@example.com',
      password: 'Correct horse battery staple 2026!',
    },
  });
  const cookie = sessionCookie(registration);
  const keys = generateKeyPairSync('ed25519');
  const publicDer = keys.publicKey.export({ type: 'spki', format: 'der' });
  const agentResponse = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { cookie },
    payload: {
      name: 'Gate Agent',
      publicKey: Buffer.from(publicDer).subarray(-32).toString('base64url'),
    },
  });
  const agent = body(agentResponse).data;
  const merchantResponse = await app.inject({
    method: 'POST',
    url: '/v1/merchants',
    headers: { cookie },
    payload: {
      name: 'Gate Merchant',
      callbackUrl: 'https://gate-merchant.example.com/webhook',
    },
  });
  const merchant = body(merchantResponse).data;
  const serviceResponse = await app.inject({
    method: 'POST',
    url: `/v1/merchants/${merchant.merchantId}/services`,
    headers: { cookie },
    payload: {
      type: 'mcp',
      name: 'Paid Weather Tool',
      category: 'data.weather',
      unit: 'tool_call',
      unitPrice: { currency: 'CNY', amountMinor: '300' },
      refundPolicy: 'full_on_delivery_failure',
    },
  });
  const service = body(serviceResponse).data;

  const catalogResponse = await app.inject({
    method: 'GET',
    url: catalogPath,
    headers: signedCatalogHeaders(agent, keys.privateKey),
  });
  assert.equal(catalogResponse.statusCode, 200);
  const catalog = body(catalogResponse).data;
  assert.equal(catalog.items.length, 1);
  assert.deepEqual(catalog.items[0], {
    ...service,
    merchantName: 'Gate Merchant',
  });
  assert.equal(catalog.items[0].unitPrice.amountMinor, '300');
  assert.equal(catalog.items[0].status, 'enabled');
});
