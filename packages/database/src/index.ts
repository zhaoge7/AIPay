import { CamelCasePlugin, Kysely, PostgresDialect, type Generated, type Transaction } from 'kysely';
import pg from 'pg';

const { Pool } = pg;

export const DATABASE_SCHEMA = 'aipay';
export const MIGRATIONS_TABLE = 'aipay_migrations';

export interface DeveloperTable {
  id: Generated<string>;
  email: string;
  passwordHash: string;
  status: Generated<'active' | 'suspended' | 'closed'>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface AuthSessionTable {
  id: Generated<string>;
  developerId: string;
  tokenHash: Uint8Array;
  createdAt: Generated<Date>;
  lastUsedAt: Generated<Date>;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface ApiKeyTable {
  id: Generated<string>;
  developerId: string;
  name: string;
  tokenHash: Uint8Array;
  tokenHint: string;
  status: Generated<'active' | 'revoked'>;
  createdAt: Generated<Date>;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  replacedByKeyId: string | null;
}

export interface AgentTable {
  id: Generated<string>;
  developerId: string;
  name: string;
  status: Generated<'enabled' | 'disabled' | 'revoked'>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface SigningKeyTable {
  id: Generated<string>;
  ownerType: 'developer' | 'agent' | 'merchant';
  developerId: string | null;
  agentId: string | null;
  merchantId: string | null;
  algorithm: Generated<'ed25519'>;
  publicKey: Uint8Array;
  status: Generated<'active' | 'revoked'>;
  createdAt: Generated<Date>;
  revokedAt: Date | null;
}

export interface AgentRequestNonceTable {
  id: Generated<string>;
  agentId: string;
  nonceHash: Uint8Array;
  createdAt: Generated<Date>;
  expiresAt: Date;
}

export interface MerchantTable {
  id: Generated<string>;
  developerId: string;
  name: string;
  callbackUrl: string;
  status: Generated<'active' | 'suspended' | 'closed'>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface ServiceTable {
  id: Generated<string>;
  merchantId: string;
  serviceType: 'api' | 'mcp' | 'skill';
  name: string;
  category: string;
  unit: string;
  unitPriceAmountMinor: string;
  currency: Generated<'CNY'>;
  refundPolicy: Generated<'full_on_delivery_failure' | 'non_refundable'>;
  status: Generated<'enabled' | 'disabled'>;
  createdAt: Generated<Date>;
  updatedAt: Generated<Date>;
}

export interface AIPayDatabase {
  developers: DeveloperTable;
  authSessions: AuthSessionTable;
  apiKeys: ApiKeyTable;
  agents: AgentTable;
  signingKeys: SigningKeyTable;
  agentRequestNonces: AgentRequestNonceTable;
  merchants: MerchantTable;
  services: ServiceTable;
}

export interface CreateDatabaseOptions {
  readonly maxConnections?: number;
}

export function createDatabase(
  connectionString: string,
  options: CreateDatabaseOptions = {},
): Kysely<AIPayDatabase> {
  return new Kysely<AIPayDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString,
        max: options.maxConnections ?? 10,
      }),
    }),
    plugins: [new CamelCasePlugin()],
  }).withSchema(DATABASE_SCHEMA);
}

export type Database = Kysely<AIPayDatabase>;
export type DatabaseTransaction = Transaction<AIPayDatabase>;
