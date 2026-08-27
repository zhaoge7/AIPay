import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { formatUtcDateTime, type UtcDateTime } from '@aipay/contracts';

import {
  PaymentProviderError,
  type CreatePaymentRequest,
  type CreateRefundRequest,
  type PaymentProvider,
  type ProviderPaymentResult,
  type ProviderPaymentStatus,
  type ProviderRefundResult,
  type ProviderRefundStatus,
  type ProviderWebhookAcknowledgement,
  type ProviderWebhookEvent,
  type ProviderWebhookRequest,
  type QueryPaymentRequest,
  type QueryRefundRequest,
} from './index.js';

export type FakeOutcome = 'pending' | 'succeeded' | 'failed' | 'timeout';

export interface FakeProviderOptions {
  readonly webhookSecret: string;
  readonly now?: () => Date;
}

interface PaymentRecord {
  readonly idempotencyKey: string;
  readonly providerPaymentId: string;
  status: ProviderPaymentStatus;
  occurredAt: UtcDateTime;
  failureCode: string | null;
}

interface RefundRecord {
  readonly idempotencyKey: string;
  readonly providerRefundId: string;
  readonly providerPaymentId: string;
  status: ProviderRefundStatus;
  occurredAt: UtcDateTime;
  failureCode: string | null;
}

function freezePayment(record: PaymentRecord): Readonly<ProviderPaymentResult> {
  return Object.freeze({
    providerPaymentId: record.providerPaymentId,
    status: record.status,
    occurredAt: record.occurredAt,
    failureCode: record.failureCode,
    action: null,
  });
}

function freezeRefund(record: RefundRecord): Readonly<ProviderRefundResult> {
  return Object.freeze({
    providerRefundId: record.providerRefundId,
    status: record.status,
    occurredAt: record.occurredAt,
    failureCode: record.failureCode,
  });
}

function header(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const target = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }

  return undefined;
}

function parseWebhookEvent(value: unknown): ProviderWebhookEvent {
  if (typeof value !== 'object' || value === null) {
    throw new PaymentProviderError({
      provider: 'fake',
      kind: 'invalid_webhook',
      code: 'MALFORMED_WEBHOOK',
    });
  }

  const event = value as Record<string, unknown>;
  const commonValid =
    typeof event.eventId === 'string' &&
    typeof event.occurredAt === 'string' &&
    typeof event.status === 'string' &&
    (event.failureCode === null || typeof event.failureCode === 'string');

  if (
    !commonValid ||
    (event.eventType !== 'payment.updated' && event.eventType !== 'refund.updated') ||
    typeof event.providerPaymentId !== 'string' ||
    (event.eventType === 'refund.updated' && typeof event.providerRefundId !== 'string')
  ) {
    throw new PaymentProviderError({
      provider: 'fake',
      kind: 'invalid_webhook',
      code: 'MALFORMED_WEBHOOK',
    });
  }

  return Object.freeze(event) as unknown as ProviderWebhookEvent;
}

