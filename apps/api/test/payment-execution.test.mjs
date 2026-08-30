import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import test from 'node:test';

import { parseResourceId } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';
import { AlipayWebPaymentProvider, FakePaymentProvider } from '@aipay/payment';

import { PaymentExecutionError, PaymentExecutionService } from '../dist/payments/execution.js';
import { RefundExecutionError, RefundExecutionService } from '../dist/payments/refunds.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

test('records every Provider create/retry/query call and its result', async (context) => {
  const container = {
    name: `aipay-payment-execution-test-${process.pid}`,
    database: 'aipay_payment_execution_test',
    user: 'aipay',
    password: 'payment-execution-only',
  };
  let database;
  context.after(async () => {
    await database?.destroy();
    removePostgresContainer(container.name);
  });

  const { databaseUrl } = await startPostgresContainer(container);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 6 });
  const developer = await database
    .insertInto('developers')
    .values({
      email: 'payment-execution@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Payment Execution Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'Payment Execution Merchant',
      callbackUrl: 'https://payment-execution.example.com/webhook',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const systemKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'system',
      developerId: null,
      agentId: null,
      merchantId: null,
      publicKey: Buffer.alloc(32, 50),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchantKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'merchant',
      developerId: null,
      agentId: null,
      merchantId: merchant.id,
      publicKey: Buffer.alloc(32, 51),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const catalogService = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Payment Execution Service',
      category: 'data.payment',
      unit: 'request',
      unitPriceAmountMinor: '200',
      refundPolicy: 'full_on_delivery_failure',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandate = await database
    .insertInto('mandates')
    .values({
      principalId: developer.id,
      agentId: agent.id,
      purpose: 'Payment execution tracking',
      maxPerTransactionAmountMinor: '1000',
      totalBudgetAmountMinor: '5000',
      approvalRequiredAboveAmountMinor: '1000',
      maxTransactions: 10,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 52),
      proofKeyId: systemKey.id,
      proofValue: Buffer.alloc(64, 53),
      status: 'active',
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  async function transaction(label) {
    const quote = await database
      .insertInto('quotes')
      .values({
        merchantId: merchant.id,
        serviceId: catalogService.id,
        unit: 'request',
        quantity: 1,
        unitPriceAmountMinor: '200',
        subtotalAmountMinor: '200',
        taxBehavior: 'inclusive',
        taxAmountMinor: '0',
        totalAmountMinor: '200',
        issuedAt: new Date(Date.now() - 1_000),
        expiresAt: new Date(Date.now() + 60_000),
        proofKeyId: merchantKey.id,
        proofValue: Buffer.alloc(64, label),
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const row = await database
      .insertInto('transactions')
      .values({
        quoteId: quote.id,
        mandateId: mandate.id,
        principalId: developer.id,
        agentId: agent.id,
        merchantId: merchant.id,
        serviceId: catalogService.id,
        amountMinor: '200',
        status: 'authorized',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return parseResourceId(`txn_${row.id}`, 'txn');
  }

  const provider = new FakePaymentProvider({ webhookSecret: 'payment-execution-fake-secret' });
  const execution = new PaymentExecutionService(
    database,
    'https://aipay.example.com/webhooks/fake',
  );

  const successfulTransaction = await transaction(54);
  provider.enqueuePaymentOutcome('succeeded');
  const successful = await execution.create(successfulTransaction, provider);
  assert.equal(successful.status, 'succeeded');
  assert.match(successful.providerReference, /^fake_pay_/u);

  const failedTransaction = await transaction(55);
  provider.enqueuePaymentOutcome('failed');
  const failed = await execution.create(failedTransaction, provider);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'FAKE_PAYMENT_FAILED');

  const timeoutTransaction = await transaction(56);
  provider.enqueuePaymentOutcome('timeout');
  let timeoutAttemptId;
  await assert.rejects(
    execution.create(timeoutTransaction, provider),
    (error) => error instanceof PaymentExecutionError && error.providerCode === 'TIMEOUT',
  );
  const timeoutAttempt = await database
    .selectFrom('paymentAttempts')
    .select(['id', 'status', 'errorCode', 'providerReference'])
    .where('transactionId', '=', timeoutTransaction.slice(4))
    .executeTakeFirstOrThrow();
  timeoutAttemptId = parseResourceId(`pat_${timeoutAttempt.id}`, 'pat');
  assert.deepEqual(
    {
      status: timeoutAttempt.status,
      errorCode: timeoutAttempt.errorCode,
      providerReference: timeoutAttempt.providerReference,
    },
    { status: 'unknown', errorCode: 'TIMEOUT', providerReference: null },
  );

  const restartedExecution = new PaymentExecutionService(
    database,
    'https://aipay.example.com/webhooks/fake',
  );
  const retryCreate = await restartedExecution.retryCreate(timeoutAttemptId, provider);
  assert.equal(retryCreate.status, 'unknown');
  assert.match(retryCreate.providerReference, /^fake_pay_/u);
  provider.setPaymentStatus(retryCreate.providerReference, 'succeeded');
  const recovered = await restartedExecution.query(timeoutAttemptId, provider);
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.providerReference, retryCreate.providerReference);

  const alipayTransaction = await transaction(57);
  const alipayClientCalls = [];
  let failAlipayQuery = false;
  const alipayClient = {
    pageExec() {
      return 'https://openapi-sandbox.dl.alipaydev.com/gateway.do?method=alipay.trade.page.pay';
    },
    async exec(method, parameters, options) {
      alipayClientCalls.push({ method, parameters, options });

      if (method === 'alipay.trade.query' && failAlipayQuery) {
        throw new Error('simulated query outage');
      }

      const outTradeNo = parameters.bizContent.outTradeNo;

      if (method === 'alipay.trade.refund') {
        return { code: '10000', outTradeNo, refundFee: '2.00', fundChange: 'N' };
      }

      if (method === 'alipay.trade.fastpay.refund.query') {
        return {
          code: '10000',
          outTradeNo,
          outRequestNo: parameters.bizContent.outRequestNo,
          refundAmount: '2.00',
          refundStatus: 'REFUND_SUCCESS',
        };
      }

      return {
        code: '10000',
        outTradeNo,
        tradeNo: '2026082822001234567890123457',
        totalAmount: '2.00',
        tradeStatus: 'TRADE_SUCCESS',
        sendPayDate: '2026-08-28 16:00:00',
      };
    },
    checkNotifySignV2() {
      return false;
    },
  };
  const alipay = new AlipayWebPaymentProvider(
    {
      appId: '2024001234567890',
      sellerId: '2088123456789012',
      privateKeyPkcs8Base64: 'injected-client-does-not-read-private-key',
      alipayPublicKeySpkiBase64: 'injected-client-does-not-read-public-key',
      gatewayUrl: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
    },
    alipayClient,
  );
  const alipayPending = await execution.create(alipayTransaction, alipay);
  assert.equal(alipayPending.status, 'pending');
  assert.equal(alipayPending.providerTransactionId, null);
  assert.equal(alipayPending.action.type, 'redirect');
  const alipayRecovered = await execution.query(alipayPending.paymentAttemptId, alipay);
  assert.equal(alipayRecovered.status, 'succeeded');
  assert.equal(alipayRecovered.providerReference, alipayPending.providerReference);
  assert.equal(alipayRecovered.providerTransactionId, '2026082822001234567890123457');
  assert.equal(alipayRecovered.action, null);
  assert.equal(alipayClientCalls.length, 1);
  failAlipayQuery = true;
  await assert.rejects(
    execution.query(alipayPending.paymentAttemptId, alipay),
    (error) =>
      error instanceof PaymentExecutionError && error.providerCode === 'CHANNEL_UNAVAILABLE',
  );
  assert.equal(alipayClientCalls.length, 2);

  const attempts = await database
    .selectFrom('paymentAttempts')
    .select(['transactionId', 'status', 'providerReference', 'providerTransactionId'])
    .orderBy('createdAt', 'asc')
    .execute();
  assert.equal(attempts.length, 4);
  assert.deepEqual(
    attempts.map(({ status }) => status),
    ['succeeded', 'failed', 'succeeded', 'succeeded'],
  );

  const calls = await database
    .selectFrom('paymentProviderCalls')
    .select([
      'paymentAttemptId',
      'operation',
      'requestDigest',
      'outcome',
      'providerStatus',
      'providerReference',
      'providerTransactionId',
      'errorKind',
      'errorCode',
      'completedAt',
      'durationMs',
    ])
    .orderBy('startedAt', 'asc')
    .execute();
  assert.equal(calls.length, 8);
  assert.deepEqual(
    calls.map(({ operation }) => operation),
    [
      'payment.create',
      'payment.create',
      'payment.create',
      'payment.create',
      'payment.query',
      'payment.create',
      'payment.query',
      'payment.query',
    ],
  );
  assert.equal(
    calls.every(({ requestDigest }) => requestDigest.byteLength === 32),
    true,
  );
  assert.equal(
    calls.every(({ completedAt }) => completedAt !== null),
    true,
  );
  assert.equal(
    calls.every(({ durationMs }) => durationMs !== null && durationMs >= 0),
    true,
  );
  const timeoutCall = calls.find(({ errorCode }) => errorCode === 'TIMEOUT');
  assert.equal(timeoutCall?.outcome, 'failed');
  assert.equal(timeoutCall?.providerStatus, 'unknown');
  assert.equal(timeoutCall?.errorKind, 'retryable');
  assert.equal(calls.filter(({ providerReference }) => providerReference !== null).length, 7);
  assert.equal(
    calls.filter(
      ({ providerTransactionId }) => providerTransactionId === '2026082822001234567890123457',
    ).length,
    2,
  );

  const transactionStates = await database
    .selectFrom('transactions')
    .select(['id', 'status'])
    .orderBy('createdAt', 'asc')
    .execute();
  assert.deepEqual(
    transactionStates.map(({ status }) => status),
    ['paid', 'failed', 'paid', 'paid'],
  );
  const alipayState = await database
    .selectFrom('paymentAttempts')
    .innerJoin('transactions', 'transactions.id', 'paymentAttempts.transactionId')
    .select(['paymentAttempts.status as attemptStatus', 'transactions.status as transactionStatus'])
    .where('paymentAttempts.id', '=', alipayPending.paymentAttemptId.slice(4))
    .executeTakeFirstOrThrow();
  assert.deepEqual(alipayState, { attemptStatus: 'succeeded', transactionStatus: 'paid' });
  const alipayOutbox = await database
    .selectFrom('outboxEvents')
    .select(({ fn }) => fn.countAll().as('count'))
    .where('aggregateId', '=', alipayTransaction.slice(4))
    .executeTakeFirstOrThrow();
  assert.equal(Number(alipayOutbox.count), 1);

  const refundExecution = new RefundExecutionService(database);
  const unknownRefund = await refundExecution.create(alipayTransaction, alipay);
  assert.equal(unknownRefund.status, 'unknown');
  assert.deepEqual(unknownRefund.amount, { currency: 'CNY', amountMinor: '200' });
  assert.match(unknownRefund.providerReference, /^alipay_refund_AIPAYRF/u);
  const recoveredRefund = await refundExecution.query(unknownRefund.refundId, alipay);
  assert.equal(recoveredRefund.status, 'succeeded');
  assert.equal(recoveredRefund.providerReference, unknownRefund.providerReference);
  assert.deepEqual(await refundExecution.create(alipayTransaction, alipay), recoveredRefund);

  const finalRefundState = await database
    .selectFrom('transactions')
    .innerJoin('refunds', 'refunds.transactionId', 'transactions.id')
    .select([
      'transactions.status as transactionStatus',
      'transactions.amountMinor as transactionAmount',
      'refunds.status as refundStatus',
      'refunds.amountMinor as refundAmount',
      'refunds.providerReference',
    ])
    .where('transactions.id', '=', alipayTransaction.slice(4))
    .executeTakeFirstOrThrow();
  assert.deepEqual(finalRefundState, {
    transactionStatus: 'refunded',
    transactionAmount: '200',
    refundStatus: 'succeeded',
    refundAmount: '200',
    providerReference: unknownRefund.providerReference,
  });
  const refundCalls = await database
    .selectFrom('refundProviderCalls')
    .select(['operation', 'outcome', 'providerStatus', 'providerReference'])
    .orderBy('startedAt', 'asc')
    .execute();
  assert.deepEqual(refundCalls, [
    {
      operation: 'refund.create',
      outcome: 'succeeded',
      providerStatus: 'unknown',
      providerReference: unknownRefund.providerReference,
    },
    {
      operation: 'refund.query',
      outcome: 'succeeded',
      providerStatus: 'succeeded',
      providerReference: unknownRefund.providerReference,
    },
  ]);
  const finalAlipayOutbox = await database
    .selectFrom('outboxEvents')
    .select(['eventType', 'payload'])
    .where('aggregateId', '=', alipayTransaction.slice(4))
    .orderBy('createdAt', 'asc')
    .execute();
  assert.deepEqual(
    finalAlipayOutbox.map(({ eventType }) => eventType),
    ['transaction.paid', 'transaction.refund_review', 'transaction.refunded'],
  );
  assert.equal(finalAlipayOutbox.at(-1).payload.refundId, recoveredRefund.refundId);

  await database
    .updateTable('services')
    .set({ refundPolicy: 'non_refundable', updatedAt: new Date() })
    .where('id', '=', catalogService.id)
    .executeTakeFirstOrThrow();
  const nonRefundableTransaction = await transaction(58);
  provider.enqueuePaymentOutcome('succeeded');
  await execution.create(nonRefundableTransaction, provider);
  await assert.rejects(
    refundExecution.create(nonRefundableTransaction, provider),
    (error) => error instanceof RefundExecutionError && error.code === 'invalid_state',
  );
  const refundCount = await database
    .selectFrom('refunds')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(Number(refundCount.count), 1);
});
