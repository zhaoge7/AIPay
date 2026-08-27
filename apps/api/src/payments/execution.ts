import { createHash } from 'node:crypto';

import {
  createMoney,
  formatUtcDateTime,
  getResourceUuid,
  parseResourceId,
  type ResourceId,
} from '@aipay/contracts';
import { enqueueOutboxEvent, type Database, type DatabaseTransaction } from '@aipay/database';
import {
  PaymentProviderError,
  type PaymentProvider,
  type ProviderPaymentAction,
  type ProviderPaymentResult,
  type ProviderPaymentStatus,
} from '@aipay/payment';

export type PaymentExecutionErrorCode =
  'not_found' | 'invalid_state' | 'provider_error' | 'provider_reference_missing';

export class PaymentExecutionError extends Error {
  readonly code: PaymentExecutionErrorCode;
  readonly providerCode: string | undefined;

  constructor(code: PaymentExecutionErrorCode, providerCode?: string) {
    super('Payment execution failed');
    this.name = 'PaymentExecutionError';
    this.code = code;
    this.providerCode = providerCode;
  }
}

export interface PaymentAttemptView {
  readonly paymentAttemptId: ResourceId<'pat'>;
  readonly transactionId: ResourceId<'txn'>;
  readonly attemptNumber: number;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly amount: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly status: ProviderPaymentStatus;
  readonly errorCode: string | null;
  readonly action: Readonly<ProviderPaymentAction> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ExecutionContext {
  readonly transactionId: ResourceId<'txn'>;
  readonly merchantId: ResourceId<'mch'>;
  readonly paymentAttemptId: ResourceId<'pat'>;
  readonly amountMinor: string;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly callId: string;
  readonly startedAt: Date;
}

function requestDigest(value: unknown): Buffer {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest();
}

function transactionStatus(status: ProviderPaymentStatus) {
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

async function enqueuePaymentStateChange(
  transaction: DatabaseTransaction,
  context: ExecutionContext,
  status: ProviderPaymentStatus,
  providerReference: string | null,
  errorCode: string | null,
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
      errorCode,
    },
  });
}

function toAttemptView(
  row: {
    readonly id: string;
    readonly transactionId: string;
    readonly attemptNumber: number;
    readonly provider: string;
    readonly providerReference: string | null;
    readonly currency: 'CNY';
    readonly amountMinor: string;
    readonly status: ProviderPaymentStatus;
    readonly errorCode: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  },
  action: Readonly<ProviderPaymentAction> | null = null,
): Readonly<PaymentAttemptView> {
  return Object.freeze({
    paymentAttemptId: parseResourceId(`pat_${row.id}`, 'pat'),
    transactionId: parseResourceId(`txn_${row.transactionId}`, 'txn'),
    attemptNumber: row.attemptNumber,
    provider: row.provider,
    providerReference: row.providerReference,
    amount: createMoney(row.currency, row.amountMinor),
    status: row.status,
    errorCode: row.errorCode,
    action,
    createdAt: formatUtcDateTime(row.createdAt),
    updatedAt: formatUtcDateTime(row.updatedAt),
  });
}

const attemptColumns = [
  'id',
  'transactionId',
  'attemptNumber',
  'provider',
  'providerReference',
  'currency',
  'amountMinor',
  'status',
  'errorCode',
  'createdAt',
  'updatedAt',
] as const;

export class PaymentExecutionService {
  readonly #database: Database;
  readonly #callbackUrl: string;
  readonly #now: () => Date;

  constructor(database: Database, callbackUrl: string, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#callbackUrl = callbackUrl;
    this.#now = now;
  }

