import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';

import { createDatabase } from '@aipay/database';

import { buildApp } from '../dist/app.js';
import { ApiKeyError, ApiKeyService } from '../dist/api-keys/service.js';
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
  return Object.freeze({
    cookie: cookieHeader(response),
    developerId: parseBody(response).data.developerId,
  });
}

test('creates, lists, authenticates, rotates and revokes API Keys safely', async (context) => {
  const container = {
    name: `aipay-api-key-test-${process.pid}`,
    database: 'aipay_api_key_test',
    user: 'aipay',
    password: 'api-key-test-only',
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
  const owner = await register(app, 'owner@example.com');

  const unauthenticated = await app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    payload: { name: 'Local Agent' },
  });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(parseBody(unauthenticated).code, 'UNAUTHENTICATED');

  const created = await app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: { cookie: owner.cookie },
    payload: { name: 'Local Agent', expiresInDays: 30 },
  });
  assert.equal(created.statusCode, 201);
  const createdData = parseBody(created).data;
  assert.match(createdData.apiKey.apiKeyId, /^apk_[0-9a-f-]{36}$/u);
  assert.match(createdData.token, /^apk_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
  assert.equal(createdData.apiKey.status, 'active');
  assert.equal(createdData.apiKey.hint, createdData.token.slice(-4));

  const stored = await database
    .selectFrom('apiKeys')
    .select(['tokenHash', 'tokenHint'])
    .executeTakeFirstOrThrow();
  const expectedHash = createHash('sha256').update(createdData.token, 'utf8').digest();
  assert.deepEqual(Buffer.from(stored.tokenHash), expectedHash);
  assert.equal(stored.tokenHint, createdData.token.slice(-4));
  assert.equal(Buffer.from(stored.tokenHash).toString('utf8').includes(createdData.token), false);

  const duplicate = await app.inject({
    method: 'POST',
    url: '/v1/api-keys',
    headers: { cookie: owner.cookie },
    payload: { name: 'local agent' },
  });
  assert.equal(duplicate.statusCode, 400);
  assert.equal(parseBody(duplicate).errors[0].code, 'name_unavailable');

  const listed = await app.inject({
    method: 'GET',
    url: '/v1/api-keys',
    headers: { cookie: owner.cookie },
  });
  assert.equal(listed.statusCode, 200);
  const listedData = parseBody(listed).data;
  assert.equal(listedData.length, 1);
  assert.equal(listedData[0].apiKeyId, createdData.apiKey.apiKeyId);
  assert.equal(listed.body.includes(createdData.token), false);
  assert.equal(listed.body.includes('tokenHash'), false);

  const service = new ApiKeyService(database);
  assert.equal(await service.authenticate(createdData.token), owner.developerId);

  const rotated = await app.inject({
    method: 'POST',
    url: `/v1/api-keys/${createdData.apiKey.apiKeyId}/rotate`,
    headers: { cookie: owner.cookie },
    payload: { expiresInDays: 60 },
  });
  assert.equal(rotated.statusCode, 201);
  const rotatedData = parseBody(rotated).data;
  assert.notEqual(rotatedData.apiKey.apiKeyId, createdData.apiKey.apiKeyId);
  assert.notEqual(rotatedData.token, createdData.token);
  await assert.rejects(
    service.authenticate(createdData.token),
    (error) => error instanceof ApiKeyError && error.code === 'invalid_token',
  );
  assert.equal(await service.authenticate(rotatedData.token), owner.developerId);

  const afterRotation = parseBody(
    await app.inject({
      method: 'GET',
      url: '/v1/api-keys',
      headers: { cookie: owner.cookie },
    }),
  ).data;
  const oldKey = afterRotation.find((key) => key.apiKeyId === createdData.apiKey.apiKeyId);
  assert.equal(oldKey.status, 'revoked');
  assert.equal(oldKey.replacedByApiKeyId, rotatedData.apiKey.apiKeyId);

  const revoked = await app.inject({
    method: 'DELETE',
    url: `/v1/api-keys/${rotatedData.apiKey.apiKeyId}`,
    headers: { cookie: owner.cookie },
  });
  assert.equal(revoked.statusCode, 200);
  assert.equal(parseBody(revoked).data.status, 'revoked');
  const revokedAgain = await app.inject({
    method: 'DELETE',
    url: `/v1/api-keys/${rotatedData.apiKey.apiKeyId}`,
    headers: { cookie: owner.cookie },
  });
  assert.equal(revokedAgain.statusCode, 200);
  await assert.rejects(
    service.authenticate(rotatedData.token),
    (error) => error instanceof ApiKeyError && error.code === 'invalid_token',
  );

  const other = await register(app, 'other@example.com');
  const crossAccount = await app.inject({
    method: 'DELETE',
    url: `/v1/api-keys/${rotatedData.apiKey.apiKeyId}`,
    headers: { cookie: other.cookie },
  });
  assert.equal(crossAccount.statusCode, 403);
  assert.equal(parseBody(crossAccount).code, 'AUTHORIZATION_DENIED');
});

test('rejects invalid API Key names, expiries and identifiers', async (context) => {
  const container = {
    name: `aipay-api-key-validation-test-${process.pid}`,
    database: 'aipay_api_key_validation_test',
    user: 'aipay',
    password: 'api-key-validation-only',
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
  database = createDatabase(databaseUrl, { maxConnections: 2 });
  app = await buildApp({ database });
  const owner = await register(app, 'validation@example.com');

  for (const payload of [
    { name: '   ' },
    { name: 'Agent', expiresInDays: 0 },
    { name: 'Agent', expiresInDays: 366 },
    { name: 'Agent', unexpected: true },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/api-keys',
      headers: { cookie: owner.cookie },
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(parseBody(response).code, 'INVALID_REQUEST');
  }

  const invalidId = await app.inject({
    method: 'DELETE',
    url: '/v1/api-keys/apk_not-a-uuid',
    headers: { cookie: owner.cookie },
  });
  assert.equal(invalidId.statusCode, 400);

  const count = await database
    .selectFrom('apiKeys')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(Number(count.count), 0);
});
