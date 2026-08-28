import { createHash } from 'node:crypto';

import {
  createMoney,
  formatUtcDateTime,
  getResourceUuid,
  parseResourceId,
  type ResourceId,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';
import {
  PaymentProviderError,
  type PaymentProvider,
  type ProviderRefundResult,
  type ProviderRefundStatus,
} from '@aipay/payment';

import {
  enqueueRefundStateChange,
  shouldApplyRefundStatus,
  transactionStatusForRefund,
  type RefundStateContext,
} from './state.js';

export type RefundExecutionErrorCode =
  'not_found' | 'invalid_state' | 'provider_reference_missing' | 'provider_error';

export class RefundExecutionError extends Error {
  readonly code: RefundExecutionErrorCode;
  readonly providerCode: string | undefined;

  constructor(code: RefundExecutionErrorCode, providerCode?: string) {
    super('Refund execution failed');
    this.name = 'RefundExecutionError';
    this.code = code;
    this.providerCode = providerCode;
  }
}

export interface RefundView {
  readonly refundId: ResourceId<'rfd'>;
  readonly transactionId: ResourceId<'txn'>;
  readonly paymentAttemptId: ResourceId<'pat'>;
  readonly amount: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly status: ProviderRefundStatus;
  readonly providerReference: string | null;
  readonly errorCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface RefundExecutionContext extends RefundStateContext {
  readonly amountMinor: string;
  readonly providerPaymentId: string;
  readonly providerRefundId: string | null;
  readonly operation: 'refund.create' | 'refund.query';
  readonly callId: string;
  readonly startedAt: Date;
}

const refundColumns = [
  'id',
  'transactionId',
  'paymentAttemptId',
  'currency',
  'amountMinor',
  'status',
  'providerReference',
  'errorCode',
  'createdAt',
  'updatedAt',
] as const;

function toView(row: {
  readonly id: string;
  readonly transactionId: string;
  readonly paymentAttemptId: string;
  readonly currency: 'CNY';
  readonly amountMinor: string;
  readonly status: ProviderRefundStatus;
  readonly providerReference: string | null;
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): Readonly<RefundView> {
  return Object.freeze({
    refundId: parseResourceId(`rfd_${row.id}`, 'rfd'),
    transactionId: parseResourceId(`txn_${row.transactionId}`, 'txn'),
    paymentAttemptId: parseResourceId(`pat_${row.paymentAttemptId}`, 'pat'),
    amount: createMoney(row.currency, row.amountMinor),
    status: row.status,
    providerReference: row.providerReference,
    errorCode: row.errorCode,
    createdAt: formatUtcDateTime(row.createdAt),
    updatedAt: formatUtcDateTime(row.updatedAt),
  });
}

function digest(value: unknown): Buffer {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest();
}

export class RefundExecutionService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async create(
    transactionId: ResourceId<'txn'>,
    provider: PaymentProvider,
  ): Promise<Readonly<RefundView>> {
    const prepared = await this.#database.transaction().execute(async (transaction) => {
      const paymentTransaction = await transaction
        .selectFrom('transactions')
        .innerJoin('services', 'services.id', 'transactions.serviceId')
        .leftJoin('deliveries', 'deliveries.transactionId', 'transactions.id')
        .select([
          'transactions.id',
          'transactions.merchantId',
          'transactions.amountMinor',
          'transactions.status',
          'services.refundPolicy as currentRefundPolicy',
          'deliveries.status as deliveryStatus',
          'deliveries.refundPolicy as deliveryRefundPolicy',
        ])
        .where('transactions.id', '=', getResourceUuid(transactionId))
        .forUpdate('transactions')
        .executeTakeFirst();

      if (paymentTransaction === undefined) {
        throw new RefundExecutionError('not_found');
      }

      const existing = await transaction
        .selectFrom('refunds')
        .select(refundColumns)
        .where('transactionId', '=', paymentTransaction.id)
        .executeTakeFirst();

      if (existing !== undefined) {
        return Object.freeze({ existing: toView(existing) });
      }

      const refundPolicy =
        paymentTransaction.deliveryRefundPolicy ?? paymentTransaction.currentRefundPolicy;
      const stateEligible = ['paid', 'delivery_review', 'delivered', 'refund_pending'].includes(
        paymentTransaction.status,
      );
      const automaticRefundEligible =
        paymentTransaction.status !== 'refund_pending' ||
        paymentTransaction.deliveryStatus === 'failed' ||
        paymentTransaction.deliveryStatus === 'timed_out';

      if (
        !stateEligible ||
        !automaticRefundEligible ||
        refundPolicy !== 'full_on_delivery_failure'
      ) {
        throw new RefundExecutionError('invalid_state');
      }

      const attempt = await transaction
        .selectFrom('paymentAttempts')
        .select(['id', 'provider', 'providerReference', 'status'])
        .where('transactionId', '=', paymentTransaction.id)
        .where('provider', '=', provider.name)
        .orderBy('attemptNumber', 'desc')
        .forUpdate()
        .executeTakeFirst();

      if (attempt?.status !== 'succeeded' || attempt.providerReference === null) {
        throw new RefundExecutionError('invalid_state');
      }

      const refund = await transaction
        .insertInto('refunds')
        .values({
          transactionId: paymentTransaction.id,
          paymentAttemptId: attempt.id,
          amountMinor: paymentTransaction.amountMinor,
          status: 'pending',
          providerReference: null,
          errorCode: null,
        })
        .returning(['id', 'createdAt'])
        .executeTakeFirstOrThrow();
      const refundId = parseResourceId(`rfd_${refund.id}`, 'rfd');
      const call = await transaction
        .insertInto('refundProviderCalls')
        .values({
          refundId: refund.id,
          operation: 'refund.create',
          requestDigest: digest({
            transactionId,
            refundId,
            providerPaymentId: attempt.providerReference,
            amountMinor: paymentTransaction.amountMinor,
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
        .set({ status: 'refund_pending', updatedAt: this.#now() })
        .where('id', '=', paymentTransaction.id)
        .executeTakeFirstOrThrow();
      return Object.freeze({
        context: Object.freeze({
          transactionId,
          merchantId: parseResourceId(`mch_${paymentTransaction.merchantId}`, 'mch'),
          paymentAttemptId: parseResourceId(`pat_${attempt.id}`, 'pat'),
          refundId,
          provider: provider.name,
          amountMinor: paymentTransaction.amountMinor,
          providerPaymentId: attempt.providerReference,
          providerRefundId: null,
          operation: 'refund.create' as const,
          callId: call.id,
          startedAt: call.startedAt,
        }),
      });
    });

    if ('existing' in prepared) {
      return prepared.existing;
    }

    return this.#invokeCreate(prepared.context, provider);
  }

  async retryCreate(
    refundId: ResourceId<'rfd'>,
    provider: PaymentProvider,
  ): Promise<Readonly<RefundView>> {
    const context = await this.#prepareExisting(refundId, provider, 'refund.create');
    return this.#invokeCreate(context, provider);
  }

  async query(
    refundId: ResourceId<'rfd'>,
    provider: PaymentProvider,
  ): Promise<Readonly<RefundView>> {
    const context = await this.#prepareExisting(refundId, provider, 'refund.query');

    if (context.providerRefundId === null) {
      throw new RefundExecutionError('provider_reference_missing');
    }

    try {
      const result = await provider.queryRefund({
        refundId,
        providerRefundId: context.providerRefundId,
        transactionId: context.transactionId,
        providerPaymentId: context.providerPaymentId,
        amount: createMoney('CNY', context.amountMinor),
      });
      return await this.#completeSuccess(context, result);
    } catch (error) {
      return this.#completeFailureAndThrow(context, error);
    }
  }

  async #invokeCreate(
    context: RefundExecutionContext,
    provider: PaymentProvider,
  ): Promise<Readonly<RefundView>> {
    try {
      const result = await provider.createRefund({
        refundId: context.refundId,
        transactionId: context.transactionId,
        providerPaymentId: context.providerPaymentId,
        amount: createMoney('CNY', context.amountMinor),
        idempotencyKey: `refund:${context.refundId}:create`,
        reason: 'full_on_delivery_failure',
      });
      return await this.#completeSuccess(context, result);
    } catch (error) {
      return this.#completeFailureAndThrow(context, error);
    }
  }

  async #prepareExisting(
    refundId: ResourceId<'rfd'>,
    provider: PaymentProvider,
    operation: 'refund.create' | 'refund.query',
  ): Promise<RefundExecutionContext> {
    return this.#database.transaction().execute(async (transaction) => {
      const refund = await transaction
        .selectFrom('refunds')
        .innerJoin('paymentAttempts', 'paymentAttempts.id', 'refunds.paymentAttemptId')
        .innerJoin('transactions', 'transactions.id', 'refunds.transactionId')
        .select([
          'refunds.id',
          'refunds.transactionId',
          'refunds.paymentAttemptId',
          'refunds.amountMinor',
          'refunds.status',
          'refunds.providerReference',
          'paymentAttempts.provider',
          'paymentAttempts.providerReference as providerPaymentId',
          'transactions.merchantId',
        ])
        .where('refunds.id', '=', getResourceUuid(refundId))
        .forUpdate('refunds')
        .executeTakeFirst();

      if (refund === undefined) {
        throw new RefundExecutionError('not_found');
      }

      if (refund.provider !== provider.name || refund.providerPaymentId === null) {
        throw new RefundExecutionError('invalid_state');
      }

      if (operation === 'refund.create' && refund.status === 'succeeded') {
        throw new RefundExecutionError('invalid_state');
      }

      if (operation === 'refund.query' && refund.providerReference === null) {
        throw new RefundExecutionError('provider_reference_missing');
      }

      if (operation === 'refund.create') {
        await transaction
          .updateTable('refunds')
          .set({ status: 'pending', errorCode: null, updatedAt: this.#now() })
          .where('id', '=', refund.id)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable('transactions')
          .set({ status: 'refund_pending', updatedAt: this.#now() })
          .where('id', '=', refund.transactionId)
          .executeTakeFirstOrThrow();
      }

      const call = await transaction
        .insertInto('refundProviderCalls')
        .values({
          refundId: refund.id,
          operation,
          requestDigest: digest({
            refundId,
            providerPaymentId: refund.providerPaymentId,
            providerRefundId: refund.providerReference,
            amountMinor: refund.amountMinor,
            operation,
          }),
          providerStatus: null,
          providerReference: refund.providerReference,
          errorKind: null,
          errorCode: null,
          completedAt: null,
          durationMs: null,
        })
        .returning(['id', 'startedAt'])
        .executeTakeFirstOrThrow();
      return Object.freeze({
        transactionId: parseResourceId(`txn_${refund.transactionId}`, 'txn'),
        merchantId: parseResourceId(`mch_${refund.merchantId}`, 'mch'),
        paymentAttemptId: parseResourceId(`pat_${refund.paymentAttemptId}`, 'pat'),
        refundId,
        provider: provider.name,
        amountMinor: refund.amountMinor,
        providerPaymentId: refund.providerPaymentId,
        providerRefundId: refund.providerReference,
        operation,
        callId: call.id,
        startedAt: call.startedAt,
      });
    });
  }

  async #completeSuccess(
    context: RefundExecutionContext,
    result: Readonly<ProviderRefundResult>,
  ): Promise<Readonly<RefundView>> {
    const completedAt = this.#now();
    const durationMs = Math.max(0, completedAt.getTime() - context.startedAt.getTime());

    return this.#database.transaction().execute(async (transaction) => {
      const previous = await transaction
        .selectFrom('refunds')
        .select(refundColumns)
        .where('id', '=', getResourceUuid(context.refundId))
        .forUpdate()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('refundProviderCalls')
        .set({
          outcome: 'succeeded',
          providerStatus: result.status,
          providerReference: result.providerRefundId,
          completedAt,
          durationMs,
        })
        .where('id', '=', context.callId)
        .where('outcome', '=', 'started')
        .executeTakeFirstOrThrow();
      const apply = shouldApplyRefundStatus(previous.status, result.status);
      const preserve = !apply && previous.status !== result.status;
      const errorCode = result.status === 'failed' ? (result.failureCode ?? 'REFUND_FAILED') : null;
      const refund = preserve
        ? previous
        : await transaction
            .updateTable('refunds')
            .set({
              status: result.status,
              providerReference: result.providerRefundId,
              errorCode,
              updatedAt: completedAt,
            })
            .where('id', '=', getResourceUuid(context.refundId))
            .returning(refundColumns)
            .executeTakeFirstOrThrow();

      if (apply) {
        await transaction
          .updateTable('transactions')
          .set({ status: transactionStatusForRefund(result.status), updatedAt: completedAt })
          .where('id', '=', getResourceUuid(context.transactionId))
          .executeTakeFirstOrThrow();
        await enqueueRefundStateChange(
          transaction,
          context,
          result.status,
          result.providerRefundId,
          errorCode,
        );
      }

      return toView(refund);
    });
  }

  async #completeFailureAndThrow(context: RefundExecutionContext, error: unknown): Promise<never> {
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
    const status: ProviderRefundStatus = providerError.kind === 'retryable' ? 'unknown' : 'failed';

    await this.#database.transaction().execute(async (transaction) => {
      const previous = await transaction
        .selectFrom('refunds')
        .select('status')
        .where('id', '=', getResourceUuid(context.refundId))
        .forUpdate()
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('refundProviderCalls')
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
      const apply = shouldApplyRefundStatus(previous.status, status);

      if (apply) {
        await transaction
          .updateTable('refunds')
          .set({
            status,
            errorCode: status === 'failed' ? providerError.code : null,
            updatedAt: completedAt,
          })
          .where('id', '=', getResourceUuid(context.refundId))
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable('transactions')
          .set({ status: transactionStatusForRefund(status), updatedAt: completedAt })
          .where('id', '=', getResourceUuid(context.transactionId))
          .executeTakeFirstOrThrow();
        await enqueueRefundStateChange(
          transaction,
          context,
          status,
          context.providerRefundId,
          providerError.code,
        );
      }
    });

    throw new RefundExecutionError('provider_error', providerError.code);
  }
}
