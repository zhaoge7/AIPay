import { formatUtcDateTime, getResourceUuid, type ResourceId } from '@aipay/contracts';
import type { Database, DatabaseTransaction } from '@aipay/database';

export interface PaymentControlView {
  readonly paymentsPaused: boolean;
  readonly updatedAt: string | null;
}

export class PaymentControlService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async get(developerId: ResourceId<'dev'>): Promise<Readonly<PaymentControlView>> {
    const row = await this.#database
      .selectFrom('developerPaymentControls')
      .select(['paymentsPaused', 'updatedAt'])
      .where('developerId', '=', getResourceUuid(developerId))
      .executeTakeFirst();
    return Object.freeze({
      paymentsPaused: row?.paymentsPaused ?? false,
      updatedAt: row === undefined ? null : formatUtcDateTime(row.updatedAt),
    });
  }

  async set(
    developerId: ResourceId<'dev'>,
    paymentsPaused: boolean,
  ): Promise<Readonly<PaymentControlView>> {
    const updatedAt = this.#now();
    const row = await this.#database
      .insertInto('developerPaymentControls')
      .values({ developerId: getResourceUuid(developerId), paymentsPaused, updatedAt })
      .onConflict((conflict) =>
        conflict.column('developerId').doUpdateSet({ paymentsPaused, updatedAt }),
      )
      .returning(['paymentsPaused', 'updatedAt'])
      .executeTakeFirstOrThrow();
    return Object.freeze({
      paymentsPaused: row.paymentsPaused,
      updatedAt: formatUtcDateTime(row.updatedAt),
    });
  }
}

export async function developerPaymentsPaused(
  executor: Database | DatabaseTransaction,
  developerId: string,
): Promise<boolean> {
  const row = await executor
    .selectFrom('developerPaymentControls')
    .select('paymentsPaused')
    .where('developerId', '=', developerId)
    .executeTakeFirst();
  return row?.paymentsPaused ?? false;
}
