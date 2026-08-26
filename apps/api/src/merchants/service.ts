import {
  formatUtcDateTime,
  getResourceUuid,
  parseResourceId,
  type ResourceId,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export type MerchantErrorCode =
  'invalid_name' | 'invalid_callback_url' | 'name_unavailable' | 'not_found' | 'empty_update';

export class MerchantError extends Error {
  readonly code: MerchantErrorCode;

  constructor(code: MerchantErrorCode) {
    super('Merchant operation failed');
    this.name = 'MerchantError';
    this.code = code;
  }
}

export interface MerchantView {
  readonly merchantId: ResourceId<'mch'>;
  readonly name: string;
  readonly callbackUrl: string;
  readonly status: 'active' | 'suspended' | 'closed';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MerchantUpdate {
  readonly name?: string;
  readonly callbackUrl?: string;
  readonly status?: 'active' | 'suspended';
}

interface MerchantRow {
  readonly id: string;
  readonly name: string;
  readonly callbackUrl: string;
  readonly status: 'active' | 'suspended' | 'closed';
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
    throw new MerchantError('invalid_name');
  }

  return normalized;
}

function normalizeCallbackUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new MerchantError('invalid_callback_url');
  }

  const isLoopback = loopbackHosts.has(url.hostname);

  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    value.length > 2_048
  ) {
    throw new MerchantError('invalid_callback_url');
  }

  return url.toString();
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

function toView(row: MerchantRow): Readonly<MerchantView> {
  return Object.freeze({
    merchantId: parseResourceId(`mch_${row.id}`, 'mch'),
    name: row.name,
    callbackUrl: row.callbackUrl,
    status: row.status,
    createdAt: formatUtcDateTime(row.createdAt),
    updatedAt: formatUtcDateTime(row.updatedAt),
  });
}

export class MerchantService {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async create(
    developerId: ResourceId<'dev'>,
    nameInput: string,
    callbackUrlInput: string,
  ): Promise<Readonly<MerchantView>> {
    const name = normalizeName(nameInput);
    const callbackUrl = normalizeCallbackUrl(callbackUrlInput);

    try {
      const row = await this.#database
        .insertInto('merchants')
        .values({ developerId: getResourceUuid(developerId), name, callbackUrl })
        .returning(['id', 'name', 'callbackUrl', 'status', 'createdAt', 'updatedAt'])
        .executeTakeFirstOrThrow();
      return toView(row);
    } catch (error) {
      if (hasDatabaseConstraint(error, 'merchants_active_name_unique')) {
        throw new MerchantError('name_unavailable');
      }

      throw error;
    }
  }

  async list(developerId: ResourceId<'dev'>): Promise<readonly Readonly<MerchantView>[]> {
    const rows = await this.#database
      .selectFrom('merchants')
      .select(['id', 'name', 'callbackUrl', 'status', 'createdAt', 'updatedAt'])
      .where('developerId', '=', getResourceUuid(developerId))
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return Object.freeze(rows.map(toView));
  }

  async update(
    developerId: ResourceId<'dev'>,
    merchantId: ResourceId<'mch'>,
    update: MerchantUpdate,
  ): Promise<Readonly<MerchantView>> {
    if (
      update.name === undefined &&
      update.callbackUrl === undefined &&
      update.status === undefined
    ) {
      throw new MerchantError('empty_update');
    }

    const values = {
      ...(update.name === undefined ? {} : { name: normalizeName(update.name) }),
      ...(update.callbackUrl === undefined
        ? {}
        : { callbackUrl: normalizeCallbackUrl(update.callbackUrl) }),
      ...(update.status === undefined ? {} : { status: update.status }),
      updatedAt: new Date(),
    };

    try {
      const row = await this.#database
        .updateTable('merchants')
        .set(values)
        .where('id', '=', getResourceUuid(merchantId))
        .where('developerId', '=', getResourceUuid(developerId))
        .where('status', '<>', 'closed')
        .returning(['id', 'name', 'callbackUrl', 'status', 'createdAt', 'updatedAt'])
        .executeTakeFirst();

      if (row === undefined) {
        throw new MerchantError('not_found');
      }

      return toView(row);
    } catch (error) {
      if (hasDatabaseConstraint(error, 'merchants_active_name_unique')) {
        throw new MerchantError('name_unavailable');
      }

      throw error;
    }
  }
}
