import {
  formatUtcDateTime,
  getResourceUuid,
  parseResourceId,
  type ResourceId,
} from '@aipay/contracts';
import type { Database, DatabaseTransaction } from '@aipay/database';

export type MandateLifecycleAction = 'pause' | 'resume' | 'revoke';
export type MandateLifecycleErrorCode =
  'not_found' | 'invalid_state' | 'expired' | 'inactive' | 'agent_unavailable';

export class MandateLifecycleError extends Error {
  readonly code: MandateLifecycleErrorCode;

  constructor(code: MandateLifecycleErrorCode) {
    super('Mandate lifecycle operation failed');
    this.name = 'MandateLifecycleError';
    this.code = code;
  }
}

export interface MandateLifecycleView {
  readonly mandateId: ResourceId<'mdt'>;
  readonly agentId: ResourceId<'agt'>;
  readonly status: 'draft' | 'active' | 'paused' | 'revoked' | 'expired';
  readonly validUntil: string;
  readonly statusChangedAt: string;
  readonly revokedAt: string | null;
}

interface LifecycleRow {
  readonly id: string;
  readonly agentId: string;
  readonly status: MandateLifecycleView['status'];
  readonly validUntil: Date;
  readonly statusChangedAt: Date;
  readonly revokedAt: Date | null;
}

const lifecycleColumns = [
  'id',
  'agentId',
  'status',
  'validUntil',
  'statusChangedAt',
  'revokedAt',
] as const;

function toView(row: LifecycleRow): Readonly<MandateLifecycleView> {
  return Object.freeze({
    mandateId: parseResourceId(`mdt_${row.id}`, 'mdt'),
    agentId: parseResourceId(`agt_${row.agentId}`, 'agt'),
    status: row.status,
    validUntil: formatUtcDateTime(row.validUntil),
    statusChangedAt: formatUtcDateTime(row.statusChangedAt),
    revokedAt: row.revokedAt === null ? null : formatUtcDateTime(row.revokedAt),
  });
}

async function markExpired(
  transaction: DatabaseTransaction,
  row: LifecycleRow,
  now: Date,
): Promise<LifecycleRow> {
  if (now < row.validUntil || (row.status !== 'active' && row.status !== 'paused')) {
    return row;
  }

  return transaction
    .updateTable('mandates')
    .set({ status: 'expired', statusChangedAt: now })
    .where('id', '=', row.id)
    .returning(lifecycleColumns)
    .executeTakeFirstOrThrow();
}

export class MandateLifecycleService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async getOwned(
    principalId: ResourceId<'dev'>,
    mandateId: ResourceId<'mdt'>,
  ): Promise<Readonly<MandateLifecycleView>> {
    const now = this.#now();

    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom('mandates')
        .select(lifecycleColumns)
        .where('id', '=', getResourceUuid(mandateId))
        .where('principalId', '=', getResourceUuid(principalId))
        .forUpdate()
        .executeTakeFirst();

      if (row === undefined) {
        throw new MandateLifecycleError('not_found');
      }

      return toView(await markExpired(transaction, row, now));
    });
  }

  async transition(
    principalId: ResourceId<'dev'>,
    mandateId: ResourceId<'mdt'>,
    action: MandateLifecycleAction,
  ): Promise<Readonly<MandateLifecycleView>> {
    const now = this.#now();

    const outcome = await this.#database.transaction().execute(async (transaction) => {
      const found = await transaction
        .selectFrom('mandates')
        .select(lifecycleColumns)
        .where('id', '=', getResourceUuid(mandateId))
        .where('principalId', '=', getResourceUuid(principalId))
        .forUpdate()
        .executeTakeFirst();

      if (found === undefined) {
        throw new MandateLifecycleError('not_found');
      }

      const row = await markExpired(transaction, found, now);

      if (row.status === 'expired') {
        return Object.freeze({ error: 'expired' as const });
      }

      if (action === 'revoke' && row.status === 'revoked') {
        return Object.freeze({ view: toView(row) });
      }

      const nextStatus =
        action === 'pause' && row.status === 'active'
          ? 'paused'
          : action === 'resume' && row.status === 'paused'
            ? 'active'
            : action === 'revoke' && (row.status === 'active' || row.status === 'paused')
              ? 'revoked'
              : undefined;

      if (nextStatus === undefined) {
        throw new MandateLifecycleError('invalid_state');
      }

      const updated = await transaction
        .updateTable('mandates')
        .set({
          status: nextStatus,
          statusChangedAt: now,
          revokedAt: nextStatus === 'revoked' ? now : null,
        })
        .where('id', '=', row.id)
        .returning(lifecycleColumns)
        .executeTakeFirstOrThrow();
      return Object.freeze({ view: toView(updated) });
    });

    if ('error' in outcome) {
      throw new MandateLifecycleError(outcome.error);
    }

    return outcome.view;
  }

  async assertUsable(
    mandateId: ResourceId<'mdt'>,
    expectedAgentId?: ResourceId<'agt'>,
  ): Promise<Readonly<MandateLifecycleView>> {
    const now = this.#now();

    const outcome = await this.#database.transaction().execute(async (transaction) => {
      const found = await transaction
        .selectFrom('mandates')
        .select(lifecycleColumns)
        .where('id', '=', getResourceUuid(mandateId))
        .forUpdate()
        .executeTakeFirst();

      if (found === undefined) {
        throw new MandateLifecycleError('not_found');
      }

      const row = await markExpired(transaction, found, now);

      if (row.status === 'expired') {
        return Object.freeze({ error: 'expired' as const });
      }

      if (row.status !== 'active') {
        return Object.freeze({ error: 'inactive' as const });
      }

      if (expectedAgentId !== undefined && row.agentId !== getResourceUuid(expectedAgentId)) {
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

      return Object.freeze({ view: toView(row) });
    });

    if ('error' in outcome) {
      throw new MandateLifecycleError(outcome.error);
    }

    return outcome.view;
  }
}
