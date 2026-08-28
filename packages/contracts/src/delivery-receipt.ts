import canonicalize from 'canonicalize';
import * as z from 'zod';

import {
  ContractValidationError,
  mapSchemaIssueCode,
  toJsonPointer,
  type ContractValidationIssue,
} from './contract-validation.js';
import { getResourceIdPattern, parseResourceId, type ResourceId } from './values/identifier.js';
import { parseUtcDateTime, type UtcDateTime } from './values/time.js';

export const DELIVERY_RECEIPT_SIGNATURE_DOMAIN = 'AIPAY-DELIVERY-RECEIPT-V1\0';

const utcDateTimePattern =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const errorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const ed25519SignaturePattern = /^[A-Za-z0-9_-]{85}[AQgw]$/;

const resourceIdSchema = (prefix: Parameters<typeof getResourceIdPattern>[0]) =>
  z.string().regex(getResourceIdPattern(prefix));

const ProofSchema = z.strictObject({
  scheme: z.literal('aipay-jcs-ed25519-v1'),
  keyId: resourceIdSchema('key'),
  value: z.string().regex(ed25519SignaturePattern),
});

export const DeliveryReceiptWireSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  deliveryId: resourceIdSchema('dlv'),
  transactionId: resourceIdSchema('txn'),
  paymentProofId: resourceIdSchema('ppf'),
  merchantId: resourceIdSchema('mch'),
  serviceId: resourceIdSchema('svc'),
  status: z.enum(['succeeded', 'failed']),
  resultDigest: z.string().regex(digestPattern),
  deliveredAt: z.string().regex(utcDateTimePattern),
  errorCode: z.nullable(z.string().regex(errorCodePattern)),
  proof: ProofSchema,
});

export type DeliveryReceiptWire = z.infer<typeof DeliveryReceiptWireSchema>;

declare const deliveryReceiptProofBrand: unique symbol;
declare const resultDigestBrand: unique symbol;

export interface DeliveryReceiptProof {
  readonly scheme: 'aipay-jcs-ed25519-v1';
  readonly keyId: ResourceId<'key'>;
  readonly value: string & { readonly [deliveryReceiptProofBrand]: true };
}

export type DeliveryResultDigest = string & { readonly [resultDigestBrand]: true };

export interface DeliveryReceipt {
  readonly schemaVersion: '1';
  readonly deliveryId: ResourceId<'dlv'>;
  readonly transactionId: ResourceId<'txn'>;
  readonly paymentProofId: ResourceId<'ppf'>;
  readonly merchantId: ResourceId<'mch'>;
  readonly serviceId: ResourceId<'svc'>;
  readonly status: 'succeeded' | 'failed';
  readonly resultDigest: DeliveryResultDigest;
  readonly deliveredAt: UtcDateTime;
  readonly errorCode: string | null;
  readonly proof: Readonly<DeliveryReceiptProof>;
}

export interface DeliveryReceiptSigningPayload extends Omit<DeliveryReceipt, 'proof'> {
  readonly proof: Readonly<Omit<DeliveryReceipt['proof'], 'value'>>;
}

function validateSemantics(value: DeliveryReceiptWire): readonly ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];

  try {
    parseUtcDateTime(value.deliveredAt);
  } catch {
    issues.push({ code: 'invalid_format', path: '/deliveredAt' });
  }

  if (
    (value.status === 'succeeded' && value.errorCode !== null) ||
    (value.status === 'failed' && value.errorCode === null)
  ) {
    issues.push({ code: 'invalid_result_code', path: '/errorCode' });
  }

  return issues;
}

function toDeliveryReceipt(wire: DeliveryReceiptWire): DeliveryReceipt {
  return Object.freeze({
    schemaVersion: wire.schemaVersion,
    deliveryId: parseResourceId(wire.deliveryId, 'dlv'),
    transactionId: parseResourceId(wire.transactionId, 'txn'),
    paymentProofId: parseResourceId(wire.paymentProofId, 'ppf'),
    merchantId: parseResourceId(wire.merchantId, 'mch'),
    serviceId: parseResourceId(wire.serviceId, 'svc'),
    status: wire.status,
    resultDigest: wire.resultDigest as DeliveryResultDigest,
    deliveredAt: parseUtcDateTime(wire.deliveredAt),
    errorCode: wire.errorCode,
    proof: Object.freeze({
      scheme: wire.proof.scheme,
      keyId: parseResourceId(wire.proof.keyId, 'key'),
      value: wire.proof.value as DeliveryReceiptProof['value'],
    }),
  });
}

export function parseDeliveryReceipt(value: unknown): DeliveryReceipt {
  const result = DeliveryReceiptWireSchema.safeParse(value);

  if (!result.success) {
    throw new ContractValidationError(
      'DeliveryReceipt',
      result.error.issues.map((issue) => ({
        code: mapSchemaIssueCode(issue.code),
        path: toJsonPointer(issue.path),
      })),
    );
  }

  const semanticIssues = validateSemantics(result.data);

  if (semanticIssues.length > 0) {
    throw new ContractValidationError('DeliveryReceipt', semanticIssues);
  }

  return toDeliveryReceipt(result.data);
}

export function getDeliveryReceiptSigningPayload(
  receipt: DeliveryReceipt,
): Readonly<DeliveryReceiptSigningPayload> {
  return Object.freeze({
    schemaVersion: receipt.schemaVersion,
    deliveryId: receipt.deliveryId,
    transactionId: receipt.transactionId,
    paymentProofId: receipt.paymentProofId,
    merchantId: receipt.merchantId,
    serviceId: receipt.serviceId,
    status: receipt.status,
    resultDigest: receipt.resultDigest,
    deliveredAt: receipt.deliveredAt,
    errorCode: receipt.errorCode,
    proof: Object.freeze({ scheme: receipt.proof.scheme, keyId: receipt.proof.keyId }),
  });
}

export function canonicalizeDeliveryReceiptSigningPayload(
  payload: DeliveryReceiptSigningPayload,
): string {
  const canonical = canonicalize(payload);

  if (canonical === undefined) {
    throw new Error('Delivery Receipt signing payload cannot be canonicalized');
  }

  return canonical;
}

export function toDeliveryReceiptWire(receipt: DeliveryReceipt): Readonly<DeliveryReceiptWire> {
  const wire: DeliveryReceiptWire = {
    schemaVersion: receipt.schemaVersion,
    deliveryId: receipt.deliveryId,
    transactionId: receipt.transactionId,
    paymentProofId: receipt.paymentProofId,
    merchantId: receipt.merchantId,
    serviceId: receipt.serviceId,
    status: receipt.status,
    resultDigest: receipt.resultDigest,
    deliveredAt: receipt.deliveredAt,
    errorCode: receipt.errorCode,
    proof: { ...receipt.proof },
  };

  Object.freeze(wire.proof);
  return Object.freeze(wire);
}

export function getDeliveryReceiptJsonSchema() {
  return z.toJSONSchema(DeliveryReceiptWireSchema, { target: 'draft-2020-12' });
}
