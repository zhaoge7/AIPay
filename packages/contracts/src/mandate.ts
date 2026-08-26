import * as z from 'zod';

import { getResourceIdPattern, parseResourceId, type ResourceId } from './values/identifier.js';
import { createMoney, MAX_MINOR_AMOUNT, type Money } from './values/money.js';
import { isExpired, parseUtcDateTime, type UtcDateTime } from './values/time.js';

export const MANDATE_SIGNATURE_DOMAIN = 'AIPAY-MANDATE-V1\0';

const maxMinorAmountDigits = MAX_MINOR_AMOUNT.toString().length;
const minorAmountPattern = /^(0|[1-9][0-9]*)$/;
const utcDateTimePattern =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const categoryPattern = /^[a-z][a-z0-9._-]{0,63}$/;
const sha256DigestPattern = /^sha256:[0-9a-f]{64}$/;
const ed25519SignaturePattern = /^[A-Za-z0-9_-]{85}[AQgw]$/;

const resourceIdSchema = (prefix: Parameters<typeof getResourceIdPattern>[0]) =>
  z.string().regex(getResourceIdPattern(prefix));

const MoneySchema = z.strictObject({
  currency: z.literal('CNY'),
  amountMinor: z.string().max(maxMinorAmountDigits).regex(minorAmountPattern),
});

const ProofSchema = z.strictObject({
  scheme: z.literal('aipay-jcs-ed25519-v1'),
  keyId: resourceIdSchema('key'),
  value: z.string().regex(ed25519SignaturePattern),
});

export const MandateWireSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  mandateId: resourceIdSchema('mdt'),
  principalId: resourceIdSchema('dev'),
  agentId: resourceIdSchema('agt'),
  purpose: z.string().min(1).max(500),
  allowedMerchantIds: z.array(resourceIdSchema('mch')).min(1).max(100),
  allowedCategories: z.array(z.string().regex(categoryPattern)).min(1).max(50),
  maxPerTransaction: MoneySchema,
  totalBudget: MoneySchema,
  approvalRequiredAbove: MoneySchema,
  maxTransactions: z.number().int().min(1).max(1_000_000),
  issuedAt: z.string().regex(utcDateTimePattern),
  validUntil: z.string().regex(utcDateTimePattern),
  instructionHash: z.string().regex(sha256DigestPattern),
  proof: ProofSchema,
});

export type MandateWire = z.infer<typeof MandateWireSchema>;

declare const sha256DigestBrand: unique symbol;

export type Sha256Digest = string & {
  readonly [sha256DigestBrand]: true;
};

declare const mandateProofValueBrand: unique symbol;

export interface MandateProof {
  readonly scheme: 'aipay-jcs-ed25519-v1';
  readonly keyId: ResourceId<'key'>;
  readonly value: string & { readonly [mandateProofValueBrand]: true };
}

export interface Mandate {
  readonly schemaVersion: '1';
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
  readonly issuedAt: UtcDateTime;
  readonly validUntil: UtcDateTime;
  readonly instructionHash: Sha256Digest;
  readonly proof: Readonly<MandateProof>;
}

export interface MandateSigningPayload {
  readonly schemaVersion: Mandate['schemaVersion'];
  readonly mandateId: Mandate['mandateId'];
  readonly principalId: Mandate['principalId'];
  readonly agentId: Mandate['agentId'];
  readonly purpose: Mandate['purpose'];
  readonly allowedMerchantIds: Mandate['allowedMerchantIds'];
  readonly allowedCategories: Mandate['allowedCategories'];
  readonly maxPerTransaction: Mandate['maxPerTransaction'];
  readonly totalBudget: Mandate['totalBudget'];
  readonly approvalRequiredAbove: Mandate['approvalRequiredAbove'];
  readonly maxTransactions: Mandate['maxTransactions'];
  readonly issuedAt: Mandate['issuedAt'];
  readonly validUntil: Mandate['validUntil'];
  readonly instructionHash: Mandate['instructionHash'];
  readonly proof: Readonly<Omit<Mandate['proof'], 'value'>>;
}

export type ContractValidationIssueCode =
  | 'invalid_type'
  | 'invalid_value'
  | 'invalid_format'
  | 'out_of_range'
  | 'unknown_field'
  | 'duplicate_allowed_merchant'
  | 'duplicate_allowed_category'
  | 'invalid_unicode'
  | 'invalid_validity_window'
  | 'max_per_transaction_exceeds_budget';

export interface ContractValidationIssue {
  readonly code: ContractValidationIssueCode;
  readonly path: string;
}

export class ContractValidationError extends Error {
  readonly issues: readonly Readonly<ContractValidationIssue>[];

  constructor(issues: readonly ContractValidationIssue[]) {
    super('Invalid Mandate contract');
    this.name = 'ContractValidationError';
    this.issues = Object.freeze(
      issues.map((issue) => Object.freeze({ code: issue.code, path: issue.path })),
    );
  }
}

function escapeJsonPointerSegment(segment: PropertyKey): string {
  return String(segment).replaceAll('~', '~0').replaceAll('/', '~1');
}

function toJsonPointer(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '/' : `/${path.map(escapeJsonPointerSegment).join('/')}`;
}

function mapZodIssueCode(code: string): ContractValidationIssueCode {
  switch (code) {
    case 'invalid_type':
      return 'invalid_type';
    case 'too_small':
    case 'too_big':
      return 'out_of_range';
    case 'unrecognized_keys':
      return 'unknown_field';
    case 'invalid_format':
      return 'invalid_format';
    default:
      return 'invalid_value';
  }
}

