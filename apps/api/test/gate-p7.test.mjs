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
  parseResourceId,
} from '@aipay/contracts';
import { createDatabase } from '@aipay/database';
import { FakePaymentProvider } from '@aipay/payment';
import { WebhookDispatcher } from '@aipay/worker/dist/webhooks/dispatcher.js';
import { Ed25519WebhookSigner } from '@aipay/worker/dist/webhooks/signing.js';
import { v7 as uuidv7 } from 'uuid';

import { DeliveryReceiptService } from '../dist/deliveries/receipts.js';
import { PaymentExecutionService } from '../dist/payments/execution.js';
import { PaymentProofError, PaymentProofIssuer } from '../dist/payments/proofs.js';
import { RefundExecutionService } from '../dist/payments/refunds.js';
import { TransactionTimelineService } from '../dist/timeline/service.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

function signedFailureReceipt(input, keyId, privateKey) {
  const placeholder = parseDeliveryReceipt({
    schemaVersion: '1',
    ...input,
    proof: { scheme: 'aipay-jcs-ed25519-v1', keyId, value: 'A'.repeat(86) },
  });
  const signature = sign(
    null,
    Buffer.concat([
      Buffer.from(DELIVERY_RECEIPT_SIGNATURE_DOMAIN, 'utf8'),
      Buffer.from(
        canonicalizeDeliveryReceiptSigningPayload(getDeliveryReceiptSigningPayload(placeholder)),
        'utf8',
      ),
    ]),
    privateKey,
  ).toString('base64url');
  return {
    schemaVersion: '1',
    ...input,
    proof: { scheme: 'aipay-jcs-ed25519-v1', keyId, value: signature },
  };
}

class VerifyingTransport {
  constructor(signer) {
    this.signer = signer;
    this.requests = [];
  }

  async deliver(request) {
    const match = /^ed25519=:([A-Za-z0-9_-]+):$/u.exec(request.headers['x-aipay-signature']);
    assert.notEqual(match, null);
    assert.equal(
      this.signer.verify(
        request.headers['x-aipay-event-id'],
        request.headers['x-aipay-timestamp'],
        request.body,
        match[1],
      ),
      true,
    );
    this.requests.push(request);
    return { statusCode: 204 };
  }
}

