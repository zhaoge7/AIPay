import * as z from 'zod';

import {
  ContractValidationError,
  mapSchemaIssueCode,
  toJsonPointer,
  type ContractValidationIssue,
} from './contract-validation.js';
import { getResourceIdPattern, parseResourceId, type ResourceId } from './values/identifier.js';
import { createMoney, MAX_MINOR_AMOUNT, type Money } from './values/money.js';
import { parseUtcDateTime, type UtcDateTime } from './values/time.js';

const maxMinorAmountDigits = MAX_MINOR_AMOUNT.toString().length;
const minorAmountPattern = /^(0|[1-9][0-9]*)$/;
const utcDateTimePattern =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

const resourceIdSchema = (prefix: Parameters<typeof getResourceIdPattern>[0]) =>
  z.string().regex(getResourceIdPattern(prefix));

const MoneySchema = z.strictObject({
  currency: z.literal('CNY'),
  amountMinor: z.string().max(maxMinorAmountDigits).regex(minorAmountPattern),
});

export const transactionStatuses = [
  'requires_confirmation',
  'authorized',
  'payment_pending',
  'paid',
  'delivery_pending',
  'delivered',
  'refund_pending',
  'refunded',
  'failed',
  'cancelled',
  'manual_review',
] as const;

export type TransactionStatus = (typeof transactionStatuses)[number];

export const TransactionWireSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  transactionId: resourceIdSchema('txn'),
  quoteId: resourceIdSchema('qte'),
  mandateId: resourceIdSchema('mdt'),
  principalId: resourceIdSchema('dev'),
  agentId: resourceIdSchema('agt'),
  merchantId: resourceIdSchema('mch'),
  serviceId: resourceIdSchema('svc'),
  amount: MoneySchema,
  status: z.enum(transactionStatuses),
  paymentAttemptIds: z.array(resourceIdSchema('pat')).max(100),
  deliveryId: z.nullable(resourceIdSchema('dlv')),
  refundIds: z.array(resourceIdSchema('rfd')).max(100),
  createdAt: z.string().regex(utcDateTimePattern),
  updatedAt: z.string().regex(utcDateTimePattern),
});

export type TransactionWire = z.infer<typeof TransactionWireSchema>;

export interface Transaction {
  readonly schemaVersion: '1';
  readonly transactionId: ResourceId<'txn'>;
  readonly quoteId: ResourceId<'qte'>;
  readonly mandateId: ResourceId<'mdt'>;
  readonly principalId: ResourceId<'dev'>;
  readonly agentId: ResourceId<'agt'>;
  readonly merchantId: ResourceId<'mch'>;
  readonly serviceId: ResourceId<'svc'>;
  readonly amount: Readonly<Money>;
  readonly status: TransactionStatus;
  readonly paymentAttemptIds: readonly ResourceId<'pat'>[];
  readonly deliveryId: ResourceId<'dlv'> | null;
  readonly refundIds: readonly ResourceId<'rfd'>[];
  readonly createdAt: UtcDateTime;
  readonly updatedAt: UtcDateTime;
}

function validateUniqueReferences(
  values: readonly string[],
  path: string,
  issues: ContractValidationIssue[],
): void {
  if (new Set(values).size !== values.length) {
    issues.push({ code: 'duplicate_reference', path });
  }
}

function validateSemantics(transaction: TransactionWire): readonly ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];
  let createdAt: UtcDateTime | undefined;
  let updatedAt: UtcDateTime | undefined;

  try {
    createdAt = parseUtcDateTime(transaction.createdAt);
  } catch {
    issues.push({ code: 'invalid_format', path: '/createdAt' });
  }

  try {
    updatedAt = parseUtcDateTime(transaction.updatedAt);
  } catch {
    issues.push({ code: 'invalid_format', path: '/updatedAt' });
  }

  if (
    createdAt !== undefined &&
    updatedAt !== undefined &&
    Date.parse(updatedAt) < Date.parse(createdAt)
  ) {
    issues.push({ code: 'invalid_timestamp_order', path: '/updatedAt' });
  }

  try {
    const amount = createMoney(transaction.amount.currency, transaction.amount.amountMinor);

    if (BigInt(amount.amountMinor) === 0n) {
      issues.push({ code: 'non_positive_total', path: '/amount' });
    }
  } catch {
    issues.push({ code: 'out_of_range', path: '/amount' });
  }

  validateUniqueReferences(transaction.paymentAttemptIds, '/paymentAttemptIds', issues);
  validateUniqueReferences(transaction.refundIds, '/refundIds', issues);

  return issues;
}

function toTransaction(wire: TransactionWire): Transaction {
  return Object.freeze({
    schemaVersion: wire.schemaVersion,
    transactionId: parseResourceId(wire.transactionId, 'txn'),
    quoteId: parseResourceId(wire.quoteId, 'qte'),
    mandateId: parseResourceId(wire.mandateId, 'mdt'),
    principalId: parseResourceId(wire.principalId, 'dev'),
    agentId: parseResourceId(wire.agentId, 'agt'),
    merchantId: parseResourceId(wire.merchantId, 'mch'),
    serviceId: parseResourceId(wire.serviceId, 'svc'),
    amount: createMoney(wire.amount.currency, wire.amount.amountMinor),
    status: wire.status,
    paymentAttemptIds: Object.freeze(
      wire.paymentAttemptIds.map((id) => parseResourceId(id, 'pat')),
    ),
    deliveryId: wire.deliveryId === null ? null : parseResourceId(wire.deliveryId, 'dlv'),
    refundIds: Object.freeze(wire.refundIds.map((id) => parseResourceId(id, 'rfd'))),
    createdAt: parseUtcDateTime(wire.createdAt),
    updatedAt: parseUtcDateTime(wire.updatedAt),
  });
}

export function parseTransaction(value: unknown): Transaction {
  const result = TransactionWireSchema.safeParse(value);

  if (!result.success) {
    throw new ContractValidationError(
      'Transaction',
      result.error.issues.map((issue) => ({
        code: mapSchemaIssueCode(issue.code),
        path: toJsonPointer(issue.path),
      })),
    );
  }

  const semanticIssues = validateSemantics(result.data);

  if (semanticIssues.length > 0) {
    throw new ContractValidationError('Transaction', semanticIssues);
  }

  return toTransaction(result.data);
}

export function getTransactionJsonSchema() {
  return z.toJSONSchema(TransactionWireSchema, { target: 'draft-2020-12' });
}
