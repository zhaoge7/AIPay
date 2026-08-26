import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

import {
  ContractValidationError,
  assertTransactionBindings,
  parseMandate,
  parseQuote,
  parseTransaction,
  toMandateWire,
  toQuoteWire,
  toTransactionWire,
  transitionTransaction,
} from '../dist/index.js';

const fixtureDirectory = new URL('./fixtures/v1/', import.meta.url);

async function readFixture(name) {
  return JSON.parse(await readFile(new URL(name, fixtureDirectory), 'utf8'));
}

async function createBoundChain() {
  const mandateWire = await readFixture('mandate.json');
  const quoteWire = await readFixture('quote.json');
  quoteWire.merchantId = mandateWire.allowedMerchantIds[0];
  const transactionWire = {
    schemaVersion: '1',
    transactionId: 'txn_01890f3e-9b80-7cc2-98c5-7f6a1b2c3d4e',
    quoteId: quoteWire.quoteId,
    mandateId: mandateWire.mandateId,
    principalId: mandateWire.principalId,
    agentId: mandateWire.agentId,
    merchantId: quoteWire.merchantId,
    serviceId: quoteWire.serviceId,
    amount: { ...quoteWire.total },
    status: 'requires_confirmation',
    paymentAttemptIds: [],
    deliveryId: null,
    refundIds: [],
    createdAt: '2026-08-27T01:02:00.000Z',
    updatedAt: '2026-08-27T01:02:00.000Z',
  };

  return {
    mandate: parseMandate(mandateWire),
    quote: parseQuote(quoteWire),
    transaction: parseTransaction(transactionWire),
  };
}

test('passes Gate P2 with a bound Mandate, Quote and no-payment Transaction', async () => {
  const { mandate, quote, transaction } = await createBoundChain();

  assert.doesNotThrow(() => assertTransactionBindings(transaction, quote, mandate));
  assert.equal(transaction.status, 'requires_confirmation');
  assert.deepEqual(transaction.paymentAttemptIds, []);
  assert.equal(transaction.deliveryId, null);
  assert.deepEqual(transaction.refundIds, []);

  const authorizedStatus = transitionTransaction(transaction.status, 'confirmation_approved');
  assert.equal(authorizedStatus, 'authorized');

  assert.deepEqual(parseMandate(JSON.parse(JSON.stringify(toMandateWire(mandate)))), mandate);
  assert.deepEqual(parseQuote(JSON.parse(JSON.stringify(toQuoteWire(quote)))), quote);
  assert.deepEqual(
    parseTransaction(JSON.parse(JSON.stringify(toTransactionWire(transaction)))),
    transaction,
  );
});

test('rejects cross-object substitution and stale no-payment transactions', async () => {
  const { mandate, quote, transaction } = await createBoundChain();
  const baseWire = toTransactionWire(transaction);
  const cases = [
    [
      { ...baseWire, quoteId: 'qte_01890f3e-9b81-7cc2-a8c5-7f6a1b2c3d4e' },
      'reference_mismatch',
      '/quoteId',
    ],
    [
      { ...baseWire, agentId: 'agt_01890f3e-9b82-7cc2-b8c5-7f6a1b2c3d4e' },
      'identity_mismatch',
      '/agentId',
    ],
    [
      { ...baseWire, amount: { currency: 'CNY', amountMinor: '599' } },
      'amount_mismatch',
      '/amount',
    ],
    [
      {
        ...baseWire,
        createdAt: quote.expiresAt,
        updatedAt: quote.expiresAt,
      },
      'created_outside_validity',
      '/createdAt',
    ],
  ];

  for (const [wire, code, path] of cases) {
    const changedTransaction = parseTransaction(wire);
    assert.throws(
      () => assertTransactionBindings(changedTransaction, quote, mandate),
      (error) => {
        assert.equal(error instanceof ContractValidationError, true);
        assert.equal(
          error.issues.some((issue) => issue.code === code && issue.path === path),
          true,
        );
        return true;
      },
    );
  }
});

test('rejects a Quote merchant outside the Mandate allowlist', async () => {
  const { mandate, quote, transaction } = await createBoundChain();
  const unauthorizedMerchantId = 'mch_01890f3e-9b83-7cc2-88c5-7f6a1b2c3d4e';
  const quoteWire = { ...toQuoteWire(quote), merchantId: unauthorizedMerchantId };
  const transactionWire = { ...toTransactionWire(transaction), merchantId: unauthorizedMerchantId };

  assert.throws(
    () =>
      assertTransactionBindings(parseTransaction(transactionWire), parseQuote(quoteWire), mandate),
    (error) => {
      assert.equal(error instanceof ContractValidationError, true);
      assert.equal(
        error.issues.some(
          (issue) => issue.code === 'merchant_not_allowed' && issue.path === '/merchantId',
        ),
        true,
      );
      return true;
    },
  );
});
