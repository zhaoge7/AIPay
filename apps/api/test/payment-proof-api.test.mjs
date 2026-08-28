import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';

import {
  DELIVERY_RECEIPT_SIGNATURE_DOMAIN,
  canonicalizeDeliveryReceiptSigningPayload,
  getDeliveryReceiptSigningPayload,
  parseDeliveryReceipt,
} from '@aipay/contracts';
import { createDatabase } from '@aipay/database';
import { v7 as uuidv7 } from 'uuid';

import { buildApp } from '../dist/app.js';
import { DeliveryTimeoutService } from '../dist/deliveries/timeouts.js';
import { PaymentProofIssuer } from '../dist/payments/proofs.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;
const password = 'Correct horse battery staple 2026!';

function body(response) {
  return JSON.parse(response.body);
}

function cookie(response) {
  const value = response.headers['set-cookie'];
  assert.equal(typeof value, 'string');
  return value.split(';', 1)[0];
}

async function register(app, email) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password },
  });
  assert.equal(response.statusCode, 201);
  return { cookie: cookie(response), developerId: body(response).data.developerId };
}

function signedReceipt(input, keyId, privateKey) {
  const placeholder = parseDeliveryReceipt({
    schemaVersion: '1',
    ...input,
    proof: { scheme: 'aipay-jcs-ed25519-v1', keyId, value: 'A'.repeat(86) },
  });
  const bytes = Buffer.concat([
    Buffer.from(DELIVERY_RECEIPT_SIGNATURE_DOMAIN, 'utf8'),
    Buffer.from(
      canonicalizeDeliveryReceiptSigningPayload(getDeliveryReceiptSigningPayload(placeholder)),
      'utf8',
    ),
  ]);
  const signature = sign(null, bytes, privateKey).toString('base64url');
  return {
    schemaVersion: '1',
    ...input,
    proof: { scheme: 'aipay-jcs-ed25519-v1', keyId, value: signature },
  };
}

