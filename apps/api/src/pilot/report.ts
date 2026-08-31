import {
  getResourceUuid,
  parseResourceId,
  type PilotManifest,
  type ResourceId,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';

const paidEvent = 'transaction.paid';
const deliveredEvent = 'transaction.delivered';

export class PilotReportError extends Error {
  readonly code: 'scope_not_found' | 'catalog_mismatch';

  constructor(code: PilotReportError['code']) {
    super(`Pilot report failed: ${code}`);
    this.name = 'PilotReportError';
    this.code = code;
  }
}

interface IndexedRow {
  readonly transactionId: string;
}

function indexByTransaction<Row extends IndexedRow>(rows: readonly Row[]) {
  const index = new Map<string, Row[]>();

  for (const row of rows) {
    const group = index.get(row.transactionId) ?? [];
    group.push(row);
    index.set(row.transactionId, group);
  }

  return index;
}

function percentage(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(2));
}

function durationMinutes(startedAt: string, completedAt: string): number {
  return Number(((Date.parse(completedAt) - Date.parse(startedAt)) / 60_000).toFixed(2));
}

function summarizeFailures(manifest: PilotManifest) {
  const groups = new Map<string, number>();

  for (const failure of manifest.failures) {
    const key = `${failure.actor}:${failure.phase}:${failure.code}:${failure.source}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => {
      const [actor, phase, code, source] = key.split(':') as [string, string, string, string];
      return Object.freeze({ actor, phase, code, source, count });
    });
}

export async function buildPilotReport(
  database: Database,
  manifest: PilotManifest,
  manifestSha256: string,
  generatedAt = new Date(),
) {
  const merchantId = getResourceUuid(parseResourceId(manifest.merchant.merchantId, 'mch'));
  const serviceId = getResourceUuid(parseResourceId(manifest.merchant.serviceId, 'svc'));
  const agentId = getResourceUuid(parseResourceId(manifest.agent.agentId, 'agt'));
  const [catalog, agent] = await Promise.all([
    database
      .selectFrom('services')
      .innerJoin('merchants', 'merchants.id', 'services.merchantId')
      .select([
        'services.merchantId',
        'services.id as serviceId',
        'services.serviceType',
        'services.unit',
        'services.unitPriceAmountMinor',
        'services.currency',
        'services.status as serviceStatus',
        'merchants.status as merchantStatus',
      ])
      .where('services.id', '=', serviceId)
      .where('services.merchantId', '=', merchantId)
      .executeTakeFirst(),
    database
      .selectFrom('agents')
      .select(['id', 'status'])
      .where('id', '=', agentId)
      .executeTakeFirst(),
  ]);

  if (catalog === undefined || agent === undefined) {
    throw new PilotReportError('scope_not_found');
  }

  if (
    catalog.serviceType !== manifest.merchant.serviceType ||
    catalog.unit !== manifest.merchant.unit ||
    catalog.unitPriceAmountMinor !== manifest.merchant.unitPrice.amountMinor
  ) {
    throw new PilotReportError('catalog_mismatch');
  }

  const transactions = await database
    .selectFrom('transactions')
    .select(['id', 'mandateId', 'agentId', 'status', 'amountMinor', 'createdAt'])
    .where('agentId', '=', agentId)
    .where('merchantId', '=', merchantId)
    .where('serviceId', '=', serviceId)
    .where('createdAt', '>=', new Date(manifest.window.startedAt))
    .where('createdAt', '<', new Date(manifest.window.endedAt))
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .execute();
  const transactionIds = transactions.map(({ id }) => id);

  const [attempts, proofs, deliveries, outbox] =
    transactionIds.length === 0
      ? [[], [], [], []]
      : await Promise.all([
          database
            .selectFrom('paymentAttempts')
            .select([
              'id',
              'transactionId',
              'reservationId',
              'provider',
              'providerReference',
              'status',
            ])
            .where('transactionId', 'in', transactionIds)
            .execute(),
          database
            .selectFrom('paymentProofs')
            .select(['id', 'transactionId', 'paymentAttemptId', 'status'])
            .where('transactionId', 'in', transactionIds)
            .execute(),
          database
            .selectFrom('deliveries')
            .select([
              'transactionId',
              'paymentProofId',
              'status',
              'resultDigest',
              'proofScheme',
              'proofKeyId',
              'proofValue',
            ])
            .where('transactionId', 'in', transactionIds)
            .execute(),
          database
            .selectFrom('outboxEvents')
            .select(['aggregateId as transactionId', 'eventType', 'status'])
            .where('aggregateType', '=', 'transaction')
            .where('aggregateId', 'in', transactionIds)
            .where('eventType', 'in', [paidEvent, deliveredEvent])
            .execute(),
        ]);
  const attemptIds = attempts.map(({ id }) => id);
  const reservationIds = attempts.flatMap(({ reservationId }) =>
    reservationId === null ? [] : [reservationId],
  );
  const [providerCalls, reservations] = await Promise.all([
    attemptIds.length === 0
      ? []
      : database
          .selectFrom('paymentProviderCalls')
          .innerJoin(
            'paymentAttempts',
            'paymentAttempts.id',
            'paymentProviderCalls.paymentAttemptId',
          )
          .select([
            'paymentAttempts.transactionId',
            'paymentProviderCalls.paymentAttemptId',
            'paymentProviderCalls.operation',
            'paymentProviderCalls.outcome',
            'paymentProviderCalls.providerStatus',
          ])
          .where('paymentProviderCalls.paymentAttemptId', 'in', attemptIds)
          .execute(),
    reservationIds.length === 0
      ? []
      : database
          .selectFrom('budgetReservations')
          .select(['id', 'mandateId', 'agentId', 'amountMinor', 'status'])
          .where('id', 'in', reservationIds)
          .execute(),
  ]);
  const attemptsByTransaction = indexByTransaction(attempts);
  const proofsByTransaction = indexByTransaction(proofs);
  const deliveriesByTransaction = indexByTransaction(deliveries);
  const outboxByTransaction = indexByTransaction(outbox);
  const callsByTransaction = indexByTransaction(providerCalls);
  const reservationsById = new Map(
    reservations.map((reservation) => [reservation.id, reservation]),
  );
  const acceptedTransactionIds: ResourceId<'txn'>[] = [];
  const rejectedTransactions: {
    readonly transactionId: ResourceId<'txn'>;
    readonly reasons: readonly string[];
  }[] = [];
  let successfulPaymentCount = 0;
  let successfulDeliveryCount = 0;
  let unauthorizedPaymentCount = 0;
  let duplicateChargeCount = 0;
  let fakeProviderCount = 0;
  let auditCompleteCount = 0;
  let acceptedAmountMinor = 0n;

  for (const transaction of transactions) {
    const transactionAttempts = attemptsByTransaction.get(transaction.id) ?? [];
    const successfulAttempts = transactionAttempts.filter(({ status }) => status === 'succeeded');
    const transactionProofs = proofsByTransaction.get(transaction.id) ?? [];
    const transactionDeliveries = deliveriesByTransaction.get(transaction.id) ?? [];
    const transactionOutbox = outboxByTransaction.get(transaction.id) ?? [];
    const transactionCalls = callsByTransaction.get(transaction.id) ?? [];
    const reasons = new Set<string>();
    const successfulAttempt = successfulAttempts[0];
    const proof = transactionProofs[0];
    const delivery = transactionDeliveries[0];
    const fakeProvider = successfulAttempts.some(({ provider }) => provider.startsWith('fake'));
    const hasInvalidReservation = successfulAttempts.some((attempt) => {
      const reservation =
        attempt.reservationId === null ? undefined : reservationsById.get(attempt.reservationId);
      return (
        reservation?.mandateId !== transaction.mandateId ||
        reservation.agentId !== transaction.agentId ||
        reservation.amountMinor !== transaction.amountMinor ||
        reservation.status !== 'confirmed'
      );
    });
    const hasSuccessfulProviderCall =
      successfulAttempt !== undefined &&
      transactionCalls.some(
        (call) =>
          call.paymentAttemptId === successfulAttempt.id &&
          call.outcome === 'succeeded' &&
          call.providerStatus === 'succeeded',
      );
    const hasPaidEvent = transactionOutbox.some(({ eventType }) => eventType === paidEvent);
    const hasDeliveredEvent = transactionOutbox.some(
      ({ eventType }) => eventType === deliveredEvent,
    );

    if (successfulAttempts.length > 0) {
      successfulPaymentCount += 1;
    }

    if (transactionDeliveries.some(({ status }) => status === 'succeeded')) {
      successfulDeliveryCount += 1;
    }

    if (hasInvalidReservation) {
      unauthorizedPaymentCount += 1;
      reasons.add('missing_or_misbound_budget_reservation');
    }

    if (successfulAttempts.length > 1) {
      duplicateChargeCount += 1;
      reasons.add('multiple_successful_payment_attempts');
    } else if (successfulAttempts.length === 0) {
      reasons.add('missing_successful_payment');
    }

    if (fakeProvider) {
      fakeProviderCount += 1;
      reasons.add('fake_provider');
    }

    if (successfulAttempt?.providerReference === null) {
      reasons.add('missing_provider_reference');
    }

    if (!hasSuccessfulProviderCall) {
      reasons.add('incomplete_provider_call_ledger');
    }

    if (proof?.paymentAttemptId !== successfulAttempt?.id || proof?.status !== 'consumed') {
      reasons.add('missing_or_unconsumed_payment_proof');
    }

    if (
      delivery?.paymentProofId !== proof?.id ||
      delivery?.status !== 'succeeded' ||
      delivery.resultDigest?.byteLength !== 32 ||
      delivery.proofScheme !== 'aipay-jcs-ed25519-v1' ||
      delivery.proofKeyId === null ||
      delivery.proofValue?.byteLength !== 64
    ) {
      reasons.add('missing_or_invalid_delivery_receipt');
    }

    if (transaction.status !== 'delivered' && transaction.status !== 'settled') {
      reasons.add('transaction_not_delivered');
    }

    if (!hasPaidEvent || !hasDeliveredEvent) {
      reasons.add('incomplete_outbox_timeline');
    }

    const auditComplete =
      hasSuccessfulProviderCall &&
      proof?.status === 'consumed' &&
      delivery?.status === 'succeeded' &&
      hasPaidEvent &&
      hasDeliveredEvent;

    if (auditComplete) {
      auditCompleteCount += 1;
    }

    const transactionId = `txn_${transaction.id}` as ResourceId<'txn'>;

    if (reasons.size === 0) {
      acceptedTransactionIds.push(transactionId);
      acceptedAmountMinor += BigInt(transaction.amountMinor);
    } else {
      rejectedTransactions.push(
        Object.freeze({ transactionId, reasons: Object.freeze([...reasons].sort()) }),
      );
    }
  }

  const scopedTransactionCount = transactions.length;
  const acceptedCallCount = acceptedTransactionIds.length;
  const auditCompletenessPercent = percentage(auditCompleteCount, scopedTransactionCount);
  const commercialIntentConfirmed = manifest.commercialIntent.status !== 'pending';
  const gateMvpDatabaseEligible =
    acceptedCallCount >= 1 &&
    unauthorizedPaymentCount === 0 &&
    duplicateChargeCount === 0 &&
    auditCompletenessPercent === 100 &&
    commercialIntentConfirmed;

  return Object.freeze({
    schemaVersion: '1',
    pilotId: manifest.pilotId,
    manifestSha256,
    generatedAt: generatedAt.toISOString(),
    scope: Object.freeze({
      ...manifest.window,
      merchantId: manifest.merchant.merchantId,
      serviceId: manifest.merchant.serviceId,
      agentId: manifest.agent.agentId,
    }),
    catalog: Object.freeze({
      matched: true,
      merchantStatus: catalog.merchantStatus,
      serviceStatus: catalog.serviceStatus,
      agentStatus: agent.status,
      serviceType: catalog.serviceType,
      unit: catalog.unit,
      unitPrice: Object.freeze({
        currency: catalog.currency,
        amountMinor: catalog.unitPriceAmountMinor,
      }),
    }),
    onboarding: Object.freeze({
      merchantMinutes: durationMinutes(
        manifest.merchant.onboardingStartedAt,
        manifest.merchant.onboardingCompletedAt,
      ),
      agentMinutes: durationMinutes(
        manifest.agent.onboardingStartedAt,
        manifest.agent.onboardingCompletedAt,
      ),
      failureCount: manifest.failures.length,
      unresolvedFailureCount: manifest.failures.filter(({ resolvedAt }) => resolvedAt === null)
        .length,
      failureGroups: Object.freeze(summarizeFailures(manifest)),
    }),
    metrics: Object.freeze({
      scopedTransactionCount,
      acceptedCallCount,
      rejectedCallCount: rejectedTransactions.length,
      successfulPaymentCount,
      successfulDeliveryCount,
      unauthorizedPaymentCount,
      duplicateChargeCount,
      fakeProviderCount,
      auditCompleteCount,
      auditCompletenessPercent,
      paymentSuccessPercent: percentage(successfulPaymentCount, scopedTransactionCount),
      deliverySuccessPercent: percentage(successfulDeliveryCount, scopedTransactionCount),
      acceptedAmountMinor: acceptedAmountMinor.toString(),
      currency: 'CNY',
    }),
    automatedChecks: Object.freeze({
      partnerCatalogMatched: true,
      externalAgentExists: true,
      firstEndToEndTransaction: acceptedCallCount >= 1,
      oneThousandAcceptedCalls: acceptedCallCount >= 1_000,
      developerExperienceMeasured: true,
      commercialIntentConfirmed,
      gateMvpDatabaseEligible,
      externalEvidenceReviewRequired: true,
    }),
    acceptedTransactionIds: Object.freeze(acceptedTransactionIds),
    rejectedTransactions: Object.freeze(rejectedTransactions),
  });
}
