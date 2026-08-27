import {
  formatUtcDateTime,
  getResourceUuid,
  parseResourceId,
  type ResourceId,
} from '@aipay/contracts';

import type { Database, DatabaseTransaction } from './index.js';

const eventTypePattern = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_]{0,31})+$/u;
const workerPattern = /^[a-zA-Z0-9._-]{1,100}$/u;

export interface EnqueueOutboxInput {
  readonly aggregateType: string;
  readonly aggregateId: ResourceId;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly availableAt?: Date;
}

export interface ClaimedOutboxEvent {
  readonly outboxEventId: ResourceId<'obx'>;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attemptCount: number;
  readonly createdAt: string;
}

function normalizePayload(payload: Readonly<Record<string, unknown>>) {
  let encoded: string;

  try {
    encoded = JSON.stringify(payload);
  } catch {
    throw new Error('Outbox payload must be JSON serializable');
  }

  const parsed: unknown = JSON.parse(encoded);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Outbox payload must be a JSON object');
  }

  return Object.freeze(parsed as Record<string, unknown>);
}

function assertWorkerId(workerId: string): void {
  if (!workerPattern.test(workerId)) {
    throw new Error('Invalid Outbox worker ID');
  }
}

export async function enqueueOutboxEvent(
  transaction: DatabaseTransaction,
  input: EnqueueOutboxInput,
): Promise<ResourceId<'obx'>> {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(input.aggregateType)) {
    throw new Error('Invalid Outbox aggregate type');
  }

  if (!eventTypePattern.test(input.eventType)) {
    throw new Error('Invalid Outbox event type');
  }

  const row = await transaction
    .insertInto('outboxEvents')
    .values({
      aggregateType: input.aggregateType,
      aggregateId: getResourceUuid(input.aggregateId),
      eventType: input.eventType,
      payload: normalizePayload(input.payload),
      status: 'pending',
      availableAt: input.availableAt ?? new Date(),
      publishedAt: null,
      lastErrorCode: null,
      lockedAt: null,
      lockedBy: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return parseResourceId(`obx_${row.id}`, 'obx');
}

export async function claimOutboxEvents(
  database: Database,
  workerId: string,
  limit = 100,
  now = new Date(),
): Promise<readonly Readonly<ClaimedOutboxEvent>[]> {
  assertWorkerId(workerId);

  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error('Invalid Outbox claim limit');
  }

  return database.transaction().execute(async (transaction) => {
    const candidates = await transaction
      .selectFrom('outboxEvents')
      .select('id')
      .where('status', '=', 'pending')
      .where('availableAt', '<=', now)
      .orderBy('availableAt', 'asc')
      .orderBy('id', 'asc')
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();

    if (candidates.length === 0) {
      return Object.freeze([]);
    }

    const rows = await transaction
      .updateTable('outboxEvents')
      .set({ status: 'processing', lockedAt: now, lockedBy: workerId })
      .where(
        'id',
        'in',
        candidates.map(({ id }) => id),
      )
      .returning([
        'id',
        'aggregateType',
        'aggregateId',
        'eventType',
        'payload',
        'attemptCount',
        'createdAt',
      ])
      .execute();

    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          outboxEventId: parseResourceId(`obx_${row.id}`, 'obx'),
          aggregateType: row.aggregateType,
          aggregateId: row.aggregateId,
          eventType: row.eventType,
          payload: Object.freeze(row.payload as Record<string, unknown>),
          attemptCount: row.attemptCount,
          createdAt: formatUtcDateTime(row.createdAt),
        }),
      ),
    );
  });
}

export async function markOutboxPublished(
  database: Database,
  eventId: ResourceId<'obx'>,
  workerId: string,
  now = new Date(),
): Promise<void> {
  assertWorkerId(workerId);
  const result = await database
    .updateTable('outboxEvents')
    .set({
      status: 'published',
      publishedAt: now,
      lockedAt: null,
      lockedBy: null,
      lastErrorCode: null,
    })
    .where('id', '=', getResourceUuid(eventId))
    .where('status', '=', 'processing')
    .where('lockedBy', '=', workerId)
    .executeTakeFirst();

  if (result.numUpdatedRows !== 1n) {
    throw new Error('Outbox event is not claimed by this worker');
  }
}

export async function markOutboxFailed(
  database: Database,
  eventId: ResourceId<'obx'>,
  workerId: string,
  errorCode: string,
  options: { readonly maxAttempts?: number; readonly now?: Date } = {},
): Promise<'pending' | 'dead_letter'> {
  assertWorkerId(workerId);
  const maxAttempts = options.maxAttempts ?? 10;
  const now = options.now ?? new Date();

  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(errorCode) || maxAttempts < 1) {
    throw new Error('Invalid Outbox failure metadata');
  }

  return database.transaction().execute(async (transaction) => {
    const row = await transaction
      .selectFrom('outboxEvents')
      .select(['attemptCount', 'status', 'lockedBy'])
      .where('id', '=', getResourceUuid(eventId))
      .forUpdate()
      .executeTakeFirst();

    if (row === undefined) {
      throw new Error('Outbox event is not claimed by this worker');
    }

    if (row.status !== 'processing' || row.lockedBy !== workerId) {
      throw new Error('Outbox event is not claimed by this worker');
    }

    const attempts = row.attemptCount + 1;
    const status = attempts >= maxAttempts ? 'dead_letter' : 'pending';
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 10));
    await transaction
      .updateTable('outboxEvents')
      .set({
        status,
        attemptCount: attempts,
        availableAt: new Date(now.getTime() + delayMs),
        lastErrorCode: errorCode,
        lockedAt: null,
        lockedBy: null,
      })
      .where('id', '=', getResourceUuid(eventId))
      .executeTakeFirstOrThrow();
    return status;
  });
}

export async function releaseStaleOutboxClaims(
  database: Database,
  staleBefore: Date,
  now = new Date(),
): Promise<number> {
  const result = await database
    .updateTable('outboxEvents')
    .set({ status: 'pending', availableAt: now, lockedAt: null, lockedBy: null })
    .where('status', '=', 'processing')
    .where('lockedAt', '<', staleBefore)
    .executeTakeFirst();
  return Number(result.numUpdatedRows);
}
