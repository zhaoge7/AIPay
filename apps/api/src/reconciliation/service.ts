import { formatUtcDateTime, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { PaymentProvider } from '@aipay/payment';

import { PaymentExecutionError, PaymentExecutionService } from '../payments/execution.js';
import { RefundExecutionError, RefundExecutionService } from '../payments/refunds.js';

export type ReconciliationResolution = 'consistent' | 'repaired' | 'manual_review' | 'query_failed';

export interface ReconciliationRunView {
  readonly runId: string;
  readonly provider: string;
  readonly businessDate: string;
  readonly status: 'completed';
  readonly checkedCount: number;
  readonly discrepancyCount: number;
  readonly repairedCount: number;
  readonly startedAt: string;
  readonly completedAt: string;
}

function businessDateEnd(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new Error('Invalid reconciliation business date');
  }

  const start = new Date(`${value}T00:00:00.000Z`);

  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid reconciliation business date');
  }

  return new Date(start.getTime() + 24 * 60 * 60 * 1_000);
}

function toView(row: {
  readonly id: string;
  readonly provider: string;
  readonly businessDate: string;
  readonly checkedCount: number;
  readonly discrepancyCount: number;
  readonly repairedCount: number;
  readonly startedAt: Date;
  readonly completedAt: Date | null;
}): Readonly<ReconciliationRunView> {
  if (row.completedAt === null) {
    throw new Error('Reconciliation run is incomplete');
  }

  return Object.freeze({
    runId: `rcn_${row.id}`,
    provider: row.provider,
    businessDate: row.businessDate,
    status: 'completed',
    checkedCount: row.checkedCount,
    discrepancyCount: row.discrepancyCount,
    repairedCount: row.repairedCount,
    startedAt: formatUtcDateTime(row.startedAt),
    completedAt: formatUtcDateTime(row.completedAt),
  });
}

function resolution(before: string, observed: string, after: string): ReconciliationResolution {
  if (before === observed) {
    return 'consistent';
  }

  return after === observed ? 'repaired' : 'manual_review';
}

function stableErrorCode(error: unknown): string {
  if (error instanceof PaymentExecutionError || error instanceof RefundExecutionError) {
    return error.providerCode ?? error.code.toUpperCase();
  }

  return 'RECONCILIATION_QUERY_FAILED';
}

const runColumns = [
  'id',
  'provider',
  'businessDate',
  'checkedCount',
  'discrepancyCount',
  'repairedCount',
  'startedAt',
  'completedAt',
] as const;

