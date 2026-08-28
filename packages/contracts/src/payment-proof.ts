import canonicalize from 'canonicalize';
import * as z from 'zod';

import {
  ContractValidationError,
  mapSchemaIssueCode,
  toJsonPointer,
  type ContractValidationIssue,
} from './contract-validation.js';
import { getResourceIdPattern, parseResourceId, type ResourceId } from './values/identifier.js';
import { createMoney, MAX_MINOR_AMOUNT, type Money } from './values/money.js';
import { isExpired, parseUtcDateTime, type UtcDateTime } from './values/time.js';

export const PAYMENT_PROOF_SIGNATURE_DOMAIN = 'AIPAY-PAYMENT-PROOF-V1\0';
export const MAX_PAYMENT_PROOF_VALIDITY_MS = 15 * 60 * 1_000;

const maxMinorAmountDigits = MAX_MINOR_AMOUNT.toString().length;
const minorAmountPattern = /^(0|[1-9][0-9]*)$/;
const utcDateTimePattern =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
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

export const PaymentProofWireSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  paymentProofId: resourceIdSchema('ppf'),
  transactionId: resourceIdSchema('txn'),
  paymentAttemptId: resourceIdSchema('pat'),
  merchantId: resourceIdSchema('mch'),
  serviceId: resourceIdSchema('svc'),
  amount: MoneySchema,
  issuedAt: z.string().regex(utcDateTimePattern),
  expiresAt: z.string().regex(utcDateTimePattern),
  proof: ProofSchema,
});

export type PaymentProofWire = z.infer<typeof PaymentProofWireSchema>;

declare const paymentProofValueBrand: unique symbol;

export interface PaymentProofSignature {
  readonly scheme: 'aipay-jcs-ed25519-v1';
  readonly keyId: ResourceId<'key'>;
  readonly value: string & { readonly [paymentProofValueBrand]: true };
}

export interface PaymentProof {
  readonly schemaVersion: '1';
  readonly paymentProofId: ResourceId<'ppf'>;
  readonly transactionId: ResourceId<'txn'>;
  readonly paymentAttemptId: ResourceId<'pat'>;
  readonly merchantId: ResourceId<'mch'>;
  readonly serviceId: ResourceId<'svc'>;
  readonly amount: Readonly<Money>;
  readonly issuedAt: UtcDateTime;
  readonly expiresAt: UtcDateTime;
  readonly proof: Readonly<PaymentProofSignature>;
}

export interface PaymentProofSigningPayload {
  readonly schemaVersion: PaymentProof['schemaVersion'];
  readonly paymentProofId: PaymentProof['paymentProofId'];
  readonly transactionId: PaymentProof['transactionId'];
  readonly paymentAttemptId: PaymentProof['paymentAttemptId'];
  readonly merchantId: PaymentProof['merchantId'];
  readonly serviceId: PaymentProof['serviceId'];
  readonly amount: PaymentProof['amount'];
  readonly issuedAt: PaymentProof['issuedAt'];
  readonly expiresAt: PaymentProof['expiresAt'];
  readonly proof: Readonly<Omit<PaymentProof['proof'], 'value'>>;
}

function validateSemantics(value: PaymentProofWire): readonly ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];
  let issuedAt: UtcDateTime | undefined;
  let expiresAt: UtcDateTime | undefined;

  try {
    issuedAt = parseUtcDateTime(value.issuedAt);
  } catch {
    issues.push({ code: 'invalid_format', path: '/issuedAt' });
  }

  try {
    expiresAt = parseUtcDateTime(value.expiresAt);
  } catch {
    issues.push({ code: 'invalid_format', path: '/expiresAt' });
  }

  if (issuedAt !== undefined && expiresAt !== undefined) {
    const validityMs = Date.parse(expiresAt) - Date.parse(issuedAt);

    if (isExpired(expiresAt, issuedAt) || validityMs > MAX_PAYMENT_PROOF_VALIDITY_MS) {
      issues.push({ code: 'invalid_validity_window', path: '/expiresAt' });
    }
  }

  try {
    const amount = createMoney(value.amount.currency, value.amount.amountMinor);

    if (BigInt(amount.amountMinor) === 0n) {
      issues.push({ code: 'non_positive_total', path: '/amount' });
    }
  } catch {
    issues.push({ code: 'out_of_range', path: '/amount' });
  }

  return issues;
}

