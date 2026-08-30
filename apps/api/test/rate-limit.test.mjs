import assert from 'node:assert/strict';
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

function body(response) {
  return JSON.parse(response.body);
}

function cookie(response) {
  const value = response.headers['set-cookie'];
  assert.equal(typeof value, 'string');
  return value.split(';', 1)[0];
}

function assertRateLimited(response) {
  assert.equal(response.statusCode, 429);
  assert.equal(body(response).code, 'RATE_LIMITED');
  assert.equal(body(response).retryable, true);
  assert.equal(body(response).retryAfterMs, 60_000);
  assert.equal(typeof response.headers['retry-after'], 'string');
}

test('limits IP, account, Agent and sensitive interfaces independently', async (context) => {
  const container = {
    name: `aipay-rate-limit-${process.pid}`,
    database: 'aipay_rate_limit_test',
    user: 'aipay',
    password: 'rate-limit-only',
  };
  let accountApp;
  let ipApp;
  let database;
  context.after(async () => {
    await accountApp?.close();
    await ipApp?.close();
    await database?.destroy();
    removePostgresContainer(container.name);
  });

  const { databaseUrl } = await startPostgresContainer(container);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 4 });
  accountApp = await buildApp({
    database,
    rateLimits: {
      ipMax: 100,
      accountMax: 2,
      agentMax: 2,
      sensitiveMax: 2,
      timeWindowMs: 60_000,
    },
  });
  const registration = await accountApp.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: 'rate-limit@example.com',
      password: 'Correct horse battery staple 2026!',
    },
  });
  assert.equal(registration.statusCode, 201);
  const session = cookie(registration);

  for (let request = 0; request < 2; request += 1) {
    const response = await accountApp.inject({
      method: 'GET',
      url: '/v1/merchants',
      headers: { cookie: session },
    });
    assert.equal(response.statusCode, 200);
  }
  assertRateLimited(
    await accountApp.inject({
      method: 'GET',
      url: '/v1/merchants',
      headers: { cookie: session },
    }),
  );

  const agentHeaders = {
    'x-aipay-agent-id': 'agt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3dd0',
    'content-type': 'application/json',
  };
  for (let request = 0; request < 2; request += 1) {
    const response = await accountApp.inject({
      method: 'POST',
      url: '/v1/agent/verify',
      headers: agentHeaders,
      payload: { action: 'verify' },
    });
    assert.equal(response.statusCode, 401);
  }
  assertRateLimited(
    await accountApp.inject({
      method: 'POST',
      url: '/v1/agent/verify',
      headers: agentHeaders,
      payload: { action: 'verify' },
    }),
  );

  for (let request = 0; request < 2; request += 1) {
    const response = await accountApp.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '198.51.100.2',
      payload: { email: 'missing@example.com', password: 'Wrong password value' },
    });
    assert.equal(response.statusCode, 401);
  }
  assertRateLimited(
    await accountApp.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress: '198.51.100.2',
      payload: { email: 'missing@example.com', password: 'Wrong password value' },
    }),
  );

  ipApp = await buildApp({
    database,
    rateLimits: {
      ipMax: 2,
      accountMax: 100,
      agentMax: 100,
      sensitiveMax: 100,
      timeWindowMs: 60_000,
    },
  });
  for (let request = 0; request < 2; request += 1) {
    const response = await ipApp.inject({ method: 'GET', url: '/v1/auth/session' });
    assert.equal(response.statusCode, 401);
  }
  assertRateLimited(await ipApp.inject({ method: 'GET', url: '/v1/auth/session' }));
});
