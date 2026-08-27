import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';

import { parseResourceId } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';
import { v7 as uuidv7 } from 'uuid';

import { buildApp } from '../dist/app.js';
import { MandateIssuer } from '../dist/mandates/issuer.js';
import { MandateLifecycleError, MandateLifecycleService } from '../dist/mandates/lifecycle.js';
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

async function createFoundation(app, cookie) {
  const keys = generateKeyPairSync('ed25519');
  const publicDer = keys.publicKey.export({ type: 'spki', format: 'der' });
  const agentResponse = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { cookie },
    payload: {
      name: 'Lifecycle Agent',
      publicKey: Buffer.from(publicDer).subarray(-32).toString('base64url'),
    },
  });
  const merchantResponse = await app.inject({
    method: 'POST',
    url: '/v1/merchants',
    headers: { cookie },
    payload: {
      name: 'Lifecycle Merchant',
      callbackUrl: 'https://lifecycle-merchant.example.com/webhook',
    },
  });
  return Object.freeze({
    agent: parseBody(agentResponse).data,
    merchant: parseBody(merchantResponse).data,
  });
}

async function createDraft(app, cookie, foundation, purpose) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/mandates',
    headers: { cookie },
    payload: {
      agentId: foundation.agent.agentId,
      purpose,
      allowedMerchantIds: [foundation.merchant.merchantId],
      allowedCategories: ['data.weather'],
      maxPerTransaction: { currency: 'CNY', amountMinor: '1000' },
      totalBudget: { currency: 'CNY', amountMinor: '10000' },
      approvalRequiredAbove: { currency: 'CNY', amountMinor: '500' },
      maxTransactions: 100,
      validUntil: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      instructionHash: `sha256:${createHash('sha256').update(purpose).digest('hex')}`,
    },
  });
  assert.equal(response.statusCode, 201);
  return parseBody(response).data;
}

async function issue(app, cookie, mandateId) {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/mandates/${mandateId}/issue`,
    headers: { cookie },
  });
  assert.equal(response.statusCode, 200);
  return parseBody(response).data;
}

async function transition(app, cookie, mandateId, action) {
  return app.inject({
    method: 'POST',
    url: `/v1/mandates/${mandateId}/lifecycle`,
    headers: { cookie },
    payload: { action },
  });
}

test('pauses, resumes, revokes and expires Mandates before transaction use', async (context) => {
  const container = {
    name: `aipay-mandate-lifecycle-test-${process.pid}`,
    database: 'aipay_mandate_lifecycle_test',
    user: 'aipay',
    password: 'mandate-lifecycle-test-only',
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
  const issuer = new MandateIssuer(database, {
    keyId: `key_${uuidv7()}`,
    privateKeyPkcs8Base64: Buffer.from(privateDer).toString('base64'),
  });
  app = await buildApp({ database, mandateIssuer: issuer });
  const ownerCookie = await register(app, 'lifecycle-owner@example.com');
  const otherCookie = await register(app, 'lifecycle-other@example.com');
  const foundation = await createFoundation(app, ownerCookie);
  const draft = await createDraft(app, ownerCookie, foundation, 'Lifecycle mandate one');
  const wire = await issue(app, ownerCookie, draft.mandateId);
  const mandateId = parseResourceId(draft.mandateId, 'mdt');
  const agentId = parseResourceId(foundation.agent.agentId, 'agt');
  const lifecycle = new MandateLifecycleService(database);

  assert.equal((await lifecycle.assertUsable(mandateId, agentId)).status, 'active');

  const paused = await transition(app, ownerCookie, draft.mandateId, 'pause');
  assert.equal(paused.statusCode, 200);
  assert.equal(parseBody(paused).data.status, 'paused');
  await assert.rejects(
    lifecycle.assertUsable(mandateId, agentId),
    (error) => error instanceof MandateLifecycleError && error.code === 'inactive',
  );

  const resumed = await transition(app, ownerCookie, draft.mandateId, 'resume');
  assert.equal(parseBody(resumed).data.status, 'active');
  assert.equal((await lifecycle.assertUsable(mandateId, agentId)).status, 'active');

  await app.inject({
    method: 'PATCH',
    url: `/v1/agents/${foundation.agent.agentId}/status`,
    headers: { cookie: ownerCookie },
    payload: { status: 'disabled' },
  });
  await assert.rejects(
    lifecycle.assertUsable(mandateId, agentId),
    (error) => error instanceof MandateLifecycleError && error.code === 'agent_unavailable',
  );
  await app.inject({
    method: 'PATCH',
    url: `/v1/agents/${foundation.agent.agentId}/status`,
    headers: { cookie: ownerCookie },
    payload: { status: 'enabled' },
  });

  const revoked = await transition(app, ownerCookie, draft.mandateId, 'revoke');
  assert.equal(parseBody(revoked).data.status, 'revoked');
  assert.match(parseBody(revoked).data.revokedAt, /Z$/u);
  const revokedAgain = await transition(app, ownerCookie, draft.mandateId, 'revoke');
  assert.equal(parseBody(revokedAgain).data.status, 'revoked');
  await assert.rejects(
    lifecycle.assertUsable(mandateId, agentId),
    (error) => error instanceof MandateLifecycleError && error.code === 'inactive',
  );
  const cannotResume = await transition(app, ownerCookie, draft.mandateId, 'resume');
  assert.equal(cannotResume.statusCode, 409);

  const proofStillAuthentic = await app.inject({
    method: 'POST',
    url: '/v1/mandates/verify',
    payload: wire,
  });
  assert.equal(proofStillAuthentic.statusCode, 200);

  const crossAccount = await transition(app, otherCookie, draft.mandateId, 'pause');
  assert.equal(crossAccount.statusCode, 403);

  const draftTwo = await createDraft(app, ownerCookie, foundation, 'Lifecycle mandate two');
  const wireTwo = await issue(app, ownerCookie, draftTwo.mandateId);
  const future = new Date(Date.parse(wireTwo.validUntil) + 1);
  const futureLifecycle = new MandateLifecycleService(database, () => future);
  const secondId = parseResourceId(draftTwo.mandateId, 'mdt');
  await assert.rejects(
    futureLifecycle.assertUsable(secondId, agentId),
    (error) => error instanceof MandateLifecycleError && error.code === 'expired',
  );
  const expiredStored = await database
    .selectFrom('mandates')
    .select(['status', 'statusChangedAt'])
    .where('id', '=', draftTwo.mandateId.slice(4))
    .executeTakeFirstOrThrow();
  assert.equal(expiredStored.status, 'expired');
  assert.equal(expiredStored.statusChangedAt.toISOString(), future.toISOString());

  const unsignedDraft = await createDraft(app, ownerCookie, foundation, 'Unsigned lifecycle draft');
  await assert.rejects(
    lifecycle.assertUsable(parseResourceId(unsignedDraft.mandateId, 'mdt'), agentId),
    (error) => error instanceof MandateLifecycleError && error.code === 'inactive',
  );

  const invalidAction = await transition(app, ownerCookie, unsignedDraft.mandateId, 'delete');
  assert.equal(invalidAction.statusCode, 400);
});
