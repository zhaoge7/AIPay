import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createSign, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { URL, URLSearchParams } from 'node:url';

import { AlipayWebPaymentProvider, PaymentProviderError } from '../dist/index.js';

function fixture(client) {
  const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platformKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

  const alipay = new AlipayWebPaymentProvider(
    {
      appId: '2024001234567890',
      sellerId: '2088123456789012',
      privateKeyPkcs8Base64: appKeys.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      alipayPublicKeySpkiBase64: platformKeys.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64'),
      gatewayUrl: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
      returnUrl: 'https://aipay.example.com/payments/return',
      now: () => new Date('2026-08-28T08:00:00.000Z'),
    },
    client,
  );

  return { alipay, platformPrivateKey: platformKeys.privateKey };
}

function provider() {
  return fixture().alipay;
}

function notification(privateKey, overrides = {}) {
  const parameters = {
    notify_time: '2026-08-28 16:00:00',
    notify_type: 'trade_status_sync',
    notify_id: 'notify_gate_001',
    app_id: '2024001234567890',
    auth_app_id: '2024001234567890',
    trade_no: '2026082822001234567890123456',
    out_trade_no: 'AIPAY01890F3EB1017CC2A8C57F6A1B2C3D4E',
    seller_id: '2088123456789012',
    total_amount: '12.34',
    trade_status: 'TRADE_SUCCESS',
    gmt_payment: '2026-08-28 15:59:58',
    sign_type: 'RSA2',
    ...overrides,
  };
  const content = Object.entries(parameters)
    .filter(([name]) => name !== 'sign_type')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const signature = createSign('RSA-SHA256').update(content, 'utf8').sign(privateKey, 'base64');
  return {
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    rawBody: Buffer.from(new URLSearchParams({ ...parameters, sign: signature }).toString()),
    receivedAt: '2026-08-28T08:00:01.000Z',
  };
}

const request = {
  transactionId: 'txn_01890f3e-b100-7cc2-98c5-7f6a1b2c3d4e',
  paymentAttemptId: 'pat_01890f3e-b101-7cc2-a8c5-7f6a1b2c3d4e',
  amount: { currency: 'CNY', amountMinor: '1234' },
  idempotencyKey: 'alipay-payment-key',
  description: 'AIPay / weather & data = two calls',
  callbackUrl: 'https://aipay.example.com/provider-webhooks/alipay',
};

test('generates an RSA2-signed Alipay page payment action idempotently', async () => {
  const alipay = provider();
  const first = await alipay.createPayment(request);
  const repeated = await alipay.createPayment(request);

  assert.equal(first.providerPaymentId, 'alipay_out_AIPAY01890F3EB1017CC2A8C57F6A1B2C3D4E');
  assert.equal(first.status, 'pending');
  assert.equal(first.occurredAt, '2026-08-28T08:00:00.000Z');
  assert.equal(first.action.type, 'redirect');
  assert.equal(first.action.method, 'GET');
  assert.equal(repeated.providerPaymentId, first.providerPaymentId);

  const action = new URL(first.action.url);
  assert.equal(action.origin, 'https://openapi-sandbox.dl.alipaydev.com');
  assert.equal(action.pathname, '/gateway.do');
  assert.equal(action.searchParams.get('method'), 'alipay.trade.page.pay');
  assert.equal(action.searchParams.get('app_id'), '2024001234567890');
  assert.equal(action.searchParams.get('sign_type'), 'RSA2');
  assert.match(action.searchParams.get('sign'), /\S/u);
  const content = JSON.parse(action.searchParams.get('biz_content'));
  assert.deepEqual(content, {
    out_trade_no: 'AIPAY01890F3EB1017CC2A8C57F6A1B2C3D4E',
    product_code: 'FAST_INSTANT_TRADE_PAY',
    subject: 'AIPay weather data two calls',
    total_amount: '12.34',
  });
  assert.equal(
    action.searchParams.get('notify_url'),
    'https://aipay.example.com/provider-webhooks/alipay',
  );
  assert.equal(action.searchParams.get('return_url'), 'https://aipay.example.com/payments/return');
});

