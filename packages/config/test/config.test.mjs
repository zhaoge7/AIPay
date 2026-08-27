import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  ConfigurationError,
  loadApiConfig,
  loadDatabaseConfig,
  loadMandateIssuerConfig,
  loadWorkerConfig,
} from '../dist/index.js';

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

test('loads a PostgreSQL URL without copying unrelated secrets', () => {
  const databaseUrl = 'postgresql://aipay:local-password@127.0.0.1:54329/aipay_test';
  const config = loadDatabaseConfig({
    AIPAY_DATABASE_URL: databaseUrl,
    UNUSED_SECRET: 'must-not-be-copied',
  });

  assert.deepEqual(config, { url: databaseUrl });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(JSON.stringify(config).includes('must-not-be-copied'), false);
});

test('rejects incomplete or non-PostgreSQL database URLs without exposing them', () => {
  for (const invalidUrl of [
    'mysql://aipay:secret@127.0.0.1/aipay_test',
    'postgresql://127.0.0.1/aipay_test',
    'postgresql://aipay@127.0.0.1',
    'not-a-url',
  ]) {
    assert.throws(
      () => loadDatabaseConfig({ AIPAY_DATABASE_URL: invalidUrl }),
      (error) => {
        assert.equal(error instanceof ConfigurationError, true);
        assert.deepEqual(error.variables, ['AIPAY_DATABASE_URL']);
        assert.equal(error.message.includes(invalidUrl), false);
        return true;
      },
    );
  }
});

test('loads and redacts Mandate issuer configuration', () => {
  const privateKey = Buffer.alloc(48, 7).toString('base64');
  const config = loadMandateIssuerConfig({
    AIPAY_MANDATE_SIGNING_KEY_ID: 'key_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4e',
    AIPAY_MANDATE_SIGNING_PRIVATE_KEY: privateKey,
  });
  assert.deepEqual(config, {
    keyId: 'key_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4e',
    privateKeyPkcs8Base64: privateKey,
  });

  for (const [name, value] of [
    ['AIPAY_MANDATE_SIGNING_KEY_ID', 'key_not-valid'],
    ['AIPAY_MANDATE_SIGNING_PRIVATE_KEY', 'PRIVATE_SECRET_NOT_BASE64'],
  ]) {
    const environment = {
      AIPAY_MANDATE_SIGNING_KEY_ID: 'key_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4e',
      AIPAY_MANDATE_SIGNING_PRIVATE_KEY: privateKey,
      [name]: value,
    };
    assert.throws(
      () => loadMandateIssuerConfig(environment),
      (error) => {
        assert.equal(error instanceof ConfigurationError, true);
        assert.equal(error.message.includes(value), false);
        return true;
      },
    );
  }
});
