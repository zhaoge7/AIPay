import { Buffer } from 'node:buffer';

import {
  formatUtcDateTime,
  getResourceUuid,
  parseResourceId,
  type ResourceId,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';

export type AgentErrorCode =
  | 'invalid_name'
  | 'invalid_public_key'
  | 'name_unavailable'
  | 'public_key_unavailable'
  | 'not_found';

export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode) {
    super('Agent operation failed');
    this.name = 'AgentError';
    this.code = code;
  }
}

export interface AgentView {
  readonly agentId: ResourceId<'agt'>;
  readonly name: string;
  readonly status: 'enabled' | 'disabled' | 'revoked';
  readonly signingKey: Readonly<{
    keyId: ResourceId<'key'>;
    algorithm: 'ed25519';
    publicKey: string;
  }>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface AgentRow {
  readonly id: string;
  readonly name: string;
  readonly status: 'enabled' | 'disabled' | 'revoked';
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly keyId: string;
  readonly algorithm: 'ed25519';
  readonly publicKey: Uint8Array;
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
    throw new AgentError('invalid_name');
  }

  return normalized;
}

function parseEd25519PublicKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new AgentError('invalid_public_key');
  }

  const bytes = Buffer.from(value, 'base64url');

  if (bytes.byteLength !== 32 || bytes.toString('base64url') !== value) {
    throw new AgentError('invalid_public_key');
  }

  return bytes;
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

function toView(row: AgentRow): Readonly<AgentView> {
  return Object.freeze({
    agentId: parseResourceId(`agt_${row.id}`, 'agt'),
    name: row.name,
    status: row.status,
    signingKey: Object.freeze({
      keyId: parseResourceId(`key_${row.keyId}`, 'key'),
      algorithm: row.algorithm,
      publicKey: Buffer.from(row.publicKey).toString('base64url'),
    }),
    createdAt: formatUtcDateTime(row.createdAt),
    updatedAt: formatUtcDateTime(row.updatedAt),
  });
}

export class AgentService {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async create(
    developerId: ResourceId<'dev'>,
    nameInput: string,
    publicKeyInput: string,
  ): Promise<Readonly<AgentView>> {
    const name = normalizeName(nameInput);
    const publicKey = parseEd25519PublicKey(publicKeyInput);

    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const agent = await transaction
          .insertInto('agents')
          .values({ developerId: getResourceUuid(developerId), name })
          .returning(['id', 'name', 'status', 'createdAt', 'updatedAt'])
          .executeTakeFirstOrThrow();
        const signingKey = await transaction
          .insertInto('signingKeys')
          .values({
            ownerType: 'agent',
            developerId: null,
            agentId: agent.id,
            merchantId: null,
            publicKey,
            revokedAt: null,
          })
          .returning(['id', 'algorithm', 'publicKey'])
          .executeTakeFirstOrThrow();

        return toView({
          ...agent,
          keyId: signingKey.id,
          algorithm: signingKey.algorithm,
          publicKey: signingKey.publicKey,
        });
      });
    } catch (error) {
      if (hasDatabaseConstraint(error, 'agents_active_name_unique')) {
        throw new AgentError('name_unavailable');
      }

      if (hasDatabaseConstraint(error, 'signing_keys_public_key_unique')) {
        throw new AgentError('public_key_unavailable');
      }

      throw error;
    }
  }

  async list(developerId: ResourceId<'dev'>): Promise<readonly Readonly<AgentView>[]> {
    const rows = await this.#database
      .selectFrom('agents')
      .innerJoin('signingKeys', (join) =>
        join
          .onRef('signingKeys.agentId', '=', 'agents.id')
          .on('signingKeys.ownerType', '=', 'agent')
          .on('signingKeys.status', '=', 'active'),
      )
      .select([
        'agents.id',
        'agents.name',
        'agents.status',
        'agents.createdAt',
        'agents.updatedAt',
        'signingKeys.id as keyId',
        'signingKeys.algorithm',
        'signingKeys.publicKey',
      ])
      .where('agents.developerId', '=', getResourceUuid(developerId))
      .orderBy('agents.createdAt', 'desc')
      .orderBy('agents.id', 'desc')
      .execute();

    return Object.freeze(rows.map(toView));
  }

  async setStatus(
    developerId: ResourceId<'dev'>,
    agentId: ResourceId<'agt'>,
    status: 'enabled' | 'disabled',
  ): Promise<Readonly<AgentView>> {
    const updated = await this.#database
      .updateTable('agents')
      .set({ status, updatedAt: new Date() })
      .where('id', '=', getResourceUuid(agentId))
      .where('developerId', '=', getResourceUuid(developerId))
      .where('status', '<>', 'revoked')
      .returning(['id', 'name', 'status', 'createdAt', 'updatedAt'])
      .executeTakeFirst();

    if (updated === undefined) {
      throw new AgentError('not_found');
    }

    const signingKey = await this.#database
      .selectFrom('signingKeys')
      .select(['id', 'algorithm', 'publicKey'])
      .where('agentId', '=', updated.id)
      .where('ownerType', '=', 'agent')
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();

    return toView({
      ...updated,
      keyId: signingKey.id,
      algorithm: signingKey.algorithm,
      publicKey: signingKey.publicKey,
    });
  }
}
