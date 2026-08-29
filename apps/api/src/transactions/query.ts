import {
  createMoney,
  formatUtcDateTime,
  getResourceUuid,
  parseResourceId,
  type ResourceId,
  type TransactionStatus,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';

export interface TransactionQuery {
  readonly status?: TransactionStatus;
  readonly agentId?: ResourceId<'agt'>;
  readonly merchantId?: ResourceId<'mch'>;
  readonly from?: Date;
  readonly to?: Date;
  readonly limit?: number;
}

export interface TransactionListItem {
  readonly transactionId: ResourceId<'txn'>;
  readonly mandateId: ResourceId<'mdt'>;
  readonly quoteId: ResourceId<'qte'>;
  readonly agentId: ResourceId<'agt'>;
  readonly agentName: string;
  readonly merchantId: ResourceId<'mch'>;
  readonly merchantName: string;
  readonly serviceId: ResourceId<'svc'>;
  readonly serviceName: string;
  readonly amount: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly status: TransactionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class TransactionQueryError extends Error {
  constructor() {
    super('Transaction query is invalid');
    this.name = 'TransactionQueryError';
  }
}

export class TransactionQueryService {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async list(
    developerId: ResourceId<'dev'>,
    filters: TransactionQuery = {},
  ): Promise<readonly Readonly<TransactionListItem>[]> {
    const limit = filters.limit ?? 100;

    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (filters.from !== undefined && Number.isNaN(filters.from.getTime())) ||
      (filters.to !== undefined && Number.isNaN(filters.to.getTime())) ||
      (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to)
    ) {
      throw new TransactionQueryError();
    }

    const ownerId = getResourceUuid(developerId);
    let query = this.#database
      .selectFrom('transactions')
      .innerJoin('agents', 'agents.id', 'transactions.agentId')
      .innerJoin('merchants', 'merchants.id', 'transactions.merchantId')
      .innerJoin('services', 'services.id', 'transactions.serviceId')
      .select([
        'transactions.id',
        'transactions.mandateId',
        'transactions.quoteId',
        'transactions.agentId',
        'agents.name as agentName',
        'transactions.merchantId',
        'merchants.name as merchantName',
        'transactions.serviceId',
        'services.name as serviceName',
        'transactions.currency',
        'transactions.amountMinor',
        'transactions.status',
        'transactions.createdAt',
        'transactions.updatedAt',
      ])
      .where((expression) =>
        expression.or([
          expression('transactions.principalId', '=', ownerId),
          expression('merchants.developerId', '=', ownerId),
        ]),
      );

    if (filters.status !== undefined) {
      query = query.where('transactions.status', '=', filters.status);
    }

    if (filters.agentId !== undefined) {
      query = query.where('transactions.agentId', '=', getResourceUuid(filters.agentId));
    }

    if (filters.merchantId !== undefined) {
      query = query.where('transactions.merchantId', '=', getResourceUuid(filters.merchantId));
    }

    if (filters.from !== undefined) {
      query = query.where('transactions.createdAt', '>=', filters.from);
    }

    if (filters.to !== undefined) {
      query = query.where('transactions.createdAt', '<=', filters.to);
    }

    const rows = await query
      .orderBy('transactions.createdAt', 'desc')
      .orderBy('transactions.id', 'desc')
      .limit(limit)
      .execute();
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({
          transactionId: parseResourceId(`txn_${row.id}`, 'txn'),
          mandateId: parseResourceId(`mdt_${row.mandateId}`, 'mdt'),
          quoteId: parseResourceId(`qte_${row.quoteId}`, 'qte'),
          agentId: parseResourceId(`agt_${row.agentId}`, 'agt'),
          agentName: row.agentName,
          merchantId: parseResourceId(`mch_${row.merchantId}`, 'mch'),
          merchantName: row.merchantName,
          serviceId: parseResourceId(`svc_${row.serviceId}`, 'svc'),
          serviceName: row.serviceName,
          amount: createMoney(row.currency, row.amountMinor),
          status: row.status,
          createdAt: formatUtcDateTime(row.createdAt),
          updatedAt: formatUtcDateTime(row.updatedAt),
        }),
      ),
    );
  }
}
