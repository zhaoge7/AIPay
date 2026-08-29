import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
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

function extractSessionToken(response) {
  const header = response.headers['set-cookie'];
  assert.equal(typeof header, 'string');
  const match = /(?:^|;\s*)aipay_session=([^;]+)/u.exec(header);
  assert.notEqual(match, null);
  return decodeURIComponent(match[1]);
}

test('registers and logs in a local developer without storing credentials in plaintext', async (context) => {
  const container = {
    name: `aipay-auth-test-${process.pid}`,
    database: 'aipay_auth_test',
    user: 'aipay',
    password: 'auth-test-only',
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
    payload: { email: '  Developer@Example.COM  ', password },
  });

  assert.equal(registration.statusCode, 201);
  const registrationBody = parseBody(registration);
  assert.equal(registrationBody.data.email, 'developer@example.com');
  assert.match(registrationBody.data.developerId, /^dev_[0-9a-f-]{36}$/u);
  assert.match(registrationBody.meta.traceId, /^[0-9a-f]{32}$/u);
  assert.equal(registration.body.includes(password), false);

  const registrationCookie = registration.headers['set-cookie'];
  assert.match(registrationCookie, /HttpOnly/iu);
  assert.match(registrationCookie, /SameSite=Lax/iu);
  assert.match(registrationCookie, /Path=\//u);
  const firstToken = extractSessionToken(registration);
  assert.match(firstToken, /^aps_[A-Za-z0-9_-]{43}$/u);

  const developer = await database
    .selectFrom('developers')
    .select(['id', 'email', 'passwordHash'])
    .executeTakeFirstOrThrow();
  assert.equal(developer.email, 'developer@example.com');
  assert.notEqual(developer.passwordHash, password);
  assert.match(developer.passwordHash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);

  const firstSession = await database
    .selectFrom('authSessions')
    .select(['tokenHash'])
    .executeTakeFirstOrThrow();
  const expectedHash = createHash('sha256').update(firstToken, 'utf8').digest();
  assert.deepEqual(Buffer.from(firstSession.tokenHash), expectedHash);
  assert.equal(Buffer.from(firstSession.tokenHash).toString('utf8').includes(firstToken), false);

  const duplicate = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'developer@example.com', password },
  });
  assert.equal(duplicate.statusCode, 400);
  assert.match(duplicate.headers['content-type'], /^application\/problem\+json/u);
  assert.equal(parseBody(duplicate).errors[0].code, 'email_unavailable');

  const wrongPassword = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'developer@example.com', password: 'This password is incorrect' },
  });
  const missingAccount = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'missing@example.com', password: 'This password is incorrect' },
  });
  assert.equal(wrongPassword.statusCode, 401);
  assert.equal(missingAccount.statusCode, 401);
  const wrongProblem = parseBody(wrongPassword);
  const missingProblem = parseBody(missingAccount);
  assert.deepEqual(
    [wrongProblem.code, wrongProblem.title, wrongProblem.kind, wrongProblem.retryable],
    [missingProblem.code, missingProblem.title, missingProblem.kind, missingProblem.retryable],
  );

  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'DEVELOPER@example.com', password },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(parseBody(login).data.developerId, registrationBody.data.developerId);
  assert.notEqual(extractSessionToken(login), firstToken);
  const sessions = await database
    .selectFrom('authSessions')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(Number(sessions.count), 2);

  const currentSession = await app.inject({
    method: 'GET',
    url: '/v1/auth/session',
    headers: { cookie: `aipay_session=${encodeURIComponent(firstToken)}` },
  });
  assert.equal(currentSession.statusCode, 200);
  assert.equal(parseBody(currentSession).data.email, 'developer@example.com');

  const logout = await app.inject({
    method: 'POST',
    url: '/v1/auth/logout',
    headers: { cookie: `aipay_session=${encodeURIComponent(firstToken)}` },
  });
  assert.equal(logout.statusCode, 200);
  assert.equal(parseBody(logout).data.loggedOut, true);
  assert.match(logout.headers['set-cookie'], /aipay_session=;/u);

  const revokedSession = await app.inject({
    method: 'GET',
    url: '/v1/auth/session',
    headers: { cookie: `aipay_session=${encodeURIComponent(firstToken)}` },
  });
  assert.equal(revokedSession.statusCode, 401);
});

test('rejects malformed registration bodies and weak credentials', async (context) => {
  const container = {
    name: `aipay-auth-validation-test-${process.pid}`,
    database: 'aipay_auth_validation_test',
    user: 'aipay',
    password: 'auth-validation-test-only',
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

  const cases = [
    { email: 'not-an-email', password },
    { email: 'valid@example.com', password: 'too-short' },
    { email: 'valid@example.com', password, admin: true },
  ];

  for (const payload of cases) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload,
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.headers['content-type'], /^application\/problem\+json/u);
    assert.equal(parseBody(response).code, 'INVALID_REQUEST');
  }

  const developers = await database
    .selectFrom('developers')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(Number(developers.count), 0);
});
