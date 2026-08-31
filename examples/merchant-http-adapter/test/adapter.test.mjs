/* global Headers, Response */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import test from 'node:test';
import { URL } from 'node:url';

import { parsePaymentProof, toPaymentProofWire } from '@aipay/contracts';
import {
  AIPayApiError,
  PAYMENT_NEEDED_HEADER,
  createPaymentRequirement,
  decodePaymentRequirement,
  encodePaymentProof,
} from '@aipay/sdk-ts';

import { MerchantAdapterConfigurationError, loadMerchantAdapterConfig } from '../dist/config.js';
import { createMerchantAdapterApp } from '../dist/server.js';
import { MerchantAdapterError, MerchantAdapterService } from '../dist/service.js';
import { PostgresAdapterDeliveryStore } from '../dist/store.js';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const quoteFixture = JSON.parse(
  await readFile(
    new URL('../../../packages/contracts/test/fixtures/v1/quote.json', import.meta.url),
  ),
);
const paymentProof = toPaymentProofWire(
  parsePaymentProof(
    JSON.parse(
      await readFile(
        new URL('../../../packages/contracts/test/fixtures/v1/payment-proof.json', import.meta.url),
      ),
    ),
  ),
);
const privateKey = generateKeyPairSync('ed25519')
  .privateKey.export({
    format: 'der',
    type: 'pkcs8',
  })
  .toString('base64');
const deliveryId = 'dlv_01890f3e-9b90-7cc2-b8c5-7f6a1b2c3d4e';
const environment = {
  AIPAY_BASE_URL: 'http://127.0.0.1:3101',
  AIPAY_MERCHANT_API_KEY: 'apk_test.secret',
  AIPAY_MERCHANT_ID: paymentProof.merchantId,
  AIPAY_MERCHANT_KEY_ID: quoteFixture.proof.keyId,
  AIPAY_MERCHANT_PRIVATE_KEY: privateKey,
  AIPAY_SERVICE_ID: paymentProof.serviceId,
  AIPAY_ADAPTER_DATABASE_URL: 'postgresql://adapter:adapter-test@127.0.0.1:54329/adapter_test',
  AIPAY_ADAPTER_PUBLIC_ORIGIN: 'https://merchant.example.cn',
  AIPAY_ADAPTER_RESOURCE_PATH: '/v1/paid/weather',
  AIPAY_ADAPTER_QUERY_KEYS: 'city,date',
  AIPAY_UPSTREAM_ORIGIN: 'https://upstream.example.cn',
  AIPAY_UPSTREAM_PATH: '/api/weather',
  AIPAY_UPSTREAM_API_KEY_LOCATION: 'query',
  AIPAY_UPSTREAM_API_KEY_NAME: 'key',
  AIPAY_UPSTREAM_API_KEY_VALUE: 'upstream-test-secret',
};

function config(overrides = {}) {
  return loadMerchantAdapterConfig({ ...environment, ...overrides });
}

class MemoryStore {
  records = new Map();

  initialize() {
    return Promise.resolve();
  }

  async withProofLock(_paymentProofId, operation) {
    return operation();
  }

  async claim(paymentProofId, resourceUrl, proofDigest) {
    if (!this.records.has(paymentProofId)) {
      this.records.set(paymentProofId, {
        paymentProofId,
        resourceUrl,
        proofDigest,
        state: 'claimed',
        deliveryId: null,
        consumedAt: null,
        outcome: null,
        resultText: null,
        completedAt: null,
      });
    }
  }

  async get(paymentProofId) {
    const value = this.records.get(paymentProofId);
    assert.ok(value);
    return { ...value, proofDigest: Buffer.from(value.proofDigest) };
  }

  async markConsumed(paymentProofId, id, consumedAt) {
    Object.assign(this.records.get(paymentProofId), {
      state: 'consumed',
      deliveryId: id,
      consumedAt,
    });
  }

  async markResult(paymentProofId, outcome, resultText) {
    Object.assign(this.records.get(paymentProofId), {
      state: 'result_ready',
      outcome,
      resultText,
    });
  }

  async markCompleted(paymentProofId) {
    Object.assign(this.records.get(paymentProofId), {
      state: 'completed',
      completedAt: '2026-08-31T00:00:00.000Z',
    });
  }
}

