import { createMoney, formatUtcDateTime, getResourceUuid, type ResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';

export type TimelinePhase =
  | 'authorization'
  | 'quote'
  | 'transaction'
  | 'payment'
  | 'delivery'
  | 'refund'
  | 'notification'
  | 'reconciliation';

export interface TimelineEvent {
  readonly eventId: string;
  readonly phase: TimelinePhase;
  readonly eventType: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly occurredAt: string;
  readonly completedAt: string | null;
  readonly status: string;
  readonly provider: string | null;
  readonly operation: string | null;
  readonly errorCode: string | null;
}

export interface TransactionTimeline {
  readonly transaction: Readonly<{
    transactionId: ResourceId<'txn'>;
    mandateId: ResourceId<'mdt'>;
    quoteId: ResourceId<'qte'>;
    agentId: ResourceId<'agt'>;
    merchantId: ResourceId<'mch'>;
    serviceId: ResourceId<'svc'>;
    amount: Readonly<{ currency: 'CNY'; amountMinor: string }>;
    status: string;
  }>;
  readonly events: readonly Readonly<TimelineEvent>[];
}

export class TimelineError extends Error {
  readonly code = 'not_found';

  constructor() {
    super('Transaction timeline was not found');
    this.name = 'TimelineError';
  }
}

function event(input: {
  readonly eventId: string;
  readonly phase: TimelinePhase;
  readonly eventType: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly occurredAt: Date;
  readonly completedAt?: Date | null;
  readonly status: string;
  readonly provider?: string | null;
  readonly operation?: string | null;
  readonly errorCode?: string | null;
}): Readonly<TimelineEvent> {
  return Object.freeze({
    eventId: input.eventId,
    phase: input.phase,
    eventType: input.eventType,
    objectType: input.objectType,
    objectId: input.objectId,
    occurredAt: formatUtcDateTime(input.occurredAt),
    completedAt:
      input.completedAt === undefined || input.completedAt === null
        ? null
        : formatUtcDateTime(input.completedAt),
    status: input.status,
    provider: input.provider ?? null,
    operation: input.operation ?? null,
    errorCode: input.errorCode ?? null,
  });
}

export class TransactionTimelineService {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async get(
    developerId: ResourceId<'dev'>,
    transactionId: ResourceId<'txn'>,
  ): Promise<Readonly<TransactionTimeline>> {
    const paymentTransaction = await this.#database
      .selectFrom('transactions')
      .innerJoin('merchants', 'merchants.id', 'transactions.merchantId')
      .select([
        'transactions.id',
        'transactions.quoteId',
        'transactions.mandateId',
        'transactions.agentId',
        'transactions.merchantId',
        'transactions.serviceId',
        'transactions.currency',
        'transactions.amountMinor',
        'transactions.status',
        'transactions.principalId',
        'transactions.createdAt',
        'transactions.updatedAt',
        'merchants.developerId as merchantDeveloperId',
      ])
      .where('transactions.id', '=', getResourceUuid(transactionId))
      .executeTakeFirst();

    if (
      paymentTransaction === undefined ||
      (paymentTransaction.principalId !== getResourceUuid(developerId) &&
        paymentTransaction.merchantDeveloperId !== getResourceUuid(developerId))
    ) {
      throw new TimelineError();
    }

    const [
      mandate,
      quote,
      attempts,
      paymentCalls,
      proofs,
      deliveries,
      refunds,
      refundCalls,
      outbox,
    ] = await Promise.all([
      this.#database
        .selectFrom('mandates')
        .select(['id', 'status', 'issuedAt', 'statusChangedAt'])
        .where('id', '=', paymentTransaction.mandateId)
        .executeTakeFirstOrThrow(),
      this.#database
        .selectFrom('quotes')
        .select(['id', 'status', 'issuedAt', 'createdAt'])
        .where('id', '=', paymentTransaction.quoteId)
        .executeTakeFirstOrThrow(),
      this.#database
        .selectFrom('paymentAttempts')
        .select(['id', 'provider', 'status', 'errorCode', 'createdAt', 'updatedAt'])
        .where('transactionId', '=', paymentTransaction.id)
        .orderBy('createdAt', 'asc')
        .execute(),
      this.#database
        .selectFrom('paymentProviderCalls')
        .innerJoin('paymentAttempts', 'paymentAttempts.id', 'paymentProviderCalls.paymentAttemptId')
        .select([
          'paymentProviderCalls.id',
          'paymentProviderCalls.operation',
          'paymentProviderCalls.outcome',
          'paymentProviderCalls.providerStatus',
          'paymentProviderCalls.errorCode',
          'paymentProviderCalls.startedAt',
          'paymentProviderCalls.completedAt',
          'paymentAttempts.provider',
        ])
        .where('paymentAttempts.transactionId', '=', paymentTransaction.id)
        .orderBy('paymentProviderCalls.startedAt', 'asc')
        .execute(),
      this.#database
        .selectFrom('paymentProofs')
        .select(['id', 'status', 'issuedAt', 'consumedAt'])
        .where('transactionId', '=', paymentTransaction.id)
        .orderBy('issuedAt', 'asc')
        .execute(),
      this.#database
        .selectFrom('deliveries')
        .select(['id', 'status', 'errorCode', 'createdAt', 'updatedAt', 'deliveredAt'])
        .where('transactionId', '=', paymentTransaction.id)
        .execute(),
      this.#database
        .selectFrom('refunds')
        .select(['id', 'status', 'errorCode', 'createdAt', 'updatedAt'])
        .where('transactionId', '=', paymentTransaction.id)
        .execute(),
      this.#database
        .selectFrom('refundProviderCalls')
        .innerJoin('refunds', 'refunds.id', 'refundProviderCalls.refundId')
        .innerJoin('paymentAttempts', 'paymentAttempts.id', 'refunds.paymentAttemptId')
        .select([
          'refundProviderCalls.id',
          'refundProviderCalls.operation',
          'refundProviderCalls.outcome',
          'refundProviderCalls.providerStatus',
          'refundProviderCalls.errorCode',
          'refundProviderCalls.startedAt',
          'refundProviderCalls.completedAt',
          'paymentAttempts.provider',
        ])
        .where('refunds.transactionId', '=', paymentTransaction.id)
        .orderBy('refundProviderCalls.startedAt', 'asc')
        .execute(),
      this.#database
        .selectFrom('outboxEvents')
        .select(['id', 'eventType', 'status', 'lastErrorCode', 'createdAt', 'publishedAt'])
        .where('aggregateType', '=', 'transaction')
        .where('aggregateId', '=', paymentTransaction.id)
        .orderBy('createdAt', 'asc')
        .execute(),
    ]);
    const timeline: TimelineEvent[] = [];
    timeline.push(
      event({
        eventId: `mdt_${mandate.id}`,
        phase: 'authorization',
        eventType: 'authorization.mandate',
        objectType: 'mandate',
        objectId: `mdt_${mandate.id}`,
        occurredAt: mandate.issuedAt,
        completedAt: mandate.statusChangedAt,
        status: mandate.status,
      }),
      event({
        eventId: `qte_${quote.id}`,
        phase: 'quote',
        eventType: 'quote.created',
        objectType: 'quote',
        objectId: `qte_${quote.id}`,
        occurredAt: quote.createdAt,
        completedAt: quote.issuedAt,
        status: quote.status,
      }),
      event({
        eventId: transactionId,
        phase: 'transaction',
        eventType: 'transaction.created',
        objectType: 'transaction',
        objectId: transactionId,
        occurredAt: paymentTransaction.createdAt,
        completedAt: paymentTransaction.updatedAt,
        status: paymentTransaction.status,
      }),
    );

    for (const attempt of attempts) {
      timeline.push(
        event({
          eventId: `pat_${attempt.id}`,
          phase: 'payment',
          eventType: 'payment.attempt',
          objectType: 'payment_attempt',
          objectId: `pat_${attempt.id}`,
          occurredAt: attempt.createdAt,
          completedAt: attempt.updatedAt,
          status: attempt.status,
          provider: attempt.provider,
          errorCode: attempt.errorCode,
        }),
      );
    }

    for (const call of paymentCalls) {
      timeline.push(
        event({
          eventId: `pcl_${call.id}`,
          phase: 'payment',
          eventType: 'payment.provider_call',
          objectType: 'payment_provider_call',
          objectId: `pcl_${call.id}`,
          occurredAt: call.startedAt,
          completedAt: call.completedAt,
          status: call.providerStatus ?? call.outcome,
          provider: call.provider,
          operation: call.operation,
          errorCode: call.errorCode,
        }),
      );
    }

    for (const proof of proofs) {
      timeline.push(
        event({
          eventId: `ppf_${proof.id}`,
          phase: 'payment',
          eventType: 'payment.proof',
          objectType: 'payment_proof',
          objectId: `ppf_${proof.id}`,
          occurredAt: proof.issuedAt,
          completedAt: proof.consumedAt,
          status: proof.status,
        }),
      );
    }

    for (const delivery of deliveries) {
      timeline.push(
        event({
          eventId: `dlv_${delivery.id}`,
          phase: 'delivery',
          eventType: 'delivery.state',
          objectType: 'delivery',
          objectId: `dlv_${delivery.id}`,
          occurredAt: delivery.createdAt,
          completedAt: delivery.deliveredAt ?? delivery.updatedAt,
          status: delivery.status,
          errorCode: delivery.errorCode,
        }),
      );
    }

    for (const refund of refunds) {
      timeline.push(
        event({
          eventId: `rfd_${refund.id}`,
          phase: 'refund',
          eventType: 'refund.state',
          objectType: 'refund',
          objectId: `rfd_${refund.id}`,
          occurredAt: refund.createdAt,
          completedAt: refund.updatedAt,
          status: refund.status,
          errorCode: refund.errorCode,
        }),
      );
    }

    for (const call of refundCalls) {
      timeline.push(
        event({
          eventId: `rcl_${call.id}`,
          phase: 'refund',
          eventType: 'refund.provider_call',
          objectType: 'refund_provider_call',
          objectId: `rcl_${call.id}`,
          occurredAt: call.startedAt,
          completedAt: call.completedAt,
          status: call.providerStatus ?? call.outcome,
          provider: call.provider,
          operation: call.operation,
          errorCode: call.errorCode,
        }),
      );
    }

    for (const notification of outbox) {
      timeline.push(
        event({
          eventId: `obx_${notification.id}`,
          phase: 'notification',
          eventType: notification.eventType,
          objectType: 'outbox_event',
          objectId: `obx_${notification.id}`,
          occurredAt: notification.createdAt,
          completedAt: notification.publishedAt,
          status: notification.status,
          errorCode: notification.lastErrorCode,
        }),
      );
    }

    const entityIds = [...attempts.map(({ id }) => id), ...refunds.map(({ id }) => id)];

    if (entityIds.length > 0) {
      const reconciliationItems = await this.#database
        .selectFrom('reconciliationItems')
        .innerJoin('reconciliationRuns', 'reconciliationRuns.id', 'reconciliationItems.runId')
        .select([
          'reconciliationItems.id',
          'reconciliationItems.entityType',
          'reconciliationItems.entityId',
          'reconciliationItems.resolution',
          'reconciliationItems.errorCode',
          'reconciliationItems.createdAt',
          'reconciliationRuns.provider',
          'reconciliationRuns.completedAt',
        ])
        .where('reconciliationItems.entityId', 'in', entityIds)
        .orderBy('reconciliationItems.createdAt', 'asc')
        .execute();

      for (const item of reconciliationItems) {
        timeline.push(
          event({
            eventId: `rci_${item.id}`,
            phase: 'reconciliation',
            eventType: 'reconciliation.item',
            objectType: item.entityType,
            objectId:
              item.entityType === 'payment' ? `pat_${item.entityId}` : `rfd_${item.entityId}`,
            occurredAt: item.createdAt,
            completedAt: item.completedAt,
            status: item.resolution,
            provider: item.provider,
            errorCode: item.errorCode,
          }),
        );
      }
    }

    timeline.sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.eventId.localeCompare(right.eventId),
    );
    return Object.freeze({
      transaction: Object.freeze({
        transactionId,
        mandateId: `mdt_${paymentTransaction.mandateId}` as ResourceId<'mdt'>,
        quoteId: `qte_${paymentTransaction.quoteId}` as ResourceId<'qte'>,
        agentId: `agt_${paymentTransaction.agentId}` as ResourceId<'agt'>,
        merchantId: `mch_${paymentTransaction.merchantId}` as ResourceId<'mch'>,
        serviceId: `svc_${paymentTransaction.serviceId}` as ResourceId<'svc'>,
        amount: createMoney(paymentTransaction.currency, paymentTransaction.amountMinor),
        status: paymentTransaction.status,
      }),
      events: Object.freeze(timeline),
    });
  }
}