test('rejects unsafe endpoints, currency and page-pay amount boundaries', async () => {
  assert.throws(
    () =>
      new AlipayWebPaymentProvider({
        appId: '2024001234567890',
        sellerId: '2088123456789012',
        privateKeyPkcs8Base64: 'not-used',
        alipayPublicKeySpkiBase64: 'not-used',
        gatewayUrl: 'https://attacker.example.com/gateway.do',
      }),
    /official endpoint/u,
  );
  const alipay = provider();

  for (const changed of [
    { amount: { currency: 'USD', amountMinor: '1234' } },
    { amount: { currency: 'CNY', amountMinor: '0' } },
    { amount: { currency: 'CNY', amountMinor: '10000000001' } },
  ]) {
    await assert.rejects(
      alipay.createPayment({ ...request, ...changed }),
      (error) => error instanceof PaymentProviderError && error.kind === 'invalid_request',
    );
  }
});

test('advertises only implemented capabilities until later P6 tasks', () => {
  const alipay = provider();
  assert.deepEqual(alipay.capabilities, {
    supportsActiveQuery: true,
    supportsRefunds: false,
    supportsWebhookSignatures: true,
  });
  assert.equal(alipay.acknowledgeWebhook({ eventId: 'verified' }).body, 'success');
});

const queryRequest = {
  transactionId: request.transactionId,
  paymentAttemptId: request.paymentAttemptId,
  providerPaymentId: 'alipay_out_AIPAY01890F3EB1017CC2A8C57F6A1B2C3D4E',
  amount: request.amount,
};

function clientReturning(response, calls = []) {
  return {
    pageExec() {
      return 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
    },
    async exec(method, parameters, options) {
      calls.push({ method, parameters, options });

      if (response instanceof Error) {
        throw response;
      }

      return response;
    },
    checkNotifySignV2() {
      return false;
    },
  };
}

test('actively queries and binds an Alipay final payment result', async () => {
  const calls = [];
  const { alipay } = fixture(
    clientReturning(
      {
        code: '10000',
        outTradeNo: 'AIPAY01890F3EB1017CC2A8C57F6A1B2C3D4E',
        tradeNo: '2026082822001234567890123456',
        totalAmount: '12.34',
        tradeStatus: 'TRADE_SUCCESS',
        sendPayDate: '2026-08-28 15:59:58',
      },
      calls,
    ),
  );
  const result = await alipay.queryPayment(queryRequest);

  assert.deepEqual(result, {
    providerPaymentId: queryRequest.providerPaymentId,
    providerTransactionId: '2026082822001234567890123456',
    status: 'succeeded',
    occurredAt: '2026-08-28T07:59:58.000Z',
    failureCode: null,
    action: null,
  });
  assert.deepEqual(calls, [
    {
      method: 'alipay.trade.query',
      parameters: {
        bizContent: { outTradeNo: 'AIPAY01890F3EB1017CC2A8C57F6A1B2C3D4E' },
      },
      options: { validateSign: true },
    },
  ]);
});

test('maps not-created orders to pending and rejects query failures or mismatches', async () => {
  const notCreated = fixture(
    clientReturning({ code: '40004', subCode: 'ACQ.TRADE_NOT_EXIST' }),
  ).alipay;
  assert.equal((await notCreated.queryPayment(queryRequest)).status, 'pending');

  for (const response of [
    {
      code: '10000',
      outTradeNo: 'AIPAY01890F3EB9997CC2A8C57F6A1B2C3D4E',
      tradeNo: '2026082822001234567890123456',
      totalAmount: '12.34',
      tradeStatus: 'TRADE_SUCCESS',
    },
    {
      code: '10000',
      outTradeNo: 'AIPAY01890F3EB1017CC2A8C57F6A1B2C3D4E',
      tradeNo: '2026082822001234567890123456',
      totalAmount: '12.35',
      tradeStatus: 'TRADE_SUCCESS',
    },
  ]) {
    await assert.rejects(
      fixture(clientReturning(response)).alipay.queryPayment(queryRequest),
      (error) => error instanceof PaymentProviderError && error.code === 'CHANNEL_RESPONSE_INVALID',
    );
  }

  await assert.rejects(
    fixture(clientReturning(new Error('network secret'))).alipay.queryPayment(queryRequest),
    (error) =>
      error instanceof PaymentProviderError &&
      error.kind === 'retryable' &&
      error.code === 'CHANNEL_UNAVAILABLE' &&
      !error.message.includes('network secret'),
  );
});

