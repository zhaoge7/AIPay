import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';

import { parseMandate } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';
import { v7 as uuidv7 } from 'uuid';

import { buildApp } from '../dist/app.js';
import { MandateIssuer, MandateVerifier } from '../dist/mandates/issuer.js';
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

async function createDraft(app, cookie, suffix = 'One') {
  const agentKeys = generateKeyPairSync('ed25519');
  const publicDer = agentKeys.publicKey.export({ type: 'spki', format: 'der' });
  const agentResponse = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { cookie },
    payload: {
      name: `Issuance Agent ${suffix}`,
      publicKey: Buffer.from(publicDer).subarray(-32).toString('base64url'),
    },
  });
  const merchantResponse = await app.inject({
    method: 'POST',
    url: '/v1/merchants',
    headers: { cookie },
    payload: {
      name: `Issuance Merchant ${suffix}`,
      callbackUrl: 'https://issuance-merchant.example.com/webhook',
    },
  });
  const agent = parseBody(agentResponse).data;
  const merchant = parseBody(merchantResponse).data;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/mandates',
    headers: { cookie },
    payload: {
      agentId: agent.agentId,
      purpose: 'Purchase signed weather data',
      allowedMerchantIds: [merchant.merchantId],
      allowedCategories: ['data.weather'],
      maxPerTransaction: { currency: 'CNY', amountMinor: '1000' },
      totalBudget: { currency: 'CNY', amountMinor: '10000' },
      approvalRequiredAbove: { currency: 'CNY', amountMinor: '500' },
      maxTransactions: 100,
      validUntil: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      instructionHash: `sha256:${createHash('sha256').update('signed instruction').digest('hex')}`,
    },
  });
  assert.equal(response.statusCode, 201);
  return parseBody(response).data;
}

test('issues and independently verifies a JCS Ed25519 Mandate', async (context) => {
  const container = {
    name: `aipay-mandate-issuance-test-${process.pid}`,
    database: 'aipay_mandate_issuance_test',
    user: 'aipay',
    password: 'mandate-issuance-test-only',
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
  const issuerKeys = generateKeyPairSync('ed25519');
  const privateDer = issuerKeys.privateKey.export({ type: 'pkcs8', format: 'der' });
  const issuerKeyId = `key_${uuidv7()}`;
  const issueTime = new Date(Date.now() + 1_000);
  const issuer = new MandateIssuer(database, {
    keyId: issuerKeyId,
    privateKeyPkcs8Base64: Buffer.from(privateDer).toString('base64'),
    now: () => issueTime,
  });
  app = await buildApp({ database, mandateIssuer: issuer });
  const ownerCookie = await register(app, 'mandate-issuer-owner@example.com');
  const draft = await createDraft(app, ownerCookie);

  const issuedResponse = await app.inject({
    method: 'POST',
    url: `/v1/mandates/${draft.mandateId}/issue`,
    headers: { cookie: ownerCookie },
  });
  assert.equal(issuedResponse.statusCode, 200);
  const wire = parseBody(issuedResponse).data;
  const mandate = parseMandate(wire);
  assert.equal(wire.mandateId, draft.mandateId);
  assert.equal(wire.proof.keyId, issuerKeyId);
  assert.equal(wire.proof.scheme, 'aipay-jcs-ed25519-v1');
  assert.match(wire.proof.value, /^[A-Za-z0-9_-]{86}$/u);
  assert.equal(wire.issuedAt, issueTime.toISOString());
  assert.equal(mandate.purpose, draft.purpose);

  const verificationResponse = await app.inject({
    method: 'POST',
    url: '/v1/mandates/verify',
    payload: wire,
  });
  assert.equal(verificationResponse.statusCode, 200);
  assert.deepEqual(parseBody(verificationResponse).data, {
    valid: true,
    mandateId: wire.mandateId,
    keyId: issuerKeyId,
  });
  const independentVerifier = new MandateVerifier(database);
  assert.equal((await independentVerifier.verify(wire)).mandateId, mandate.mandateId);

  const storedMandate = await database
    .selectFrom('mandates')
    .select(['status', 'proofKeyId', 'proofValue', 'issuedAt'])
    .executeTakeFirstOrThrow();
  assert.equal(storedMandate.status, 'active');
  assert.equal(storedMandate.proofValue?.byteLength, 64);
  assert.equal(storedMandate.issuedAt.toISOString(), issueTime.toISOString());
  const storedKey = await database
    .selectFrom('signingKeys')
    .select(['ownerType', 'publicKey', 'status'])
    .where('id', '=', storedMandate.proofKeyId)
    .executeTakeFirstOrThrow();
  assert.equal(storedKey.ownerType, 'system');
  assert.equal(storedKey.publicKey.byteLength, 32);
  assert.equal(storedKey.status, 'active');
  assert.equal(
    JSON.stringify(storedKey).includes(Buffer.from(privateDer).toString('base64')),
    false,
  );

  const alternateMerchantId = 'mch_01890f3e-9d90-7cc2-98c5-7f6a1b2c3d4e';
  const tamperedValues = [
    { ...wire, purpose: 'Tampered purpose' },
    { ...wire, totalBudget: { currency: 'CNY', amountMinor: '9999' } },
    { ...wire, allowedMerchantIds: [alternateMerchantId] },
    {
      ...wire,
      proof: {
        ...wire.proof,
        value: `${wire.proof.value[0] === 'A' ? 'B' : 'A'}${wire.proof.value.slice(1)}`,
      },
    },
  ];

  for (const tampered of tamperedValues) {
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/mandates/verify',
      payload: tampered,
    });
    assert.equal(rejected.statusCode, 401);
    assert.equal(parseBody(rejected).code, 'SIGNATURE_INVALID');
  }

  const repeated = await app.inject({
    method: 'POST',
    url: `/v1/mandates/${draft.mandateId}/issue`,
    headers: { cookie: ownerCookie },
  });
  assert.equal(repeated.statusCode, 409);

  const otherCookie = await register(app, 'other-mandate-issuer@example.com');
  const otherDraft = await createDraft(app, ownerCookie, 'Two');
  const crossAccount = await app.inject({
    method: 'POST',
    url: `/v1/mandates/${otherDraft.mandateId}/issue`,
    headers: { cookie: otherCookie },
  });
  assert.equal(crossAccount.statusCode, 403);
});
