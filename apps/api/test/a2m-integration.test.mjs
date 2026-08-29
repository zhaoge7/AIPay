import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import process from 'node:process';
import test from 'node:test';
import { join } from 'node:path';

import { createDatabase } from '@aipay/database';

import { loadA2MRuntimeConfig } from '../dist/a2m/config.js';
import { A2MService } from '../dist/a2m/service.js';
import { buildApp } from '../dist/app.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

function rsaConfiguration() {
  const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platformKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    appKeys,
    sandbox: {
      appIds: [
        {
          appId: '2024001234567890',
          appPrivatePkcsKey: appKeys.privateKey
            .export({ format: 'der', type: 'pkcs1' })
            .toString('base64'),
          alipayPublicKey: platformKeys.publicKey
            .export({ format: 'der', type: 'spki' })
            .toString('base64'),
          pid: '2088123456789012',
        },
      ],
    },
  };
}

test('loads only protected PKCS1 A2M sandbox configuration', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'aipay-a2m-config-'));
  const path = join(directory, '.alipay-sandbox.json');
  context.after(() => rm(directory, { recursive: true, force: true }));
  const generated = rsaConfiguration();
  await writeFile(path, JSON.stringify(generated.sandbox), { mode: 0o600 });
  const config = await loadA2MRuntimeConfig({ AIPAY_A2M_MODE: 'sandbox' }, path);

  assert.equal(config.sandbox, true);
  assert.equal(config.serviceId, 'api_mock_service_id');
  assert.equal(config.gatewayUrl, 'https://openapi-sandbox.dl.alipaydev.com/gateway.do');
  assert.equal(config.privateKeyPkcs1Base64, generated.sandbox.appIds[0].appPrivatePkcsKey);
  assert.equal(config.merchantId, null);

  await writeFile(
    path,
    JSON.stringify({
      ...generated.sandbox,
      appIds: [
        {
          ...generated.sandbox.appIds[0],
          appPrivatePkcsKey: `${generated.sandbox.appIds[0].appPrivatePkcsKey}\n`,
        },
      ],
    }),
  );
  await assert.rejects(loadA2MRuntimeConfig({ AIPAY_A2M_MODE: 'sandbox' }, path), /RSA key/u);
  await writeFile(path, JSON.stringify(generated.sandbox));
  await chmod(path, 0o644);
  await assert.rejects(loadA2MRuntimeConfig({ AIPAY_A2M_MODE: 'sandbox' }, path), /not protected/u);
  await assert.rejects(loadA2MRuntimeConfig({ AIPAY_A2M_MODE: 'staging' }, path), /mode/u);
  await assert.rejects(loadA2MRuntimeConfig({ NODE_ENV: 'production' }, path), /explicit/u);
});

class FakeA2MClient {
  constructor(privateKey) {
    this.appId = '2024001234567890';
    this.sellerId = '2088123456789012';
    this.sellerName = 'AIPay';
    this.serviceId = 'api_mock_service_id';
    this.sandbox = true;
    this.privateKey = privateKey;
    this.verification = null;
    this.confirmResults = [];
    this.verifyCalls = 0;
    this.confirmCalls = 0;
  }

  signBill(input) {
    const content = Object.entries(input)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    return sign('RSA-SHA256', Buffer.from(content), this.privateKey).toString('base64');
  }

  async verifyPaymentProof() {
    this.verifyCalls += 1;
    return this.verification;
  }

  async confirmFulfillment() {
    this.confirmCalls += 1;
    return this.confirmResults.shift() ?? true;
  }
}

