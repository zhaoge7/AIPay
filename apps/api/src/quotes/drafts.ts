import {
  createMoney,
  formatUtcDateTime,
  getResourceUuid,
  MAX_MINOR_AMOUNT,
  parseResourceId,
  type Money,
  type ResourceId,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';

export type QuoteDraftErrorCode =
  | 'not_found'
  | 'service_unavailable'
  | 'invalid_quantity'
  | 'invalid_tax'
  | 'invalid_expiry'
  | 'amount_overflow';

export class QuoteDraftError extends Error {
  readonly code: QuoteDraftErrorCode;

  constructor(code: QuoteDraftErrorCode) {
    super('Quote draft operation failed');
    this.name = 'QuoteDraftError';
    this.code = code;
  }
}

export interface CreateQuoteDraftInput {
  readonly serviceId: string;
  readonly quantity: number;
  readonly taxBehavior: 'inclusive' | 'exclusive';
  readonly taxAmount: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly expiresInSeconds: number;
}

export interface QuoteDraftView {
  readonly quoteId: ResourceId<'qte'>;
  readonly merchantId: ResourceId<'mch'>;
  readonly serviceId: ResourceId<'svc'>;
  readonly unit: string;
  readonly quantity: number;
  readonly unitPrice: Readonly<Money>;
  readonly subtotal: Readonly<Money>;
  readonly taxBehavior: 'inclusive' | 'exclusive';
  readonly taxAmount: Readonly<Money>;
  readonly total: Readonly<Money>;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly status: 'draft';
}

interface QuoteDraftRow {
  readonly id: string;
  readonly merchantId: string;
  readonly serviceId: string;
  readonly unit: string;
  readonly quantity: number;
  readonly currency: 'CNY';
  readonly unitPriceAmountMinor: string;
  readonly subtotalAmountMinor: string;
  readonly taxBehavior: 'inclusive' | 'exclusive';
  readonly taxAmountMinor: string;
  readonly totalAmountMinor: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly status: 'draft' | 'active' | 'expired';
}

const quoteDraftColumns = [
  'id',
  'merchantId',
  'serviceId',
  'unit',
  'quantity',
  'currency',
  'unitPriceAmountMinor',
  'subtotalAmountMinor',
  'taxBehavior',
  'taxAmountMinor',
  'totalAmountMinor',
  'issuedAt',
  'expiresAt',
  'status',
] as const;

function toView(row: QuoteDraftRow): Readonly<QuoteDraftView> {
  if (row.status !== 'draft') {
    throw new QuoteDraftError('service_unavailable');
  }

  return Object.freeze({
    quoteId: parseResourceId(`qte_${row.id}`, 'qte'),
    merchantId: parseResourceId(`mch_${row.merchantId}`, 'mch'),
    serviceId: parseResourceId(`svc_${row.serviceId}`, 'svc'),
    unit: row.unit,
    quantity: row.quantity,
    unitPrice: createMoney(row.currency, row.unitPriceAmountMinor),
    subtotal: createMoney(row.currency, row.subtotalAmountMinor),
    taxBehavior: row.taxBehavior,
    taxAmount: createMoney(row.currency, row.taxAmountMinor),
    total: createMoney(row.currency, row.totalAmountMinor),
    issuedAt: formatUtcDateTime(row.issuedAt),
    expiresAt: formatUtcDateTime(row.expiresAt),
    status: row.status,
  });
}

export class QuoteDraftService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async create(
    developerId: ResourceId<'dev'>,
    merchantId: ResourceId<'mch'>,
    input: CreateQuoteDraftInput,
  ): Promise<Readonly<QuoteDraftView>> {
    let serviceId: ResourceId<'svc'>;

    try {
      serviceId = parseResourceId(input.serviceId, 'svc');
    } catch {
      throw new QuoteDraftError('service_unavailable');
    }

    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 1_000_000) {
      throw new QuoteDraftError('invalid_quantity');
    }

    if (
      !Number.isInteger(input.expiresInSeconds) ||
      input.expiresInSeconds < 30 ||
      input.expiresInSeconds > 900
    ) {
      throw new QuoteDraftError('invalid_expiry');
    }

    let taxAmount: Readonly<Money>;

    try {
      taxAmount = createMoney(input.taxAmount.currency, input.taxAmount.amountMinor);
    } catch {
      throw new QuoteDraftError('invalid_tax');
    }

    const now = this.#now();
    const expiresAt = new Date(now.getTime() + input.expiresInSeconds * 1_000);

    return this.#database.transaction().execute(async (transaction) => {
      const service = await transaction
        .selectFrom('services')
        .innerJoin('merchants', 'merchants.id', 'services.merchantId')
        .select([
          'services.id',
          'services.merchantId',
          'services.unit',
          'services.unitPriceAmountMinor',
          'services.currency',
          'services.status as serviceStatus',
          'merchants.developerId',
          'merchants.status as merchantStatus',
        ])
        .where('services.id', '=', getResourceUuid(serviceId))
        .where('services.merchantId', '=', getResourceUuid(merchantId))
        .where('merchants.developerId', '=', getResourceUuid(developerId))
        .forUpdate('merchants')
        .executeTakeFirst();

      if (service === undefined) {
        throw new QuoteDraftError('not_found');
      }

      if (service.serviceStatus !== 'enabled' || service.merchantStatus !== 'active') {
        throw new QuoteDraftError('service_unavailable');
      }

      const unitPrice = BigInt(service.unitPriceAmountMinor);
      const subtotal = unitPrice * BigInt(input.quantity);
      const tax = BigInt(taxAmount.amountMinor);

      if (subtotal > MAX_MINOR_AMOUNT) {
        throw new QuoteDraftError('amount_overflow');
      }

      let total: bigint;

      if (input.taxBehavior === 'inclusive') {
        if (tax > subtotal) {
          throw new QuoteDraftError('invalid_tax');
        }

        total = subtotal;
      } else {
        total = subtotal + tax;

        if (total > MAX_MINOR_AMOUNT) {
          throw new QuoteDraftError('amount_overflow');
        }
      }

      const row = await transaction
        .insertInto('quotes')
        .values({
          merchantId: service.merchantId,
          serviceId: service.id,
          unit: service.unit,
          quantity: input.quantity,
          unitPriceAmountMinor: unitPrice.toString(),
          subtotalAmountMinor: subtotal.toString(),
          taxBehavior: input.taxBehavior,
          taxAmountMinor: tax.toString(),
          totalAmountMinor: total.toString(),
          issuedAt: now,
          expiresAt,
          proofKeyId: null,
          proofValue: null,
        })
        .returning(quoteDraftColumns)
        .executeTakeFirstOrThrow();
      return toView(row);
    });
  }
}
