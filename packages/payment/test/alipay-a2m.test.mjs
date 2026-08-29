import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import test from 'node:test';

import { AlipayA2MClient, PaymentProviderError } from '../dist/index.js';

function fixture(responses = []) {
  const appKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const platformKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const calls = [];
  const sdk = {
    async exec(method, parameters, options) {
      calls.push({ method, parameters, options });
      const response = responses.shift();

      if (response instanceof Error) {
        throw response;
      }

      return response;
    },
  };
  const client = new AlipayA2MClient(
    {
      appId: '2024001234567890',
      privateKeyPkcs1Base64: appKeys.privateKey
        .export({ format: 'der', type: 'pkcs1' })
        .toString('base64'),
      alipayPublicKeySpkiBase64: platformKeys.publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64'),
      gatewayUrl: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
      sellerId: '2088123456789012',
      sellerName: 'AIPay',
      serviceId: 'api_mock_service_id',
      sandbox: true,
    },
    sdk,
  );
  return { client, calls, appPublicKey: createPublicKey(appKeys.privateKey) };
}

test('signs the exact sorted A2M bill fields with RSA2', () => {
  const { client, appPublicKey } = fixture();
  const bill = {
    amount: '0.01',
    currency: 'CNY',
    goods_name: 'Weather API',
    out_trade_no: 'A2M01890F3EB1007CC298C57F6A1B2C3D4E',
    pay_before: '2026-08-29T15:00:00+08:00',
    resource_id: '/v1/a2m/resources/svc_01890f3e-b101-7cc2-a8c5-7f6a1b2c3d4e',
    seller_id: '2088123456789012',
    service_id: 'api_mock_service_id',
  };
  const signature = client.signBill(bill);
  const content = Object.entries(bill)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  assert.equal(
    verify('RSA-SHA256', Buffer.from(content), appPublicKey, Buffer.from(signature, 'base64')),
    true,
  );
});

test('calls A2M verify and fulfillment APIs with only documented fields', async () => {
  const { client, calls } = fixture([
    {
      code: '10000',
      active: true,
      tradeNo: '2026082922001234567890123456',
      outTradeNo: 'A2M01890F3EB1007CC298C57F6A1B2C3D4E',
      amount: '0.01',
      resourceId: '/v1/a2m/resources/test',
    },
    { code: '10000' },
  ]);
  const result = await client.verifyPaymentProof({
    tradeNo: '2026082922001234567890123456',
    paymentProof: 'a'.repeat(64),
    clientSession: 'session',
  });

  assert.equal(result.accepted, true);
  assert.equal(result.active, true);
  assert.equal(await client.confirmFulfillment(result.tradeNo), true);
  assert.deepEqual(calls, [
    {
      method: 'alipay.aipay.agent.payment.verify',
      parameters: {
        bizContent: {
          tradeNo: '2026082922001234567890123456',
          paymentProof: 'a'.repeat(64),
          clientSession: 'session',
        },
      },
      options: { validateSign: true },
    },
    {
      method: 'alipay.aipay.agent.fulfillment.confirm',
      parameters: { bizContent: { tradeNo: '2026082922001234567890123456' } },
      options: { validateSign: true },
    },
  ]);
});

test('fails closed on A2M transport and configuration errors', async () => {
  const { client } = fixture([new Error('network secret')]);
  await assert.rejects(
    client.verifyPaymentProof({ tradeNo: '2026082922001234', paymentProof: 'a'.repeat(64) }),
    (error) =>
      error instanceof PaymentProviderError &&
      error.code === 'A2M_VERIFY_UNAVAILABLE' &&
      !error.message.includes('network secret'),
  );
  assert.throws(
    () =>
      new AlipayA2MClient({
        appId: '2024001234567890',
        privateKeyPkcs1Base64: 'invalid',
        alipayPublicKeySpkiBase64: 'invalid',
        gatewayUrl: 'https://openapi.alipay.com/gateway.do',
        sellerId: '2088123456789012',
        sellerName: 'AIPay',
        serviceId: 'api_mock_service_id',
        sandbox: false,
      }),
    /forbidden in production/u,
  );
});
