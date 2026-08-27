import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, sign } from 'node:crypto';
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

import { buildApp } from '../dist/app.js';
import { QuoteDraftService } from '../dist/quotes/drafts.js';
import { QuoteSigningError, QuoteSigningService } from '../dist/quotes/signing.js';
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

function signingWire(draft, keyId, signatureValue = 'A'.repeat(86)) {
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

function signDraft(draft, keyId, privateKey) {
  const placeholder = parseQuote(signingWire(draft, keyId));
  const canonical = canonicalizeQuoteSigningPayload(getQuoteSigningPayload(placeholder));
  const bytes = Buffer.concat([
    Buffer.from(QUOTE_SIGNATURE_DOMAIN, 'utf8'),
    Buffer.from(canonical, 'utf8'),
  ]);
  return sign(null, bytes, privateKey).toString('base64url');
}

async function register(app, email) {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, password },
  });
  return cookie(response);
}

test('activates and verifies merchant JCS Ed25519 Quotes and rejects tampering', async (context) => {
  const container = {
    name: `aipay-quote-signing-test-${process.pid}`,
    database: 'aipay_quote_signing_test',
    user: 'aipay',
    password: 'quote-signing-test-only',
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
  database = createDatabase(databaseUrl, { maxConnections: 4 });
  app = await buildApp({ database });
  const owner = await register(app, 'quote-signing-owner@example.com');
  const other = await register(app, 'quote-signing-other@example.com');
  const merchantResponse = await app.inject({
    method: 'POST',
    url: '/v1/merchants',
    headers: { cookie: owner },
    payload: {
      name: 'Signing Merchant',
      callbackUrl: 'https://signing-merchant.example.com/webhook',
    },
  });
  const merchant = body(merchantResponse).data;
  const serviceResponse = await app.inject({
    method: 'POST',
    url: `/v1/merchants/${merchant.merchantId}/services`,
    headers: { cookie: owner },
    payload: {
      type: 'api',
      name: 'Signed Quote API',
      category: 'data.signed',
      unit: 'request',
      unitPrice: { currency: 'CNY', amountMinor: '200' },
      refundPolicy: 'full_on_delivery_failure',
    },
  });
  const service = body(serviceResponse).data;
  const keys = generateKeyPairSync('ed25519');
  const publicDer = keys.publicKey.export({ type: 'spki', format: 'der' });
  const publicKey = Buffer.from(publicDer).subarray(-32).toString('base64url');
  const keyResponse = await app.inject({
    method: 'POST',
    url: `/v1/merchants/${merchant.merchantId}/signing-key`,
    headers: { cookie: owner },
    payload: { publicKey },
  });
  assert.equal(keyResponse.statusCode, 201);
  const signingKey = body(keyResponse).data;
  assert.equal(signingKey.merchantId, merchant.merchantId);
  assert.equal(signingKey.publicKey, publicKey);

  const draftResponse = await app.inject({
    method: 'POST',
    url: `/v1/merchants/${merchant.merchantId}/quotes`,
    headers: { cookie: owner },
    payload: {
      serviceId: service.serviceId,
      quantity: 3,
      taxBehavior: 'inclusive',
      taxAmount: { currency: 'CNY', amountMinor: '34' },
      expiresInSeconds: 300,
    },
  });
  const draft = body(draftResponse).data;
  const signature = signDraft(draft, signingKey.keyId, keys.privateKey);
  const activation = await app.inject({
    method: 'POST',
    url: `/v1/quotes/${draft.quoteId}/activate`,
    headers: { cookie: owner },
    payload: { keyId: signingKey.keyId, signature },
  });
  assert.equal(activation.statusCode, 200);
  const wire = body(activation).data;
  assert.equal(wire.proof.value, signature);
  assert.equal(wire.proof.keyId, signingKey.keyId);
  assert.equal(parseQuote(wire).quoteId, draft.quoteId);
  const repeated = await app.inject({
    method: 'POST',
    url: `/v1/quotes/${draft.quoteId}/activate`,
    headers: { cookie: owner },
    payload: { keyId: signingKey.keyId, signature },
  });
  assert.deepEqual(body(repeated).data, wire);

  const verified = await app.inject({
    method: 'POST',
    url: '/v1/quotes/verify',
    payload: wire,
  });
  assert.equal(verified.statusCode, 200);
  assert.deepEqual(body(verified).data, {
    valid: true,
    quoteId: draft.quoteId,
    keyId: signingKey.keyId,
  });

  const stored = await database
    .selectFrom('quotes')
    .select(['status', 'proofKeyId', 'proofValue'])
    .where('id', '=', draft.quoteId.slice(4))
    .executeTakeFirstOrThrow();
  assert.equal(stored.status, 'active');
  assert.equal(stored.proofValue?.byteLength, 64);
  const storedKey = await database
    .selectFrom('signingKeys')
    .select(['ownerType', 'merchantId', 'publicKey'])
    .where('id', '=', stored.proofKeyId)
    .executeTakeFirstOrThrow();
  assert.equal(storedKey.ownerType, 'merchant');
  assert.equal(storedKey.merchantId, merchant.merchantId.slice(4));
  assert.equal(storedKey.publicKey.byteLength, 32);
  assert.equal('privateKey' in storedKey, false);

  const alternateServiceId = 'svc_01890f3e-a100-7cc2-98c5-7f6a1b2c3d4e';
  const alternateMerchantId = 'mch_01890f3e-a101-7cc2-a8c5-7f6a1b2c3d4e';
  const tampered = [
    {
      ...wire,
      unitPrice: { currency: 'CNY', amountMinor: '201' },
      subtotal: { currency: 'CNY', amountMinor: '603' },
      total: { currency: 'CNY', amountMinor: '603' },
    },
    { ...wire, serviceId: alternateServiceId },
    { ...wire, merchantId: alternateMerchantId },
    {
      ...wire,
      proof: {
        ...wire.proof,
        value: `${wire.proof.value[0] === 'A' ? 'B' : 'A'}${wire.proof.value.slice(1)}`,
      },
    },
  ];

  for (const changed of tampered) {
    const rejected = await app.inject({
      method: 'POST',
      url: '/v1/quotes/verify',
      payload: changed,
    });
    assert.equal(rejected.statusCode, 401);
    assert.equal(body(rejected).code, 'SIGNATURE_INVALID');
  }

  const invalidDraftResponse = await app.inject({
    method: 'POST',
    url: `/v1/merchants/${merchant.merchantId}/quotes`,
    headers: { cookie: owner },
    payload: {
      serviceId: service.serviceId,
      quantity: 1,
      taxBehavior: 'inclusive',
      taxAmount: { currency: 'CNY', amountMinor: '0' },
      expiresInSeconds: 300,
    },
  });
  const invalidDraft = body(invalidDraftResponse).data;
  const badActivation = await app.inject({
    method: 'POST',
    url: `/v1/quotes/${invalidDraft.quoteId}/activate`,
    headers: { cookie: owner },
    payload: { keyId: signingKey.keyId, signature: 'A'.repeat(86) },
  });
  assert.equal(badActivation.statusCode, 401);
  const invalidStored = await database
    .selectFrom('quotes')
    .select('status')
    .where('id', '=', invalidDraft.quoteId.slice(4))
    .executeTakeFirstOrThrow();
  assert.equal(invalidStored.status, 'draft');

  const crossActivation = await app.inject({
    method: 'POST',
    url: `/v1/quotes/${invalidDraft.quoteId}/activate`,
    headers: { cookie: other },
    payload: { keyId: signingKey.keyId, signature: 'A'.repeat(86) },
  });
  assert.equal(crossActivation.statusCode, 403);

  const expiredDraftService = new QuoteDraftService(database);
  const expiredDraft = await expiredDraftService.create(
    parseResourceId(
      body(
        await app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          payload: { email: 'quote-signing-owner@example.com', password },
        }),
      ).data.developerId,
      'dev',
    ),
    parseResourceId(merchant.merchantId, 'mch'),
    {
      serviceId: service.serviceId,
      quantity: 1,
      taxBehavior: 'inclusive',
      taxAmount: { currency: 'CNY', amountMinor: '0' },
      expiresInSeconds: 30,
    },
  );
  const futureSigning = new QuoteSigningService(
    database,
    () => new Date(Date.parse(expiredDraft.expiresAt)),
  );
  await assert.rejects(
    futureSigning.activate(
      parseResourceId(
        body(
          await app.inject({
            method: 'POST',
            url: '/v1/auth/login',
            payload: { email: 'quote-signing-owner@example.com', password },
          }),
        ).data.developerId,
        'dev',
      ),
      parseResourceId(expiredDraft.quoteId, 'qte'),
      parseResourceId(signingKey.keyId, 'key'),
      'A'.repeat(86),
    ),
    (error) => error instanceof QuoteSigningError && error.code === 'expired',
  );
  const expiredStored = await database
    .selectFrom('quotes')
    .select('status')
    .where('id', '=', expiredDraft.quoteId.slice(4))
    .executeTakeFirstOrThrow();
  assert.equal(expiredStored.status, 'expired');
});