function decodeHeader(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function paymentProofHeader(paymentProof, tradeNo, clientSession = 'session') {
  return Buffer.from(
    JSON.stringify({
      protocol: { payment_proof: paymentProof, trade_no: tradeNo },
      method: { client_session: clientSession },
    }),
  ).toString('base64');
}

test('runs persistent A2M 402, strict verification and retryable fulfillment', async (context) => {
  const container = {
    name: `aipay-a2m-integration-${process.pid}`,
    database: 'aipay_a2m_integration_test',
    user: 'aipay',
    password: 'a2m-integration-only',
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
  database = createDatabase(databaseUrl, { maxConnections: 8 });
  const developer = await database
    .insertInto('developers')
    .values({
      email: 'a2m-integration@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'A2M Merchant',
      callbackUrl: 'https://a2m.example.com/webhook',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const catalogService = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'A2M Weather API',
      category: 'data.a2m',
      unit: 'request',
      unitPriceAmountMinor: '1',
      refundPolicy: 'full_on_delivery_failure',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const client = new FakeA2MClient(keys.privateKey);
  let now = new Date(Date.now() + 10_000);
  const config = {
    appId: client.appId,
    privateKeyPkcs1Base64: keys.privateKey
      .export({ format: 'der', type: 'pkcs1' })
      .toString('base64'),
    alipayPublicKeySpkiBase64: keys.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
    gatewayUrl: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
    sellerId: client.sellerId,
    sellerName: client.sellerName,
    serviceId: client.serviceId,
    sandbox: true,
    merchantId: null,
  };
  app = await buildApp({
    database,
    a2mService: new A2MService(database, client, config, () => now),
  });
  const path = `/v1/a2m/resources/svc_${catalogService.id}`;
  const paymentRequired = await app.inject({ method: 'GET', url: path });
  assert.equal(paymentRequired.statusCode, 402);
  const paymentNeeded = decodeHeader(paymentRequired.headers['payment-needed']);
  assert.deepEqual(Object.keys(paymentNeeded.protocol).sort(), [
    'amount',
    'currency',
    'out_trade_no',
    'pay_before',
    'resource_id',
    'seller_sign_type',
    'seller_signature',
    'seller_unique_id',
  ]);
  assert.equal(paymentNeeded.method.service_id, 'api_mock_service_id');
  assert.equal(paymentNeeded.protocol.amount, '0.01');
  const bill = {
    amount: paymentNeeded.protocol.amount,
    currency: paymentNeeded.protocol.currency,
    goods_name: paymentNeeded.method.goods_name,
    out_trade_no: paymentNeeded.protocol.out_trade_no,
    pay_before: paymentNeeded.protocol.pay_before,
    resource_id: paymentNeeded.protocol.resource_id,
    seller_id: paymentNeeded.method.seller_id,
    service_id: paymentNeeded.method.service_id,
  };
  const signContent = Object.entries(bill)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(signContent),
      keys.publicKey,
      Buffer.from(paymentNeeded.protocol.seller_signature, 'base64'),
    ),
    true,
  );

  const proofValue = 'opaque.+/_-proof=value';
  const tradeNo = '2026082922001234567890123456';
  const encodedProof = paymentProofHeader(proofValue, tradeNo);
  client.verification = {
    accepted: true,
    active: true,
    tradeNo,
    outTradeNo: paymentNeeded.protocol.out_trade_no,
    amount: '0.01',
    resourceId: paymentNeeded.protocol.resource_id,
  };
  client.confirmResults.push(false, true);
  const firstFulfillment = await app.inject({
    method: 'GET',
    url: path,
    headers: { 'payment-proof': encodedProof },
  });
  assert.equal(firstFulfillment.statusCode, 503);
  const pending = await database
    .selectFrom('a2mOrders')
    .select(['fulfillmentStatus', 'paymentProofHash', 'serviceResult'])
    .where('outTradeNo', '=', paymentNeeded.protocol.out_trade_no)
    .executeTakeFirstOrThrow();
  assert.equal(pending.fulfillmentStatus, 'pending_confirm');
  assert.equal(pending.paymentProofHash?.byteLength, 32);
  assert.equal(typeof pending.serviceResult, 'object');

  const retried = await app.inject({
    method: 'GET',
    url: path,
    headers: { 'payment-proof': encodedProof },
  });
  assert.equal(retried.statusCode, 200);
  assert.equal(JSON.parse(retried.body).already_fulfilled, false);
  const repeated = await app.inject({
    method: 'GET',
    url: path,
    headers: { 'payment-proof': encodedProof },
  });
  assert.equal(repeated.statusCode, 200);
  assert.equal(JSON.parse(repeated.body).already_fulfilled, true);
  assert.equal(client.confirmCalls, 2);
  assert.deepEqual(JSON.parse(repeated.body).content, JSON.parse(retried.body).content);
  const validation = decodeHeader(repeated.headers['payment-validation']);
  assert.equal(validation.validated, true);
  assert.equal(validation.trade_no, tradeNo);

  const stored = await database
    .selectFrom('a2mOrders')
    .selectAll()
    .where('outTradeNo', '=', paymentNeeded.protocol.out_trade_no)
    .executeTakeFirstOrThrow();
  assert.equal(stored.fulfillmentStatus, 'fulfilled');
  assert.equal(stored.providerTradeNo, tradeNo);
  assert.equal(JSON.stringify(stored).includes(proofValue), false);

  const mismatchedOrderResponse = await app.inject({ method: 'GET', url: path });
  const mismatchedBill = decodeHeader(mismatchedOrderResponse.headers['payment-needed']);
  client.verification = {
    accepted: true,
    active: true,
    tradeNo: '2026082922001234567890123457',
    outTradeNo: mismatchedBill.protocol.out_trade_no,
    amount: '0.02',
    resourceId: mismatchedBill.protocol.resource_id,
  };
  const mismatch = await app.inject({
    method: 'GET',
    url: path,
    headers: {
      'payment-proof': paymentProofHeader('q'.repeat(64), client.verification.tradeNo),
    },
  });
  assert.equal(mismatch.statusCode, 402);

  const expiringResponse = await app.inject({ method: 'GET', url: path });
  const expiringBill = decodeHeader(expiringResponse.headers['payment-needed']);
  now = new Date(now.getTime() + 31 * 60 * 1_000);
  client.verification = {
    accepted: true,
    active: true,
    tradeNo: '2026082922001234567890123458',
    outTradeNo: expiringBill.protocol.out_trade_no,
    amount: expiringBill.protocol.amount,
    resourceId: expiringBill.protocol.resource_id,
  };
  const expired = await app.inject({
    method: 'GET',
    url: path,
    headers: {
      'payment-proof': paymentProofHeader('r'.repeat(64), client.verification.tradeNo),
    },
  });
  assert.equal(expired.statusCode, 402);
});
