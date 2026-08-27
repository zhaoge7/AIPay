import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync } from 'node:crypto';
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
  return Object.freeze({ cookie: cookieHeader(response), developer: parseBody(response).data });
}

async function createAgent(app, cookie, name) {
  const keys = generateKeyPairSync('ed25519');
  const der = keys.publicKey.export({ type: 'spki', format: 'der' });
  const response = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { cookie },
    payload: {
      name,
      publicKey: Buffer.from(der).subarray(-32).toString('base64url'),
    },
  });
  assert.equal(response.statusCode, 201);
  return parseBody(response).data;
}

async function createMerchant(app, cookie, name) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/merchants',
    headers: { cookie },
    payload: { name, callbackUrl: 'https://mandate-merchant.example.com/webhook' },
  });
  assert.equal(response.statusCode, 201);
  return parseBody(response).data;
}

function draftInput(agentId, merchantId) {
  return {
    agentId,
    purpose: 'Purchase weather data for travel planning',
    allowedMerchantIds: [merchantId],
    allowedCategories: ['data.weather'],
    maxPerTransaction: { currency: 'CNY', amountMinor: '1000' },
    totalBudget: { currency: 'CNY', amountMinor: '10000' },
    approvalRequiredAbove: { currency: 'CNY', amountMinor: '500' },
    maxTransactions: 100,
    validUntil: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    instructionHash: `sha256:${createHash('sha256').update('travel weather instruction').digest('hex')}`,
  };
}

test('creates a structured unsigned Mandate draft without any LLM dependency', async (context) => {
  const container = {
    name: `aipay-mandate-draft-test-${process.pid}`,
    database: 'aipay_mandate_draft_test',
    user: 'aipay',
    password: 'mandate-draft-test-only',
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
  const principal = await register(app, 'mandate-principal@example.com');
  const merchantOwner = await register(app, 'mandate-merchant-owner@example.com');
  const agent = await createAgent(app, principal.cookie, 'Mandated Agent');
  const merchant = await createMerchant(app, merchantOwner.cookie, 'Mandate Merchant');
  const input = draftInput(agent.agentId, merchant.merchantId);

  const response = await app.inject({
    method: 'POST',
    url: '/v1/mandates',
    headers: { cookie: principal.cookie },
    payload: input,
  });
  assert.equal(response.statusCode, 201);
  const draft = parseBody(response).data;
  assert.match(draft.mandateId, /^mdt_[0-9a-f-]{36}$/u);
  assert.equal(draft.principalId, principal.developer.developerId);
  assert.equal(draft.agentId, agent.agentId);
  assert.deepEqual(draft.allowedMerchantIds, [merchant.merchantId]);
  assert.deepEqual(draft.allowedCategories, ['data.weather']);
  assert.deepEqual(draft.maxPerTransaction, input.maxPerTransaction);
  assert.deepEqual(draft.totalBudget, input.totalBudget);
  assert.equal(draft.status, 'draft');
  assert.equal('proof' in draft, false);

  const stored = await database
    .selectFrom('mandates')
    .select([
      'status',
      'proofKeyId',
      'proofValue',
      'instructionHash',
      'maxPerTransactionAmountMinor',
      'totalBudgetAmountMinor',
    ])
    .executeTakeFirstOrThrow();
  assert.equal(stored.status, 'draft');
  assert.equal(stored.proofKeyId, null);
  assert.equal(stored.proofValue, null);
  assert.equal(Buffer.from(stored.instructionHash).byteLength, 32);
  assert.equal(stored.maxPerTransactionAmountMinor, '1000');
  assert.equal(stored.totalBudgetAmountMinor, '10000');
  const merchants = await database.selectFrom('mandateAllowedMerchants').selectAll().execute();
  const categories = await database.selectFrom('mandateAllowedCategories').selectAll().execute();
  assert.equal(merchants.length, 1);
  assert.deepEqual(
    categories.map((row) => row.category),
    ['data.weather'],
  );

  const other = await register(app, 'other-mandate-principal@example.com');
  const crossAgent = await app.inject({
    method: 'POST',
    url: '/v1/mandates',
    headers: { cookie: other.cookie },
    payload: input,
  });
  assert.equal(crossAgent.statusCode, 403);

  await app.inject({
    method: 'PATCH',
    url: `/v1/agents/${agent.agentId}/status`,
    headers: { cookie: principal.cookie },
    payload: { status: 'disabled' },
  });
  const disabledAgent = await app.inject({
    method: 'POST',
    url: '/v1/mandates',
    headers: { cookie: principal.cookie },
    payload: input,
  });
  assert.equal(disabledAgent.statusCode, 403);

  await app.inject({
    method: 'PATCH',
    url: `/v1/agents/${agent.agentId}/status`,
    headers: { cookie: principal.cookie },
    payload: { status: 'enabled' },
  });
  await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${merchant.merchantId}`,
    headers: { cookie: merchantOwner.cookie },
    payload: { status: 'suspended' },
  });
  const suspendedMerchant = await app.inject({
    method: 'POST',
    url: '/v1/mandates',
    headers: { cookie: principal.cookie },
    payload: { ...input, purpose: 'A second valid purpose' },
  });
  assert.equal(suspendedMerchant.statusCode, 403);

  await app.inject({
    method: 'PATCH',
    url: `/v1/merchants/${merchant.merchantId}`,
    headers: { cookie: merchantOwner.cookie },
    payload: { status: 'active' },
  });

  const invalidInputs = [
    {
      ...input,
      maxPerTransaction: { currency: 'CNY', amountMinor: '10001' },
      totalBudget: { currency: 'CNY', amountMinor: '10000' },
    },
    { ...input, allowedMerchantIds: [merchant.merchantId, merchant.merchantId] },
    { ...input, allowedCategories: ['data.weather', 'data.weather'] },
    { ...input, validUntil: new Date(Date.now() - 1_000).toISOString() },
    { ...input, validUntil: new Date(Date.now() + 366 * 24 * 60 * 60 * 1_000).toISOString() },
    { ...input, instructionHash: 'sha256:not-a-digest' },
    { ...input, unexpected: true },
  ];

  for (const invalid of invalidInputs) {
    const invalidResponse = await app.inject({
      method: 'POST',
      url: '/v1/mandates',
      headers: { cookie: principal.cookie },
      payload: invalid,
    });
    assert.equal(invalidResponse.statusCode, 400);
  }

  const mandateCount = await database
    .selectFrom('mandates')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(Number(mandateCount.count), 1);
});