class FakeMerchant {
  consumeCalls = 0;
  recoverCalls = 0;
  receiptCalls = [];
  recoverMode = false;

  async createPaymentRequirement({ resourceUrl }) {
    const quote = {
      ...quoteFixture,
      merchantId: paymentProof.merchantId,
      serviceId: paymentProof.serviceId,
    };
    const requirement = createPaymentRequirement({ quote, resourceUrl });
    return {
      requirement,
      headerValue: Buffer.from(JSON.stringify(requirement)).toString('base64url'),
    };
  }

  async consumePaymentProof() {
    this.consumeCalls += 1;

    if (this.recoverMode) {
      throw new AIPayApiError({
        status: 409,
        code: 'TRANSACTION_STATE_CONFLICT',
        kind: 'rejected',
      });
    }

    return {
      paymentProofId: paymentProof.paymentProofId,
      deliveryId,
      consumedAt: '2026-08-28T09:01:00.000Z',
    };
  }

  async recoverPaymentProofConsumption() {
    this.recoverCalls += 1;
    return {
      paymentProofId: paymentProof.paymentProofId,
      deliveryId,
      consumedAt: '2026-08-28T09:01:00.000Z',
    };
  }

  async submitDeliveryReceipt(input) {
    this.receiptCalls.push(input);
    return {};
  }
}

function harness(options = {}) {
  const merchant = new FakeMerchant();
  merchant.recoverMode = options.recoverMode ?? false;
  const store = new MemoryStore();
  const upstreamCalls = [];
  const upstreamFetch = async (input, init) => {
    upstreamCalls.push({ url: String(input), init });

    if (options.upstreamFailure) {
      return new Response('unavailable', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      });
    }

    return Response.json({ city: 'Hangzhou', condition: 'clear' });
  };
  return {
    merchant,
    store,
    upstreamCalls,
    service: new MerchantAdapterService(config(), merchant, store, upstreamFetch),
  };
}

test('validates adapter configuration without exposing credentials', () => {
  assert.equal(config().resourcePath, '/v1/paid/weather');
  assert.throws(
    () =>
      config({
        AIPAY_UPSTREAM_ORIGIN: 'http://127.0.0.1:8080',
        AIPAY_UPSTREAM_API_KEY_NAME: 'host',
        AIPAY_UPSTREAM_API_KEY_LOCATION: 'header',
        AIPAY_UPSTREAM_API_KEY_VALUE: 'must-not-be-echoed',
        AIPAY_MERCHANT_PRIVATE_KEY: 'invalid',
      }),
    (error) => {
      assert.ok(error instanceof MerchantAdapterConfigurationError);
      assert.ok(error.variables.includes('AIPAY_UPSTREAM_ORIGIN'));
      assert.ok(error.variables.includes('AIPAY_UPSTREAM_API_KEY_NAME'));
      assert.ok(error.variables.includes('AIPAY_MERCHANT_PRIVATE_KEY'));
      assert.equal(error.message.includes('must-not-be-echoed'), false);
      return true;
    },
  );
});

test('runs 402, consume, real upstream, signed receipt and durable replay', async () => {
  const { merchant, service, upstreamCalls } = harness();
  const resourceUrl = 'https://merchant.example.cn/v1/paid/weather?city=Hangzhou';
  const paymentNeeded = await service.handle(resourceUrl);
  assert.equal(paymentNeeded.statusCode, 402);
  assert.equal(
    decodePaymentRequirement(paymentNeeded.headers[PAYMENT_NEEDED_HEADER]).resource.url,
    resourceUrl,
  );

  const delivered = await service.handle(resourceUrl, encodePaymentProof(paymentProof));
  assert.equal(delivered.statusCode, 200);
  assert.deepEqual(delivered.body, { city: 'Hangzhou', condition: 'clear' });
  assert.equal(merchant.consumeCalls, 1);
  assert.equal(merchant.receiptCalls.length, 1);
  assert.equal(upstreamCalls.length, 1);
  const upstreamUrl = new URL(upstreamCalls[0].url);
  assert.equal(upstreamUrl.searchParams.get('city'), 'Hangzhou');
  assert.equal(upstreamUrl.searchParams.get('key'), 'upstream-test-secret');
  assert.equal(
    new Headers(upstreamCalls[0].init.headers).get('idempotency-key'),
    paymentProof.paymentProofId,
  );

  assert.deepEqual(await service.handle(resourceUrl, encodePaymentProof(paymentProof)), delivered);
  assert.equal(merchant.consumeCalls, 1);
  assert.equal(merchant.receiptCalls.length, 1);
  assert.equal(upstreamCalls.length, 1);
  await assert.rejects(
    service.handle(
      'https://merchant.example.cn/v1/paid/weather?city=Suzhou',
      encodePaymentProof(paymentProof),
    ),
    (error) => error instanceof MerchantAdapterError && error.code === 'invalid_payment_proof',
  );
});