function validateUniqueValues(
  values: readonly string[],
  path: string,
  code: ContractValidationIssueCode,
) {
  if (new Set(values).size !== values.length) {
    return Object.freeze({ code, path });
  }

  return undefined;
}

function hasInvalidPurposeText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      return true;
    }

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);

      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        return true;
      }

      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }

  return false;
}

function validateMoney(
  value: MandateWire['totalBudget'],
  path: string,
  issues: ContractValidationIssue[],
): Readonly<Money> | undefined {
  try {
    return createMoney(value.currency, value.amountMinor);
  } catch {
    issues.push({ code: 'out_of_range', path });
    return undefined;
  }
}

function validateSemantics(mandate: MandateWire): readonly ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];
  const duplicateMerchant = validateUniqueValues(
    mandate.allowedMerchantIds,
    '/allowedMerchantIds',
    'duplicate_allowed_merchant',
  );
  const duplicateCategory = validateUniqueValues(
    mandate.allowedCategories,
    '/allowedCategories',
    'duplicate_allowed_category',
  );

  if (duplicateMerchant !== undefined) {
    issues.push(duplicateMerchant);
  }

  if (duplicateCategory !== undefined) {
    issues.push(duplicateCategory);
  }

  if (hasInvalidPurposeText(mandate.purpose)) {
    issues.push({ code: 'invalid_unicode', path: '/purpose' });
  }

  let issuedAt: UtcDateTime | undefined;
  let validUntil: UtcDateTime | undefined;

  try {
    issuedAt = parseUtcDateTime(mandate.issuedAt);
  } catch {
    issues.push({ code: 'invalid_format', path: '/issuedAt' });
  }

  try {
    validUntil = parseUtcDateTime(mandate.validUntil);
  } catch {
    issues.push({ code: 'invalid_format', path: '/validUntil' });
  }

  if (issuedAt !== undefined && validUntil !== undefined && isExpired(validUntil, issuedAt)) {
    issues.push({ code: 'invalid_validity_window', path: '/validUntil' });
  }

  const maxPerTransaction = validateMoney(mandate.maxPerTransaction, '/maxPerTransaction', issues);
  const totalBudget = validateMoney(mandate.totalBudget, '/totalBudget', issues);
  validateMoney(mandate.approvalRequiredAbove, '/approvalRequiredAbove', issues);

  if (
    maxPerTransaction !== undefined &&
    totalBudget !== undefined &&
    BigInt(maxPerTransaction.amountMinor) > BigInt(totalBudget.amountMinor)
  ) {
    issues.push({
      code: 'max_per_transaction_exceeds_budget',
      path: '/maxPerTransaction',
    });
  }

  return issues;
}

function toMandate(wire: MandateWire): Mandate {
  return Object.freeze({
    schemaVersion: wire.schemaVersion,
    mandateId: parseResourceId(wire.mandateId, 'mdt'),
    principalId: parseResourceId(wire.principalId, 'dev'),
    agentId: parseResourceId(wire.agentId, 'agt'),
    purpose: wire.purpose,
    allowedMerchantIds: Object.freeze(
      wire.allowedMerchantIds.map((id) => parseResourceId(id, 'mch')),
    ),
    allowedCategories: Object.freeze([...wire.allowedCategories]),
    maxPerTransaction: createMoney(
      wire.maxPerTransaction.currency,
      wire.maxPerTransaction.amountMinor,
    ),
    totalBudget: createMoney(wire.totalBudget.currency, wire.totalBudget.amountMinor),
    approvalRequiredAbove: createMoney(
      wire.approvalRequiredAbove.currency,
      wire.approvalRequiredAbove.amountMinor,
    ),
    maxTransactions: wire.maxTransactions,
    issuedAt: parseUtcDateTime(wire.issuedAt),
    validUntil: parseUtcDateTime(wire.validUntil),
    instructionHash: wire.instructionHash as Sha256Digest,
    proof: Object.freeze({
      scheme: wire.proof.scheme,
      keyId: parseResourceId(wire.proof.keyId, 'key'),
      value: wire.proof.value as MandateProof['value'],
    }),
  });
}

export function parseMandate(value: unknown): Mandate {
  const result = MandateWireSchema.safeParse(value);

  if (!result.success) {
    throw new ContractValidationError(
      result.error.issues.map((issue) => ({
        code: mapZodIssueCode(issue.code),
        path: toJsonPointer(issue.path),
      })),
    );
  }

  const semanticIssues = validateSemantics(result.data);

  if (semanticIssues.length > 0) {
    throw new ContractValidationError(semanticIssues);
  }

  return toMandate(result.data);
}

export function getMandateSigningPayload(mandate: Mandate): Readonly<MandateSigningPayload> {
  return Object.freeze({
    schemaVersion: mandate.schemaVersion,
    mandateId: mandate.mandateId,
    principalId: mandate.principalId,
    agentId: mandate.agentId,
    purpose: mandate.purpose,
    allowedMerchantIds: Object.freeze([...mandate.allowedMerchantIds]),
    allowedCategories: Object.freeze([...mandate.allowedCategories]),
    maxPerTransaction: Object.freeze({ ...mandate.maxPerTransaction }),
    totalBudget: Object.freeze({ ...mandate.totalBudget }),
    approvalRequiredAbove: Object.freeze({ ...mandate.approvalRequiredAbove }),
    maxTransactions: mandate.maxTransactions,
    issuedAt: mandate.issuedAt,
    validUntil: mandate.validUntil,
    instructionHash: mandate.instructionHash,
    proof: Object.freeze({
      scheme: mandate.proof.scheme,
      keyId: mandate.proof.keyId,
    }),
  });
}

export function getMandateJsonSchema() {
  return z.toJSONSchema(MandateWireSchema, { target: 'draft-2020-12' });
}
