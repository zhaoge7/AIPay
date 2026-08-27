import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';

import {
  QUOTE_SIGNATURE_DOMAIN,
  canonicalizeQuoteSigningPayload,
  getQuoteSigningPayload,
  parseQuote,
  parseResourceId,
} from '@aipay/contracts';
import { createDatabase } from '@aipay/database';
import { FakePaymentProvider } from '@aipay/payment';
import { WebhookDispatcher } from '@aipay/worker/dist/webhooks/dispatcher.js';
import { Ed25519WebhookSigner } from '@aipay/worker/dist/webhooks/signing.js';
import { v7 as uuidv7 } from 'uuid';

import { MandateIssuer, MandateVerifier } from '../dist/mandates/issuer.js';
import { MandateDraftService } from '../dist/mandates/service.js';
import { PaymentExecutionError, PaymentExecutionService } from '../dist/payments/execution.js';
import { QuoteDraftService } from '../dist/quotes/drafts.js';
import { QuoteSigningService } from '../dist/quotes/signing.js';
import { TransactionCreationService } from '../dist/transactions/create.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

function quoteSigningWire(draft, keyId, signatureValue = 'A'.repeat(86)) {
  return {
    schemaVersion: '1',
    quoteId: draft.quoteId,
    merchantId: draft.merchantId,
    serviceId: draft.serviceId,
    unit: draft.unit,
    quantity: draft.quantity,
    unitPrice: draft.unitPrice,
    subtotal: draft.subtotal,
    taxBehavior: draft.taxBehavior,
    taxAmount: draft.taxAmount,
    total: draft.total,
    issuedAt: draft.issuedAt,
    expiresAt: draft.expiresAt,
    proof: { scheme: 'aipay-jcs-ed25519-v1', keyId, value: signatureValue },
  };
}

function signQuoteDraft(draft, keyId, privateKey) {
  const placeholder = parseQuote(quoteSigningWire(draft, keyId));
  const canonical = canonicalizeQuoteSigningPayload(getQuoteSigningPayload(placeholder));
  return sign(
    null,
    Buffer.concat([Buffer.from(QUOTE_SIGNATURE_DOMAIN, 'utf8'), Buffer.from(canonical, 'utf8')]),
    privateKey,
  ).toString('base64url');
}

class VerifyingTransport {
  constructor(signer) {
    this.signer = signer;
    this.requests = [];
  }

  async deliver(request) {
    this.requests.push(request);
    const signature = /^ed25519=:([A-Za-z0-9_-]+):$/u.exec(request.headers['x-aipay-signature']);
    assert.notEqual(signature, null);
    assert.equal(
      this.signer.verify(
        request.headers['x-aipay-event-id'],
        request.headers['x-aipay-timestamp'],
        request.body,
        signature[1],
      ),
      true,
    );
    return Object.freeze({ statusCode: 204 });
  }
}

