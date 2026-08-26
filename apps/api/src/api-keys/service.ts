import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  formatUtcDateTime,
  getResourceUuid,
  parseResourceId,
  type ResourceId,
} from '@aipay/contracts';
import type { Database, DatabaseTransaction } from '@aipay/database';

const apiKeyTokenPattern =
  /^(apk_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{43})$/u;
const millisecondsPerDay = 24 * 60 * 60 * 1_000;

export type ApiKeyErrorCode =
  'invalid_name' | 'invalid_expiry' | 'name_unavailable' | 'not_found' | 'invalid_token';

export class ApiKeyError extends Error {
  readonly code: ApiKeyErrorCode;

  constructor(code: ApiKeyErrorCode) {
    super('API Key operation failed');
    this.name = 'ApiKeyError';
    this.code = code;
  }
}

export interface ApiKeyView {
  readonly apiKeyId: ResourceId<'apk'>;
  readonly name: string;
  readonly hint: string;
  readonly status: 'active' | 'revoked';
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly replacedByApiKeyId: ResourceId<'apk'> | null;
}

export interface ApiKeySecret {
  readonly apiKey: Readonly<ApiKeyView>;
  readonly token: string;
}

export interface ApiKeyServiceOptions {
  readonly now?: () => Date;
  readonly randomSecretBytes?: () => Uint8Array;
}

interface ApiKeyRow {
  readonly id: string;
  readonly name: string;
  readonly tokenHint: string;
  readonly status: 'active' | 'revoked';
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly replacedByKeyId: string | null;
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

  if (normalized.length < 1 || normalized.length > 100 || hasControlCharacter(normalized)) {
    throw new ApiKeyError('invalid_name');
  }

  return normalized;
}

function parseExpiryDays(value: number | undefined): number {
  const days = value ?? 90;

  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new ApiKeyError('invalid_expiry');
  }

  return days;
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
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

function toView(row: ApiKeyRow): Readonly<ApiKeyView> {
  return Object.freeze({
    apiKeyId: parseResourceId(`apk_${row.id}`, 'apk'),
    name: row.name,
    hint: row.tokenHint,
    status: row.status,
    createdAt: formatUtcDateTime(row.createdAt),
    expiresAt: formatUtcDateTime(row.expiresAt),
    lastUsedAt: row.lastUsedAt === null ? null : formatUtcDateTime(row.lastUsedAt),
    revokedAt: row.revokedAt === null ? null : formatUtcDateTime(row.revokedAt),
    replacedByApiKeyId:
      row.replacedByKeyId === null ? null : parseResourceId(`apk_${row.replacedByKeyId}`, 'apk'),
  });
}

export class ApiKeyService {
  readonly #database: Database;
  readonly #now: () => Date;
  readonly #randomSecretBytes: () => Uint8Array;

  constructor(database: Database, options: ApiKeyServiceOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#randomSecretBytes = options.randomSecretBytes ?? (() => randomBytes(32));
  }

