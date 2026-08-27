import {
  createMoney,
  formatUtcDateTime,
  getResourceUuid,
  parseResourceId,
  type ResourceId,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';
import { evaluateAmountCountPolicy, type AmountCountDenialReason } from '@aipay/policy';

const defaultTtlMs = 5 * 60 * 1_000;
const maximumTtlMs = 15 * 60 * 1_000;

export type BudgetReservationErrorCode =
  | AmountCountDenialReason
  | 'not_found'
  | 'inactive'
  | 'expired'
  | 'agent_unavailable'
  | 'invalid_ttl';

export class BudgetReservationError extends Error {
  readonly code: BudgetReservationErrorCode;

  constructor(code: BudgetReservationErrorCode) {
    super('Budget reservation failed');
    this.name = 'BudgetReservationError';
    this.code = code;
  }
}

export interface BudgetReservationView {
  readonly reservationId: ResourceId<'rsv'>;
  readonly mandateId: ResourceId<'mdt'>;
  readonly agentId: ResourceId<'agt'>;
  readonly amount: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly status: 'held';
  readonly createdAt: string;
  readonly expiresAt: string;
}

export class BudgetReservationService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async reserve(
    mandateId: ResourceId<'mdt'>,
    agentId: ResourceId<'agt'>,
    amountMinor: string,
    ttlMs: number = defaultTtlMs,
  ): Promise<Readonly<BudgetReservationView>> {
    let amount;

    try {
      amount = createMoney('CNY', amountMinor);
    } catch {
      throw new BudgetReservationError('non_positive_amount');
    }

    if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > maximumTtlMs) {
      throw new BudgetReservationError('invalid_ttl');
    }

    const now = this.#now();
    const expiresAt = new Date(now.getTime() + ttlMs);
    const outcome = await this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom('mandates')
        .select([
          'id',
          'agentId',
          'status',
          'validUntil',
          'maxPerTransactionAmountMinor',
          'totalBudgetAmountMinor',
          'maxTransactions',
          'spentAmountMinor',
          'completedTransactionCount',
          'reservedAmountMinor',
          'reservedTransactionCount',
        ])
        .where('id', '=', getResourceUuid(mandateId))
        .forUpdate()
        .executeTakeFirst();

      if (row === undefined) {
        return Object.freeze({ error: 'not_found' as const });
      }

      if (now >= row.validUntil && (row.status === 'active' || row.status === 'paused')) {
        await transaction
          .updateTable('mandates')
          .set({ status: 'expired', statusChangedAt: now })
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow();
        return Object.freeze({ error: 'expired' as const });
      }

      if (row.status !== 'active') {
        return Object.freeze({ error: 'inactive' as const });
      }

      if (row.agentId !== getResourceUuid(agentId)) {
        return Object.freeze({ error: 'agent_unavailable' as const });
      }

      const agent = await transaction
        .selectFrom('agents')
        .select('status')
        .where('id', '=', row.agentId)
        .executeTakeFirst();

      if (agent?.status !== 'enabled') {
        return Object.freeze({ error: 'agent_unavailable' as const });
      }

      const decision = evaluateAmountCountPolicy(
        {
          maxPerTransaction: createMoney('CNY', row.maxPerTransactionAmountMinor),
          totalBudget: createMoney('CNY', row.totalBudgetAmountMinor),
          maxTransactions: row.maxTransactions,
        },
        {
          spentAmountMinor: (
            BigInt(row.spentAmountMinor) + BigInt(row.reservedAmountMinor)
          ).toString(),
          completedTransactionCount: row.completedTransactionCount + row.reservedTransactionCount,
        },
        amount,
      );

      if (!decision.allowed) {
        return Object.freeze({ error: decision.reason });
      }

      const reservation = await transaction
        .insertInto('budgetReservations')
        .values({
          mandateId: row.id,
          agentId: row.agentId,
          amountMinor: amount.amountMinor,
          expiresAt,
          finalizedAt: null,
        })
        .returning(['id', 'createdAt'])
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('mandates')
        .set({
          reservedAmountMinor: (
            BigInt(row.reservedAmountMinor) + BigInt(amount.amountMinor)
          ).toString(),
          reservedTransactionCount: row.reservedTransactionCount + 1,
        })
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow();

      return Object.freeze({ reservation });
    });

    if ('error' in outcome) {
      throw new BudgetReservationError(outcome.error);
    }

    return Object.freeze({
      reservationId: parseResourceId(`rsv_${outcome.reservation.id}`, 'rsv'),
      mandateId,
      agentId,
      amount,
      status: 'held',
      createdAt: formatUtcDateTime(outcome.reservation.createdAt),
      expiresAt: formatUtcDateTime(expiresAt),
    });
  }
}
