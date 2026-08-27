import { Buffer } from 'node:buffer';

import {
  createMoney,
  formatUtcDateTime,
  getResourceUuid,
  parseResourceId,
  parseUtcDateTime,
  type Money,
  type ResourceId,
} from '@aipay/contracts';
import type { Database, DatabaseTransaction } from '@aipay/database';

const categoryPattern = /^[a-z][a-z0-9._-]{0,63}$/u;
const instructionHashPattern = /^sha256:([0-9a-f]{64})$/u;
const maxValidityMs = 365 * 24 * 60 * 60 * 1_000;

export type MandateDraftErrorCode =
  | 'invalid_purpose'
  | 'invalid_allowlist'
  | 'invalid_amount'
  | 'invalid_limit'
  | 'invalid_validity'
  | 'invalid_instruction_hash'
  | 'agent_unavailable'
  | 'merchant_unavailable';

export class MandateDraftError extends Error {
  readonly code: MandateDraftErrorCode;

  constructor(code: MandateDraftErrorCode) {
    super('Mandate draft operation failed');
    this.name = 'MandateDraftError';
    this.code = code;
  }
}

export interface MoneyInput {
  readonly currency: 'CNY';
  readonly amountMinor: string;
}

export interface CreateMandateDraftInput {
  readonly agentId: string;
  readonly purpose: string;
  readonly allowedMerchantIds: readonly string[];
  readonly allowedCategories: readonly string[];
  readonly maxPerTransaction: MoneyInput;
  readonly totalBudget: MoneyInput;
  readonly approvalRequiredAbove: MoneyInput;
  readonly maxTransactions: number;
  readonly validUntil: string;
  readonly instructionHash: string;
}

export interface MandateDraftView {
  readonly mandateId: ResourceId<'mdt'>;
  readonly principalId: ResourceId<'dev'>;
  readonly agentId: ResourceId<'agt'>;
  readonly purpose: string;
  readonly allowedMerchantIds: readonly ResourceId<'mch'>[];
  readonly allowedCategories: readonly string[];
  readonly maxPerTransaction: Readonly<Money>;
  readonly totalBudget: Readonly<Money>;
  readonly approvalRequiredAbove: Readonly<Money>;
  readonly maxTransactions: number;
  readonly issuedAt: string;
  readonly validUntil: string;
  readonly instructionHash: string;
  readonly status: 'draft';
  readonly createdAt: string;
}

interface MandateDraftRow {
  readonly id: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly purpose: string;
  readonly currency: 'CNY';
  readonly maxPerTransactionAmountMinor: string;
  readonly totalBudgetAmountMinor: string;
  readonly approvalRequiredAboveAmountMinor: string;
  readonly maxTransactions: number;
  readonly issuedAt: Date;
  readonly validUntil: Date;
  readonly instructionHash: Uint8Array;
  readonly status: 'draft' | 'active' | 'paused' | 'revoked' | 'expired';
  readonly createdAt: Date;
}

function hasInvalidText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }

  return false;
}

function parsePurpose(value: string): string {
  const codePointLength = Array.from(value).length;

  if (codePointLength < 1 || codePointLength > 500 || hasInvalidText(value)) {
    throw new MandateDraftError('invalid_purpose');
  }

  return value;
}

function parseMoneyInput(value: MoneyInput): Readonly<Money> {
  try {
    return createMoney(value.currency, value.amountMinor);
  } catch {
    throw new MandateDraftError('invalid_amount');
  }
}

function parseUniqueIds<Prefix extends 'mch'>(
  values: readonly string[],
  prefix: Prefix,
  maximum: number,
): readonly ResourceId<Prefix>[] {
  if (values.length < 1 || values.length > maximum || new Set(values).size !== values.length) {
    throw new MandateDraftError('invalid_allowlist');
  }

  try {
    return Object.freeze(values.map((value) => parseResourceId(value, prefix)));
  } catch {
    throw new MandateDraftError('invalid_allowlist');
  }
}

function parseCategories(values: readonly string[]): readonly string[] {
  if (
    values.length < 1 ||
    values.length > 50 ||
    new Set(values).size !== values.length ||
    values.some((value) => !categoryPattern.test(value))
  ) {
    throw new MandateDraftError('invalid_allowlist');
  }

  return Object.freeze([...values]);
}

function parseInstructionHash(value: string): Buffer {
  const match = instructionHashPattern.exec(value);
  const digest = match?.[1];

  if (digest === undefined) {
    throw new MandateDraftError('invalid_instruction_hash');
  }

  return Buffer.from(digest, 'hex');
}

function instructionHashString(value: Uint8Array): string {
  return `sha256:${Buffer.from(value).toString('hex')}`;
}

async function loadAllowlist(
  transaction: DatabaseTransaction,
  merchantIds: readonly ResourceId<'mch'>[],
): Promise<void> {
  const rows = await transaction
    .selectFrom('merchants')
    .select('id')
    .where(
      'id',
      'in',
      merchantIds.map((merchantId) => getResourceUuid(merchantId)),
    )
    .where('status', '=', 'active')
    .execute();

  if (rows.length !== merchantIds.length) {
    throw new MandateDraftError('merchant_unavailable');
  }
}

