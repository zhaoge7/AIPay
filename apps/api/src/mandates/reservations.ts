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
  | 'invalid_ttl'
  | 'invalid_state'
  | 'not_expired'
  | 'counter_invariant';

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
  readonly status: 'held' | 'released' | 'confirmed' | 'expired';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly finalizedAt: string | null;
  readonly finalizationReason:
    'payment_failed' | 'cancelled' | 'payment_succeeded' | 'timeout' | null;
}

type ReleaseReason = 'payment_failed' | 'cancelled';
type FinalStatus = 'released' | 'confirmed' | 'expired';
type FinalReason = Exclude<BudgetReservationView['finalizationReason'], null>;

interface ReservationRow {
  readonly id: string;
  readonly mandateId: string;
  readonly agentId: string;
  readonly currency: 'CNY';
  readonly amountMinor: string;
  readonly status: BudgetReservationView['status'];
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly finalizedAt: Date | null;
  readonly finalizationReason: string | null;
}

const reservationColumns = [
  'id',
  'mandateId',
  'agentId',
  'currency',
  'amountMinor',
  'status',
  'createdAt',
  'expiresAt',
  'finalizedAt',
  'finalizationReason',
] as const;

function toReservationView(row: ReservationRow): Readonly<BudgetReservationView> {
  return Object.freeze({
    reservationId: parseResourceId(`rsv_${row.id}`, 'rsv'),
    mandateId: parseResourceId(`mdt_${row.mandateId}`, 'mdt'),
    agentId: parseResourceId(`agt_${row.agentId}`, 'agt'),
    amount: createMoney(row.currency, row.amountMinor),
    status: row.status,
    createdAt: formatUtcDateTime(row.createdAt),
    expiresAt: formatUtcDateTime(row.expiresAt),
    finalizedAt: row.finalizedAt === null ? null : formatUtcDateTime(row.finalizedAt),
    finalizationReason: row.finalizationReason as BudgetReservationView['finalizationReason'],
  });
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
          finalizationReason: null,
        })
        .returning(reservationColumns)
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

    return toReservationView(outcome.reservation);
  }

  async #finalize(
    reservationId: ResourceId<'rsv'>,
    targetStatus: FinalStatus,
    reason: FinalReason,
  ): Promise<Readonly<BudgetReservationView>> {
    const now = this.#now();

    const outcome = await this.#database.transaction().execute(async (transaction) => {
      const reference = await transaction
        .selectFrom('budgetReservations')
        .select('mandateId')
        .where('id', '=', getResourceUuid(reservationId))
        .executeTakeFirst();

      if (reference === undefined) {
        return Object.freeze({ error: 'not_found' as const });
      }

      const mandate = await transaction
        .selectFrom('mandates')
        .select([
          'id',
          'spentAmountMinor',
          'completedTransactionCount',
          'reservedAmountMinor',
          'reservedTransactionCount',
        ])
        .where('id', '=', reference.mandateId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const reservation = await transaction
        .selectFrom('budgetReservations')
        .select(reservationColumns)
        .where('id', '=', getResourceUuid(reservationId))
        .forUpdate()
        .executeTakeFirstOrThrow();

      if (reservation.status === targetStatus) {
        return Object.freeze({ reservation });
      }

      if (reservation.status !== 'held') {
        return Object.freeze({ error: 'invalid_state' as const });
      }

      if (targetStatus === 'expired' && now < reservation.expiresAt) {
        return Object.freeze({ error: 'not_expired' as const });
      }

      const reservedAmount = BigInt(mandate.reservedAmountMinor);
      const amount = BigInt(reservation.amountMinor);

      if (reservedAmount < amount || mandate.reservedTransactionCount < 1) {
        return Object.freeze({ error: 'counter_invariant' as const });
      }

      await transaction
        .updateTable('mandates')
        .set({
          reservedAmountMinor: (reservedAmount - amount).toString(),
          reservedTransactionCount: mandate.reservedTransactionCount - 1,
          ...(targetStatus === 'confirmed'
            ? {
                spentAmountMinor: (BigInt(mandate.spentAmountMinor) + amount).toString(),
                completedTransactionCount: mandate.completedTransactionCount + 1,
              }
            : {}),
        })
        .where('id', '=', mandate.id)
        .executeTakeFirstOrThrow();
      const finalized = await transaction
        .updateTable('budgetReservations')
        .set({
          status: targetStatus,
          finalizedAt: now,
          finalizationReason: reason,
        })
        .where('id', '=', reservation.id)
        .returning(reservationColumns)
        .executeTakeFirstOrThrow();
      return Object.freeze({ reservation: finalized });
    });

    if ('error' in outcome) {
      throw new BudgetReservationError(outcome.error);
    }

    return toReservationView(outcome.reservation);
  }

  async release(
    reservationId: ResourceId<'rsv'>,
    reason: ReleaseReason,
  ): Promise<Readonly<BudgetReservationView>> {
    return this.#finalize(reservationId, 'released', reason);
  }

  async confirm(reservationId: ResourceId<'rsv'>): Promise<Readonly<BudgetReservationView>> {
    return this.#finalize(reservationId, 'confirmed', 'payment_succeeded');
  }

  async expire(reservationId: ResourceId<'rsv'>): Promise<Readonly<BudgetReservationView>> {
    return this.#finalize(reservationId, 'expired', 'timeout');
  }

  async expireDue(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new BudgetReservationError('invalid_ttl');
    }

    const now = this.#now();
    const due = await this.#database
      .selectFrom('budgetReservations')
      .select('id')
      .where('status', '=', 'held')
      .where('expiresAt', '<=', now)
      .orderBy('expiresAt', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .execute();
    let expired = 0;

    for (const { id } of due) {
      try {
        const result = await this.expire(parseResourceId(`rsv_${id}`, 'rsv'));

        if (result.status === 'expired') {
          expired += 1;
        }
      } catch (error) {
        if (!(error instanceof BudgetReservationError) || error.code !== 'invalid_state') {
          throw error;
        }
      }
    }

    return expired;
  }
}
