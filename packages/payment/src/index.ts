import type { Money, ResourceId, UtcDateTime } from '@aipay/contracts';

export type ProviderPaymentStatus = 'pending' | 'succeeded' | 'failed' | 'unknown';
export type ProviderRefundStatus = 'pending' | 'succeeded' | 'failed' | 'unknown';

export interface ProviderCapabilities {
  readonly supportsActiveQuery: boolean;
  readonly supportsRefunds: boolean;
  readonly supportsWebhookSignatures: boolean;
}

export interface CreatePaymentRequest {
  readonly transactionId: ResourceId<'txn'>;
  readonly paymentAttemptId: ResourceId<'pat'>;
  readonly amount: Readonly<Money>;
  readonly idempotencyKey: string;
  readonly description: string;
  readonly callbackUrl: string;
}

export interface QueryPaymentRequest {
  readonly transactionId: ResourceId<'txn'>;
  readonly paymentAttemptId: ResourceId<'pat'>;
  readonly providerPaymentId: string;
}

export interface ProviderPaymentAction {
  readonly type: 'redirect';
  readonly method: 'GET';
  readonly url: string;
}

export interface ProviderPaymentResult {
  readonly providerPaymentId: string;
  readonly status: ProviderPaymentStatus;
  readonly occurredAt: UtcDateTime;
  readonly failureCode: string | null;
  readonly action: Readonly<ProviderPaymentAction> | null;
}

export interface CreateRefundRequest {
  readonly refundId: ResourceId<'rfd'>;
  readonly transactionId: ResourceId<'txn'>;
  readonly providerPaymentId: string;
  readonly amount: Readonly<Money>;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface QueryRefundRequest {
  readonly refundId: ResourceId<'rfd'>;
  readonly providerRefundId: string;
}

export interface ProviderRefundResult {
  readonly providerRefundId: string;
  readonly status: ProviderRefundStatus;
  readonly occurredAt: UtcDateTime;
  readonly failureCode: string | null;
}

export interface ProviderWebhookRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: Uint8Array;
  readonly receivedAt: UtcDateTime;
}

export type ProviderWebhookEvent =
  | Readonly<{
      eventId: string;
      eventType: 'payment.updated';
      providerPaymentId: string;
      status: ProviderPaymentStatus;
      occurredAt: UtcDateTime;
      failureCode: string | null;
    }>
  | Readonly<{
      eventId: string;
      eventType: 'refund.updated';
      providerRefundId: string;
      providerPaymentId: string;
      status: ProviderRefundStatus;
      occurredAt: UtcDateTime;
      failureCode: string | null;
    }>;

export interface ProviderWebhookAcknowledgement {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface PaymentProvider {
  readonly name: string;
  readonly capabilities: Readonly<ProviderCapabilities>;

  createPayment(request: CreatePaymentRequest): Promise<Readonly<ProviderPaymentResult>>;
  queryPayment(request: QueryPaymentRequest): Promise<Readonly<ProviderPaymentResult>>;
  createRefund(request: CreateRefundRequest): Promise<Readonly<ProviderRefundResult>>;
  queryRefund(request: QueryRefundRequest): Promise<Readonly<ProviderRefundResult>>;
  verifyWebhook(request: ProviderWebhookRequest): Promise<ProviderWebhookEvent>;
  acknowledgeWebhook(event: ProviderWebhookEvent): ProviderWebhookAcknowledgement;
}

export type PaymentProviderErrorKind =
  'retryable' | 'declined' | 'invalid_request' | 'invalid_webhook' | 'fatal';

export class PaymentProviderError extends Error {
  readonly provider: string;
  readonly kind: PaymentProviderErrorKind;
  readonly code: string;
  readonly retryAfterMs: number | undefined;

  constructor(options: {
    readonly provider: string;
    readonly kind: PaymentProviderErrorKind;
    readonly code: string;
    readonly retryAfterMs?: number;
  }) {
    super('Payment provider operation failed');
    this.name = 'PaymentProviderError';
    this.provider = options.provider;
    this.kind = options.kind;
    this.code = options.code;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export function isRetryableProviderError(error: unknown): error is PaymentProviderError {
  return error instanceof PaymentProviderError && error.kind === 'retryable';
}

export function isTerminalPaymentStatus(status: ProviderPaymentStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}

export function isTerminalRefundStatus(status: ProviderRefundStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}

export {
  AlipayWebPaymentProvider,
  type AlipayWebPaymentProviderOptions,
} from './alipay-web-provider.js';
export {
  FakePaymentProvider,
  type FakeOutcome,
  type FakeProviderOptions,
} from './fake-provider.js';
