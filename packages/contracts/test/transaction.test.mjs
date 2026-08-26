import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContractValidationError,
  getTransactionJsonSchema,
  parseTransaction,
  TransactionWireSchema,
  transactionStatuses,
} from '../dist/index.js';

const uuids = [
  '01890f3e-9b60-7cc2-98c5-7f6a1b2c3d4e',
  '01890f3e-9b61-7cc2-a8c5-7f6a1b2c3d4e',
  '01890f3e-9b62-7cc2-b8c5-7f6a1b2c3d4e',
  '01890f3e-9b63-7cc2-88c5-7f6a1b2c3d4e',
  '01890f3e-9b64-7cc2-98c5-7f6a1b2c3d4e',
  '01890f3e-9b65-7cc2-a8c5-7f6a1b2c3d4e',
  '01890f3e-9b66-7cc2-b8c5-7f6a1b2c3d4e',
  '01890f3e-9b67-7cc2-88c5-7f6a1b2c3d4e',
  '01890f3e-9b68-7cc2-98c5-7f6a1b2c3d4e',
  '01890f3e-9b69-7cc2-a8c5-7f6a1b2c3d4e',
  '01890f3e-9b6a-7cc2-b8c5-7f6a1b2c3d4e',
];

function createValidTransaction() {
  return {
    schemaVersion: '1',
    transactionId: `txn_${uuids[0]}`,
    quoteId: `qte_${uuids[1]}`,
    mandateId: `mdt_${uuids[2]}`,
    principalId: `dev_${uuids[3]}`,
    agentId: `agt_${uuids[4]}`,
    merchantId: `mch_${uuids[5]}`,
    serviceId: `svc_${uuids[6]}`,
    amount: { currency: 'CNY', amountMinor: '600' },
    status: 'delivery_pending',
    paymentAttemptIds: [`pat_${uuids[7]}`, `pat_${uuids[8]}`],
    deliveryId: `dlv_${uuids[9]}`,
    refundIds: [`rfd_${uuids[10]}`],
    createdAt: '2026-08-27T02:00:00.000Z',
    updatedAt: '2026-08-27T02:01:00.000Z',
  };
}

function assertContractError(callback, expectedIssue) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof ContractValidationError, true);
    assert.equal(
      error.issues.some(
        (issue) => issue.code === expectedIssue.code && issue.path === expectedIssue.path,
      ),
      true,
    );
    return true;
  });
}

test('parses all stable transaction and lifecycle references into immutable values', () => {
  const transaction = parseTransaction(createValidTransaction());

  assert.equal(transaction.transactionId, `txn_${uuids[0]}`);
  assert.equal(transaction.quoteId, `qte_${uuids[1]}`);
  assert.equal(transaction.mandateId, `mdt_${uuids[2]}`);
  assert.equal(transaction.paymentAttemptIds.length, 2);
  assert.equal(transaction.deliveryId, `dlv_${uuids[9]}`);
  assert.equal(transaction.refundIds[0], `rfd_${uuids[10]}`);
  assert.equal(Object.isFrozen(transaction), true);
  assert.equal(Object.isFrozen(transaction.amount), true);
  assert.equal(Object.isFrozen(transaction.paymentAttemptIds), true);
  assert.equal(Object.isFrozen(transaction.refundIds), true);
});

test('supports an initial transaction before payment, delivery and refund records exist', () => {
  const wire = createValidTransaction();
  wire.status = 'authorized';
  wire.paymentAttemptIds = [];
  wire.deliveryId = null;
  wire.refundIds = [];

  const transaction = parseTransaction(wire);

  assert.deepEqual(transaction.paymentAttemptIds, []);
  assert.equal(transaction.deliveryId, null);
  assert.deepEqual(transaction.refundIds, []);
});

test('rejects duplicate child references and malformed reference types', () => {
  const duplicateAttempts = createValidTransaction();
  duplicateAttempts.paymentAttemptIds.push(duplicateAttempts.paymentAttemptIds[0]);
  assertContractError(() => parseTransaction(duplicateAttempts), {
    code: 'duplicate_reference',
    path: '/paymentAttemptIds',
  });

  const duplicateRefunds = createValidTransaction();
  duplicateRefunds.refundIds.push(duplicateRefunds.refundIds[0]);
  assertContractError(() => parseTransaction(duplicateRefunds), {
    code: 'duplicate_reference',
    path: '/refundIds',
  });

  const wrongDeliveryPrefix = createValidTransaction();
  wrongDeliveryPrefix.deliveryId = `rfd_${uuids[9]}`;
  assertContractError(() => parseTransaction(wrongDeliveryPrefix), {
    code: 'invalid_format',
    path: '/deliveryId',
  });
});

test('rejects zero or overflowing amounts and timestamps before creation', () => {
  const zeroAmount = createValidTransaction();
  zeroAmount.amount.amountMinor = '0';
  assertContractError(() => parseTransaction(zeroAmount), {
    code: 'non_positive_total',
    path: '/amount',
  });

  const overflowingAmount = createValidTransaction();
  overflowingAmount.amount.amountMinor = '9223372036854775808';
  assertContractError(() => parseTransaction(overflowingAmount), {
    code: 'out_of_range',
    path: '/amount',
  });

  const backwardsUpdate = createValidTransaction();
  backwardsUpdate.updatedAt = '2026-08-27T01:59:59.999Z';
  assertContractError(() => parseTransaction(backwardsUpdate), {
    code: 'invalid_timestamp_order',
    path: '/updatedAt',
  });
});

test('rejects unknown fields and does not echo rejected input', () => {
  const privateValue = 'PRIVATE_TRANSACTION_VALUE_THAT_MUST_NOT_APPEAR';
  const wire = { ...createValidTransaction(), unexpected: privateValue };

  assert.throws(
    () => parseTransaction(wire),
    (error) => {
      assert.equal(error instanceof ContractValidationError, true);
      assert.equal(error.message.includes(privateValue), false);
      assert.equal(JSON.stringify(error.issues).includes(privateValue), false);
      assert.equal(
        error.issues.some((issue) => issue.code === 'unknown_field'),
        true,
      );
      return true;
    },
  );
});

test('exports a strict Draft 2020-12 schema with the complete status vocabulary', () => {
  const schema = getTransactionJsonSchema();

  assert.equal(TransactionWireSchema.safeParse(createValidTransaction()).success, true);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.amount.additionalProperties, false);
  assert.deepEqual(schema.properties.status.enum, transactionStatuses);
  assert.deepEqual(schema.required, [
    'schemaVersion',
    'transactionId',
    'quoteId',
    'mandateId',
    'principalId',
    'agentId',
    'merchantId',
    'serviceId',
    'amount',
    'status',
    'paymentAttemptIds',
    'deliveryId',
    'refundIds',
    'createdAt',
    'updatedAt',
  ]);
});
