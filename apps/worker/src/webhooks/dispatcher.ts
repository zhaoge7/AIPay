import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { getResourceUuid, parseResourceId, type ResourceId } from '@aipay/contracts';
import {
  claimOutboxEvents,
  markOutboxFailed,
  markOutboxPublished,
  type ClaimedOutboxEvent,
  type Database,
} from '@aipay/database';

import { Ed25519WebhookSigner } from './signing.js';
import {
  WebhookTransportError,
  type WebhookTransport,
  type WebhookTransportResponse,
} from './transport.js';

export type WebhookDispatchStatus = 'delivered' | 'pending' | 'dead_letter';

export interface WebhookDispatchResult {
  readonly outboxEventId: ResourceId<'obx'>;
  readonly deliveryId: ResourceId<'whd'>;
  readonly status: WebhookDispatchStatus;
}

export interface WebhookDispatcherOptions {
  readonly maxAttempts?: number;
  readonly now?: () => Date;
}

interface PreparedDelivery {
  readonly deliveryId: ResourceId<'whd'>;
  readonly targetUrl: string;
  readonly body: Buffer;
  readonly attemptId: ResourceId<'wha'> | null;
  readonly attemptNumber: number;
  readonly startedAt: Date;
  readonly alreadyDelivered: boolean;
}

function merchantIdFromPayload(payload: Readonly<Record<string, unknown>>): ResourceId<'mch'> {
  try {
    return parseResourceId(payload.merchantId, 'mch');
  } catch {
    throw new Error('Webhook Outbox payload requires merchantId');
  }
}

function eventBody(event: ClaimedOutboxEvent): Buffer {
  return Buffer.from(
    JSON.stringify({
      eventId: event.outboxEventId,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      occurredAt: event.createdAt,
      data: event.payload,
    }),
    'utf8',
  );
}

export class WebhookDispatcher {
  readonly #database: Database;
  readonly #signer: Ed25519WebhookSigner;
  readonly #transport: WebhookTransport;
  readonly #maxAttempts: number;
  readonly #now: () => Date;

  constructor(
    database: Database,
    signer: Ed25519WebhookSigner,
    transport: WebhookTransport,
    options: WebhookDispatcherOptions = {},
  ) {
    this.#database = database;
    this.#signer = signer;
    this.#transport = transport;
    this.#maxAttempts = options.maxAttempts ?? 10;
    this.#now = options.now ?? (() => new Date());

    if (this.#maxAttempts < 1) {
      throw new Error('Webhook max attempts must be positive');
    }
  }

  async claimAndDeliver(workerId: string, limit = 100): Promise<readonly WebhookDispatchResult[]> {
    const events = await claimOutboxEvents(this.#database, workerId, limit, this.#now());
    const results: WebhookDispatchResult[] = [];

    for (const event of events) {
      results.push(await this.deliver(event, workerId));
    }

    return Object.freeze(results);
  }

  async deliver(
    event: ClaimedOutboxEvent,
    workerId: string,
  ): Promise<Readonly<WebhookDispatchResult>> {
    const prepared = await this.#prepare(event);

    if (prepared.alreadyDelivered) {
      await markOutboxPublished(this.#database, event.outboxEventId, workerId, this.#now());
      return Object.freeze({
        outboxEventId: event.outboxEventId,
        deliveryId: prepared.deliveryId,
        status: 'delivered',
      });
    }

    if (prepared.attemptId === null) {
      throw new Error('Webhook attempt was not prepared');
    }
    const attemptId = prepared.attemptId;

    const signed = this.#signer.sign(event.outboxEventId, prepared.body, this.#now());
    const headers = {
      ...signed.headers,
      'content-type': 'application/json',
    };

    let response: Readonly<WebhookTransportResponse>;

    try {
      response = await this.#transport.deliver({
        url: prepared.targetUrl,
        headers,
        body: prepared.body,
      });
    } catch (error) {
      const code = error instanceof WebhookTransportError ? error.code : 'NETWORK_ERROR';
      return this.#recordFailure(event, workerId, prepared, code, null);
    }

    if (response.statusCode < 200 || response.statusCode > 299) {
      return this.#recordFailure(
        event,
        workerId,
        prepared,
        `HTTP_${String(response.statusCode)}`,
        response.statusCode,
      );
    }