export class ReconciliationService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async run(
    provider: PaymentProvider,
    businessDate: string,
    limit = 1_000,
  ): Promise<Readonly<ReconciliationRunView>> {
    const end = businessDateEnd(businessDate);

    if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('Invalid reconciliation limit');
    }

    const inserted = await this.#database
      .insertInto('reconciliationRuns')
      .values({
        provider: provider.name,
        businessDate,
        status: 'running',
        errorCode: null,
        completedAt: null,
      })
      .onConflict((conflict) => conflict.columns(['provider', 'businessDate']).doNothing())
      .returning(['id', 'startedAt'])
      .executeTakeFirst();

    if (inserted === undefined) {
      const existing = await this.#database
        .selectFrom('reconciliationRuns')
        .select([...runColumns, 'status'])
        .where('provider', '=', provider.name)
        .where('businessDate', '=', businessDate)
        .executeTakeFirstOrThrow();

      if (existing.status === 'completed') {
        return toView(existing);
      }

      throw new Error('Reconciliation run is already in progress or failed');
    }

    const runId = inserted.id;
    const paymentService = new PaymentExecutionService(
      this.#database,
      'https://aipay.invalid/provider-webhooks/reconciliation',
      this.#now,
    );
    const refundService = new RefundExecutionService(this.#database, this.#now);
    let checkedCount = 0;
    let discrepancyCount = 0;
    let repairedCount = 0;

    try {
      const payments = await this.#database
        .selectFrom('paymentAttempts')
        .select(['id', 'status'])
        .where('provider', '=', provider.name)
        .where('providerReference', 'is not', null)
        .where('createdAt', '<', end)
        .orderBy('createdAt', 'asc')
        .orderBy('id', 'asc')
        .limit(limit)
        .execute();
      const refunds = await this.#database
        .selectFrom('refunds')
        .innerJoin('paymentAttempts', 'paymentAttempts.id', 'refunds.paymentAttemptId')
        .select(['refunds.id', 'refunds.status'])
        .where('paymentAttempts.provider', '=', provider.name)
        .where('refunds.providerReference', 'is not', null)
        .where('refunds.createdAt', '<', end)
        .orderBy('refunds.createdAt', 'asc')
        .orderBy('refunds.id', 'asc')
        .limit(limit)
        .execute();

      for (const payment of payments) {
        const paymentAttemptId = parseResourceId(`pat_${payment.id}`, 'pat');
        let observed: string | null = null;
        let after = payment.status;
        let itemResolution: ReconciliationResolution;
        let errorCode: string | null = null;

        try {
          const result = await paymentService.queryObserved(paymentAttemptId, provider);
          observed = result.observed.status;
          after = result.attempt.status;
          itemResolution = resolution(payment.status, observed, after);
        } catch (error) {
          const current = await this.#database
            .selectFrom('paymentAttempts')
            .select('status')
            .where('id', '=', payment.id)
            .executeTakeFirstOrThrow();
          after = current.status;
          itemResolution = 'query_failed';
          errorCode = stableErrorCode(error);
        }

        await this.#insertItem(
          runId,
          'payment',
          payment.id,
          payment.status,
          observed,
          after,
          itemResolution,
          errorCode,
        );
        checkedCount += 1;
        discrepancyCount += itemResolution === 'consistent' ? 0 : 1;
        repairedCount += itemResolution === 'repaired' ? 1 : 0;
      }

      for (const refund of refunds) {
        const refundId = parseResourceId(`rfd_${refund.id}`, 'rfd');
        let observed: string | null = null;
        let after = refund.status;
        let itemResolution: ReconciliationResolution;
        let errorCode: string | null = null;

        try {
          const result = await refundService.queryObserved(refundId, provider);
          observed = result.observed.status;
          after = result.refund.status;
          itemResolution = resolution(refund.status, observed, after);
        } catch (error) {
          const current = await this.#database
            .selectFrom('refunds')
            .select('status')
            .where('id', '=', refund.id)
            .executeTakeFirstOrThrow();
          after = current.status;
          itemResolution = 'query_failed';
          errorCode = stableErrorCode(error);
        }

        await this.#insertItem(
          runId,
          'refund',
          refund.id,
          refund.status,
          observed,
          after,
          itemResolution,
          errorCode,
        );
        checkedCount += 1;
        discrepancyCount += itemResolution === 'consistent' ? 0 : 1;
        repairedCount += itemResolution === 'repaired' ? 1 : 0;
      }

      const completedAt = this.#now();
      const completed = await this.#database
        .updateTable('reconciliationRuns')
        .set({
          status: 'completed',
          checkedCount,
          discrepancyCount,
          repairedCount,
          completedAt,
        })
        .where('id', '=', runId)
        .returning(runColumns)
        .executeTakeFirstOrThrow();
      return toView(completed);
    } catch (error) {
      await this.#database
        .updateTable('reconciliationRuns')
        .set({ status: 'failed', errorCode: 'RECONCILIATION_FAILED', completedAt: this.#now() })
        .where('id', '=', runId)
        .executeTakeFirstOrThrow();
      throw error;
    }
  }

  async #insertItem(
    runId: string,
    entityType: 'payment' | 'refund',
    entityId: string,
    before: string,
    providerStatus: string | null,
    after: string,
    itemResolution: ReconciliationResolution,
    errorCode: string | null,
  ): Promise<void> {
    await this.#database
      .insertInto('reconciliationItems')
      .values({
        runId,
        entityType,
        entityId,
        internalStatusBefore: before,
        providerStatus,
        internalStatusAfter: after,
        resolution: itemResolution,
        errorCode,
      })
      .executeTakeFirstOrThrow();
  }
}
