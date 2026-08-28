import type { ResourceId } from '@aipay/contracts';
import { enqueueOutboxEvent, type DatabaseTransaction } from '@aipay/database';
import type { ProviderPaymentStatus, ProviderRefundStatus } from '@aipay/payment';

export interface PaymentStateContext {
  readonly transactionId: ResourceId<'txn'>;
  readonly merchantId: ResourceId<'mch'>;
  readonly paymentAttemptId: ResourceId<'pat'>;
  readonly provider: string;
}

export function transactionStatus(status: ProviderPaymentStatus) {
  switch (status) {
    case 'pending':
      return 'payment_pending' as const;
    case 'succeeded':
      return 'paid' as const;
    case 'failed':
      return 'failed' as const;
    case 'unknown':
      return 'payment_review' as const;
  }
}

export function shouldApplyPaymentStatus(
  current: ProviderPaymentStatus,
  incoming: ProviderPaymentStatus,
): boolean {
  if (current === incoming || current === 'succeeded' || current === 'failed') {
    return false;
  }

  return !(current === 'unknown' && incoming === 'pending');
}

function paymentEventType(status: ProviderPaymentStatus) {
  switch (status) {
    case 'succeeded':
      return 'transaction.paid' as const;
    case 'failed':
      return 'transaction.failed' as const;
    case 'unknown':
      return 'transaction.payment_review' as const;
    case 'pending':
      return null;
  }
}

export async function enqueuePaymentStateChange(
  transaction: DatabaseTransaction,
  context: PaymentStateContext,
  status: ProviderPaymentStatus,
  providerReference: string | null,
  errorCode: string | null,
  providerTransactionId: string | null = null,
): Promise<void> {
  const eventType = paymentEventType(status);

  if (eventType === null) {
    return;
  }

  await enqueueOutboxEvent(transaction, {
    aggregateType: 'transaction',
    aggregateId: context.transactionId,
    eventType,
    payload: {
      merchantId: context.merchantId,
      transactionId: context.transactionId,
      paymentAttemptId: context.paymentAttemptId,
      paymentStatus: status,
      provider: context.provider,
      providerReference,
      ...(providerTransactionId === null ? {} : { providerTransactionId }),
      errorCode,
    },
  });
}

export function shouldApplyRefundStatus(
  current: ProviderRefundStatus,
  incoming: ProviderRefundStatus,
): boolean {
  if (current === incoming || current === 'succeeded') {
    return false;
  }

  return !(current === 'unknown' && incoming === 'pending');
}

export function transactionStatusForRefund(status: ProviderRefundStatus) {
  switch (status) {
    case 'pending':
      return 'refund_pending' as const;
    case 'unknown':
    case 'failed':
      return 'refund_review' as const;
    case 'succeeded':
      return 'refunded' as const;
  }
}

export interface RefundStateContext extends PaymentStateContext {
  readonly refundId: ResourceId<'rfd'>;
}

export async function enqueueRefundStateChange(
  transaction: DatabaseTransaction,
  context: RefundStateContext,
  status: ProviderRefundStatus,
  providerReference: string | null,
  errorCode: string | null,
): Promise<void> {
  if (status === 'pending') {
    return;
  }

  await enqueueOutboxEvent(transaction, {
    aggregateType: 'transaction',
    aggregateId: context.transactionId,
    eventType: status === 'succeeded' ? 'transaction.refunded' : 'transaction.refund_review',
    payload: {
      merchantId: context.merchantId,
      transactionId: context.transactionId,
      paymentAttemptId: context.paymentAttemptId,
      refundId: context.refundId,
      refundStatus: status,
      provider: context.provider,
      providerReference,
      errorCode,
    },
  });
}
