import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { URL } from 'node:url';

import { AlipayWebPaymentProvider, PaymentProviderError } from '../dist/index.js';

function provider() {
  const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platformKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });

  return new AlipayWebPaymentProvider({
    appId: '2024001234567890',
    privateKeyPkcs8Base64: appKeys.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    alipayPublicKeySpkiBase64: platformKeys.publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
    gatewayUrl: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
    returnUrl: 'https://aipay.example.com/payments/return',
    now: () => new Date('2026-08-28T08:00:00.000Z'),
  });
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

test('advertises only implemented capabilities until later P6 tasks', async () => {
  const alipay = provider();
  assert.deepEqual(alipay.capabilities, {
    supportsActiveQuery: false,
    supportsRefunds: false,
    supportsWebhookSignatures: false,
  });
  await assert.rejects(
    alipay.queryPayment({ providerPaymentId: 'alipay_out_order' }),
    (error) =>
      error instanceof PaymentProviderError && error.code === 'QUERY_PAYMENT_NOT_AVAILABLE',
  );
  assert.equal(alipay.acknowledgeWebhook({ eventId: 'not-verified' }).body, 'failure');
});