function toPaymentProof(wire: PaymentProofWire): PaymentProof {
  return Object.freeze({
    schemaVersion: wire.schemaVersion,
    paymentProofId: parseResourceId(wire.paymentProofId, 'ppf'),
    transactionId: parseResourceId(wire.transactionId, 'txn'),
    paymentAttemptId: parseResourceId(wire.paymentAttemptId, 'pat'),
    merchantId: parseResourceId(wire.merchantId, 'mch'),
    serviceId: parseResourceId(wire.serviceId, 'svc'),
    amount: createMoney(wire.amount.currency, wire.amount.amountMinor),
    issuedAt: parseUtcDateTime(wire.issuedAt),
    expiresAt: parseUtcDateTime(wire.expiresAt),
    proof: Object.freeze({
      scheme: wire.proof.scheme,
      keyId: parseResourceId(wire.proof.keyId, 'key'),
      value: wire.proof.value as PaymentProofSignature['value'],
    }),
  });
}

export function parsePaymentProof(value: unknown): PaymentProof {
  const result = PaymentProofWireSchema.safeParse(value);

  if (!result.success) {
    throw new ContractValidationError(
      'PaymentProof',
      result.error.issues.map((issue) => ({
        code: mapSchemaIssueCode(issue.code),
        path: toJsonPointer(issue.path),
      })),
    );
  }

  const semanticIssues = validateSemantics(result.data);

  if (semanticIssues.length > 0) {
    throw new ContractValidationError('PaymentProof', semanticIssues);
  }

  return toPaymentProof(result.data);
}

export function getPaymentProofSigningPayload(
  paymentProof: PaymentProof,
): Readonly<PaymentProofSigningPayload> {
  return Object.freeze({
    schemaVersion: paymentProof.schemaVersion,
    paymentProofId: paymentProof.paymentProofId,
    transactionId: paymentProof.transactionId,
    paymentAttemptId: paymentProof.paymentAttemptId,
    merchantId: paymentProof.merchantId,
    serviceId: paymentProof.serviceId,
    amount: Object.freeze({ ...paymentProof.amount }),
    issuedAt: paymentProof.issuedAt,
    expiresAt: paymentProof.expiresAt,
    proof: Object.freeze({
      scheme: paymentProof.proof.scheme,
      keyId: paymentProof.proof.keyId,
    }),
  });
}

export function canonicalizePaymentProofSigningPayload(
  payload: PaymentProofSigningPayload,
): string {
  const canonical = canonicalize(payload);

  if (canonical === undefined) {
    throw new Error('Payment Proof signing payload cannot be canonicalized');
  }

  return canonical;
}

export function toPaymentProofWire(paymentProof: PaymentProof): Readonly<PaymentProofWire> {
  const wire: PaymentProofWire = {
    schemaVersion: paymentProof.schemaVersion,
    paymentProofId: paymentProof.paymentProofId,
    transactionId: paymentProof.transactionId,
    paymentAttemptId: paymentProof.paymentAttemptId,
    merchantId: paymentProof.merchantId,
    serviceId: paymentProof.serviceId,
    amount: { ...paymentProof.amount },
    issuedAt: paymentProof.issuedAt,
    expiresAt: paymentProof.expiresAt,
    proof: { ...paymentProof.proof },
  };

  Object.freeze(wire.amount);
  Object.freeze(wire.proof);
  return Object.freeze(wire);
}

export function getPaymentProofJsonSchema() {
  return z.toJSONSchema(PaymentProofWireSchema, { target: 'draft-2020-12' });
}
