import { formatUtcDateTime } from '@aipay/contracts';
import type { Database } from '@aipay/database';

export type PlatformTreasuryErrorCode = 'not_found' | 'invalid_state' | 'invalid_timestamp';

export class PlatformTreasuryError extends Error {
  readonly code: PlatformTreasuryErrorCode;

  constructor(code: PlatformTreasuryErrorCode) {
    super('Platform treasury operation failed');
    this.name = 'PlatformTreasuryError';
    this.code = code;
  }
}

export interface PlatformSettlementView {
  readonly providerTradeNo: string;
  readonly amount: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly status: 'received';
  readonly receivedAt: string;
}

export class PlatformTreasuryService {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async confirmProviderSettlement(
    providerTradeNo: string,
    receivedAt = new Date(),
  ): Promise<Readonly<PlatformSettlementView>> {
    if (!/^\d{16,64}$/u.test(providerTradeNo)) {
      throw new PlatformTreasuryError('not_found');
    }

    return this.#database.transaction().execute(async (transaction) => {
      const receivable = await transaction
        .selectFrom('platformReceivables')
        .selectAll()
        .where('providerTradeNo', '=', providerTradeNo)
        .forUpdate()
        .executeTakeFirst();

      if (receivable === undefined) {
        throw new PlatformTreasuryError('not_found');
      }

      if (receivable.status === 'received') {
        if (receivable.receivedAt === null) throw new PlatformTreasuryError('invalid_state');
        return Object.freeze({
          providerTradeNo,
          amount: Object.freeze({ currency: 'CNY', amountMinor: receivable.amountMinor }),
          status: 'received',
          receivedAt: formatUtcDateTime(receivable.receivedAt),
        });
      }

      if (receivable.status !== 'pending') {
        throw new PlatformTreasuryError('invalid_state');
      }

      if (receivedAt < receivable.createdAt) {
        throw new PlatformTreasuryError('invalid_timestamp');
      }

      await transaction
        .updateTable('platformReceivables')
        .set({ status: 'received', receivedAt, updatedAt: receivedAt })
        .where('id', '=', receivable.id)
        .where('status', '=', 'pending')
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('platformFundingAccounts')
        .set((expressions) => ({
          availableAmountMinor: expressions('availableAmountMinor', '+', receivable.amountMinor),
          updatedAt: receivedAt,
        }))
        .where('currency', '=', 'CNY')
        .executeTakeFirstOrThrow();
      return Object.freeze({
        providerTradeNo,
        amount: Object.freeze({ currency: 'CNY', amountMinor: receivable.amountMinor }),
        status: 'received',
        receivedAt: formatUtcDateTime(receivedAt),
      });
    });
  }
}
