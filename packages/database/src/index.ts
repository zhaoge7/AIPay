import { CamelCasePlugin, Kysely, PostgresDialect, type Generated } from 'kysely';
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

export interface AIPayDatabase {
  developers: DeveloperTable;
  authSessions: AuthSessionTable;
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
