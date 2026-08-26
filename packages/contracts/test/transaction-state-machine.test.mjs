import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TransactionTransitionError,
  canTransitionTransaction,
  getAllowedTransactionEvents,
  isTerminalTransactionStatus,
  terminalTransactionStatuses,
  transactionEvents,
  transactionStatuses,
  transactionTransitions,
  transitionTransaction,
} from '../dist/index.js';

const expectedTransitions = Object.freeze({
  requires_confirmation: {
    confirmation_approved: 'authorized',
    confirmation_rejected: 'cancelled',
  },
  authorized: { payment_started: 'payment_pending', cancelled: 'cancelled' },
  payment_pending: {
    payment_succeeded: 'paid',
    payment_failed: 'failed',
    payment_outcome_unknown: 'payment_review',
  },
  payment_review: {
    payment_retried: 'payment_pending',
    payment_succeeded: 'paid',
    payment_abandoned: 'failed',
  },
  paid: { delivery_started: 'delivery_pending', refund_requested: 'refund_pending' },
  delivery_pending: {
    delivery_succeeded: 'delivered',
    delivery_failed: 'refund_pending',
    delivery_outcome_unknown: 'delivery_review',
  },
  delivery_review: {
    delivery_retried: 'delivery_pending',
    delivery_succeeded: 'delivered',
    refund_requested: 'refund_pending',
  },
  delivered: { refund_requested: 'refund_pending', settlement_completed: 'settled' },
  refund_pending: {
    refund_succeeded: 'refunded',
    refund_outcome_unknown: 'refund_review',
  },
  refund_review: {
    refund_retried: 'refund_pending',
    refund_succeeded: 'refunded',
    refund_confirmed_manually: 'refunded',
  },
  refunded: {},
  settled: {},
  failed: {},
  cancelled: {},
});

test('defines every legal transition in one exhaustive table', () => {
  assert.deepEqual(transactionTransitions, expectedTransitions);
  assert.deepEqual(Object.keys(transactionTransitions), transactionStatuses);

  for (const status of transactionStatuses) {
    assert.deepEqual(getAllowedTransactionEvents(status), Object.keys(expectedTransitions[status]));

    for (const [event, expectedStatus] of Object.entries(expectedTransitions[status])) {
      assert.equal(canTransitionTransaction(status, event), true);
      assert.equal(transitionTransaction(status, event), expectedStatus);
    }
  }
});

test('covers confirmation rejection and payment failure exception branches', () => {
  assert.equal(
    transitionTransaction('requires_confirmation', 'confirmation_rejected'),
    'cancelled',
  );
  assert.equal(transitionTransaction('payment_pending', 'payment_failed'), 'failed');
  assert.equal(
    transitionTransaction('payment_pending', 'payment_outcome_unknown'),
    'payment_review',
  );
  assert.equal(transitionTransaction('payment_review', 'payment_abandoned'), 'failed');
});

test('covers delivery failure and unknown-outcome recovery branches', () => {
  assert.equal(transitionTransaction('delivery_pending', 'delivery_failed'), 'refund_pending');
  assert.equal(
    transitionTransaction('delivery_pending', 'delivery_outcome_unknown'),
    'delivery_review',
  );
  assert.equal(transitionTransaction('delivery_review', 'delivery_retried'), 'delivery_pending');
});

test('covers refund unknown-outcome recovery and manual confirmation', () => {
  assert.equal(transitionTransaction('refund_pending', 'refund_outcome_unknown'), 'refund_review');
  assert.equal(transitionTransaction('refund_review', 'refund_retried'), 'refund_pending');
  assert.equal(transitionTransaction('refund_review', 'refund_confirmed_manually'), 'refunded');
});

test('rejects every event that is absent from the current state transition table', () => {
  for (const status of transactionStatuses) {
    for (const event of transactionEvents) {
      const expectedStatus = expectedTransitions[status][event];

      if (expectedStatus === undefined) {
        assert.equal(canTransitionTransaction(status, event), false);
        assert.throws(
          () => transitionTransaction(status, event),
          (error) => {
            assert.equal(error instanceof TransactionTransitionError, true);
            assert.equal(error.code, 'illegal_transition');
            assert.equal(error.currentStatus, status);
            assert.equal(error.event, event);
            return true;
          },
        );
      }
    }
  }
});

test('marks only settled, refunded, failed and cancelled as terminal', () => {
  assert.deepEqual(terminalTransactionStatuses, ['refunded', 'settled', 'failed', 'cancelled']);

  for (const status of transactionStatuses) {
    const terminal = terminalTransactionStatuses.includes(status);
    assert.equal(isTerminalTransactionStatus(status), terminal);

    if (terminal) {
      assert.deepEqual(getAllowedTransactionEvents(status), []);
    }
  }
});

test('supports complete success and delivery-failure/refund paths', () => {
  const apply = (initialStatus, events) =>
    events.reduce((status, event) => transitionTransaction(status, event), initialStatus);

  assert.equal(
    apply('authorized', [
      'payment_started',
      'payment_succeeded',
      'delivery_started',
      'delivery_succeeded',
      'settlement_completed',
    ]),
    'settled',
  );

  assert.equal(
    apply('authorized', [
      'payment_started',
      'payment_succeeded',
      'delivery_started',
      'delivery_failed',
      'refund_succeeded',
    ]),
    'refunded',
  );
});
