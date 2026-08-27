import assert from 'node:assert/strict';
import test from 'node:test';
import { TextEncoder } from 'node:util';

import {
  FakePaymentProvider,
  PaymentProviderError,
  isRetryableProviderError,
} from '../dist/index.js';

const request = {
  transactionId: 'txn_01890f3e-b000-7cc2-98c5-7f6a1b2c3d4e',
  paymentAttemptId: 'pat_01890f3e-b001-7cc2-a8c5-7f6a1b2c3d4e',
  amount: { currency: 'CNY', amountMinor: '200' },
  idempotencyKey: 'fake-payment-key',
  description: 'Fake payment',
  callbackUrl: 'https://aipay.example.com/webhooks/fake',
};

test('simulates successful and failed payments idempotently', async () => {
  const provider = new FakePaymentProvider({ webhookSecret: 'fake-secret-at-least-16-bytes' });
  provider.enqueuePaymentOutcome('succeeded');
  const succeeded = await provider.createPayment(request);
  assert.equal(succeeded.status, 'succeeded');
  assert.equal(succeeded.failureCode, null);
  assert.deepEqual(await provider.createPayment(request), succeeded);
  assert.deepEqual(
    await provider.queryPayment({
      transactionId: request.transactionId,
      paymentAttemptId: request.paymentAttemptId,
      providerPaymentId: succeeded.providerPaymentId,
    }),
    succeeded,
  );

  provider.enqueuePaymentOutcome('failed');
  const failed = await provider.createPayment({ ...request, idempotencyKey: 'fake-failure-key' });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureCode, 'FAKE_PAYMENT_FAILED');
});

test('simulates timeout with an unknown payment recoverable by query', async () => {
  const provider = new FakePaymentProvider({ webhookSecret: 'fake-secret-at-least-16-bytes' });
  provider.enqueuePaymentOutcome('timeout');
  await assert.rejects(
    provider.createPayment(request),
    (error) =>
      error instanceof PaymentProviderError &&
      isRetryableProviderError(error) &&
      error.code === 'TIMEOUT',
  );

  const retried = await provider.createPayment(request);
  assert.equal(retried.status, 'unknown');
  provider.setPaymentStatus(retried.providerPaymentId, 'succeeded');
  const recovered = await provider.queryPayment({ providerPaymentId: retried.providerPaymentId });
  assert.equal(recovered.status, 'succeeded');
});

test('verifies callbacks and can emit the same event more than once', async () => {
  const provider = new FakePaymentProvider({ webhookSecret: 'fake-secret-at-least-16-bytes' });
  provider.enqueuePaymentOutcome('pending');
  const payment = await provider.createPayment(request);
  provider.setPaymentStatus(payment.providerPaymentId, 'succeeded');
  const first = provider.paymentWebhook(payment.providerPaymentId, 'duplicate_event');
  const duplicate = provider.paymentWebhook(payment.providerPaymentId, 'duplicate_event');

  assert.deepEqual(first.rawBody, duplicate.rawBody);
  assert.deepEqual(await provider.verifyWebhook(first), await provider.verifyWebhook(duplicate));
  assert.equal(provider.acknowledgeWebhook(await provider.verifyWebhook(first)).body, 'ok');

  const tampered = {
    ...first,
    rawBody: new TextEncoder().encode('{"tampered":true}'),
  };
  await assert.rejects(
    provider.verifyWebhook(tampered),
    (error) =>
      error instanceof PaymentProviderError &&
      error.kind === 'invalid_webhook' &&
      error.code === 'INVALID_SIGNATURE',
  );
});

test('simulates refund success, failure, timeout and query recovery', async () => {
  const provider = new FakePaymentProvider({ webhookSecret: 'fake-secret-at-least-16-bytes' });
  provider.enqueuePaymentOutcome('succeeded');
  const payment = await provider.createPayment(request);
  const refundRequest = {
    refundId: 'rfd_01890f3e-b002-7cc2-b8c5-7f6a1b2c3d4e',
    transactionId: request.transactionId,
    providerPaymentId: payment.providerPaymentId,
    amount: request.amount,
    idempotencyKey: 'fake-refund-key',
    reason: 'delivery_failed',
  };

  provider.enqueueRefundOutcome('succeeded');
  const succeeded = await provider.createRefund(refundRequest);
  assert.equal(succeeded.status, 'succeeded');
  assert.deepEqual(await provider.createRefund(refundRequest), succeeded);
  assert.equal(
    (await provider.verifyWebhook(provider.refundWebhook(succeeded.providerRefundId))).eventType,
    'refund.updated',
  );

  provider.enqueueRefundOutcome('failed');
  const failed = await provider.createRefund({
    ...refundRequest,
    idempotencyKey: 'fake-refund-failed',
  });
  assert.equal(failed.status, 'failed');

  provider.enqueueRefundOutcome('timeout');
  const timeoutRequest = { ...refundRequest, idempotencyKey: 'fake-refund-timeout' };
  await assert.rejects(provider.createRefund(timeoutRequest), isRetryableProviderError);
  const unknown = await provider.createRefund(timeoutRequest);
  assert.equal(unknown.status, 'unknown');
  provider.setRefundStatus(unknown.providerRefundId, 'succeeded');
  assert.equal(
    (await provider.queryRefund({ providerRefundId: unknown.providerRefundId })).status,
    'succeeded',
  );
});
