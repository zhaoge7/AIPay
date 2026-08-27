import { createMoney, getResourceUuid, type ResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import { evaluateAmountCountPolicy, type AmountCountDenialReason } from '@aipay/policy';

export type MandateUsageErrorCode =
  AmountCountDenialReason | 'not_found' | 'inactive' | 'expired' | 'agent_unavailable';

export class MandateUsageError extends Error {
  readonly code: MandateUsageErrorCode;

  constructor(code: MandateUsageErrorCode) {
    super('Mandate usage operation failed');
    this.name = 'MandateUsageError';
    this.code = code;
  }
}

export interface MandateUsageView {
  readonly mandateId: ResourceId<'mdt'>;
  readonly spentAmountMinor: string;
  readonly completedTransactionCount: number;
}

export class MandateUsageService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async recordCompletedSpend(
    mandateId: ResourceId<'mdt'>,
    agentId: ResourceId<'agt'>,
    amountMinor: string,
  ): Promise<Readonly<MandateUsageView>> {
    const now = this.#now();
    let amount;

    try {
      amount = createMoney('CNY', amountMinor);
    } catch {
      throw new MandateUsageError('non_positive_amount');
    }

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
          spentAmountMinor: row.spentAmountMinor,
          completedTransactionCount: row.completedTransactionCount,
        },
        amount,
      );

      if (!decision.allowed) {
        return Object.freeze({ error: decision.reason });
      }

      const updated = await transaction
        .updateTable('mandates')
        .set({
          spentAmountMinor: decision.nextSpentAmountMinor,
          completedTransactionCount: decision.nextCompletedTransactionCount,
        })
        .where('id', '=', row.id)
        .returning(['spentAmountMinor', 'completedTransactionCount'])
        .executeTakeFirstOrThrow();

      return Object.freeze({ usage: updated });
    });

    if ('error' in outcome) {
      throw new MandateUsageError(outcome.error);
    }

    return Object.freeze({ mandateId, ...outcome.usage });
  }
}