export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  readonly capabilities = Object.freeze({
    supportsActiveQuery: true,
    supportsRefunds: true,
    supportsWebhookSignatures: true,
  });
  readonly #secret: Buffer;
  readonly #now: () => Date;
  readonly #paymentOutcomes: FakeOutcome[] = [];
  readonly #refundOutcomes: FakeOutcome[] = [];
  readonly #paymentsByIdempotency = new Map<string, PaymentRecord>();
  readonly #paymentsById = new Map<string, PaymentRecord>();
  readonly #refundsByIdempotency = new Map<string, RefundRecord>();
  readonly #refundsById = new Map<string, RefundRecord>();
  #paymentSequence = 0;
  #refundSequence = 0;
  #eventSequence = 0;

  constructor(options: FakeProviderOptions) {
    if (Buffer.byteLength(options.webhookSecret, 'utf8') < 16) {
      throw new Error('Fake Provider webhook secret must contain at least 16 bytes');
    }

    this.#secret = Buffer.from(options.webhookSecret, 'utf8');
    this.#now = options.now ?? (() => new Date());
  }

  enqueuePaymentOutcome(outcome: FakeOutcome): void {
    this.#paymentOutcomes.push(outcome);
  }

  enqueueRefundOutcome(outcome: FakeOutcome): void {
    this.#refundOutcomes.push(outcome);
  }

  setPaymentStatus(providerPaymentId: string, status: ProviderPaymentStatus): void {
    const record = this.#paymentsById.get(providerPaymentId);

    if (record === undefined) {
      throw new Error('Unknown Fake Provider payment');
    }

    record.status = status;
    record.failureCode = status === 'failed' ? 'FAKE_PAYMENT_FAILED' : null;
    record.occurredAt = formatUtcDateTime(this.#now());
  }

  setRefundStatus(providerRefundId: string, status: ProviderRefundStatus): void {
    const record = this.#refundsById.get(providerRefundId);

    if (record === undefined) {
      throw new Error('Unknown Fake Provider refund');
    }

    record.status = status;
    record.failureCode = status === 'failed' ? 'FAKE_REFUND_FAILED' : null;
    record.occurredAt = formatUtcDateTime(this.#now());
  }

  async createPayment(request: CreatePaymentRequest): Promise<Readonly<ProviderPaymentResult>> {
    await Promise.resolve();
    const existing = this.#paymentsByIdempotency.get(request.idempotencyKey);

    if (existing !== undefined) {
      return freezePayment(existing);
    }

    const outcome = this.#paymentOutcomes.shift() ?? 'pending';
    const record: PaymentRecord = {
      idempotencyKey: request.idempotencyKey,
      providerPaymentId: `fake_pay_${String(++this.#paymentSequence)}`,
      status: outcome === 'timeout' ? 'unknown' : outcome,
      occurredAt: formatUtcDateTime(this.#now()),
      failureCode: outcome === 'failed' ? 'FAKE_PAYMENT_FAILED' : null,
    };
    this.#paymentsByIdempotency.set(request.idempotencyKey, record);
    this.#paymentsById.set(record.providerPaymentId, record);

    if (outcome === 'timeout') {
      throw new PaymentProviderError({
        provider: this.name,
        kind: 'retryable',
        code: 'TIMEOUT',
        retryAfterMs: 100,
      });
    }

    return freezePayment(record);
  }

  async queryPayment(request: QueryPaymentRequest): Promise<Readonly<ProviderPaymentResult>> {
    await Promise.resolve();
    const record = this.#paymentsById.get(request.providerPaymentId);

    if (record === undefined) {
      throw new PaymentProviderError({
        provider: this.name,
        kind: 'invalid_request',
        code: 'PAYMENT_NOT_FOUND',
      });
    }

    return freezePayment(record);
  }

  async createRefund(request: CreateRefundRequest): Promise<Readonly<ProviderRefundResult>> {
    await Promise.resolve();
    const existing = this.#refundsByIdempotency.get(request.idempotencyKey);

    if (existing !== undefined) {
      return freezeRefund(existing);
    }

    if (!this.#paymentsById.has(request.providerPaymentId)) {
      throw new PaymentProviderError({
        provider: this.name,
        kind: 'invalid_request',
        code: 'PAYMENT_NOT_FOUND',
      });
    }

    const outcome = this.#refundOutcomes.shift() ?? 'pending';
    const record: RefundRecord = {
      idempotencyKey: request.idempotencyKey,
      providerRefundId: `fake_refund_${String(++this.#refundSequence)}`,
      providerPaymentId: request.providerPaymentId,
      status: outcome === 'timeout' ? 'unknown' : outcome,
      occurredAt: formatUtcDateTime(this.#now()),
      failureCode: outcome === 'failed' ? 'FAKE_REFUND_FAILED' : null,
    };
    this.#refundsByIdempotency.set(request.idempotencyKey, record);
    this.#refundsById.set(record.providerRefundId, record);

    if (outcome === 'timeout') {
      throw new PaymentProviderError({
        provider: this.name,
        kind: 'retryable',
        code: 'TIMEOUT',
        retryAfterMs: 100,
      });
    }

    return freezeRefund(record);
  }

  async queryRefund(request: QueryRefundRequest): Promise<Readonly<ProviderRefundResult>> {
    await Promise.resolve();
    const record = this.#refundsById.get(request.providerRefundId);

    if (record === undefined) {
      throw new PaymentProviderError({
        provider: this.name,
        kind: 'invalid_request',
        code: 'REFUND_NOT_FOUND',
      });
    }

    return freezeRefund(record);
  }

  paymentWebhook(providerPaymentId: string, eventId?: string): ProviderWebhookRequest {
    const record = this.#paymentsById.get(providerPaymentId);

    if (record === undefined) {
      throw new Error('Unknown Fake Provider payment');
    }

    return this.#webhook({
      eventId: eventId ?? `fake_event_${String(++this.#eventSequence)}`,
      eventType: 'payment.updated',
      providerPaymentId,
      status: record.status,
      occurredAt: record.occurredAt,
      failureCode: record.failureCode,
    });
  }

  refundWebhook(providerRefundId: string, eventId?: string): ProviderWebhookRequest {
    const record = this.#refundsById.get(providerRefundId);

    if (record === undefined) {
      throw new Error('Unknown Fake Provider refund');
    }

    return this.#webhook({
      eventId: eventId ?? `fake_event_${String(++this.#eventSequence)}`,
      eventType: 'refund.updated',
      providerRefundId,
      providerPaymentId: record.providerPaymentId,
      status: record.status,
      occurredAt: record.occurredAt,
      failureCode: record.failureCode,
    });
  }

  #webhook(event: ProviderWebhookEvent): ProviderWebhookRequest {
    const rawBody = Buffer.from(JSON.stringify(event), 'utf8');
    const signature = createHmac('sha256', this.#secret).update(rawBody).digest('hex');
    return Object.freeze({
      headers: Object.freeze({ 'x-fake-signature': signature }),
      rawBody,
      receivedAt: formatUtcDateTime(this.#now()),
    });
  }

  async verifyWebhook(request: ProviderWebhookRequest): Promise<ProviderWebhookEvent> {
    await Promise.resolve();
    const provided = header(request.headers, 'x-fake-signature');
    const expected = createHmac('sha256', this.#secret).update(request.rawBody).digest();
    const providedBytes =
      provided !== undefined && /^[0-9a-f]{64}$/u.test(provided)
        ? Buffer.from(provided, 'hex')
        : undefined;

    if (providedBytes === undefined) {
      throw new PaymentProviderError({
        provider: this.name,
        kind: 'invalid_webhook',
        code: 'INVALID_SIGNATURE',
      });
    }

    if (
      providedBytes.byteLength !== expected.byteLength ||
      !timingSafeEqual(providedBytes, expected)
    ) {
      throw new PaymentProviderError({
        provider: this.name,
        kind: 'invalid_webhook',
        code: 'INVALID_SIGNATURE',
      });
    }

    let value: unknown;

    try {
      value = JSON.parse(Buffer.from(request.rawBody).toString('utf8'));
    } catch {
      throw new PaymentProviderError({
        provider: this.name,
        kind: 'invalid_webhook',
        code: 'MALFORMED_WEBHOOK',
      });
    }

    return parseWebhookEvent(value);
  }

  acknowledgeWebhook(event: ProviderWebhookEvent): ProviderWebhookAcknowledgement {
    void event;
    return Object.freeze({
      statusCode: 200,
      headers: Object.freeze({ 'content-type': 'text/plain; charset=utf-8' }),
      body: 'ok',
    });
  }
}