test('issues, verifies and consumes a Payment Proof exactly once with bound resources', async (context) => {
  const container = {
    name: `aipay-payment-proof-${process.pid}`,
    database: 'aipay_payment_proof_test',
    user: 'aipay',
    password: 'payment-proof-only',
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
  const issuerKeys = generateKeyPairSync('ed25519');
  const privateKey = issuerKeys.privateKey.export({ format: 'der', type: 'pkcs8' });
  let now = new Date(Date.now() + 1_000);
  const issuer = new PaymentProofIssuer(database, {
    keyId: `key_${uuidv7()}`,
    privateKeyPkcs8Base64: privateKey.toString('base64'),
    validityMs: 5 * 60 * 1_000,
    now: () => now,
  });
  app = await buildApp({ database, paymentProofIssuer: issuer });
  const owner = await register(app, 'payment-proof-owner@example.com');
  const other = await register(app, 'payment-proof-other@example.com');
  const ownerUuid = owner.developerId.slice(4);
  const agent = await database
    .insertInto('agents')
    .values({ developerId: ownerUuid, name: 'Payment Proof Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: ownerUuid,
      name: 'Payment Proof Merchant',
      callbackUrl: 'https://payment-proof.example.com/webhook',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const alternateMerchant = await database
    .insertInto('merchants')
    .values({
      developerId: ownerUuid,
      name: 'Alternate Proof Merchant',
      callbackUrl: 'https://alternate-proof.example.com/webhook',
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
      publicKey: Buffer.alloc(32, 91),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchantKeys = generateKeyPairSync('ed25519');
  const merchantPublic = merchantKeys.publicKey.export({ format: 'der', type: 'spki' });
  const merchantKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'merchant',
      developerId: null,
      agentId: null,
      merchantId: merchant.id,
      publicKey: merchantPublic.subarray(-32),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const catalogService = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Payment Proof API',
      category: 'data.proof',
      unit: 'request',
      unitPriceAmountMinor: '600',
      refundPolicy: 'full_on_delivery_failure',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandate = await database
    .insertInto('mandates')
    .values({
      principalId: ownerUuid,
      agentId: agent.id,
      purpose: 'Payment Proof consumption',
      maxPerTransactionAmountMinor: '1000',
      totalBudgetAmountMinor: '5000',
      approvalRequiredAboveAmountMinor: '1000',
      maxTransactions: 10,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 93),
      proofKeyId: systemKey.id,
      proofValue: Buffer.alloc(64, 94),
      status: 'active',
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();

  async function paidTransaction(label) {
    const quote = await database
      .insertInto('quotes')
      .values({
        merchantId: merchant.id,
        serviceId: catalogService.id,
        unit: 'request',
        quantity: 1,
        unitPriceAmountMinor: '600',
        subtotalAmountMinor: '600',
        taxBehavior: 'inclusive',
        taxAmountMinor: '0',
        totalAmountMinor: '600',
        issuedAt: new Date(Date.now() - 1_000),
        expiresAt: new Date(Date.now() + 60_000),
        proofKeyId: merchantKey.id,
        proofValue: Buffer.alloc(64, label),
        status: 'active',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const paymentTransaction = await database
      .insertInto('transactions')
      .values({
        quoteId: quote.id,
        mandateId: mandate.id,
        principalId: ownerUuid,
        agentId: agent.id,
        merchantId: merchant.id,
        serviceId: catalogService.id,
        amountMinor: '600',
        status: 'paid',
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const attempt = await database
      .insertInto('paymentAttempts')
      .values({
        transactionId: paymentTransaction.id,
        attemptNumber: 1,
        provider: 'fake',
        providerReference: `fake_proof_${String(label)}`,
        amountMinor: '600',
        status: 'succeeded',
        errorCode: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return { transactionId: `txn_${paymentTransaction.id}`, attemptId: attempt.id };
  }

  now = new Date(Date.now() + 10_000);
  const firstTransaction = await paidTransaction(95);
  const issue = () =>
    app.inject({
      method: 'POST',
      url: `/v1/transactions/${firstTransaction.transactionId}/payment-proof`,
      headers: { cookie: owner.cookie },
    });
  const issued = await issue();
  assert.equal(issued.statusCode, 201);
  const paymentProof = body(issued).data;
  assert.match(paymentProof.paymentProofId, /^ppf_/u);
  assert.equal(paymentProof.paymentAttemptId, `pat_${firstTransaction.attemptId}`);
  assert.equal(paymentProof.merchantId, `mch_${merchant.id}`);
  assert.equal(paymentProof.serviceId, `svc_${catalogService.id}`);
  assert.deepEqual(paymentProof.amount, { currency: 'CNY', amountMinor: '600' });
  assert.deepEqual(body(await issue()).data, paymentProof);

  const verified = await app.inject({
    method: 'POST',
    url: '/v1/payment-proofs/verify',
    payload: paymentProof,
  });
  assert.equal(verified.statusCode, 200);
  assert.deepEqual(body(verified).data, {
    valid: true,
    paymentProofId: paymentProof.paymentProofId,
    transactionId: paymentProof.transactionId,
    merchantId: paymentProof.merchantId,
    serviceId: paymentProof.serviceId,
    expiresAt: paymentProof.expiresAt,
    keyId: paymentProof.proof.keyId,
  });

  const tampered = [
    { ...paymentProof, transactionId: `txn_${uuidv7()}` },
    { ...paymentProof, merchantId: `mch_${alternateMerchant.id}` },
    { ...paymentProof, serviceId: `svc_${uuidv7()}` },
    { ...paymentProof, amount: { currency: 'CNY', amountMinor: '601' } },
  ];

  for (const changed of tampered) {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/payment-proofs/verify',
      payload: changed,
    });
    assert.equal(response.statusCode, 401);
    assert.equal(body(response).code, 'SIGNATURE_INVALID');
  }

  const wrongMerchant = await app.inject({
    method: 'POST',
    url: `/v1/merchants/mch_${alternateMerchant.id}/payment-proofs/consume`,
    headers: { cookie: owner.cookie },
    payload: { paymentProof },
  });
  assert.equal(wrongMerchant.statusCode, 401);

  const wrongOwner = await app.inject({
    method: 'POST',
    url: `/v1/merchants/mch_${merchant.id}/payment-proofs/consume`,
    headers: { cookie: other.cookie },
    payload: { paymentProof },
  });
  assert.equal(wrongOwner.statusCode, 403);

  const consumed = await app.inject({
    method: 'POST',
    url: `/v1/merchants/mch_${merchant.id}/payment-proofs/consume`,
    headers: { cookie: owner.cookie },
    payload: { paymentProof },
  });
  assert.equal(consumed.statusCode, 200);
  assert.equal(body(consumed).data.paymentProofId, paymentProof.paymentProofId);
  const deliveryId = body(consumed).data.deliveryId;
  assert.match(deliveryId, /^dlv_/u);
  const replay = await app.inject({
    method: 'POST',
    url: `/v1/merchants/mch_${merchant.id}/payment-proofs/consume`,
    headers: { cookie: owner.cookie },
    payload: { paymentProof },
  });
  assert.equal(replay.statusCode, 409);

  const firstState = await database
    .selectFrom('paymentProofs')
    .innerJoin('transactions', 'transactions.id', 'paymentProofs.transactionId')
    .select([
      'paymentProofs.status as proofStatus',
      'paymentProofs.consumedAt',
      'transactions.status as transactionStatus',
    ])
    .where('paymentProofs.id', '=', paymentProof.paymentProofId.slice(4))
    .executeTakeFirstOrThrow();
  assert.equal(firstState.proofStatus, 'consumed');
  assert.notEqual(firstState.consumedAt, null);
  assert.equal(firstState.transactionStatus, 'delivery_pending');
  const deliveryEvent = await database
    .selectFrom('outboxEvents')
    .select(['eventType', 'payload'])
    .where('aggregateId', '=', firstTransaction.transactionId.slice(4))
    .executeTakeFirstOrThrow();
  assert.equal(deliveryEvent.eventType, 'transaction.delivery_started');
  assert.equal(deliveryEvent.payload.paymentProofId, paymentProof.paymentProofId);
  assert.equal(deliveryEvent.payload.deliveryId, deliveryId);

  const successReceipt = signedReceipt(
    {
      deliveryId,
      transactionId: paymentProof.transactionId,
      paymentProofId: paymentProof.paymentProofId,
      merchantId: paymentProof.merchantId,
      serviceId: paymentProof.serviceId,
      status: 'succeeded',
      resultDigest: `sha256:${createHash('sha256').update('delivered result').digest('hex')}`,
      deliveredAt: now.toISOString(),
      errorCode: null,
    },
    `key_${merchantKey.id}`,
    merchantKeys.privateKey,
  );
  const receiptVerification = await app.inject({
    method: 'POST',
    url: '/v1/deliveries/verify',
    payload: successReceipt,
  });
  assert.equal(receiptVerification.statusCode, 200);
  assert.equal(body(receiptVerification).data.deliveryId, deliveryId);
  const changedDigest = {
    ...successReceipt,
    resultDigest: `sha256:${'f'.repeat(64)}`,
  };
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/v1/deliveries/verify',
        payload: changedDigest,
      })
    ).statusCode,
    401,
  );
  const submitReceipt = () =>
    app.inject({
      method: 'POST',
      url: `/v1/merchants/mch_${merchant.id}/deliveries/${deliveryId}/receipt`,
      headers: { cookie: owner.cookie },
      payload: successReceipt,
    });
  const submitted = await submitReceipt();
  assert.equal(submitted.statusCode, 200);
  assert.deepEqual(body(submitted).data, successReceipt);
  assert.deepEqual(body(await submitReceipt()).data, successReceipt);
  const deliveredState = await database
    .selectFrom('deliveries')
    .innerJoin('transactions', 'transactions.id', 'deliveries.transactionId')
    .select([
      'deliveries.status as deliveryStatus',
      'deliveries.resultDigest',
      'deliveries.proofValue',
      'transactions.status as transactionStatus',
    ])
    .where('deliveries.id', '=', deliveryId.slice(4))
    .executeTakeFirstOrThrow();
  assert.equal(deliveredState.deliveryStatus, 'succeeded');
  assert.equal(deliveredState.resultDigest?.byteLength, 32);
  assert.equal(deliveredState.proofValue?.byteLength, 64);
  assert.equal(deliveredState.transactionStatus, 'delivered');

  const failedTransaction = await paidTransaction(97);
  const failedProofResponse = await app.inject({
    method: 'POST',
    url: `/v1/transactions/${failedTransaction.transactionId}/payment-proof`,
    headers: { cookie: owner.cookie },
  });
  const failedProof = body(failedProofResponse).data;
  const failedConsume = await app.inject({
    method: 'POST',
    url: `/v1/merchants/mch_${merchant.id}/payment-proofs/consume`,
    headers: { cookie: owner.cookie },
    payload: { paymentProof: failedProof },
  });
  const failedDeliveryId = body(failedConsume).data.deliveryId;
  const failureReceipt = signedReceipt(
    {
      deliveryId: failedDeliveryId,
      transactionId: failedProof.transactionId,
      paymentProofId: failedProof.paymentProofId,
      merchantId: failedProof.merchantId,
      serviceId: failedProof.serviceId,
      status: 'failed',
      resultDigest: `sha256:${createHash('sha256').update('failure evidence').digest('hex')}`,
      deliveredAt: now.toISOString(),
      errorCode: 'UPSTREAM_DELIVERY_FAILED',
    },
    `key_${merchantKey.id}`,
    merchantKeys.privateKey,
  );
  const failedSubmission = await app.inject({
    method: 'POST',
    url: `/v1/merchants/mch_${merchant.id}/deliveries/${failedDeliveryId}/receipt`,
    headers: { cookie: owner.cookie },
    payload: failureReceipt,
  });
  assert.equal(failedSubmission.statusCode, 200);
  const failedState = await database
    .selectFrom('deliveries')
    .innerJoin('transactions', 'transactions.id', 'deliveries.transactionId')
    .select([
      'deliveries.status as deliveryStatus',
      'deliveries.errorCode',
      'transactions.status as transactionStatus',
    ])
    .where('deliveries.id', '=', failedDeliveryId.slice(4))
    .executeTakeFirstOrThrow();
  assert.deepEqual(failedState, {
    deliveryStatus: 'failed',
    errorCode: 'UPSTREAM_DELIVERY_FAILED',
    transactionStatus: 'refund_pending',
  });

  const fullTimeoutTransaction = await paidTransaction(98);
  const fullTimeoutProof = body(
    await app.inject({
      method: 'POST',
      url: `/v1/transactions/${fullTimeoutTransaction.transactionId}/payment-proof`,
      headers: { cookie: owner.cookie },
    }),
  ).data;
  const fullTimeoutConsume = body(
    await app.inject({
      method: 'POST',
      url: `/v1/merchants/mch_${merchant.id}/payment-proofs/consume`,
      headers: { cookie: owner.cookie },
      payload: { paymentProof: fullTimeoutProof },
    }),
  ).data;
  await database
    .updateTable('services')
    .set({ refundPolicy: 'non_refundable', updatedAt: now })
    .where('id', '=', catalogService.id)
    .executeTakeFirstOrThrow();
  const reviewTimeoutTransaction = await paidTransaction(99);
  const reviewTimeoutProof = body(
    await app.inject({
      method: 'POST',
      url: `/v1/transactions/${reviewTimeoutTransaction.transactionId}/payment-proof`,
      headers: { cookie: owner.cookie },
    }),
  ).data;
  const reviewTimeoutConsume = body(
    await app.inject({
      method: 'POST',
      url: `/v1/merchants/mch_${merchant.id}/payment-proofs/consume`,
      headers: { cookie: owner.cookie },
      payload: { paymentProof: reviewTimeoutProof },
    }),
  ).data;
  now = new Date(now.getTime() + 5 * 60 * 1_000);
  const [timeoutWorkerA, timeoutWorkerB] = await Promise.all([
    new DeliveryTimeoutService(database, () => now).expireDue(10),
    new DeliveryTimeoutService(database, () => now).expireDue(10),
  ]);
  const timeouts = [...timeoutWorkerA, ...timeoutWorkerB];
  assert.equal(new Set(timeouts.map(({ deliveryId: id }) => id)).size, 2);
  assert.deepEqual(timeouts.map(({ resolution }) => resolution).sort(), [
    'delivery_review',
    'refund_pending',
  ]);
  const timeoutStates = await database
    .selectFrom('deliveries')
    .innerJoin('transactions', 'transactions.id', 'deliveries.transactionId')
    .select([
      'deliveries.id',
      'deliveries.status as deliveryStatus',
      'deliveries.refundPolicy',
      'transactions.status as transactionStatus',
    ])
    .where('deliveries.id', 'in', [
      fullTimeoutConsume.deliveryId.slice(4),
      reviewTimeoutConsume.deliveryId.slice(4),
    ])
    .orderBy('deliveries.refundPolicy', 'asc')
    .execute();
  assert.deepEqual(
    timeoutStates.map(({ deliveryStatus, refundPolicy, transactionStatus }) => ({
      deliveryStatus,
      refundPolicy,
      transactionStatus,
    })),
    [
      {
        deliveryStatus: 'timed_out',
        refundPolicy: 'full_on_delivery_failure',
        transactionStatus: 'refund_pending',
      },
      {
        deliveryStatus: 'timed_out',
        refundPolicy: 'non_refundable',
        transactionStatus: 'delivery_review',
      },
    ],
  );
  const lateReceipt = signedReceipt(
    {
      deliveryId: fullTimeoutConsume.deliveryId,
      transactionId: fullTimeoutProof.transactionId,
      paymentProofId: fullTimeoutProof.paymentProofId,
      merchantId: fullTimeoutProof.merchantId,
      serviceId: fullTimeoutProof.serviceId,
      status: 'succeeded',
      resultDigest: `sha256:${createHash('sha256').update('late result').digest('hex')}`,
      deliveredAt: now.toISOString(),
      errorCode: null,
    },
    `key_${merchantKey.id}`,
    merchantKeys.privateKey,
  );
  const lateResponse = await app.inject({
    method: 'POST',
    url: `/v1/merchants/mch_${merchant.id}/deliveries/${fullTimeoutConsume.deliveryId}/receipt`,
    headers: { cookie: owner.cookie },
    payload: lateReceipt,
  });
  assert.equal(lateResponse.statusCode, 409);

  const expiringTransaction = await paidTransaction(96);
  const expiringResponse = await app.inject({
    method: 'POST',
    url: `/v1/transactions/${expiringTransaction.transactionId}/payment-proof`,
    headers: { cookie: owner.cookie },
  });
  const expiringProof = body(expiringResponse).data;
  now = new Date(now.getTime() + 5 * 60 * 1_000);
  const expiredVerification = await app.inject({
    method: 'POST',
    url: '/v1/payment-proofs/verify',
    payload: expiringProof,
  });
  assert.equal(expiredVerification.statusCode, 410);
  assert.equal(body(expiredVerification).code, 'PAYMENT_PROOF_EXPIRED');
  const expiredConsumption = await app.inject({
    method: 'POST',
    url: `/v1/merchants/mch_${merchant.id}/payment-proofs/consume`,
    headers: { cookie: owner.cookie },
    payload: { paymentProof: expiringProof },
  });
  assert.equal(expiredConsumption.statusCode, 410);
  const expiredRow = await database
    .selectFrom('paymentProofs')
    .select('status')
    .where('id', '=', expiringProof.paymentProofId.slice(4))
    .executeTakeFirstOrThrow();
  assert.equal(expiredRow.status, 'expired');
});
