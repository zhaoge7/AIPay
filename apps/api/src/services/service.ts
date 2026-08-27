import {
  createMoney,
  formatUtcDateTime,
  getResourceUuid,
  parseResourceId,
  type Money,
  type ResourceId,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';

const catalogValuePattern = /^[a-z][a-z0-9._-]{0,63}$/u;

export type ServiceType = 'api' | 'mcp' | 'skill';
export type RefundPolicy = 'full_on_delivery_failure' | 'non_refundable';

export type ServiceErrorCode =
  | 'invalid_name'
  | 'invalid_catalog_value'
  | 'invalid_price'
  | 'name_unavailable'
  | 'merchant_unavailable'
  | 'not_found'
  | 'empty_update';

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;

  constructor(code: ServiceErrorCode) {
    super('Service operation failed');
    this.name = 'ServiceError';
    this.code = code;
  }
}

export interface ServiceView {
  readonly serviceId: ResourceId<'svc'>;
  readonly merchantId: ResourceId<'mch'>;
  readonly type: ServiceType;
  readonly name: string;
  readonly category: string;
  readonly unit: string;
  readonly unitPrice: Readonly<Money>;
  readonly refundPolicy: RefundPolicy;
  readonly status: 'enabled' | 'disabled';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateServiceInput {
  readonly type: ServiceType;
  readonly name: string;
  readonly category: string;
  readonly unit: string;
  readonly unitPrice: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly refundPolicy: RefundPolicy;
}

export interface UpdateServiceInput {
  readonly name?: string;
  readonly category?: string;
  readonly unit?: string;
  readonly unitPrice?: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly refundPolicy?: RefundPolicy;
  readonly status?: 'enabled' | 'disabled';
}

interface ServiceRow {
  readonly id: string;
  readonly merchantId: string;
  readonly serviceType: ServiceType;
  readonly name: string;
  readonly category: string;
  readonly unit: string;
  readonly unitPriceAmountMinor: string;
  readonly currency: 'CNY';
  readonly refundPolicy: RefundPolicy;
  readonly status: 'enabled' | 'disabled';
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }

  return false;
}

function normalizeName(name: string): string {
  const normalized = name.trim();

  if (normalized.length < 1 || normalized.length > 200 || hasControlCharacter(normalized)) {
    throw new ServiceError('invalid_name');
  }

  return normalized;
}

function parseCatalogValue(value: string): string {
  if (!catalogValuePattern.test(value)) {
    throw new ServiceError('invalid_catalog_value');
  }

  return value;
}

function parsePositivePrice(value: Readonly<{ currency: 'CNY'; amountMinor: string }>) {
  try {
    const money = createMoney(value.currency, value.amountMinor);

    if (BigInt(money.amountMinor) === 0n) {
      throw new ServiceError('invalid_price');
    }

    return money;
  } catch (error) {
    if (error instanceof ServiceError) {
      throw error;
    }

    throw new ServiceError('invalid_price');
  }
}

function hasDatabaseConstraint(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}

function toView(row: ServiceRow): Readonly<ServiceView> {
  return Object.freeze({
    serviceId: parseResourceId(`svc_${row.id}`, 'svc'),
    merchantId: parseResourceId(`mch_${row.merchantId}`, 'mch'),
    type: row.serviceType,
    name: row.name,
    category: row.category,
    unit: row.unit,
    unitPrice: createMoney(row.currency, row.unitPriceAmountMinor),
    refundPolicy: row.refundPolicy,
    status: row.status,
    createdAt: formatUtcDateTime(row.createdAt),
    updatedAt: formatUtcDateTime(row.updatedAt),
  });
}

const serviceColumns = [
  'id',
  'merchantId',
  'serviceType',
  'name',
  'category',
  'unit',
  'unitPriceAmountMinor',
  'currency',
  'refundPolicy',
  'status',
  'createdAt',
  'updatedAt',
] as const;