test('passes Gate P7 from successful payment through failed delivery and reliable refund', async (context) => {
  const container = {
    name: `aipay-gate-p7-${process.pid}`,
    database: 'aipay_gate_p7_test',
    user: 'aipay',
    password: 'gate-p7-only',
  };
  let database;
  context.after(async () => {
    await database?.destroy();
    removePostgresContainer(container.name);
  });

  const { databaseUrl } = await startPostgresContainer(container);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 10 });
  const developer = await database
    .insertInto('developers')
    .values({
      email: 'gate-p7@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Gate P7 Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'Gate P7 Merchant',
      callbackUrl: 'https://gate-p7-merchant.example.com/webhook',
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
  const mandateKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'system',
      developerId: null,
      agentId: null,
      merchantId: null,
      publicKey: Buffer.alloc(32, 111),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const catalogService = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Gate P7 API',
      category: 'data.gate_p7',
      unit: 'request',
      unitPriceAmountMinor: '300',
      refundPolicy: 'full_on_delivery_failure',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandate = await database
    .insertInto('mandates')
    .values({
      principalId: developer.id,
      agentId: agent.id,
      purpose: 'Gate P7 full lifecycle',
      maxPerTransactionAmountMinor: '1000',
      totalBudgetAmountMinor: '5000',
      approvalRequiredAboveAmountMinor: '1000',
      maxTransactions: 10,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 112),
      proofKeyId: mandateKey.id,
      proofValue: Buffer.alloc(64, 113),
      status: 'active',
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const quote = await database
    .insertInto('quotes')
    .values({
      merchantId: merchant.id,
      serviceId: catalogService.id,
      unit: 'request',
      quantity: 1,
      unitPriceAmountMinor: '300',
      subtotalAmountMinor: '300',
      taxBehavior: 'inclusive',
      taxAmountMinor: '0',
      totalAmountMinor: '300',
      issuedAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 60_000),
      proofKeyId: merchantKey.id,
      proofValue: Buffer.alloc(64, 114),
      status: 'active',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const paymentTransaction = await database
    .insertInto('transactions')
    .values({
      quoteId: quote.id,
      mandateId: mandate.id,
      principalId: developer.id,
      agentId: agent.id,
      merchantId: merchant.id,
      serviceId: catalogService.id,
      amountMinor: '300',
      status: 'authorized',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const transactionId = parseResourceId(`txn_${paymentTransaction.id}`, 'txn');
  let now = new Date(Date.now() + 10_000);
  const provider = new FakePaymentProvider({
    webhookSecret: 'gate-p7-fake-provider-secret',
    now: () => now,
  });
  provider.enqueuePaymentOutcome('succeeded');
  const payment = await new PaymentExecutionService(
    database,
    'https://aipay.example.com/provider-webhooks/fake',
    () => now,
  ).create(transactionId, provider);
  assert.equal(payment.status, 'succeeded');

  const proofKeys = generateKeyPairSync('ed25519');
  const proofPrivate = proofKeys.privateKey.export({ format: 'der', type: 'pkcs8' });
  const proofIssuer = new PaymentProofIssuer(database, {
    keyId: `key_${uuidv7()}`,
    privateKeyPkcs8Base64: proofPrivate.toString('base64'),
    now: () => now,
  });
  const paymentProof = await proofIssuer.issue(`dev_${developer.id}`, transactionId);
  const consumed = await proofIssuer.consume(
    `dev_${developer.id}`,
    `mch_${merchant.id}`,
    paymentProof,
  );
  await assert.rejects(
    proofIssuer.consume(`dev_${developer.id}`, `mch_${merchant.id}`, paymentProof),
    (error) => error instanceof PaymentProofError && error.code === 'already_consumed',
  );

  const failureReceipt = signedFailureReceipt(
    {
      deliveryId: consumed.deliveryId,
      transactionId,
      paymentProofId: paymentProof.paymentProofId,
      merchantId: `mch_${merchant.id}`,
      serviceId: `svc_${catalogService.id}`,
      status: 'failed',
      resultDigest: `sha256:${createHash('sha256').update('gate p7 failure').digest('hex')}`,
      deliveredAt: now.toISOString(),
      errorCode: 'UPSTREAM_DELIVERY_FAILED',
    },
    `key_${merchantKey.id}`,
    merchantKeys.privateKey,
  );
  const receiptService = new DeliveryReceiptService(database, () => now);
  assert.deepEqual(
    await receiptService.submit(
      `dev_${developer.id}`,
      `mch_${merchant.id}`,
      consumed.deliveryId,
      failureReceipt,
    ),
    failureReceipt,
  );
  assert.deepEqual(
    await receiptService.submit(
      `dev_${developer.id}`,
      `mch_${merchant.id}`,
      consumed.deliveryId,
      failureReceipt,
    ),
    failureReceipt,
  );

  provider.enqueueRefundOutcome('succeeded');
  const refundService = new RefundExecutionService(database, () => now);
  const refund = await refundService.create(transactionId, provider);
  assert.equal(refund.status, 'succeeded');
  assert.equal(refund.amount.amountMinor, '300');
  assert.deepEqual(await refundService.create(transactionId, provider), refund);

  const webhookKeys = generateKeyPairSync('ed25519');
  const webhookPrivate = webhookKeys.privateKey.export({ format: 'der', type: 'pkcs8' });
  const webhookPublic = webhookKeys.publicKey.export({ format: 'der', type: 'spki' });
  const webhookKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'system',
      developerId: null,
      agentId: null,
      merchantId: null,
      publicKey: webhookPublic.subarray(-32),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const webhookSigner = new Ed25519WebhookSigner(
    `key_${webhookKey.id}`,
    webhookPrivate.toString('base64'),
  );
  const transport = new VerifyingTransport(webhookSigner);
  const delivered = await new WebhookDispatcher(database, webhookSigner, transport, {
    now: () => now,
  }).claimAndDeliver('gate-p7-worker', 100);
  assert.equal(delivered.length, 4);
  assert.equal(
    delivered.every(({ status }) => status === 'delivered'),
    true,
  );
  assert.equal(transport.requests.length, 4);
  assert.deepEqual(
    transport.requests
      .map(({ body: requestBody }) => JSON.parse(requestBody.toString('utf8')).eventType)
      .sort(),
    [
      'transaction.delivery_failed',
      'transaction.delivery_started',
      'transaction.paid',
      'transaction.refunded',
    ],
  );

  const finalState = await database
    .selectFrom('transactions')
    .innerJoin('paymentAttempts', 'paymentAttempts.transactionId', 'transactions.id')
    .innerJoin('paymentProofs', 'paymentProofs.transactionId', 'transactions.id')
    .innerJoin('deliveries', 'deliveries.transactionId', 'transactions.id')
    .innerJoin('refunds', 'refunds.transactionId', 'transactions.id')
    .select([
      'transactions.status as transactionStatus',
      'paymentAttempts.status as paymentStatus',
      'paymentProofs.status as proofStatus',
      'deliveries.status as deliveryStatus',
      'refunds.status as refundStatus',
    ])
    .where('transactions.id', '=', paymentTransaction.id)
    .executeTakeFirstOrThrow();
  assert.deepEqual(finalState, {
    transactionStatus: 'refunded',
    paymentStatus: 'succeeded',
    proofStatus: 'consumed',
    deliveryStatus: 'failed',
    refundStatus: 'succeeded',
  });
  const timeline = await new TransactionTimelineService(database).get(
    `dev_${developer.id}`,
    transactionId,
  );
  assert.equal(timeline.transaction.status, 'refunded');
  assert.deepEqual([...new Set(timeline.events.map(({ phase }) => phase))].sort(), [
    'authorization',
    'delivery',
    'notification',
    'payment',
    'quote',
    'refund',
    'transaction',
  ]);
  assert.equal(
    timeline.events.some(({ eventType }) => eventType === 'refund.provider_call'),
    true,
  );
  assert.equal(
    Number(
      (
        await database
          .selectFrom('refundProviderCalls')
          .select(({ fn }) => fn.countAll().as('count'))
          .executeTakeFirstOrThrow()
      ).count,
    ),
    1,
  );
});
