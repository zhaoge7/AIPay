import assert from 'node:assert/strict';
import test from 'node:test';

import { createMoney } from '@aipay/contracts';

import { evaluateApprovalPolicy } from '../dist/index.js';

const mandate = Object.freeze({ approvalRequiredAbove: createMoney('CNY', '500') });

test('does not require confirmation below or exactly at the threshold', () => {
  assert.deepEqual(evaluateApprovalPolicy(mandate, createMoney('CNY', '499')), {
    requiresConfirmation: false,
  });
  assert.deepEqual(evaluateApprovalPolicy(mandate, createMoney('CNY', '500')), {
    requiresConfirmation: false,
  });
});

test('requires confirmation for the first minor unit above the threshold', () => {
  const decision = evaluateApprovalPolicy(mandate, createMoney('CNY', '501'));
  assert.deepEqual(decision, { requiresConfirmation: true });
  assert.equal(Object.isFrozen(decision), true);
});

test('a zero threshold requires confirmation for every positive payment', () => {
  assert.deepEqual(
    evaluateApprovalPolicy(
      { approvalRequiredAbove: createMoney('CNY', '0') },
      createMoney('CNY', '1'),
    ),
    { requiresConfirmation: true },
  );
});
