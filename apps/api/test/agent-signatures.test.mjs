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
const targetUrl = 'http://api.aipay.test/v1/agent/verify';
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

function createSignedRequest({
  agentId,
  keyId,
  privateKey,
  body = '{"action":"verify"}',
  created = Math.floor(Date.now() / 1_000),
  expires = created + 300,
  nonce = randomBytes(16).toString('base64url'),
}) {
  const headers = {
    host: 'api.aipay.test',
    'content-type': 'application/json',
    'content-digest': `sha-256=:${createHash('sha256').update(body, 'utf8').digest('base64')}:`,
    'x-aipay-agent-id': agentId,
  };
  const params = {
    keyid: keyId,
    alg: 'ed25519',
    created,
    expires,
    nonce,
    tag: 'aipay-agent-v1',
    coveredComponents,
  };
  const signatureBase = buildSignatureBase(
    { method: 'POST', url: targetUrl, headers, body },
    params,
  );
  const signature = sign(null, signatureBaseToBytes(signatureBase), privateKey).toString('base64');
  const components = coveredComponents.map((component) => `"${component}"`).join(' ');
  headers['signature-input'] =
    `aipay=(${components});created=${created};expires=${expires};nonce="${nonce}";` +
    `keyid="${keyId}";alg="ed25519";tag="aipay-agent-v1"`;
  headers.signature = `aipay=:${signature}:`;

  return Object.freeze({ body, headers });
}

async function registerAgent(app, publicKey) {
  const registration = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'signature-owner@example.com', password },
  });
  const cookie = cookieHeader(registration);
  const agentResponse = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { cookie },
    payload: { name: 'Signed Agent', publicKey },
  });
  assert.equal(agentResponse.statusCode, 201);
  return Object.freeze({ cookie, agent: parseBody(agentResponse).data });
}

test('verifies RFC 9421 Agent requests and atomically rejects replay', async (context) => {
  const container = {
    name: `aipay-agent-signature-test-${process.pid}`,
    database: 'aipay_agent_signature_test',
    user: 'aipay',
    password: 'agent-signature-test-only',
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
  database = createDatabase(databaseUrl, { maxConnections: 5 });
  app = await buildApp({ database });
  const keyPair = generateKeyPairSync('ed25519');
  const publicDer = keyPair.publicKey.export({ type: 'spki', format: 'der' });
  const publicKey = Buffer.from(publicDer).subarray(-32).toString('base64url');
  const { cookie, agent } = await registerAgent(app, publicKey);

  const signed = createSignedRequest({
    agentId: agent.agentId,
    keyId: agent.signingKey.keyId,
    privateKey: keyPair.privateKey,
  });
  const [first, replay] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/v1/agent/verify',
      headers: signed.headers,
      payload: signed.body,
    }),
    app.inject({
      method: 'POST',
      url: '/v1/agent/verify',
      headers: signed.headers,
      payload: signed.body,
    }),
  ]);
  assert.deepEqual([first.statusCode, replay.statusCode].sort(), [200, 409]);
  const success = first.statusCode === 200 ? first : replay;
  const rejectedReplay = first.statusCode === 409 ? first : replay;
  assert.equal(parseBody(success).data.agentId, agent.agentId);
  assert.equal(parseBody(success).data.keyId, agent.signingKey.keyId);
  assert.equal(parseBody(rejectedReplay).code, 'REPLAY_DETECTED');

  const nonces = await database
    .selectFrom('agentRequestNonces')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(Number(nonces.count), 1);

  const digestSigned = createSignedRequest({
    agentId: agent.agentId,
    keyId: agent.signingKey.keyId,
    privateKey: keyPair.privateKey,
  });
  const digestMismatch = await app.inject({
    method: 'POST',
    url: '/v1/agent/verify',
    headers: digestSigned.headers,
    payload: '{"action": "verify"}',
  });
  assert.equal(digestMismatch.statusCode, 401);
  assert.equal(parseBody(digestMismatch).code, 'SIGNATURE_INVALID');

  const tampered = createSignedRequest({
    agentId: agent.agentId,
    keyId: agent.signingKey.keyId,
    privateKey: keyPair.privateKey,
  });
  const signatureHeader = tampered.headers.signature;
  tampered.headers.signature = `${signatureHeader.slice(0, -3)}AA:`;
  const invalidSignature = await app.inject({
    method: 'POST',
    url: '/v1/agent/verify',
    headers: tampered.headers,
    payload: tampered.body,
  });
  assert.equal(invalidSignature.statusCode, 401);

  const now = Math.floor(Date.now() / 1_000);
  for (const request of [
    createSignedRequest({
      agentId: agent.agentId,
      keyId: agent.signingKey.keyId,
      privateKey: keyPair.privateKey,
      created: now - 400,
      expires: now - 100,
    }),
    createSignedRequest({
      agentId: agent.agentId,
      keyId: agent.signingKey.keyId,
      privateKey: keyPair.privateKey,
      created: now + 31,
      expires: now + 100,
    }),
    createSignedRequest({
      agentId: agent.agentId,
      keyId: agent.signingKey.keyId,
      privateKey: keyPair.privateKey,
      nonce: 'not-canonical',
    }),
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/verify',
      headers: request.headers,
      payload: request.body,
    });
    assert.equal(response.statusCode, 401);
  }

  const missingSignature = await app.inject({
    method: 'POST',
    url: '/v1/agent/verify',
    headers: { host: 'api.aipay.test', 'content-type': 'application/json' },
    payload: '{"action":"verify"}',
  });
  assert.equal(missingSignature.statusCode, 401);

  const disabled = await app.inject({
    method: 'PATCH',
    url: `/v1/agents/${agent.agentId}/status`,
    headers: { cookie },
    payload: { status: 'disabled' },
  });
  assert.equal(disabled.statusCode, 200);
  const disabledRequest = createSignedRequest({
    agentId: agent.agentId,
    keyId: agent.signingKey.keyId,
    privateKey: keyPair.privateKey,
  });
  const disabledResponse = await app.inject({
    method: 'POST',
    url: '/v1/agent/verify',
    headers: disabledRequest.headers,
    payload: disabledRequest.body,
  });
  assert.equal(disabledResponse.statusCode, 403);
  assert.equal(parseBody(disabledResponse).code, 'AUTHORIZATION_DENIED');
});
