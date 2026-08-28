import { parseResourceId, type ResourceId } from '@aipay/contracts';
import { enqueueOutboxEvent, type Database, type DatabaseTransaction } from '@aipay/database';

export type DeliveryTimeoutResolution = 'refund_pending' | 'delivery_review';

export interface ExpirableDelivery {
  readonly id: string;
  readonly transactionId: string;
  readonly merchantId: string;
  readonly serviceId: string;
  readonly refundPolicy: 'full_on_delivery_failure' | 'non_refundable';
  readonly status: 'pending' | 'succeeded' | 'failed' | 'timed_out' | 'unknown';
  readonly expiresAt: Date;
}

export interface DeliveryTimeoutResult {
  readonly deliveryId: ResourceId<'dlv'>;
  readonly transactionId: ResourceId<'txn'>;
  readonly resolution: DeliveryTimeoutResolution;
}

export async function applyDeliveryTimeout(
  transaction: DatabaseTransaction,
  delivery: ExpirableDelivery,
  now: Date,
): Promise<Readonly<DeliveryTimeoutResult>> {
  if (delivery.status !== 'pending' || now < delivery.expiresAt) {
    throw new Error('Delivery is not due for timeout');
  }

  const resolution: DeliveryTimeoutResolution =
    delivery.refundPolicy === 'full_on_delivery_failure' ? 'refund_pending' : 'delivery_review';
  await transaction
    .updateTable('deliveries')
    .set({ status: 'timed_out', updatedAt: now })
    .where('id', '=', delivery.id)
    .where('status', '=', 'pending')
    .executeTakeFirstOrThrow();
  await transaction
    .updateTable('transactions')
    .set({ status: resolution, updatedAt: now })
    .where('id', '=', delivery.transactionId)
    .where('status', '=', 'delivery_pending')
    .executeTakeFirstOrThrow();
  const deliveryId = parseResourceId(`dlv_${delivery.id}`, 'dlv');
  const transactionId = parseResourceId(`txn_${delivery.transactionId}`, 'txn');
  await enqueueOutboxEvent(transaction, {
    aggregateType: 'transaction',
    aggregateId: transactionId,
    eventType: 'transaction.delivery_timed_out',
    payload: {
      merchantId: `mch_${delivery.merchantId}`,
      transactionId,
      deliveryId,
      serviceId: `svc_${delivery.serviceId}`,
      resolution,
    },
  });
  return Object.freeze({ deliveryId, transactionId, resolution });
}

export class DeliveryTimeoutService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async expireDue(limit = 100): Promise<readonly Readonly<DeliveryTimeoutResult>[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('Invalid delivery timeout limit');
    }

    const now = this.#now();
    return this.#database.transaction().execute(async (transaction) => {
      const deliveries = await transaction
        .selectFrom('deliveries')
        .select([
          'id',
          'transactionId',
          'merchantId',
          'serviceId',
          'refundPolicy',
          'status',
          'expiresAt',
        ])
        .where('status', '=', 'pending')
        .where('expiresAt', '<=', now)
        .orderBy('expiresAt', 'asc')
        .orderBy('id', 'asc')
        .limit(limit)
        .forUpdate()
        .skipLocked()
        .execute();
      const results: DeliveryTimeoutResult[] = [];

      for (const delivery of deliveries) {
        results.push(await applyDeliveryTimeout(transaction, delivery, now));
      }

      return Object.freeze(results);
    });
  }
}
