import { createHash, randomBytes } from 'node:crypto';

import {
  formatUtcDateTime,
  getResourceUuid,
  parseResourceId,
  type ResourceId,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';

import { hashPassword, verifyPassword } from './password.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const sessionDurationMs = 30 * 24 * 60 * 60 * 1_000;

export type AuthErrorCode =
  'invalid_email' | 'invalid_password' | 'email_unavailable' | 'invalid_credentials';

export class AuthError extends Error {
  readonly code: AuthErrorCode;

  constructor(code: AuthErrorCode) {
    super('Authentication request failed');
    this.name = 'AuthError';
    this.code = code;
  }
}

export interface AuthenticatedDeveloper {
  readonly developerId: ResourceId<'dev'>;
  readonly email: string;
  readonly createdAt: string;
}

export interface AuthResult {
  readonly developer: Readonly<AuthenticatedDeveloper>;
  readonly sessionToken: string;
  readonly sessionExpiresAt: string;
}

export interface AuthServiceOptions {
  readonly now?: () => Date;
  readonly randomTokenBytes?: () => Uint8Array;
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();

  if (normalized.length < 3 || normalized.length > 254 || !emailPattern.test(normalized)) {
    throw new AuthError('invalid_email');
  }

  return normalized;
}

function inspectPassword(password: string) {
  let codePointLength = 0;
  let hasControlCharacter = false;

  for (const character of password) {
    codePointLength += 1;
    const codePoint = character.codePointAt(0);

    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      hasControlCharacter = true;
    }
  }

  return Object.freeze({
    codePointLength,
    byteLength: Buffer.byteLength(password, 'utf8'),
    hasControlCharacter,
  });
}

function assertAcceptablePassword(password: string): void {
  const properties = inspectPassword(password);

  if (
    properties.codePointLength < 12 ||
    properties.codePointLength > 128 ||
    properties.byteLength > 1_024 ||
    properties.hasControlCharacter
  ) {
    throw new AuthError('invalid_password');
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

function createSessionMaterial(randomTokenBytes: () => Uint8Array) {
  const bytes = randomTokenBytes();

  if (bytes.byteLength !== 32) {
    throw new Error('Session token generator must return exactly 32 bytes');
  }

  const token = `aps_${Buffer.from(bytes).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(token, 'utf8').digest();
  return Object.freeze({ token, tokenHash });
}

function toDeveloper(row: {
  readonly id: string;
  readonly email: string;
  readonly createdAt: Date;
}): Readonly<AuthenticatedDeveloper> {
  return Object.freeze({
    developerId: parseResourceId(`dev_${row.id}`, 'dev'),
    email: row.email,
    createdAt: formatUtcDateTime(row.createdAt),
  });
}

export class AuthService {
  readonly #database: Database;
  readonly #now: () => Date;
  readonly #randomTokenBytes: () => Uint8Array;
  readonly #dummyPasswordHash: Promise<string>;

  constructor(database: Database, options: AuthServiceOptions = {}) {
    this.#database = database;
    this.#now = options.now ?? (() => new Date());
    this.#randomTokenBytes = options.randomTokenBytes ?? (() => randomBytes(32));
    this.#dummyPasswordHash = hashPassword('AIPay dummy password that is never accepted');
  }

  async register(emailInput: string, password: string): Promise<Readonly<AuthResult>> {
    const email = normalizeEmail(emailInput);
    assertAcceptablePassword(password);
    const passwordHash = await hashPassword(password);
    const now = this.#now();
    const expiresAt = new Date(now.getTime() + sessionDurationMs);
    const session = createSessionMaterial(this.#randomTokenBytes);

    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const developer = await transaction
          .insertInto('developers')
          .values({ email, passwordHash })
          .returning(['id', 'email', 'createdAt'])
          .executeTakeFirstOrThrow();

        await transaction
          .insertInto('authSessions')
          .values({
            developerId: developer.id,
            tokenHash: session.tokenHash,
            expiresAt,
            revokedAt: null,
          })
          .executeTakeFirstOrThrow();

        return Object.freeze({
          developer: toDeveloper(developer),
          sessionToken: session.token,
          sessionExpiresAt: formatUtcDateTime(expiresAt),
        });
      });
    } catch (error) {
      if (hasDatabaseConstraint(error, 'developers_email_unique')) {
        throw new AuthError('email_unavailable');
      }

      throw error;
    }
  }

  async login(emailInput: string, password: string): Promise<Readonly<AuthResult>> {
    let email: string;

    try {
      email = normalizeEmail(emailInput);
    } catch {
      email = 'invalid@example.invalid';
    }

    const passwordProperties = inspectPassword(password);

    if (
      passwordProperties.codePointLength > 128 ||
      passwordProperties.byteLength > 1_024 ||
      passwordProperties.hasControlCharacter
    ) {
      throw new AuthError('invalid_credentials');
    }

    const developer = await this.#database
      .selectFrom('developers')
      .select(['id', 'email', 'passwordHash', 'status', 'createdAt'])
      .where('email', '=', email)
      .executeTakeFirst();
    const passwordHash = developer?.passwordHash ?? (await this.#dummyPasswordHash);
    const validPassword = await verifyPassword(passwordHash, password);

    if (developer === undefined || !validPassword || developer.status !== 'active') {
      throw new AuthError('invalid_credentials');
    }

    const now = this.#now();
    const expiresAt = new Date(now.getTime() + sessionDurationMs);
    const session = createSessionMaterial(this.#randomTokenBytes);

    await this.#database
      .insertInto('authSessions')
      .values({
        developerId: developer.id,
        tokenHash: session.tokenHash,
        expiresAt,
        revokedAt: null,
      })
      .executeTakeFirstOrThrow();

    return Object.freeze({
      developer: toDeveloper(developer),
      sessionToken: session.token,
      sessionExpiresAt: formatUtcDateTime(expiresAt),
    });
  }

  async current(developerId: ResourceId<'dev'>): Promise<Readonly<AuthenticatedDeveloper>> {
    const developer = await this.#database
      .selectFrom('developers')
      .select(['id', 'email', 'createdAt'])
      .where('id', '=', getResourceUuid(developerId))
      .where('status', '=', 'active')
      .executeTakeFirst();

    if (developer === undefined) {
      throw new AuthError('invalid_credentials');
    }

    return toDeveloper(developer);
  }

  async logout(sessionToken: string): Promise<void> {
    if (!/^aps_[A-Za-z0-9_-]{43}$/u.test(sessionToken)) {
      throw new AuthError('invalid_credentials');
    }

    const result = await this.#database
      .updateTable('authSessions')
      .set({ revokedAt: this.#now() })
      .where('tokenHash', '=', createHash('sha256').update(sessionToken, 'utf8').digest())
      .where('revokedAt', 'is', null)
      .executeTakeFirst();

    if (result.numUpdatedRows !== 1n) {
      throw new AuthError('invalid_credentials');
    }
  }
}
