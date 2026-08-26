import type { TransactionStatus } from './transaction.js';

export const transactionEvents = [
  'confirmation_approved',
  'confirmation_rejected',
  'payment_started',
  'payment_succeeded',
  'payment_failed',
  'payment_outcome_unknown',
  'payment_retried',
  'payment_abandoned',
  'delivery_started',
  'delivery_succeeded',
  'delivery_failed',
  'delivery_outcome_unknown',
  'delivery_retried',
  'refund_requested',
  'refund_succeeded',
  'refund_outcome_unknown',
  'refund_retried',
  'refund_confirmed_manually',
  'settlement_completed',
  'cancelled',
] as const;

export type TransactionEvent = (typeof transactionEvents)[number];

export const terminalTransactionStatuses = [
  'refunded',
  'settled',
  'failed',
  'cancelled',
] as const satisfies readonly TransactionStatus[];

type TransitionTable = Readonly<
  Record<TransactionStatus, Readonly<Partial<Record<TransactionEvent, TransactionStatus>>>>
>;

export const transactionTransitions = Object.freeze({
  requires_confirmation: Object.freeze({
    confirmation_approved: 'authorized',
    confirmation_rejected: 'cancelled',
  }),
  authorized: Object.freeze({
    payment_started: 'payment_pending',
    cancelled: 'cancelled',
  }),
  payment_pending: Object.freeze({
    payment_succeeded: 'paid',
    payment_failed: 'failed',
    payment_outcome_unknown: 'payment_review',
  }),
  payment_review: Object.freeze({
    payment_retried: 'payment_pending',
    payment_succeeded: 'paid',
    payment_abandoned: 'failed',
  }),
  paid: Object.freeze({
    delivery_started: 'delivery_pending',
    refund_requested: 'refund_pending',
  }),
  delivery_pending: Object.freeze({
    delivery_succeeded: 'delivered',
    delivery_failed: 'refund_pending',
    delivery_outcome_unknown: 'delivery_review',
  }),
  delivery_review: Object.freeze({
    delivery_retried: 'delivery_pending',
    delivery_succeeded: 'delivered',
    refund_requested: 'refund_pending',
  }),
  delivered: Object.freeze({
    refund_requested: 'refund_pending',
    settlement_completed: 'settled',
  }),
  refund_pending: Object.freeze({
    refund_succeeded: 'refunded',
    refund_outcome_unknown: 'refund_review',
  }),
  refund_review: Object.freeze({
    refund_retried: 'refund_pending',
    refund_succeeded: 'refunded',
    refund_confirmed_manually: 'refunded',
  }),
  refunded: Object.freeze({}),
  settled: Object.freeze({}),
  failed: Object.freeze({}),
  cancelled: Object.freeze({}),
} satisfies TransitionTable);

export type TransactionTransitionErrorCode = 'illegal_transition';

export class TransactionTransitionError extends Error {
  readonly code: TransactionTransitionErrorCode = 'illegal_transition';
  readonly currentStatus: TransactionStatus;
  readonly event: TransactionEvent;

  constructor(currentStatus: TransactionStatus, event: TransactionEvent) {
    super(`Cannot apply transaction event ${event} while status is ${currentStatus}`);
    this.name = 'TransactionTransitionError';
    this.currentStatus = currentStatus;
    this.event = event;
  }
}

export function isTerminalTransactionStatus(status: TransactionStatus): boolean {
  return terminalTransactionStatuses.some((terminalStatus) => terminalStatus === status);
}

export function getAllowedTransactionEvents(
  status: TransactionStatus,
): readonly TransactionEvent[] {
  return Object.freeze(Object.keys(transactionTransitions[status]) as TransactionEvent[]);
}

export function canTransitionTransaction(
  currentStatus: TransactionStatus,
  event: TransactionEvent,
): boolean {
  return event in transactionTransitions[currentStatus];
}

export function transitionTransaction(
  currentStatus: TransactionStatus,
  event: TransactionEvent,
): TransactionStatus {
  const nextStatus = (
    transactionTransitions[currentStatus] as Partial<Record<TransactionEvent, TransactionStatus>>
  )[event];

  if (nextStatus === undefined) {
    throw new TransactionTransitionError(currentStatus, event);
  }

  return nextStatus;
}