export class ServiceCatalogService {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async create(
    developerId: ResourceId<'dev'>,
    merchantId: ResourceId<'mch'>,
    input: CreateServiceInput,
  ): Promise<Readonly<ServiceView>> {
    const name = normalizeName(input.name);
    const category = parseCatalogValue(input.category);
    const unit = parseCatalogValue(input.unit);
    const unitPrice = parsePositivePrice(input.unitPrice);

    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const merchant = await transaction
          .selectFrom('merchants')
          .select('id')
          .where('id', '=', getResourceUuid(merchantId))
          .where('developerId', '=', getResourceUuid(developerId))
          .where('status', '=', 'active')
          .forUpdate()
          .executeTakeFirst();

        if (merchant === undefined) {
          throw new ServiceError('merchant_unavailable');
        }

        const row = await transaction
          .insertInto('services')
          .values({
            merchantId: merchant.id,
            serviceType: input.type,
            name,
            category,
            unit,
            unitPriceAmountMinor: unitPrice.amountMinor,
            refundPolicy: input.refundPolicy,
          })
          .returning(serviceColumns)
          .executeTakeFirstOrThrow();
        return toView(row);
      });
    } catch (error) {
      if (hasDatabaseConstraint(error, 'services_merchant_name_unique')) {
        throw new ServiceError('name_unavailable');
      }

      throw error;
    }
  }

  async listOwned(
    developerId: ResourceId<'dev'>,
    merchantId: ResourceId<'mch'>,
  ): Promise<readonly Readonly<ServiceView>[]> {
    const merchant = await this.#database
      .selectFrom('merchants')
      .select('id')
      .where('id', '=', getResourceUuid(merchantId))
      .where('developerId', '=', getResourceUuid(developerId))
      .executeTakeFirst();

    if (merchant === undefined) {
      throw new ServiceError('not_found');
    }

    const rows = await this.#database
      .selectFrom('services')
      .select(serviceColumns)
      .where('merchantId', '=', merchant.id)
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return Object.freeze(rows.map(toView));
  }

  async update(
    developerId: ResourceId<'dev'>,
    merchantId: ResourceId<'mch'>,
    serviceId: ResourceId<'svc'>,
    input: UpdateServiceInput,
  ): Promise<Readonly<ServiceView>> {
    if (
      input.name === undefined &&
      input.category === undefined &&
      input.unit === undefined &&
      input.unitPrice === undefined &&
      input.refundPolicy === undefined &&
      input.status === undefined
    ) {
      throw new ServiceError('empty_update');
    }

    const values = {
      ...(input.name === undefined ? {} : { name: normalizeName(input.name) }),
      ...(input.category === undefined ? {} : { category: parseCatalogValue(input.category) }),
      ...(input.unit === undefined ? {} : { unit: parseCatalogValue(input.unit) }),
      ...(input.unitPrice === undefined
        ? {}
        : { unitPriceAmountMinor: parsePositivePrice(input.unitPrice).amountMinor }),
      ...(input.refundPolicy === undefined ? {} : { refundPolicy: input.refundPolicy }),
      ...(input.status === undefined ? {} : { status: input.status }),
      updatedAt: new Date(),
    };

    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const merchant = await transaction
          .selectFrom('merchants')
          .select('id')
          .where('id', '=', getResourceUuid(merchantId))
          .where('developerId', '=', getResourceUuid(developerId))
          .where('status', '<>', 'closed')
          .forUpdate()
          .executeTakeFirst();

        if (merchant === undefined) {
          throw new ServiceError('not_found');
        }

        const row = await transaction
          .updateTable('services')
          .set(values)
          .where('id', '=', getResourceUuid(serviceId))
          .where('merchantId', '=', merchant.id)
          .returning(serviceColumns)
          .executeTakeFirst();

        if (row === undefined) {
          throw new ServiceError('not_found');
        }

        return toView(row);
      });
    } catch (error) {
      if (hasDatabaseConstraint(error, 'services_merchant_name_unique')) {
        throw new ServiceError('name_unavailable');
      }

      throw error;
    }
  }
}
