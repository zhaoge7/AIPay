import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PaymentProviderError,
  isRetryableProviderError,
  isTerminalPaymentStatus,
  isTerminalRefundStatus,
} from '../dist/index.js';

test('defines stable terminal status semantics for payments and refunds', () => {
  assert.equal(isTerminalPaymentStatus('pending'), false);
  assert.equal(isTerminalPaymentStatus('unknown'), false);
  assert.equal(isTerminalPaymentStatus('succeeded'), true);
  assert.equal(isTerminalPaymentStatus('failed'), true);
  assert.equal(isTerminalRefundStatus('pending'), false);
  assert.equal(isTerminalRefundStatus('unknown'), false);
  assert.equal(isTerminalRefundStatus('succeeded'), true);
  assert.equal(isTerminalRefundStatus('failed'), true);
});

test('classifies provider errors without exposing vendor messages', () => {
  const error = new PaymentProviderError({
    provider: 'fake',
    kind: 'retryable',
    code: 'TEMPORARILY_UNAVAILABLE',
    retryAfterMs: 1_000,
  });

  assert.equal(error.message, 'Payment provider operation failed');
  assert.equal(error.provider, 'fake');
  assert.equal(error.code, 'TEMPORARILY_UNAVAILABLE');
  assert.equal(error.retryAfterMs, 1_000);
  assert.equal(isRetryableProviderError(error), true);
  assert.equal(
    isRetryableProviderError(
      new PaymentProviderError({ provider: 'fake', kind: 'declined', code: 'DECLINED' }),
    ),
    false,
  );
});

test('supports one provider implementation across create/query/refund/webhook ports', async () => {
  const calls = [];
  const provider = {
    name: 'test',
    capabilities: {
      supportsActiveQuery: true,
      supportsRefunds: true,
      supportsWebhookSignatures: true,
    },
    async createPayment(request) {
      calls.push(['createPayment', request.idempotencyKey]);
      return {
        providerPaymentId: 'pay_1',
        status: 'pending',
        occurredAt: '2026-08-27T10:00:00.000Z',
        failureCode: null,
      };
    },
    async queryPayment(request) {
      calls.push(['queryPayment', request.providerPaymentId]);
      return {
        providerPaymentId: request.providerPaymentId,
        status: 'succeeded',
        occurredAt: '2026-08-27T10:00:01.000Z',
        failureCode: null,
      };
    },
    async createRefund(request) {
      calls.push(['createRefund', request.idempotencyKey]);
      return {
        providerRefundId: 'refund_1',
        status: 'pending',
        occurredAt: '2026-08-27T10:01:00.000Z',
        failureCode: null,
      };
    },
    async queryRefund(request) {
      calls.push(['queryRefund', request.providerRefundId]);
      return {
        providerRefundId: request.providerRefundId,
        status: 'succeeded',
        occurredAt: '2026-08-27T10:01:01.000Z',
        failureCode: null,
      };
    },
    async verifyWebhook(request) {
      calls.push(['verifyWebhook', request.rawBody.byteLength]);
      return {
        eventId: 'event_1',
        eventType: 'payment.updated',
        providerPaymentId: 'pay_1',
        status: 'succeeded',
        occurredAt: request.receivedAt,
        failureCode: null,
      };
    },
    acknowledgeWebhook(event) {
      calls.push(['acknowledgeWebhook', event.eventId]);
      return { statusCode: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' };
    },
  };

  const payment = await provider.createPayment({ idempotencyKey: 'payment-key' });
  await provider.queryPayment({ providerPaymentId: payment.providerPaymentId });
  const refund = await provider.createRefund({ idempotencyKey: 'refund-key' });
  await provider.queryRefund({ providerRefundId: refund.providerRefundId });
  const event = await provider.verifyWebhook({
    rawBody: new Uint8Array([1, 2, 3]),
    receivedAt: '2026-08-27T10:02:00.000Z',
  });
  assert.equal(provider.acknowledgeWebhook(event).statusCode, 200);
  assert.deepEqual(calls, [
    ['createPayment', 'payment-key'],
    ['queryPayment', 'pay_1'],
    ['createRefund', 'refund-key'],
    ['queryRefund', 'refund_1'],
    ['verifyWebhook', 3],
    ['acknowledgeWebhook', 'event_1'],
  ]);
});