test('maps Alipay gateway codes to stable internal handling classes', async () => {
  const cases = [
    ['20000', 'isp.unknow-error', 'retryable', 'CHANNEL_UNAVAILABLE'],
    ['40004', 'ACQ.SYSTEM_ERROR', 'retryable', 'CHANNEL_UNAVAILABLE'],
    ['40004', 'ACQ.BUYER_BALANCE_NOT_ENOUGH', 'declined', 'PAYMENT_DECLINED'],
    ['40004', 'ACQ.INVALID_PARAMETER', 'invalid_request', 'INVALID_CHANNEL_REQUEST'],
    ['40004', 'ACQ.ACCESS_FORBIDDEN', 'fatal', 'CHANNEL_CONFIGURATION_ERROR'],
    ['40004', 'ACQ.NEW_UNDOCUMENTED_CODE', 'fatal', 'CHANNEL_REJECTED'],
  ];

  for (const [code, subCode, kind, stableCode] of cases) {
    await assert.rejects(
      fixture(
        clientReturning({ code, subCode, subMsg: 'vendor secret that must not escape' }),
      ).alipay.queryPayment(queryRequest),
      (error) =>
        error instanceof PaymentProviderError &&
        error.kind === kind &&
        error.code === stableCode &&
        !error.message.includes(subCode) &&
        !error.message.includes('vendor secret'),
    );
  }
});

test('maps local page-pay SDK failures without exposing key or vendor details', async () => {
  const client = clientReturning({ code: '10000' });
  client.pageExec = () => {
    throw new Error('private key parse secret');
  };

  await assert.rejects(
    fixture(client).alipay.createPayment(request),
    (error) =>
      error instanceof PaymentProviderError &&
      error.kind === 'fatal' &&
      error.code === 'CHANNEL_CONFIGURATION_ERROR' &&
      !error.message.includes('private key'),
  );
});

test('verifies and binds RSA2 payment notifications', async () => {
  const { alipay, platformPrivateKey } = fixture();
  const event = await alipay.verifyWebhook(notification(platformPrivateKey));

  assert.deepEqual(event, {
    eventId: 'notify_gate_001',
    eventType: 'payment.updated',
    providerPaymentId: 'alipay_out_AIPAY01890F3EB1017CC2A8C57F6A1B2C3D4E',
    providerTransactionId: '2026082822001234567890123456',
    amount: { currency: 'CNY', amountMinor: '1234' },
    status: 'succeeded',
    occurredAt: '2026-08-28T07:59:58.000Z',
    failureCode: null,
  });
  assert.deepEqual(alipay.acknowledgeWebhook(event), {
    statusCode: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: 'success',
  });
});

test('rejects forged, stale, misbound and ambiguous notifications', async () => {
  const { alipay, platformPrivateKey } = fixture();
  const valid = notification(platformPrivateKey);
  const forgedBody = Buffer.from(valid.rawBody);
  forgedBody[10] ^= 1;

  const rejected = [
    { ...valid, rawBody: forgedBody },
    notification(platformPrivateKey, { notify_time: '2026-08-27 10:00:00' }),
    notification(platformPrivateKey, { app_id: '2024001234567891' }),
    notification(platformPrivateKey, { seller_id: '2088123456789013' }),
    notification(platformPrivateKey, { trade_status: 'UNKNOWN_STATUS' }),
    {
      ...valid,
      rawBody: Buffer.concat([valid.rawBody, Buffer.from('&total_amount=12.34')]),
    },
  ];

  for (const request of rejected) {
    await assert.rejects(
      alipay.verifyWebhook(request),
      (error) => error instanceof PaymentProviderError && error.kind === 'invalid_webhook',
    );
  }
});
