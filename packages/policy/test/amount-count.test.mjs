import assert from 'node:assert/strict';
import test from 'node:test';

import { createMoney } from '@aipay/contracts';

import { evaluateAmountCountPolicy } from '../dist/index.js';

const mandate = Object.freeze({
  maxPerTransaction: createMoney('CNY', '600'),
  totalBudget: createMoney('CNY', '1000'),
  maxTransactions: 2,
});

test('allows exact single, cumulative and count boundaries', () => {
  assert.deepEqual(
    evaluateAmountCountPolicy(
      mandate,
      { spentAmountMinor: '400', completedTransactionCount: 1 },
      createMoney('CNY', '600'),
    ),
    {
      allowed: true,
      nextSpentAmountMinor: '1000',
      nextCompletedTransactionCount: 2,
    },
  );
});

test('rejects zero and per-transaction overflow before aggregate checks', () => {
  assert.deepEqual(
    evaluateAmountCountPolicy(
      mandate,
      { spentAmountMinor: '1000', completedTransactionCount: 2 },
      createMoney('CNY', '0'),
    ),
    { allowed: false, reason: 'non_positive_amount' },
  );
  assert.deepEqual(
    evaluateAmountCountPolicy(
      mandate,
      { spentAmountMinor: '1000', completedTransactionCount: 2 },
      createMoney('CNY', '601'),
    ),
    { allowed: false, reason: 'per_transaction_exceeded' },
  );
});

test('rejects count exhaustion before cumulative exhaustion', () => {
  assert.deepEqual(
    evaluateAmountCountPolicy(
      mandate,
      { spentAmountMinor: '1000', completedTransactionCount: 2 },
      createMoney('CNY', '1'),
    ),
    { allowed: false, reason: 'transaction_count_exceeded' },
  );
});

test('rejects cumulative budget overflow without mutating usage', () => {
  const usage = Object.freeze({ spentAmountMinor: '500', completedTransactionCount: 1 });
  assert.deepEqual(evaluateAmountCountPolicy(mandate, usage, createMoney('CNY', '501')), {
    allowed: false,
    reason: 'total_budget_exceeded',
  });
  assert.deepEqual(usage, { spentAmountMinor: '500', completedTransactionCount: 1 });
});
