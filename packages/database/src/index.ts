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
  ownerType: 'developer' | 'agent' | 'merchant' | 'system';
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

export interface MandateTable {
  id: Generated<string>;
  schemaVersion: Generated<'1'>;
  principalId: string;
  agentId: string;
  purpose: string;
  currency: Generated<'CNY'>;
  maxPerTransactionAmountMinor: string;
  totalBudgetAmountMinor: string;
  approvalRequiredAboveAmountMinor: string;
  maxTransactions: number;
  issuedAt: Date;
  validUntil: Date;
  instructionHash: Uint8Array;
  proofScheme: Generated<'aipay-jcs-ed25519-v1'>;
  proofKeyId: string | null;
  proofValue: Uint8Array | null;
  status: Generated<'draft' | 'active' | 'paused' | 'revoked' | 'expired'>;
  createdAt: Generated<Date>;
  statusChangedAt: Generated<Date>;
  revokedAt: Date | null;
  spentAmountMinor: Generated<string>;
  completedTransactionCount: Generated<number>;
  reservedAmountMinor: Generated<string>;
  reservedTransactionCount: Generated<number>;
}

export interface BudgetReservationTable {
  id: Generated<string>;
  mandateId: string;
  agentId: string;
  currency: Generated<'CNY'>;
  amountMinor: string;
  status: Generated<'held' | 'released' | 'confirmed' | 'expired'>;
  createdAt: Generated<Date>;
  expiresAt: Date;
  finalizedAt: Date | null;
}

export interface MandateAllowedMerchantTable {
  mandateId: string;
  merchantId: string;
}

export interface MandateAllowedCategoryTable {
  mandateId: string;
  category: string;
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
  mandates: MandateTable;
  mandateAllowedMerchants: MandateAllowedMerchantTable;
  mandateAllowedCategories: MandateAllowedCategoryTable;
  budgetReservations: BudgetReservationTable;
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
