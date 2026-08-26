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

function generateEd25519KeyMaterial() {
  const pair = generateKeyPairSync('ed25519');
  const publicDer = pair.publicKey.export({ type: 'spki', format: 'der' });
  const privateDer = pair.privateKey.export({ type: 'pkcs8', format: 'der' });

  return Object.freeze({
    publicKey: Buffer.from(publicDer).subarray(-32).toString('base64url'),
    privateKeyMarker: Buffer.from(privateDer).toString('base64url'),
  });
}

test('registers an Agent public key and manages its enabled state with ownership isolation', async (context) => {
  const container = {
    name: `aipay-agent-test-${process.pid}`,
    database: 'aipay_agent_test',
    user: 'aipay',
    password: 'agent-test-only',
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
  const ownerCookie = await register(app, 'agent-owner@example.com');
  const keyMaterial = generateEd25519KeyMaterial();

  const created = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { cookie: ownerCookie },
    payload: { name: 'Purchasing Agent', publicKey: keyMaterial.publicKey },
  });
  assert.equal(created.statusCode, 201);
  const agent = parseBody(created).data;
  assert.match(agent.agentId, /^agt_[0-9a-f-]{36}$/u);
  assert.match(agent.signingKey.keyId, /^key_[0-9a-f-]{36}$/u);
  assert.equal(agent.name, 'Purchasing Agent');
  assert.equal(agent.status, 'enabled');
  assert.equal(agent.signingKey.algorithm, 'ed25519');
  assert.equal(agent.signingKey.publicKey, keyMaterial.publicKey);
  assert.equal(created.body.includes(keyMaterial.privateKeyMarker), false);

  const storedAgent = await database
    .selectFrom('agents')
    .select(['id', 'developerId', 'name', 'status'])
    .executeTakeFirstOrThrow();
  const storedKey = await database
    .selectFrom('signingKeys')
    .select(['ownerType', 'agentId', 'publicKey', 'status'])
    .executeTakeFirstOrThrow();
  assert.equal(storedAgent.name, 'Purchasing Agent');
  assert.equal(storedAgent.status, 'enabled');
  assert.equal(storedKey.ownerType, 'agent');
  assert.equal(storedKey.agentId, storedAgent.id);
  assert.equal(storedKey.status, 'active');
  assert.equal(Buffer.from(storedKey.publicKey).toString('base64url'), keyMaterial.publicKey);
  assert.equal(JSON.stringify(storedKey).includes(keyMaterial.privateKeyMarker), false);

  const listed = await app.inject({
    method: 'GET',
    url: '/v1/agents',
    headers: { cookie: ownerCookie },
  });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(parseBody(listed).data, [agent]);

  const disabled = await app.inject({
    method: 'PATCH',
    url: `/v1/agents/${agent.agentId}/status`,
    headers: { cookie: ownerCookie },
    payload: { status: 'disabled' },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(parseBody(disabled).data.status, 'disabled');

  const enabled = await app.inject({
    method: 'PATCH',
    url: `/v1/agents/${agent.agentId}/status`,
    headers: { cookie: ownerCookie },
    payload: { status: 'enabled' },
  });
  assert.equal(enabled.statusCode, 200);
  assert.equal(parseBody(enabled).data.status, 'enabled');

  const secondKey = generateEd25519KeyMaterial();
  const duplicateName = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { cookie: ownerCookie },
    payload: { name: 'purchasing agent', publicKey: secondKey.publicKey },
  });
  assert.equal(duplicateName.statusCode, 400);
  assert.equal(parseBody(duplicateName).errors[0].code, 'name_unavailable');

  const duplicateKey = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { cookie: ownerCookie },
    payload: { name: 'Another Agent', publicKey: keyMaterial.publicKey },
  });
  assert.equal(duplicateKey.statusCode, 400);
  assert.equal(parseBody(duplicateKey).errors[0].code, 'public_key_unavailable');

  for (const payload of [
    { name: '   ', publicKey: secondKey.publicKey },
    { name: 'Invalid Key', publicKey: 'B'.repeat(43) },
    { name: 'Unknown Field', publicKey: secondKey.publicKey, privateKey: 'forbidden' },
  ]) {
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { cookie: ownerCookie },
      payload,
    });
    assert.equal(invalid.statusCode, 400);
  }

  const otherCookie = await register(app, 'other-agent-owner@example.com');
  const crossAccount = await app.inject({
    method: 'PATCH',
    url: `/v1/agents/${agent.agentId}/status`,
    headers: { cookie: otherCookie },
    payload: { status: 'disabled' },
  });
  assert.equal(crossAccount.statusCode, 403);
  assert.equal(parseBody(crossAccount).code, 'AUTHORIZATION_DENIED');

  const otherList = await app.inject({
    method: 'GET',
    url: '/v1/agents',
    headers: { cookie: otherCookie },
  });
  assert.deepEqual(parseBody(otherList).data, []);
});
