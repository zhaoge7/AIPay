import { createHash, timingSafeEqual } from 'node:crypto';

import { parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type {
  PaymentProvider,
  ProviderPaymentStatus,
  ProviderWebhookEvent,
  ProviderWebhookRequest,
} from '@aipay/payment';

import { enqueuePaymentStateChange, transactionStatus } from './state.js';

export type PaymentWebhookErrorCode =
  'unsupported_event' | 'event_conflict' | 'payment_not_found' | 'amount_mismatch';

export class PaymentWebhookError extends Error {
  readonly code: PaymentWebhookErrorCode;

  constructor(code: PaymentWebhookErrorCode) {
    super('Payment Webhook processing failed');
    this.name = 'PaymentWebhookError';
    this.code = code;
  }
}

export interface PaymentWebhookResult {
  readonly eventId: string;
  readonly event: Extract<ProviderWebhookEvent, { readonly eventType: 'payment.updated' }>;
  readonly duplicate: boolean;
  readonly outcome: 'applied' | 'ignored';
}

function eventDigest(event: ProviderWebhookEvent): Buffer {
  return createHash('sha256').update(JSON.stringify(event), 'utf8').digest();
}

function shouldApply(current: ProviderPaymentStatus, incoming: ProviderPaymentStatus): boolean {
  if (current === incoming || current === 'succeeded' || current === 'failed') {
    return false;
  }

  return !(current === 'unknown' && incoming === 'pending');
}

export class PaymentWebhookService {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async process(
    provider: PaymentProvider,
    request: ProviderWebhookRequest,
  ): Promise<Readonly<PaymentWebhookResult>> {
    const event = await provider.verifyWebhook(request);

    if (event.eventType !== 'payment.updated') {
      throw new PaymentWebhookError('unsupported_event');
    }

    const digest = eventDigest(event);
    return this.#database.transaction().execute(async (transaction) => {
      const inserted = await transaction
        .insertInto('providerWebhookEvents')
        .values({
          provider: provider.name,
          providerEventId: event.eventId,
          eventType: event.eventType,
          payloadDigest: digest,
          paymentAttemptId: null,
          outcome: 'processing',
          receivedAt: new Date(request.receivedAt),
          occurredAt: new Date(event.occurredAt),
        })
        .onConflict((conflict) => conflict.columns(['provider', 'providerEventId']).doNothing())
        .returning('id')
        .executeTakeFirst();

      if (inserted === undefined) {
        const existing = await transaction
          .selectFrom('providerWebhookEvents')
          .select(['payloadDigest', 'outcome'])
          .where('provider', '=', provider.name)
          .where('providerEventId', '=', event.eventId)
          .executeTakeFirstOrThrow();

        if (
          existing.payloadDigest.byteLength !== digest.byteLength ||
          !timingSafeEqual(existing.payloadDigest, digest)
        ) {
          throw new PaymentWebhookError('event_conflict');
        }

        return Object.freeze({
          eventId: event.eventId,
          event,
          duplicate: true,
          outcome: existing.outcome === 'applied' ? 'applied' : 'ignored',
        });
      }

      const attempt = await transaction
        .selectFrom('paymentAttempts')
        .innerJoin('transactions', 'transactions.id', 'paymentAttempts.transactionId')
        .select([
          'paymentAttempts.id',
          'paymentAttempts.transactionId',
          'paymentAttempts.currency',
          'paymentAttempts.amountMinor',
          'paymentAttempts.status',
          'transactions.merchantId',
        ])
        .where('paymentAttempts.provider', '=', provider.name)
        .where('paymentAttempts.providerReference', '=', event.providerPaymentId)
        .forUpdate('paymentAttempts')
        .executeTakeFirst();

      if (attempt === undefined) {
        throw new PaymentWebhookError('payment_not_found');
      }

      if (attempt.amountMinor !== event.amount.amountMinor) {
        throw new PaymentWebhookError('amount_mismatch');
      }

      const apply = shouldApply(attempt.status, event.status);

      if (apply) {
        await transaction
          .updateTable('paymentAttempts')
          .set({
            status: event.status,
            errorCode: event.failureCode,
            updatedAt: new Date(request.receivedAt),
          })
          .where('id', '=', attempt.id)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable('transactions')
          .set({
            status: transactionStatus(event.status),
            updatedAt: new Date(request.receivedAt),
          })
          .where('id', '=', attempt.transactionId)
          .executeTakeFirstOrThrow();
        await enqueuePaymentStateChange(
          transaction,
          {
            transactionId: parseResourceId(`txn_${attempt.transactionId}`, 'txn'),
            merchantId: parseResourceId(`mch_${attempt.merchantId}`, 'mch'),
            paymentAttemptId: parseResourceId(`pat_${attempt.id}`, 'pat'),
            provider: provider.name,
          },
          event.status,
          event.providerPaymentId,
          event.failureCode,
          event.providerTransactionId,
        );
      }

      const outcome = apply ? 'applied' : 'ignored';
      await transaction
        .updateTable('providerWebhookEvents')
        .set({ paymentAttemptId: attempt.id, outcome })
        .where('id', '=', inserted.id)
        .executeTakeFirstOrThrow();
      return Object.freeze({ eventId: event.eventId, event, duplicate: false, outcome });
    });
  }
}
