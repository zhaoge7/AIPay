import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContractValidationError,
  MAX_PAYMENT_PROOF_VALIDITY_MS,
  PAYMENT_PROOF_SIGNATURE_DOMAIN,
  PaymentProofWireSchema,
  canonicalizePaymentProofSigningPayload,
  getPaymentProofJsonSchema,
  getPaymentProofSigningPayload,
  parsePaymentProof,
  toPaymentProofWire,
} from '../dist/index.js';

const ids = Object.freeze({
  proof: '01890f3e-9b80-7cc2-98c5-7f6a1b2c3d4e',
  transaction: '01890f3e-9b81-7cc2-a8c5-7f6a1b2c3d4e',
  attempt: '01890f3e-9b82-7cc2-b8c5-7f6a1b2c3d4e',
  merchant: '01890f3e-9b83-7cc2-88c5-7f6a1b2c3d4e',
  service: '01890f3e-9b84-7cc2-98c5-7f6a1b2c3d4e',
  key: '01890f3e-9b85-7cc2-a8c5-7f6a1b2c3d4e',
});

function validProof() {
  return {
    schemaVersion: '1',
    paymentProofId: `ppf_${ids.proof}`,
    transactionId: `txn_${ids.transaction}`,
    paymentAttemptId: `pat_${ids.attempt}`,
    merchantId: `mch_${ids.merchant}`,
    serviceId: `svc_${ids.service}`,
    amount: { currency: 'CNY', amountMinor: '600' },
    issuedAt: '2026-08-28T09:00:00.000Z',
    expiresAt: '2026-08-28T09:05:00.000Z',
    proof: {
      scheme: 'aipay-jcs-ed25519-v1',
      keyId: `key_${ids.key}`,
      value: 'A'.repeat(86),
    },
  };
}

function assertIssue(value, expected) {
  assert.throws(
    () => parsePaymentProof(value),
    (error) =>
      error instanceof ContractValidationError &&
      error.issues.some(({ code, path }) => code === expected.code && path === expected.path),
  );
}

test('parses and round-trips an immutable bound Payment Proof', () => {
  const proof = parsePaymentProof(validProof());
  const wire = toPaymentProofWire(proof);

  assert.equal(proof.paymentProofId, `ppf_${ids.proof}`);
  assert.equal(proof.transactionId, `txn_${ids.transaction}`);
  assert.equal(proof.paymentAttemptId, `pat_${ids.attempt}`);
  assert.equal(proof.merchantId, `mch_${ids.merchant}`);
  assert.equal(proof.serviceId, `svc_${ids.service}`);
  assert.equal(proof.amount.amountMinor, '600');
  assert.deepEqual(wire, validProof());
  assert.equal(Object.isFrozen(proof), true);
  assert.equal(Object.isFrozen(proof.amount), true);
  assert.equal(Object.isFrozen(proof.proof), true);
  assert.equal(Object.isFrozen(wire), true);
  assert.equal(Object.isFrozen(wire.amount), true);
});

test('creates a deterministic signing payload without the signature value', () => {
  const input = validProof();
  const proof = parsePaymentProof(input);
  const payload = getPaymentProofSigningPayload(proof);

  assert.equal(PAYMENT_PROOF_SIGNATURE_DOMAIN, 'AIPAY-PAYMENT-PROOF-V1\0');
  assert.equal(MAX_PAYMENT_PROOF_VALIDITY_MS, 15 * 60 * 1_000);
  assert.equal('value' in payload.proof, false);
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(Object.isFrozen(payload.amount), true);
  assert.equal(Object.isFrozen(payload.proof), true);
  const canonical = canonicalizePaymentProofSigningPayload(payload);
  const repeated = canonicalizePaymentProofSigningPayload(
    getPaymentProofSigningPayload(parsePaymentProof(validProof())),
  );
  assert.equal(canonical, repeated);
  assert.match(canonical, /^\{"amount":/u);

  input.amount.amountMinor = '1';
  input.proof.keyId = `key_${ids.proof}`;
  assert.equal(payload.amount.amountMinor, '600');
  assert.equal(payload.proof.keyId, `key_${ids.key}`);
});

test('rejects unknown fields, wrong resource types and malformed signatures', () => {
  assertIssue({ ...validProof(), unknown: true }, { code: 'unknown_field', path: '/' });
  const nested = validProof();
  nested.amount.unknown = true;
  assertIssue(nested, { code: 'unknown_field', path: '/amount' });

  for (const [field, value, path] of [
    ['paymentProofId', `txn_${ids.proof}`, '/paymentProofId'],
    ['transactionId', `mch_${ids.transaction}`, '/transactionId'],
    ['paymentAttemptId', `txn_${ids.attempt}`, '/paymentAttemptId'],
    ['merchantId', `svc_${ids.merchant}`, '/merchantId'],
    ['serviceId', `mch_${ids.service}`, '/serviceId'],
  ]) {
    assertIssue({ ...validProof(), [field]: value }, { code: 'invalid_format', path });
  }

  const badSignature = validProof();
  badSignature.proof.value = `${'A'.repeat(85)}B`;
  assertIssue(badSignature, { code: 'invalid_format', path: '/proof/value' });
});

test('rejects zero, overflowing and non-string amounts', () => {
  for (const [amountMinor, issue] of [
    ['0', { code: 'non_positive_total', path: '/amount' }],
    ['9223372036854775808', { code: 'out_of_range', path: '/amount' }],
    [600, { code: 'invalid_type', path: '/amount/amountMinor' }],
  ]) {
    const value = validProof();
    value.amount.amountMinor = amountMinor;
    assertIssue(value, issue);
  }
});

test('enforces a positive validity window of at most fifteen minutes', () => {
  for (const expiresAt of [
    '2026-08-28T09:00:00.000Z',
    '2026-08-28T08:59:59.999Z',
    '2026-08-28T09:15:00.001Z',
  ]) {
    assertIssue(
      { ...validProof(), expiresAt },
      { code: 'invalid_validity_window', path: '/expiresAt' },
    );
  }

  assert.equal(
    parsePaymentProof({ ...validProof(), expiresAt: '2026-08-28T09:15:00.000Z' }).expiresAt,
    '2026-08-28T09:15:00.000Z',
  );
  assertIssue(
    { ...validProof(), expiresAt: '2026-02-29T09:05:00.000Z' },
    { code: 'invalid_format', path: '/expiresAt' },
  );
});

test('does not echo rejected Payment Proof values', () => {
  const secret = 'PRIVATE_PAYMENT_PROOF_VALUE';
  const value = { ...validProof(), transactionId: secret };

  assert.throws(
    () => parsePaymentProof(value),
    (error) =>
      error instanceof ContractValidationError &&
      !error.message.includes(secret) &&
      !JSON.stringify(error.issues).includes(secret),
  );
});

test('exports a strict Draft 2020-12 Payment Proof schema', () => {
  const schema = getPaymentProofJsonSchema();

  assert.equal(PaymentProofWireSchema.safeParse(validProof()).success, true);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.amount.additionalProperties, false);
  assert.equal(schema.properties.proof.additionalProperties, false);
  assert.deepEqual(schema.required, [
    'schemaVersion',
    'paymentProofId',
    'transactionId',
    'paymentAttemptId',
    'merchantId',
    'serviceId',
    'amount',
    'issuedAt',
    'expiresAt',
    'proof',
  ]);
});