  async create(
    transactionId: ResourceId<'txn'>,
    provider: PaymentProvider,
  ): Promise<Readonly<PaymentAttemptView>> {
    const context = await this.#database.transaction().execute(async (transaction) => {
      const paymentTransaction = await transaction
        .selectFrom('transactions')
        .select(['id', 'merchantId', 'amountMinor', 'currency', 'status'])
        .where('id', '=', getResourceUuid(transactionId))
        .forUpdate()
        .executeTakeFirst();

      if (paymentTransaction === undefined) {
        throw new PaymentExecutionError('not_found');
      }

      if (paymentTransaction.status !== 'authorized') {
        throw new PaymentExecutionError('invalid_state');
      }

      const sequence = await transaction
        .selectFrom('paymentAttempts')
        .select('attemptNumber')
        .where('transactionId', '=', paymentTransaction.id)
        .orderBy('attemptNumber', 'desc')
        .executeTakeFirst();
      const attemptNumber = (sequence?.attemptNumber ?? 0) + 1;
      const attempt = await transaction
        .insertInto('paymentAttempts')
        .values({
          transactionId: paymentTransaction.id,
          attemptNumber,
          provider: provider.name,
          providerReference: null,
          amountMinor: paymentTransaction.amountMinor,
          status: 'pending',
          errorCode: null,
        })
        .returning(['id', 'createdAt'])
        .executeTakeFirstOrThrow();
      const paymentAttemptId = parseResourceId(`pat_${attempt.id}`, 'pat');
      const call = await transaction
        .insertInto('paymentProviderCalls')
        .values({
          paymentAttemptId: attempt.id,
          operation: 'payment.create',
          requestDigest: requestDigest({
            transactionId,
            paymentAttemptId,
            amountMinor: paymentTransaction.amountMinor,
            provider: provider.name,
          }),
          providerStatus: null,
          providerReference: null,
          errorKind: null,
          errorCode: null,
          completedAt: null,
          durationMs: null,
        })
        .returning(['id', 'startedAt'])
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('transactions')
        .set({ status: 'payment_pending', updatedAt: this.#now() })
        .where('id', '=', paymentTransaction.id)
        .executeTakeFirstOrThrow();

      return Object.freeze({
        transactionId,
        merchantId: parseResourceId(`mch_${paymentTransaction.merchantId}`, 'mch'),
        paymentAttemptId,
        amountMinor: paymentTransaction.amountMinor,
        provider: provider.name,
        providerReference: null,
        callId: call.id,
        startedAt: call.startedAt,
      });
    });

    return this.#invokeCreate(context, provider);
  }

  async retryCreate(
    paymentAttemptId: ResourceId<'pat'>,
    provider: PaymentProvider,
  ): Promise<Readonly<PaymentAttemptView>> {
    const context = await this.#prepareExistingCall(paymentAttemptId, provider, 'payment.create');
    return this.#invokeCreate(context, provider);
  }

  async query(
    paymentAttemptId: ResourceId<'pat'>,
    provider: PaymentProvider,
  ): Promise<Readonly<PaymentAttemptView>> {
    const context = await this.#prepareExistingCall(paymentAttemptId, provider, 'payment.query');
    const providerPaymentId = context.providerReference;

    if (providerPaymentId === null) {
      throw new PaymentExecutionError('provider_reference_missing');
    }

    try {
      const result = await provider.queryPayment({
        transactionId: context.transactionId,
        paymentAttemptId,
        providerPaymentId,
      });
      return await this.#completeSuccess(context, result);
    } catch (error) {
      return this.#completeFailureAndThrow(context, error);
    }
  }

