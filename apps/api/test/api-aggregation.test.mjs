import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';

import { createDatabase } from '@aipay/database';

import { ApiInvocationError, ApiInvocationService } from '../dist/a2m/invocation-service.js';
import { ApiRegistrationService } from '../dist/services/api-registration.js';
import { PlatformTreasuryService } from '../dist/a2m/treasury.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

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
    return this.verification;
  }

  async confirmFulfillment() {
    this.confirmCalls += 1;
    return this.confirmResults.shift() ?? true;
  }
}

function paymentProofHeader(paymentProof, tradeNo) {
  return Buffer.from(
    JSON.stringify({
      protocol: { payment_proof: paymentProof, trade_no: tradeNo },
      method: { client_session: 'aggregation-test' },
    }),
  ).toString('base64url');
}

test('selects a registered API, reserves platform float and settles only real delivery', async (context) => {
  const container = {
    name: `aipay-api-aggregation-${process.pid}`,
    database: 'aipay_api_aggregation_test',
    user: 'aipay',
    password: 'api-aggregation-only',
  };
  let database;
  context.after(async () => {
    await database?.destroy();
    removePostgresContainer(container.name);
  });

  const { databaseUrl } = await startPostgresContainer(container);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 8 });
  const developer = await database
    .insertInto('developers')
    .values({
      email: 'aggregation@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Aggregation Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'Weather Merchant',
      callbackUrl: 'https://weather.example.com/aipay/events',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const expensive = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Weather Premium',
      category: 'data.weather',
      unit: 'request',
      unitPriceAmountMinor: '5',
      refundPolicy: 'full_on_delivery_failure',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const selected = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Weather Standard',
      category: 'data.weather',
      unit: 'request',
      unitPriceAmountMinor: '3',
      refundPolicy: 'full_on_delivery_failure',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const registrationService = new ApiRegistrationService(database);
  const inputSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['city'],
    properties: { city: { type: 'string', description: '城市名称' } },
  };

  for (const serviceId of [expensive.id, selected.id]) {
    await registrationService.put(`dev_${developer.id}`, `mch_${merchant.id}`, `svc_${serviceId}`, {
      endpointUrl: `http://127.0.0.1:39001/${serviceId}`,
      httpMethod: 'POST',
      description: '按城市查询实时天气',
      capabilities: ['天气查询', 'weather'],
      inputSchema,
      timeoutMs: 5_000,
    });
  }

  await database
    .updateTable('platformFundingAccounts')
    .set({ availableAmountMinor: '1000' })
    .where('currency', '=', 'CNY')
    .executeTakeFirstOrThrow();

  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const client = new FakeA2MClient(keys.privateKey);
  const invocations = [];
  const invoker = {
    async invoke(input) {
      const advance = await database
        .selectFrom('merchantAdvances')
        .innerJoin('a2mOrders', 'a2mOrders.id', 'merchantAdvances.a2mOrderId')
        .select(['merchantAdvances.status', 'a2mOrders.fulfillmentStatus'])
        .where('a2mOrders.outTradeNo', '=', input.outTradeNo)
        .executeTakeFirstOrThrow();
      assert.equal(advance.status, 'advanced');
      assert.equal(advance.fulfillmentStatus, 'invoking');
      invocations.push(input);
      return {
        result: { city: input.parameters.city, temperatureCelsius: 26, source: 'merchant' },
        latencyMs: 18,
      };
    },
  };
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
  const service = new ApiInvocationService(database, client, config, invoker);
  const request = {
    intent: '查询杭州天气',
    category: 'data.weather',
    parameters: { city: '杭州' },
    idempotencyKey: 'aggregation-request-0001',
  };
  const bill = await service.createPaymentRequired(`agt_${agent.id}`, request);
  const repeatedBill = await service.createPaymentRequired(`agt_${agent.id}`, request);
  assert.equal(repeatedBill.outTradeNo, bill.outTradeNo);
  assert.equal(bill.selectedServiceId, `svc_${selected.id}`);
  assert.equal(bill.amount, '0.03');
  assert.equal(bill.resourceId, `/v1/a2m/invocations/${bill.outTradeNo}`);

  const reserved = await database
    .selectFrom('platformFundingAccounts')
    .selectAll()
    .where('currency', '=', 'CNY')
    .executeTakeFirstOrThrow();
  assert.equal(reserved.availableAmountMinor, '997');
  assert.equal(reserved.reservedAmountMinor, '3');

  await assert.rejects(
    service.createPaymentRequired(`agt_${agent.id}`, {
      ...request,
      parameters: { city: '上海' },
    }),
    (error) => error instanceof ApiInvocationError && error.code === 'idempotency_conflict',
  );

  const tradeNo = '2026091522001234567890123456';
  client.verification = {
    accepted: true,
    active: true,
    tradeNo,
    outTradeNo: bill.outTradeNo,
    amount: bill.amount,
    resourceId: bill.resourceId,
  };
  client.confirmResults.push(false, true);
  const proof = paymentProofHeader('opaque-aggregation-proof-value', tradeNo);
  await assert.rejects(
    service.verifyAndFulfill(`agt_${agent.id}`, bill.outTradeNo, proof),
    (error) =>
      error instanceof ApiInvocationError && error.code === 'fulfillment_confirmation_failed',
  );
  assert.equal(invocations.length, 1);

  const settlement = await database
    .selectFrom('merchantSettlementAccounts')
    .selectAll()
    .where('merchantId', '=', merchant.id)
    .executeTakeFirstOrThrow();
  assert.equal(settlement.pendingAmountMinor, '0');
  assert.equal(settlement.availableAmountMinor, '3');

  const fulfilled = await service.verifyAndFulfill(`agt_${agent.id}`, bill.outTradeNo, proof);
  assert.equal(fulfilled.serviceResult.source, 'merchant');
  assert.equal(fulfilled.alreadyFulfilled, false);
  assert.equal(invocations.length, 1);
  const replay = await service.verifyAndFulfill(`agt_${agent.id}`, bill.outTradeNo, proof);
  assert.equal(replay.alreadyFulfilled, true);
  assert.equal(invocations.length, 1);
  assert.equal(client.confirmCalls, 2);

  const receivable = await database
    .selectFrom('platformReceivables')
    .selectAll()
    .where(
      'a2mOrderId',
      '=',
      (
        await database
          .selectFrom('a2mOrders')
          .select('id')
          .where('outTradeNo', '=', bill.outTradeNo)
          .executeTakeFirstOrThrow()
      ).id,
    )
    .executeTakeFirstOrThrow();
  assert.equal(receivable.status, 'pending');
  assert.equal(receivable.amountMinor, '3');

  const treasury = new PlatformTreasuryService(database);
  const providerSettlement = await treasury.confirmProviderSettlement(tradeNo);
  const settlementReplay = await treasury.confirmProviderSettlement(tradeNo);
  assert.deepEqual(settlementReplay, providerSettlement);
  const replenished = await database
    .selectFrom('platformFundingAccounts')
    .selectAll()
    .where('currency', '=', 'CNY')
    .executeTakeFirstOrThrow();
  assert.equal(replenished.availableAmountMinor, '1000');
  assert.equal(replenished.reservedAmountMinor, '0');
});
