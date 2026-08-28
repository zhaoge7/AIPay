import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

import {
  ContractValidationError,
  getApiProblemJsonSchema,
  getAuditEventJsonSchema,
  getDeliveryReceiptJsonSchema,
  getMandateJsonSchema,
  getPaymentProofJsonSchema,
  getQuoteJsonSchema,
  getTransactionJsonSchema,
  parseApiProblem,
  parseAuditEvent,
  parseDeliveryReceipt,
  parseMandate,
  parsePaymentProof,
  parseQuote,
  parseTransaction,
  toAuditEventWire,
  toDeliveryReceiptWire,
  toMandateWire,
  toPaymentProofWire,
  toQuoteWire,
  toTransactionWire,
} from '../dist/index.js';

const fixtureDirectory = new URL('./fixtures/v1/', import.meta.url);

async function readFixture(name) {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), 'utf8'));
}

const versionedContracts = [
  ['delivery-receipt.json', parseDeliveryReceipt, toDeliveryReceiptWire],
  ['mandate.json', parseMandate, toMandateWire],
  ['quote.json', parseQuote, toQuoteWire],
  ['payment-proof.json', parsePaymentProof, toPaymentProofWire],
  ['transaction.json', parseTransaction, toTransactionWire],
  ['audit-event.json', parseAuditEvent, toAuditEventWire],
];

test('round-trips every V1 Contract fixture through domain values without loss', async () => {
  for (const [filename, parse, toWire] of versionedContracts) {
    const fixture = await readFixture(filename);
    const domain = parse(fixture);
    const wire = toWire(domain);
    const jsonRoundTrip = JSON.parse(JSON.stringify(wire));

    assert.deepEqual(wire, fixture, filename);
    assert.deepEqual(jsonRoundTrip, fixture, filename);
    assert.deepEqual(toWire(parse(jsonRoundTrip)), fixture, filename);
    assert.equal(Object.isFrozen(wire), true, filename);
  }
});

test('keeps the RFC 9457 API Problem fixture machine-readable', async () => {
  const fixture = await readFixture('api-problem.json');
  const problem = parseApiProblem(JSON.parse(JSON.stringify(fixture)));

  assert.deepEqual(problem, fixture);
  assert.equal(problem.code, 'SERVICE_UNAVAILABLE');
  assert.equal(problem.kind, 'system');
  assert.equal(problem.retryable, true);
});

test('rejects unknown Contract versions instead of accepting future semantics', async () => {
  for (const [filename, parse] of versionedContracts) {
    const fixture = await readFixture(filename);
    fixture.schemaVersion = '2';

    assert.throws(
      () => parse(fixture),
      (error) => {
        assert.equal(error instanceof ContractValidationError, true, filename);
        assert.equal(
          error.issues.some(
            (issue) => issue.code === 'invalid_value' && issue.path === '/schemaVersion',
          ),
          true,
          filename,
        );
        return true;
      },
    );
  }
});

test('matches the reviewed V1 JSON Schema fingerprints', () => {
  const schemas = {
    deliveryReceipt: getDeliveryReceiptJsonSchema(),
    mandate: getMandateJsonSchema(),
    quote: getQuoteJsonSchema(),
    paymentProof: getPaymentProofJsonSchema(),
    transaction: getTransactionJsonSchema(),
    auditEvent: getAuditEventJsonSchema(),
    apiProblem: getApiProblemJsonSchema(),
  };
  const expected = {
    deliveryReceipt: '40cb52ab18c8998aa304605d185f54a569f3b8a9d929701e2257e5d7a7643713',
    mandate: '47261c88ffd7589f15eb1f079caf25772c41895bac6f5b89349eb7e5f50afe10',
    quote: '42a18dc34c921e6f683b997f13a85b0a65f452cbd6d71210833814489835f74a',
    paymentProof: '3a82bc59027c4ae468d03b32f90cac5f556a3d40f467aca2cf5f23ad1f9c9d09',
    transaction: 'd1a1c9b2f7baada6aed4427fdb6b099556a656874f93459821ba210cdd34449d',
    auditEvent: '4b19011f626d4f7403bc2bd4b3ee5c19be672bef407d2b8db23c28ad72ac95af',
    apiProblem: '62b15729ef1d0a39597825ddb3eef69df2b361985b5794d27b0e94d7912fda78',
  };

  for (const [name, schema] of Object.entries(schemas)) {
    const fingerprint = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
    assert.equal(fingerprint, expected[name], name);
  }
});