  async #invokeCreate(
    context: ExecutionContext,
    provider: PaymentProvider,
  ): Promise<Readonly<PaymentAttemptView>> {
    try {
      const result = await provider.createPayment({
        transactionId: context.transactionId,
        paymentAttemptId: context.paymentAttemptId,
        amount: createMoney('CNY', context.amountMinor),
        idempotencyKey: `payment:${context.paymentAttemptId}:create`,
        description: `AIPay transaction ${context.transactionId}`,
        callbackUrl: this.#callbackUrl,
      });
      return await this.#completeSuccess(context, result);
    } catch (error) {
      return this.#completeFailureAndThrow(context, error);
    }
  }

  async #prepareExistingCall(
    paymentAttemptId: ResourceId<'pat'>,
    provider: PaymentProvider,
    operation: 'payment.create' | 'payment.query',
  ): Promise<ExecutionContext> {
    return this.#database.transaction().execute(async (transaction) => {
      const attempt = await transaction
        .selectFrom('paymentAttempts')
        .select(['id', 'transactionId', 'provider', 'providerReference', 'amountMinor'])
        .where('id', '=', getResourceUuid(paymentAttemptId))
        .forUpdate()
        .executeTakeFirst();

      if (attempt === undefined) {
        throw new PaymentExecutionError('not_found');
      }

      if (attempt.provider !== provider.name) {
        throw new PaymentExecutionError('invalid_state');
      }

      if (operation === 'payment.query' && attempt.providerReference === null) {
        throw new PaymentExecutionError('provider_reference_missing');
      }

      const transactionId = parseResourceId(`txn_${attempt.transactionId}`, 'txn');
      const paymentTransaction = await transaction
        .selectFrom('transactions')
        .select('merchantId')
        .where('id', '=', attempt.transactionId)
        .executeTakeFirstOrThrow();
      const call = await transaction
        .insertInto('paymentProviderCalls')
        .values({
          paymentAttemptId: attempt.id,
          operation,
          requestDigest: requestDigest({
            transactionId,
            paymentAttemptId,
            providerReference: attempt.providerReference,
            operation,
          }),
          providerStatus: null,
          providerReference: attempt.providerReference,
          errorKind: null,
          errorCode: null,
          completedAt: null,
          durationMs: null,
        })
        .returning(['id', 'startedAt'])
        .executeTakeFirstOrThrow();

      return Object.freeze({
        transactionId,
        merchantId: parseResourceId(`mch_${paymentTransaction.merchantId}`, 'mch'),
        paymentAttemptId,
        amountMinor: attempt.amountMinor,
        provider: provider.name,
        providerReference: attempt.providerReference,
        callId: call.id,
        startedAt: call.startedAt,
      });
    });
  }

  async #completeSuccess(
    context: ExecutionContext,
    result: Readonly<ProviderPaymentResult>,
  ): Promise<Readonly<PaymentAttemptView>> {
    const completedAt = this.#now();
    const durationMs = Math.max(0, completedAt.getTime() - context.startedAt.getTime());
    const attemptErrorCode =
      result.status === 'failed'
        ? (result.failureCode ?? 'PROVIDER_FAILED')
        : result.status === 'unknown'
          ? (result.failureCode ?? 'PROVIDER_STATUS_UNKNOWN')
          : null;

    return this.#database.transaction().execute(async (transaction) => {
      const previousAttempt = await transaction
        .selectFrom('paymentAttempts')
        .select('status')
        .where('id', '=', getResourceUuid(context.paymentAttemptId))
        .forUpdate()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('paymentProviderCalls')
        .set({
          outcome: 'succeeded',
          providerStatus: result.status,
          providerReference: result.providerPaymentId,
          completedAt,
          durationMs,
        })
        .where('id', '=', context.callId)
        .where('outcome', '=', 'started')
        .executeTakeFirstOrThrow();
      const attempt = await transaction
        .updateTable('paymentAttempts')
        .set({
          providerReference: result.providerPaymentId,
          status: result.status,
          errorCode: attemptErrorCode,
          updatedAt: completedAt,
        })
        .where('id', '=', getResourceUuid(context.paymentAttemptId))
        .returning(attemptColumns)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('transactions')
        .set({ status: transactionStatus(result.status), updatedAt: completedAt })
        .where('id', '=', getResourceUuid(context.transactionId))
        .executeTakeFirstOrThrow();
      if (previousAttempt.status !== result.status) {
        await enqueuePaymentStateChange(
          transaction,
          context,
          result.status,
          result.providerPaymentId,
          attemptErrorCode,
        );
      }
      return toAttemptView(attempt, result.action);
    });
  }

  async #completeFailureAndThrow(context: ExecutionContext, error: unknown): Promise<never> {
    const completedAt = this.#now();
    const durationMs = Math.max(0, completedAt.getTime() - context.startedAt.getTime());
    const providerError =
      error instanceof PaymentProviderError
        ? error
        : new PaymentProviderError({
            provider: 'unknown',
            kind: 'fatal',
            code: 'UNEXPECTED_ERROR',
          });
    const status: ProviderPaymentStatus = providerError.kind === 'retryable' ? 'unknown' : 'failed';

    await this.#database.transaction().execute(async (transaction) => {
      const previousAttempt = await transaction
        .selectFrom('paymentAttempts')
        .select('status')
        .where('id', '=', getResourceUuid(context.paymentAttemptId))
        .forUpdate()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('paymentProviderCalls')
        .set({
          outcome: 'failed',
          providerStatus: status,
          completedAt,
          durationMs,
          errorKind: providerError.kind,
          errorCode: providerError.code,
        })
        .where('id', '=', context.callId)
        .where('outcome', '=', 'started')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('paymentAttempts')
        .set({ status, errorCode: providerError.code, updatedAt: completedAt })
        .where('id', '=', getResourceUuid(context.paymentAttemptId))
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('transactions')
        .set({ status: transactionStatus(status), updatedAt: completedAt })
        .where('id', '=', getResourceUuid(context.transactionId))
        .executeTakeFirstOrThrow();
      if (previousAttempt.status !== status) {
        await enqueuePaymentStateChange(
          transaction,
          context,
          status,
          context.providerReference,
          providerError.code,
        );
      }
    });

    throw new PaymentExecutionError('provider_error', providerError.code);
  }
}