    const completedAt = this.#now();
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('webhookDeliveryAttempts')
        .set({
          outcome: 'delivered',
          responseStatusCode: response.statusCode,
          completedAt,
          durationMs: Math.max(0, completedAt.getTime() - prepared.startedAt.getTime()),
        })
        .where('id', '=', getResourceUuid(attemptId))
        .where('outcome', '=', 'started')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('webhookDeliveries')
        .set({
          status: 'delivered',
          lastStatusCode: response.statusCode,
          lastErrorCode: null,
          deliveredAt: completedAt,
          updatedAt: completedAt,
        })
        .where('id', '=', getResourceUuid(prepared.deliveryId))
        .executeTakeFirstOrThrow();
    });
    await markOutboxPublished(this.#database, event.outboxEventId, workerId, completedAt);
    return Object.freeze({
      outboxEventId: event.outboxEventId,
      deliveryId: prepared.deliveryId,
      status: 'delivered',
    });
  }

  async #prepare(event: ClaimedOutboxEvent): Promise<PreparedDelivery> {
    const merchantId = merchantIdFromPayload(event.payload);
    const body = eventBody(event);
    const now = this.#now();

    return this.#database.transaction().execute(async (transaction) => {
      let delivery = await transaction
        .selectFrom('webhookDeliveries')
        .select(['id', 'targetUrl', 'status', 'attemptCount'])
        .where('outboxEventId', '=', getResourceUuid(event.outboxEventId))
        .forUpdate()
        .executeTakeFirst();

      if (delivery === undefined) {
        const merchant = await transaction
          .selectFrom('merchants')
          .select(['id', 'callbackUrl'])
          .where('id', '=', getResourceUuid(merchantId))
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('webhookDeliveries')
          .values({
            outboxEventId: getResourceUuid(event.outboxEventId),
            merchantId: merchant.id,
            targetUrl: merchant.callbackUrl,
            status: 'pending',
            nextAttemptAt: now,
            lastStatusCode: null,
            lastErrorCode: null,
            deliveredAt: null,
          })
          .onConflict((conflict) => conflict.column('outboxEventId').doNothing())
          .execute();
        delivery = await transaction
          .selectFrom('webhookDeliveries')
          .select(['id', 'targetUrl', 'status', 'attemptCount'])
          .where('outboxEventId', '=', getResourceUuid(event.outboxEventId))
          .forUpdate()
          .executeTakeFirstOrThrow();
      }

      const deliveryId = parseResourceId(`whd_${delivery.id}`, 'whd');

      if (delivery.status === 'delivered') {
        return Object.freeze({
          deliveryId,
          targetUrl: delivery.targetUrl,
          body,
          attemptId: null,
          attemptNumber: delivery.attemptCount,
          startedAt: now,
          alreadyDelivered: true,
        });
      }

      if (delivery.status === 'dead_letter') {
        throw new Error('Webhook delivery is dead lettered');
      }

      const attemptNumber = delivery.attemptCount + 1;
      const attempt = await transaction
        .insertInto('webhookDeliveryAttempts')
        .values({
          deliveryId: delivery.id,
          attemptNumber,
          requestDigest: createHash('sha256').update(body).digest(),
          signingKeyId: this.#signer.keyUuid,
          outcome: 'started',
          responseStatusCode: null,
          errorCode: null,
          startedAt: now,
          completedAt: null,
          durationMs: null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('webhookDeliveries')
        .set({ attemptCount: attemptNumber, updatedAt: now })
        .where('id', '=', delivery.id)
        .executeTakeFirstOrThrow();

      return Object.freeze({
        deliveryId,
        targetUrl: delivery.targetUrl,
        body,
        attemptId: parseResourceId(`wha_${attempt.id}`, 'wha'),
        attemptNumber,
        startedAt: now,
        alreadyDelivered: false,
      });
    });
  }

  async #recordFailure(
    event: ClaimedOutboxEvent,
    workerId: string,
    prepared: PreparedDelivery,
    errorCode: string,
    statusCode: number | null,
  ): Promise<Readonly<WebhookDispatchResult>> {
    if (prepared.attemptId === null) {
      throw new Error('Webhook attempt is missing');
    }
    const attemptId = prepared.attemptId;

    const completedAt = this.#now();
    const deliveryStatus = prepared.attemptNumber >= this.#maxAttempts ? 'dead_letter' : 'pending';
    const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(prepared.attemptNumber - 1, 10));
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('webhookDeliveryAttempts')
        .set({
          outcome: 'failed',
          responseStatusCode: statusCode,
          errorCode,
          completedAt,
          durationMs: Math.max(0, completedAt.getTime() - prepared.startedAt.getTime()),
        })
        .where('id', '=', getResourceUuid(attemptId))
        .where('outcome', '=', 'started')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('webhookDeliveries')
        .set({
          status: deliveryStatus,
          nextAttemptAt: new Date(completedAt.getTime() + delayMs),
          lastStatusCode: statusCode,
          lastErrorCode: errorCode,
          updatedAt: completedAt,
        })
        .where('id', '=', getResourceUuid(prepared.deliveryId))
        .executeTakeFirstOrThrow();
    });
    const outboxStatus = await markOutboxFailed(
      this.#database,
      event.outboxEventId,
      workerId,
      errorCode,
      { maxAttempts: this.#maxAttempts, now: completedAt },
    );

    if (outboxStatus !== deliveryStatus) {
      throw new Error('Webhook and Outbox retry state diverged');
    }

    return Object.freeze({
      outboxEventId: event.outboxEventId,
      deliveryId: prepared.deliveryId,
      status: deliveryStatus,
    });
  }
}
