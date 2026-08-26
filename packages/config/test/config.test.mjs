import assert from 'node:assert/strict';
import test from 'node:test';

import { ConfigurationError, loadApiConfig, loadWorkerConfig } from '../dist/index.js';

test('loads and freezes valid API configuration', () => {
  const config = loadApiConfig({
    NODE_ENV: 'test',
    AIPAY_API_HOST: '127.0.0.1',
    AIPAY_API_PORT: '3000',
    UNUSED_SECRET: 'must-not-be-copied',
  });

  assert.deepEqual(config, {
    environment: 'test',
    host: '127.0.0.1',
    port: 3000,
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(JSON.stringify(config).includes('must-not-be-copied'), false);
});

test('reports invalid variables without exposing environment values', () => {
  const secret = 'private-value-that-must-not-appear';

  assert.throws(
    () =>
      loadApiConfig({
        NODE_ENV: 'test',
        AIPAY_API_HOST: '127.0.0.1',
        AIPAY_API_PORT: secret,
      }),
    (error) => {
      assert.equal(error instanceof ConfigurationError, true);
      assert.deepEqual(error.variables, ['AIPAY_API_PORT']);
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});

test('rejects missing required API configuration', () => {
  assert.throws(
    () => loadApiConfig({ NODE_ENV: 'development' }),
    (error) => {
      assert.equal(error instanceof ConfigurationError, true);
      assert.deepEqual(error.variables, ['AIPAY_API_HOST', 'AIPAY_API_PORT']);
      return true;
    },
  );
});

test('requires positive integer worker concurrency', () => {
  assert.deepEqual(loadWorkerConfig({ NODE_ENV: 'production', AIPAY_WORKER_CONCURRENCY: '2' }), {
    environment: 'production',
    concurrency: 2,
  });

  for (const invalidValue of ['0', '-1', '1.5', 'not-a-number']) {
    assert.throws(
      () =>
        loadWorkerConfig({
          NODE_ENV: 'production',
          AIPAY_WORKER_CONCURRENCY: invalidValue,
        }),
      ConfigurationError,
    );
  }
});

test('rejects unsupported runtime environments', () => {
  assert.throws(
    () => loadWorkerConfig({ NODE_ENV: 'staging', AIPAY_WORKER_CONCURRENCY: '1' }),
    (error) => {
      assert.equal(error instanceof ConfigurationError, true);
      assert.deepEqual(error.variables, ['NODE_ENV']);
      assert.equal(error.message.includes('staging'), false);
      return true;
    },
  );
});