test('recovers a lost consume response and signs a failed receipt for upstream failure', async () => {
  const { merchant, service, upstreamCalls } = harness({
    recoverMode: true,
    upstreamFailure: true,
  });
  const response = await service.handle(
    'https://merchant.example.cn/v1/paid/weather?city=Hangzhou',
    encodePaymentProof(paymentProof),
  );
  assert.equal(response.statusCode, 502);
  assert.deepEqual(response.body, { code: 'UPSTREAM_DELIVERY_FAILED' });
  assert.equal(merchant.consumeCalls, 1);
  assert.equal(merchant.recoverCalls, 1);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(merchant.receiptCalls[0].status, 'failed');
  assert.equal(merchant.receiptCalls[0].errorCode, 'UPSTREAM_DELIVERY_FAILED');
});

test('serves the exact public resource through Fastify', async (context) => {
  const { service } = harness();
  const app = createMerchantAdapterApp(config(), service);
  context.after(async () => app.close());
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  const paymentNeeded = await app.inject({
    method: 'GET',
    url: '/v1/paid/weather?city=Hangzhou',
  });
  assert.equal(paymentNeeded.statusCode, 402);
  assert.notEqual(paymentNeeded.headers[PAYMENT_NEEDED_HEADER], undefined);
  const delivered = await app.inject({
    method: 'GET',
    url: '/v1/paid/weather?city=Hangzhou',
    headers: { 'payment-proof': encodePaymentProof(paymentProof) },
  });
  assert.equal(delivered.statusCode, 200);
  assert.deepEqual(delivered.json(), { city: 'Hangzhou', condition: 'clear' });
  assert.equal(
    (await app.inject({ method: 'GET', url: '/v1/paid/weather?secret=value' })).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/v1/paid/weather?city=Hangzhou',
        headers: { host: 'attacker.example' },
      })
    ).statusCode,
    403,
  );
});

test('persists strict delivery state in an isolated PostgreSQL database', async (context) => {
  const container = {
    name: `aipay-merchant-adapter-${process.pid}`,
    database: 'aipay_merchant_adapter_test',
    user: 'adapter',
    password: 'adapter-test-only',
  };
  const { databaseUrl } = await startPostgresContainer(container);
  const store = new PostgresAdapterDeliveryStore(databaseUrl);
  context.after(async () => {
    await store.close();
    removePostgresContainer(container.name);
  });
  await store.initialize();
  const digest = Buffer.alloc(32, 7);
  const resourceUrl = 'https://merchant.example.cn/v1/paid/weather?city=Hangzhou';
  await store.withProofLock(paymentProof.paymentProofId, async () => {
    await store.claim(paymentProof.paymentProofId, resourceUrl, digest);
    assert.equal((await store.get(paymentProof.paymentProofId)).state, 'claimed');
    await store.markConsumed(paymentProof.paymentProofId, deliveryId, '2026-08-28T09:01:00.000Z');
    await store.markResult(
      paymentProof.paymentProofId,
      'succeeded',
      JSON.stringify({ city: 'Hangzhou' }),
    );
    await store.markCompleted(paymentProof.paymentProofId);
  });
  const completed = await store.get(paymentProof.paymentProofId);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.deliveryId, deliveryId);
  assert.deepEqual(JSON.parse(completed.resultText), { city: 'Hangzhou' });
});