  async #createInTransaction(
    transaction: DatabaseTransaction,
    developerId: ResourceId<'dev'>,
    name: string,
    expiresInDays: number,
  ): Promise<Readonly<ApiKeySecret>> {
    const secretBytes = this.#randomSecretBytes();

    if (secretBytes.byteLength !== 32) {
      throw new Error('API Key generator must return exactly 32 bytes');
    }

    const secret = Buffer.from(secretBytes).toString('base64url');
    const preliminaryHash = createHash('sha256').update(secret, 'utf8').digest();
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + expiresInDays * millisecondsPerDay);
    const row = await transaction
      .insertInto('apiKeys')
      .values({
        developerId: getResourceUuid(developerId),
        name,
        tokenHash: preliminaryHash,
        tokenHint: secret.slice(-4),
        expiresAt,
        lastUsedAt: null,
        revokedAt: null,
        replacedByKeyId: null,
      })
      .returning([
        'id',
        'name',
        'tokenHint',
        'status',
        'createdAt',
        'expiresAt',
        'lastUsedAt',
        'revokedAt',
        'replacedByKeyId',
      ])
      .executeTakeFirstOrThrow();
    const token = `apk_${row.id}.${secret}`;

    await transaction
      .updateTable('apiKeys')
      .set({ tokenHash: hashToken(token) })
      .where('id', '=', row.id)
      .executeTakeFirstOrThrow();

    return Object.freeze({ apiKey: toView(row), token });
  }

  async create(
    developerId: ResourceId<'dev'>,
    nameInput: string,
    expiresInDaysInput?: number,
  ): Promise<Readonly<ApiKeySecret>> {
    const name = normalizeName(nameInput);
    const expiresInDays = parseExpiryDays(expiresInDaysInput);

    try {
      return await this.#database
        .transaction()
        .execute((transaction) =>
          this.#createInTransaction(transaction, developerId, name, expiresInDays),
        );
    } catch (error) {
      if (hasDatabaseConstraint(error, 'api_keys_active_name_unique')) {
        throw new ApiKeyError('name_unavailable');
      }

      throw error;
    }
  }

  async list(developerId: ResourceId<'dev'>): Promise<readonly Readonly<ApiKeyView>[]> {
    const rows = await this.#database
      .selectFrom('apiKeys')
      .select([
        'id',
        'name',
        'tokenHint',
        'status',
        'createdAt',
        'expiresAt',
        'lastUsedAt',
        'revokedAt',
        'replacedByKeyId',
      ])
      .where('developerId', '=', getResourceUuid(developerId))
      .orderBy('createdAt', 'desc')
      .orderBy('id', 'desc')
      .execute();

    return Object.freeze(rows.map(toView));
  }

  async revoke(
    developerId: ResourceId<'dev'>,
    apiKeyId: ResourceId<'apk'>,
  ): Promise<Readonly<ApiKeyView>> {
    return this.#database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom('apiKeys')
        .selectAll()
        .where('id', '=', getResourceUuid(apiKeyId))
        .where('developerId', '=', getResourceUuid(developerId))
        .forUpdate()
        .executeTakeFirst();

      if (existing === undefined) {
        throw new ApiKeyError('not_found');
      }

      if (existing.status === 'revoked') {
        return toView(existing);
      }

      const revoked = await transaction
        .updateTable('apiKeys')
        .set({ status: 'revoked', revokedAt: this.#now() })
        .where('id', '=', existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return toView(revoked);
    });
  }

  async rotate(
    developerId: ResourceId<'dev'>,
    apiKeyId: ResourceId<'apk'>,
    expiresInDaysInput?: number,
  ): Promise<Readonly<ApiKeySecret>> {
    const expiresInDays = parseExpiryDays(expiresInDaysInput);
    const rotationStartedAt = this.#now();

    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const existing = await transaction
          .selectFrom('apiKeys')
          .selectAll()
          .where('id', '=', getResourceUuid(apiKeyId))
          .where('developerId', '=', getResourceUuid(developerId))
          .where('status', '=', 'active')
          .where('expiresAt', '>', rotationStartedAt)
          .forUpdate()
          .executeTakeFirst();

        if (existing === undefined) {
          throw new ApiKeyError('not_found');
        }

        await transaction
          .updateTable('apiKeys')
          .set({ status: 'revoked', revokedAt: rotationStartedAt })
          .where('id', '=', existing.id)
          .executeTakeFirstOrThrow();
        const replacement = await this.#createInTransaction(
          transaction,
          developerId,
          existing.name,
          expiresInDays,
        );
        await transaction
          .updateTable('apiKeys')
          .set({ replacedByKeyId: getResourceUuid(replacement.apiKey.apiKeyId) })
          .where('id', '=', existing.id)
          .executeTakeFirstOrThrow();
        return replacement;
      });
    } catch (error) {
      if (hasDatabaseConstraint(error, 'api_keys_active_name_unique')) {
        throw new ApiKeyError('name_unavailable');
      }

      throw error;
    }
  }

  async authenticate(token: string): Promise<ResourceId<'dev'>> {
    const match = apiKeyTokenPattern.exec(token);

    if (match === null) {
      throw new ApiKeyError('invalid_token');
    }

    const apiKeyId = parseResourceId(match[1], 'apk');
    const expectedHash = hashToken(token);
    const now = this.#now();
    const apiKey = await this.#database
      .selectFrom('apiKeys')
      .innerJoin('developers', 'developers.id', 'apiKeys.developerId')
      .select(['apiKeys.id', 'apiKeys.developerId', 'apiKeys.tokenHash'])
      .where('apiKeys.id', '=', getResourceUuid(apiKeyId))
      .where('apiKeys.status', '=', 'active')
      .where('apiKeys.expiresAt', '>', now)
      .where('developers.status', '=', 'active')
      .executeTakeFirst();

    if (apiKey === undefined) {
      throw new ApiKeyError('invalid_token');
    }

    if (
      apiKey.tokenHash.byteLength !== expectedHash.byteLength ||
      !timingSafeEqual(apiKey.tokenHash, expectedHash)
    ) {
      throw new ApiKeyError('invalid_token');
    }

    await this.#database
      .updateTable('apiKeys')
      .set({ lastUsedAt: now })
      .where('id', '=', apiKey.id)
      .executeTakeFirst();

    return parseResourceId(`dev_${apiKey.developerId}`, 'dev');
  }
}
