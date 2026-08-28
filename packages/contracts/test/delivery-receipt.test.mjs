import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContractValidationError,
  DELIVERY_RECEIPT_SIGNATURE_DOMAIN,
  DeliveryReceiptWireSchema,
  canonicalizeDeliveryReceiptSigningPayload,
  getDeliveryReceiptJsonSchema,
  getDeliveryReceiptSigningPayload,
  parseDeliveryReceipt,
  toDeliveryReceiptWire,
} from '../dist/index.js';

const ids = Object.freeze({
  delivery: '01890f3e-9b90-7cc2-98c5-7f6a1b2c3d4e',
  transaction: '01890f3e-9b91-7cc2-a8c5-7f6a1b2c3d4e',
  paymentProof: '01890f3e-9b92-7cc2-b8c5-7f6a1b2c3d4e',
  merchant: '01890f3e-9b93-7cc2-88c5-7f6a1b2c3d4e',
  service: '01890f3e-9b94-7cc2-98c5-7f6a1b2c3d4e',
  key: '01890f3e-9b95-7cc2-a8c5-7f6a1b2c3d4e',
});

function validReceipt() {
  return {
    schemaVersion: '1',
    deliveryId: `dlv_${ids.delivery}`,
    transactionId: `txn_${ids.transaction}`,
    paymentProofId: `ppf_${ids.paymentProof}`,
    merchantId: `mch_${ids.merchant}`,
    serviceId: `svc_${ids.service}`,
    status: 'succeeded',
    resultDigest: `sha256:${'a'.repeat(64)}`,
    deliveredAt: '2026-08-28T09:10:00.000Z',
    errorCode: null,
    proof: {
      scheme: 'aipay-jcs-ed25519-v1',
      keyId: `key_${ids.key}`,
      value: 'A'.repeat(86),
    },
  };
}

function assertIssue(value, expected) {
  assert.throws(
    () => parseDeliveryReceipt(value),
    (error) =>
      error instanceof ContractValidationError &&
      error.issues.some(({ code, path }) => code === expected.code && path === expected.path),
  );
}

test('parses success and failure Delivery Receipts into immutable values', () => {
  const receipt = parseDeliveryReceipt(validReceipt());
  assert.equal(receipt.status, 'succeeded');
  assert.equal(receipt.errorCode, null);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.proof), true);
  assert.deepEqual(toDeliveryReceiptWire(receipt), validReceipt());

  const failed = validReceipt();
  failed.status = 'failed';
  failed.errorCode = 'UPSTREAM_DELIVERY_FAILED';
  const parsedFailure = parseDeliveryReceipt(failed);
  assert.equal(parsedFailure.status, 'failed');
  assert.equal(parsedFailure.errorCode, 'UPSTREAM_DELIVERY_FAILED');
});

test('builds a deterministic signing payload without proof.value', () => {
  const receipt = parseDeliveryReceipt(validReceipt());
  const payload = getDeliveryReceiptSigningPayload(receipt);
  const canonical = canonicalizeDeliveryReceiptSigningPayload(payload);

  assert.equal(DELIVERY_RECEIPT_SIGNATURE_DOMAIN, 'AIPAY-DELIVERY-RECEIPT-V1\0');
  assert.equal('value' in payload.proof, false);
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(Object.isFrozen(payload.proof), true);
  assert.equal(
    canonical,
    canonicalizeDeliveryReceiptSigningPayload(
      getDeliveryReceiptSigningPayload(parseDeliveryReceipt(validReceipt())),
    ),
  );
  assert.match(canonical, /^\{"deliveredAt":/u);
});

test('requires errorCode exactly for failed delivery', () => {
  assertIssue(
    { ...validReceipt(), errorCode: 'UNEXPECTED_ERROR' },
    { code: 'invalid_result_code', path: '/errorCode' },
  );
  assertIssue(
    { ...validReceipt(), status: 'failed', errorCode: null },
    { code: 'invalid_result_code', path: '/errorCode' },
  );
});

test('rejects resource substitution, malformed digest/time/signature and unknown fields', () => {
  assertIssue({ ...validReceipt(), unexpected: true }, { code: 'unknown_field', path: '/' });

  for (const [field, value, path] of [
    ['deliveryId', `txn_${ids.delivery}`, '/deliveryId'],
    ['transactionId', `dlv_${ids.transaction}`, '/transactionId'],
    ['paymentProofId', `pat_${ids.paymentProof}`, '/paymentProofId'],
    ['merchantId', `svc_${ids.merchant}`, '/merchantId'],
    ['serviceId', `mch_${ids.service}`, '/serviceId'],
    ['resultDigest', `sha256:${'A'.repeat(64)}`, '/resultDigest'],
    ['deliveredAt', '2026-02-29T09:10:00.000Z', '/deliveredAt'],
  ]) {
    assertIssue({ ...validReceipt(), [field]: value }, { code: 'invalid_format', path });
  }

  const badSignature = validReceipt();
  badSignature.proof.value = `${'A'.repeat(85)}B`;
  assertIssue(badSignature, { code: 'invalid_format', path: '/proof/value' });
});

test('does not echo rejected Delivery Receipt input', () => {
  const secret = 'PRIVATE_DELIVERY_RECEIPT';

  assert.throws(
    () => parseDeliveryReceipt({ ...validReceipt(), deliveryId: secret }),
    (error) =>
      error instanceof ContractValidationError &&
      !error.message.includes(secret) &&
      !JSON.stringify(error.issues).includes(secret),
  );
});

test('exports a strict Draft 2020-12 Delivery Receipt schema', () => {
  const schema = getDeliveryReceiptJsonSchema();

  assert.equal(DeliveryReceiptWireSchema.safeParse(validReceipt()).success, true);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.proof.additionalProperties, false);
  assert.deepEqual(schema.properties.status.enum, ['succeeded', 'failed']);
  assert.deepEqual(schema.required, [
    'schemaVersion',
    'deliveryId',
    'transactionId',
    'paymentProofId',
    'merchantId',
    'serviceId',
    'status',
    'resultDigest',
    'deliveredAt',
    'errorCode',
    'proof',
  ]);
});
