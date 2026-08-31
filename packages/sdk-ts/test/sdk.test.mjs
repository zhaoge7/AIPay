/* global Request, Response */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, verify, webcrypto } from 'node:crypto';
import test from 'node:test';

import {
  QUOTE_SIGNATURE_DOMAIN,
  canonicalizeQuoteSigningPayload,
  getQuoteSigningPayload,
  parseQuote,
} from '@aipay/contracts';
import { createWebCryptoVerifier, verifySignature } from '@peac/http-signatures';

import {
  AgentClient,
  MerchantClient,
  createPaymentRequirement,
  decodePaymentRequirement,
  encodePaymentRequirement,
} from '../dist/index.js';

const ids = {
  agent: 'agt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4e',
  key: 'key_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4f',
  merchant: 'mch_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d50',
  service: 'svc_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d51',
  quote: 'qte_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d52',
  transaction: 'txn_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d53',
  paymentAttempt: 'pat_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d54',
  paymentProof: 'ppf_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d55',
  delivery: 'dlv_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d56',
};

function keyPair() {
  const pair = generateKeyPairSync('ed25519');
  return {
    ...pair,
    privateBase64: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

function quote(signature = 'A'.repeat(86)) {
  return {
    schemaVersion: '1',
    quoteId: ids.quote,
    merchantId: ids.merchant,
    serviceId: ids.service,
    unit: 'request',
    quantity: 1,
    unitPrice: { currency: 'CNY', amountMinor: '10' },
    subtotal: { currency: 'CNY', amountMinor: '10' },
    taxBehavior: 'inclusive',
    taxAmount: { currency: 'CNY', amountMinor: '0' },
    total: { currency: 'CNY', amountMinor: '10' },
    issuedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-08-29T00:05:00.000Z',
    proof: { scheme: 'aipay-jcs-ed25519-v1', keyId: ids.key, value: signature },
  };
}

function paymentProof() {
  return {
    schemaVersion: '1',
    paymentProofId: ids.paymentProof,
    transactionId: ids.transaction,
    paymentAttemptId: ids.paymentAttempt,
    merchantId: ids.merchant,
    serviceId: ids.service,
    amount: { currency: 'CNY', amountMinor: '10' },
    issuedAt: '2026-08-29T00:00:00.000Z',
    expiresAt: '2026-08-29T00:05:00.000Z',
    proof: { scheme: 'aipay-jcs-ed25519-v1', keyId: ids.key, value: 'A'.repeat(86) },
  };
}

test('round-trips a resource-bound Payment-Needed header', () => {
  const requirement = createPaymentRequirement({
    quote: quote(),
    resourceUrl: 'https://merchant.example/paid/weather?city=hz',
  });
  const decoded = decodePaymentRequirement(encodePaymentRequirement(requirement));
  assert.deepEqual(decoded, requirement);
  assert.equal(decoded.resource.method, 'GET');
});

test('AgentClient signs catalog requests with the frozen RFC 9421 profile', async () => {
  const pair = keyPair();
  const publicKey = await webcrypto.subtle.importKey(
    'raw',
    pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32),
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const client = new AgentClient({
    baseUrl: 'http://127.0.0.1:3000',
    agentId: ids.agent,
    keyId: ids.key,
    privateKeyPkcs8Base64: pair.privateBase64,
    now: () => new Date('2026-08-29T00:00:00.000Z'),
    randomBytes: () => Buffer.alloc(16, 7),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const headers = Object.fromEntries(request.headers.entries());
      const result = await verifySignature(
        { method: request.method, url: request.url, headers, body: '' },
        {
          now: Math.floor(Date.parse('2026-08-29T00:00:00.000Z') / 1_000),
          label: 'aipay',
          keyResolver: async (keyId) =>
            keyId === ids.key ? createWebCryptoVerifier(publicKey) : null,
        },
      );
      assert.equal(result.valid, true);
      assert.equal(headers['x-aipay-agent-id'], ids.agent);
      return Response.json({
        data: { items: [], nextCursor: null },
        meta: { traceId: '1'.repeat(32) },
      });
    },
  });

  assert.deepEqual(await client.discoverServices({ type: 'api' }), {
    items: [],
    nextCursor: null,
  });
});

test('MerchantClient creates and signs a Quote without exposing its private key', async () => {
  const pair = keyPair();
  let call = 0;
  const client = new MerchantClient({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'apk_test.secret',
    merchantId: ids.merchant,
    keyId: ids.key,
    privateKeyPkcs8Base64: pair.privateBase64,
    fetch: async (input, init) => {
      call += 1;
      const request = new Request(input, init);
      assert.equal(request.headers.get('authorization'), 'Bearer apk_test.secret');

      if (call === 1) {
        return Response.json({ data: { ...quote(), status: 'draft', proof: undefined } });
      }

      const activation = await request.json();
      const signedQuote = parseQuote(quote(activation.signature));
      const bytes = Buffer.concat([
        Buffer.from(QUOTE_SIGNATURE_DOMAIN),
        Buffer.from(canonicalizeQuoteSigningPayload(getQuoteSigningPayload(signedQuote))),
      ]);
      assert.equal(
        verify(null, bytes, pair.publicKey, Buffer.from(activation.signature, 'base64url')),
        true,
      );
      return Response.json({ data: quote(activation.signature) });
    },
  });

  const payment = await client.createPaymentRequirement({
    serviceId: ids.service,
    resourceUrl: 'https://merchant.example/paid/weather',
  });
  assert.equal(payment.requirement.quote.quoteId, ids.quote);
  assert.equal(call, 2);
});

test('MerchantClient recovers the original Delivery after a consumed-Proof crash window', async () => {
  const pair = keyPair();
  const recovered = {
    paymentProofId: ids.paymentProof,
    deliveryId: ids.delivery,
    consumedAt: '2026-08-29T00:01:00.000Z',
  };
  const client = new MerchantClient({
    baseUrl: 'http://127.0.0.1:3000',
    apiKey: 'apk_test.secret',
    merchantId: ids.merchant,
    keyId: ids.key,
    privateKeyPkcs8Base64: pair.privateBase64,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      assert.equal(
        request.url,
        `http://127.0.0.1:3000/v1/merchants/${ids.merchant}/payment-proofs/recover`,
      );
      assert.equal(request.headers.get('authorization'), 'Bearer apk_test.secret');
      assert.deepEqual(await request.json(), { paymentProof: paymentProof() });
      return Response.json({ data: recovered });
    },
  });

  assert.deepEqual(await client.recoverPaymentProofConsumption(paymentProof()), recovered);
});