test('passes Gate P5 through authorization, signed Quote, Fake payment and Webhook', async (context) => {
  const container = {
    name: `aipay-gate-p5-${process.pid}`,
    database: 'aipay_gate_p5_test',
    user: 'aipay',
    password: 'gate-p5-only',
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
      email: 'gate-p5@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Gate P5 Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'Gate P5 Merchant',
      callbackUrl: 'https://gate-p5-merchant.example.com/webhook',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const catalogService = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Gate P5 Weather API',
      category: 'data.weather',
      unit: 'request',
      unitPriceAmountMinor: '250',
      refundPolicy: 'full_on_delivery_failure',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const developerId = parseResourceId(`dev_${developer.id}`, 'dev');
  const agentId = parseResourceId(`agt_${agent.id}`, 'agt');
  const merchantId = parseResourceId(`mch_${merchant.id}`, 'mch');
  const serviceId = parseResourceId(`svc_${catalogService.id}`, 'svc');

  const issuerKeys = generateKeyPairSync('ed25519');
  const issuerPrivate = issuerKeys.privateKey.export({ format: 'der', type: 'pkcs8' });
  const issuer = new MandateIssuer(database, {
    keyId: `key_${uuidv7()}`,
    privateKeyPkcs8Base64: issuerPrivate.toString('base64'),
  });
  const mandateDraft = await new MandateDraftService(database).create(developerId, {
    agentId,
    purpose: 'Buy two signed weather API calls',
    allowedMerchantIds: [merchantId],
    allowedCategories: ['data.weather'],
    maxPerTransaction: { currency: 'CNY', amountMinor: '1000' },
    totalBudget: { currency: 'CNY', amountMinor: '5000' },
    approvalRequiredAbove: { currency: 'CNY', amountMinor: '1000' },
    maxTransactions: 10,
    validUntil: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    instructionHash: `sha256:${createHash('sha256').update('gate-p5').digest('hex')}`,
  });
  const mandate = await issuer.issue(developerId, mandateDraft.mandateId);
  assert.equal((await new MandateVerifier(database).verify(mandate)).mandateId, mandate.mandateId);

  const merchantKeys = generateKeyPairSync('ed25519');
  const merchantPublic = merchantKeys.publicKey.export({ format: 'der', type: 'spki' });
  const quoteSigning = new QuoteSigningService(database);
  const merchantSigningKey = await quoteSigning.registerMerchantKey(
    developerId,
    merchantId,
    merchantPublic.subarray(-32).toString('base64url'),
  );
  const quoteDraft = await new QuoteDraftService(database).create(developerId, merchantId, {
    serviceId,
    quantity: 2,
    taxBehavior: 'inclusive',
    taxAmount: { currency: 'CNY', amountMinor: '0' },
    expiresInSeconds: 300,
  });
  const quoteSignature = signQuoteDraft(
    quoteDraft,
    merchantSigningKey.keyId,
    merchantKeys.privateKey,
  );
  const quote = await quoteSigning.activate(
    developerId,
    quoteDraft.quoteId,
    merchantSigningKey.keyId,
    quoteSignature,
  );
  assert.equal((await quoteSigning.verify(quote)).quoteId, quoteDraft.quoteId);
  assert.deepEqual(quote.total, { currency: 'CNY', amountMinor: '500' });

  const transactionCreation = new TransactionCreationService(database);
  const paymentTransaction = await transactionCreation.create(
    agentId,
    quoteDraft.quoteId,
    mandateDraft.mandateId,
    'gate-p5-transaction-key',
  );
  assert.equal(paymentTransaction.status, 'authorized');
  const provider = new FakePaymentProvider({ webhookSecret: 'gate-p5-fake-provider-secret' });
  provider.enqueuePaymentOutcome('succeeded');
  const payment = await new PaymentExecutionService(
    database,
    'https://aipay.example.com/provider-webhooks/fake',
  ).create(paymentTransaction.transactionId, provider);
  assert.equal(payment.status, 'succeeded');

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
  const dispatcher = new WebhookDispatcher(database, webhookSigner, transport);
  const delivered = await dispatcher.claimAndDeliver('gate-p5-worker', 10);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].status, 'delivered');
  assert.equal(transport.requests.length, 1);
  assert.equal(transport.requests[0].url, 'https://gate-p5-merchant.example.com/webhook');
  const notification = JSON.parse(transport.requests[0].body.toString('utf8'));
  assert.equal(notification.eventType, 'transaction.paid');
  assert.equal(notification.aggregateId, paymentTransaction.transactionId.slice(4));
  assert.deepEqual(notification.data, {
    merchantId,
    transactionId: paymentTransaction.transactionId,
    paymentAttemptId: payment.paymentAttemptId,
    paymentStatus: 'succeeded',
    provider: 'fake',
    providerReference: payment.providerReference,
    errorCode: null,
  });

  const duplicateTransaction = await transactionCreation.create(
    agentId,
    quoteDraft.quoteId,
    mandateDraft.mandateId,
    'gate-p5-transaction-key',
  );
  assert.equal(duplicateTransaction.transactionId, paymentTransaction.transactionId);
  assert.equal(duplicateTransaction.status, 'paid');
  await assert.rejects(
    new PaymentExecutionService(
      database,
      'https://aipay.example.com/provider-webhooks/fake',
    ).create(paymentTransaction.transactionId, provider),
    (error) => error instanceof PaymentExecutionError && error.code === 'invalid_state',
  );
  assert.equal((await dispatcher.claimAndDeliver('gate-p5-idle', 10)).length, 0);
  assert.equal(transport.requests.length, 1);

  const state = await database
    .selectFrom('transactions')
    .innerJoin('paymentAttempts', 'paymentAttempts.transactionId', 'transactions.id')
    .innerJoin('outboxEvents', 'outboxEvents.aggregateId', 'transactions.id')
    .innerJoin('webhookDeliveries', 'webhookDeliveries.outboxEventId', 'outboxEvents.id')
    .select([
      'transactions.status as transactionStatus',
      'paymentAttempts.status as paymentStatus',
      'outboxEvents.status as outboxStatus',
      'webhookDeliveries.status as webhookStatus',
      'webhookDeliveries.attemptCount as webhookAttempts',
    ])
    .where('transactions.id', '=', paymentTransaction.transactionId.slice(4))
    .executeTakeFirstOrThrow();
  assert.deepEqual(state, {
    transactionStatus: 'paid',
    paymentStatus: 'succeeded',
    outboxStatus: 'published',
    webhookStatus: 'delivered',
    webhookAttempts: 1,
  });
});