function toView(
  row: MandateDraftRow,
  merchantIds: readonly ResourceId<'mch'>[],
  categories: readonly string[],
): Readonly<MandateDraftView> {
  if (row.status !== 'draft') {
    throw new Error('New Mandate row must be a draft');
  }

  return Object.freeze({
    mandateId: parseResourceId(`mdt_${row.id}`, 'mdt'),
    principalId: parseResourceId(`dev_${row.principalId}`, 'dev'),
    agentId: parseResourceId(`agt_${row.agentId}`, 'agt'),
    purpose: row.purpose,
    allowedMerchantIds: merchantIds,
    allowedCategories: categories,
    maxPerTransaction: createMoney(row.currency, row.maxPerTransactionAmountMinor),
    totalBudget: createMoney(row.currency, row.totalBudgetAmountMinor),
    approvalRequiredAbove: createMoney(row.currency, row.approvalRequiredAboveAmountMinor),
    maxTransactions: row.maxTransactions,
    issuedAt: formatUtcDateTime(row.issuedAt),
    validUntil: formatUtcDateTime(row.validUntil),
    instructionHash: instructionHashString(row.instructionHash),
    status: row.status,
    createdAt: formatUtcDateTime(row.createdAt),
  });
}

const mandateDraftColumns = [
  'id',
  'principalId',
  'agentId',
  'purpose',
  'currency',
  'maxPerTransactionAmountMinor',
  'totalBudgetAmountMinor',
  'approvalRequiredAboveAmountMinor',
  'maxTransactions',
  'issuedAt',
  'validUntil',
  'instructionHash',
  'status',
  'createdAt',
] as const;

export class MandateDraftService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async create(
    principalId: ResourceId<'dev'>,
    input: CreateMandateDraftInput,
  ): Promise<Readonly<MandateDraftView>> {
    let agentId: ResourceId<'agt'>;

    try {
      agentId = parseResourceId(input.agentId, 'agt');
    } catch {
      throw new MandateDraftError('agent_unavailable');
    }

    const purpose = parsePurpose(input.purpose);
    const merchantIds = parseUniqueIds(input.allowedMerchantIds, 'mch', 100);
    const categories = parseCategories(input.allowedCategories);
    const maxPerTransaction = parseMoneyInput(input.maxPerTransaction);
    const totalBudget = parseMoneyInput(input.totalBudget);
    const approvalRequiredAbove = parseMoneyInput(input.approvalRequiredAbove);

    if (BigInt(maxPerTransaction.amountMinor) > BigInt(totalBudget.amountMinor)) {
      throw new MandateDraftError('invalid_amount');
    }

    if (
      !Number.isInteger(input.maxTransactions) ||
      input.maxTransactions < 1 ||
      input.maxTransactions > 1_000_000
    ) {
      throw new MandateDraftError('invalid_limit');
    }

    const now = this.#now();
    let validUntil: Date;

    try {
      validUntil = new Date(parseUtcDateTime(input.validUntil));
    } catch {
      throw new MandateDraftError('invalid_validity');
    }

    if (validUntil <= now || validUntil.getTime() - now.getTime() > maxValidityMs) {
      throw new MandateDraftError('invalid_validity');
    }

    const instructionHash = parseInstructionHash(input.instructionHash);

    return this.#database.transaction().execute(async (transaction) => {
      const agent = await transaction
        .selectFrom('agents')
        .select('id')
        .where('id', '=', getResourceUuid(agentId))
        .where('developerId', '=', getResourceUuid(principalId))
        .where('status', '=', 'enabled')
        .forShare()
        .executeTakeFirst();

      if (agent === undefined) {
        throw new MandateDraftError('agent_unavailable');
      }

      await loadAllowlist(transaction, merchantIds);
      const row = await transaction
        .insertInto('mandates')
        .values({
          principalId: getResourceUuid(principalId),
          agentId: agent.id,
          purpose,
          maxPerTransactionAmountMinor: maxPerTransaction.amountMinor,
          totalBudgetAmountMinor: totalBudget.amountMinor,
          approvalRequiredAboveAmountMinor: approvalRequiredAbove.amountMinor,
          maxTransactions: input.maxTransactions,
          issuedAt: now,
          validUntil,
          instructionHash,
          proofKeyId: null,
          proofValue: null,
        })
        .returning(mandateDraftColumns)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto('mandateAllowedMerchants')
        .values(
          merchantIds.map((merchantId) => ({
            mandateId: row.id,
            merchantId: getResourceUuid(merchantId),
          })),
        )
        .execute();
      await transaction
        .insertInto('mandateAllowedCategories')
        .values(categories.map((category) => ({ mandateId: row.id, category })))
        .execute();
      return toView(row, merchantIds, categories);
    });
  }
}
