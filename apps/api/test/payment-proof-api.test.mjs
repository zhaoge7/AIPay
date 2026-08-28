import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';

import { createDatabase } from '@aipay/database';
import { v7 as uuidv7 } from 'uuid';

import { buildApp } from '../dist/app.js';
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
  const merchantKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'merchant',
      developerId: null,
      agentId: null,
      merchantId: merchant.id,
      publicKey: Buffer.alloc(32, 92),
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
