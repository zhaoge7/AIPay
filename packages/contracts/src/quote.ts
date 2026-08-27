import * as z from 'zod';
import canonicalize from 'canonicalize';

import {
  ContractValidationError,
  mapSchemaIssueCode,
  toJsonPointer,
  type ContractValidationIssue,
} from './contract-validation.js';
import { getResourceIdPattern, parseResourceId, type ResourceId } from './values/identifier.js';
import { createMoney, MAX_MINOR_AMOUNT, type Money } from './values/money.js';
import { isExpired, parseUtcDateTime, type UtcDateTime } from './values/time.js';

export const QUOTE_SIGNATURE_DOMAIN = 'AIPAY-QUOTE-V1\0';

const maxMinorAmountDigits = MAX_MINOR_AMOUNT.toString().length;
const minorAmountPattern = /^(0|[1-9][0-9]*)$/;
const utcDateTimePattern =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const unitPattern = /^[a-z][a-z0-9._-]{0,63}$/;
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

export const QuoteWireSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  quoteId: resourceIdSchema('qte'),
  merchantId: resourceIdSchema('mch'),
  serviceId: resourceIdSchema('svc'),
  unit: z.string().regex(unitPattern),
  quantity: z.number().int().min(1).max(1_000_000),
  unitPrice: MoneySchema,
  subtotal: MoneySchema,
  taxBehavior: z.enum(['inclusive', 'exclusive']),
  taxAmount: MoneySchema,
  total: MoneySchema,
  issuedAt: z.string().regex(utcDateTimePattern),
  expiresAt: z.string().regex(utcDateTimePattern),
  proof: ProofSchema,
});

export type QuoteWire = z.infer<typeof QuoteWireSchema>;

declare const quoteProofValueBrand: unique symbol;

export interface QuoteProof {
  readonly scheme: 'aipay-jcs-ed25519-v1';
  readonly keyId: ResourceId<'key'>;
  readonly value: string & { readonly [quoteProofValueBrand]: true };
}

export interface Quote {
  readonly schemaVersion: '1';
  readonly quoteId: ResourceId<'qte'>;
  readonly merchantId: ResourceId<'mch'>;
  readonly serviceId: ResourceId<'svc'>;
  readonly unit: string;
  readonly quantity: number;
  readonly unitPrice: Readonly<Money>;
  readonly subtotal: Readonly<Money>;
  readonly taxBehavior: 'inclusive' | 'exclusive';
  readonly taxAmount: Readonly<Money>;
  readonly total: Readonly<Money>;
  readonly issuedAt: UtcDateTime;
  readonly expiresAt: UtcDateTime;
  readonly proof: Readonly<QuoteProof>;
}

export interface QuoteSigningPayload {
  readonly schemaVersion: Quote['schemaVersion'];
  readonly quoteId: Quote['quoteId'];
  readonly merchantId: Quote['merchantId'];
  readonly serviceId: Quote['serviceId'];
  readonly unit: Quote['unit'];
  readonly quantity: Quote['quantity'];
  readonly unitPrice: Quote['unitPrice'];
  readonly subtotal: Quote['subtotal'];
  readonly taxBehavior: Quote['taxBehavior'];
  readonly taxAmount: Quote['taxAmount'];
  readonly total: Quote['total'];
  readonly issuedAt: Quote['issuedAt'];
  readonly expiresAt: Quote['expiresAt'];
  readonly proof: Readonly<Omit<Quote['proof'], 'value'>>;
}

function validateMoney(
  value: QuoteWire['total'],
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

function validateSemantics(quote: QuoteWire): readonly ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];
  let issuedAt: UtcDateTime | undefined;
  let expiresAt: UtcDateTime | undefined;

  try {
    issuedAt = parseUtcDateTime(quote.issuedAt);
  } catch {
    issues.push({ code: 'invalid_format', path: '/issuedAt' });
  }

  try {
    expiresAt = parseUtcDateTime(quote.expiresAt);
  } catch {
    issues.push({ code: 'invalid_format', path: '/expiresAt' });
  }

  if (issuedAt !== undefined && expiresAt !== undefined && isExpired(expiresAt, issuedAt)) {
    issues.push({ code: 'invalid_validity_window', path: '/expiresAt' });
  }

  const unitPrice = validateMoney(quote.unitPrice, '/unitPrice', issues);
  const subtotal = validateMoney(quote.subtotal, '/subtotal', issues);
  const taxAmount = validateMoney(quote.taxAmount, '/taxAmount', issues);
  const total = validateMoney(quote.total, '/total', issues);

  if (unitPrice !== undefined && BigInt(unitPrice.amountMinor) === 0n) {
    issues.push({ code: 'non_positive_unit_price', path: '/unitPrice' });
  }

  if (total !== undefined && BigInt(total.amountMinor) === 0n) {
    issues.push({ code: 'non_positive_total', path: '/total' });
  }

  if (unitPrice !== undefined && subtotal !== undefined) {
    const expectedSubtotal = BigInt(unitPrice.amountMinor) * BigInt(quote.quantity);

    if (expectedSubtotal > MAX_MINOR_AMOUNT) {
      issues.push({ code: 'amount_overflow', path: '/subtotal' });
    } else if (BigInt(subtotal.amountMinor) !== expectedSubtotal) {
      issues.push({ code: 'subtotal_mismatch', path: '/subtotal' });
    }
  }

  if (subtotal !== undefined && taxAmount !== undefined && total !== undefined) {
    const subtotalMinor = BigInt(subtotal.amountMinor);
    const taxMinor = BigInt(taxAmount.amountMinor);
    const totalMinor = BigInt(total.amountMinor);

    if (quote.taxBehavior === 'inclusive') {
      if (taxMinor > subtotalMinor) {
        issues.push({ code: 'tax_exceeds_subtotal', path: '/taxAmount' });
      }

      if (totalMinor !== subtotalMinor) {
        issues.push({ code: 'total_mismatch', path: '/total' });
      }
    } else {
      const expectedTotal = subtotalMinor + taxMinor;

      if (expectedTotal > MAX_MINOR_AMOUNT) {
        issues.push({ code: 'amount_overflow', path: '/total' });
      } else if (totalMinor !== expectedTotal) {
        issues.push({ code: 'total_mismatch', path: '/total' });
      }
    }
  }

  return issues;
}

function toQuote(wire: QuoteWire): Quote {
  return Object.freeze({
    schemaVersion: wire.schemaVersion,
    quoteId: parseResourceId(wire.quoteId, 'qte'),
    merchantId: parseResourceId(wire.merchantId, 'mch'),
    serviceId: parseResourceId(wire.serviceId, 'svc'),
    unit: wire.unit,
    quantity: wire.quantity,
    unitPrice: createMoney(wire.unitPrice.currency, wire.unitPrice.amountMinor),
    subtotal: createMoney(wire.subtotal.currency, wire.subtotal.amountMinor),
    taxBehavior: wire.taxBehavior,
    taxAmount: createMoney(wire.taxAmount.currency, wire.taxAmount.amountMinor),
    total: createMoney(wire.total.currency, wire.total.amountMinor),
    issuedAt: parseUtcDateTime(wire.issuedAt),
    expiresAt: parseUtcDateTime(wire.expiresAt),
    proof: Object.freeze({
      scheme: wire.proof.scheme,
      keyId: parseResourceId(wire.proof.keyId, 'key'),
      value: wire.proof.value as QuoteProof['value'],
    }),
  });
}

export function parseQuote(value: unknown): Quote {
  const result = QuoteWireSchema.safeParse(value);

  if (!result.success) {
    throw new ContractValidationError(
      'Quote',
      result.error.issues.map((issue) => ({
        code: mapSchemaIssueCode(issue.code),
        path: toJsonPointer(issue.path),
      })),
    );
  }

  const semanticIssues = validateSemantics(result.data);

  if (semanticIssues.length > 0) {
    throw new ContractValidationError('Quote', semanticIssues);
  }

  return toQuote(result.data);
}

export function getQuoteSigningPayload(quote: Quote): Readonly<QuoteSigningPayload> {
  return Object.freeze({
    schemaVersion: quote.schemaVersion,
    quoteId: quote.quoteId,
    merchantId: quote.merchantId,
    serviceId: quote.serviceId,
    unit: quote.unit,
    quantity: quote.quantity,
    unitPrice: Object.freeze({ ...quote.unitPrice }),
    subtotal: Object.freeze({ ...quote.subtotal }),
    taxBehavior: quote.taxBehavior,
    taxAmount: Object.freeze({ ...quote.taxAmount }),
    total: Object.freeze({ ...quote.total }),
    issuedAt: quote.issuedAt,
    expiresAt: quote.expiresAt,
    proof: Object.freeze({
      scheme: quote.proof.scheme,
      keyId: quote.proof.keyId,
    }),
  });
}

export function canonicalizeQuoteSigningPayload(payload: QuoteSigningPayload): string {
  const canonical = canonicalize(payload);

  if (canonical === undefined) {
    throw new Error('Quote signing payload cannot be canonicalized');
  }

  return canonical;
}

export function toQuoteWire(quote: Quote): Readonly<QuoteWire> {
  const wire: QuoteWire = {
    schemaVersion: quote.schemaVersion,
    quoteId: quote.quoteId,
    merchantId: quote.merchantId,
    serviceId: quote.serviceId,
    unit: quote.unit,
    quantity: quote.quantity,
    unitPrice: { ...quote.unitPrice },
    subtotal: { ...quote.subtotal },
    taxBehavior: quote.taxBehavior,
    taxAmount: { ...quote.taxAmount },
    total: { ...quote.total },
    issuedAt: quote.issuedAt,
    expiresAt: quote.expiresAt,
    proof: { ...quote.proof },
  };

  Object.freeze(wire.unitPrice);
  Object.freeze(wire.subtotal);
  Object.freeze(wire.taxAmount);
  Object.freeze(wire.total);
  Object.freeze(wire.proof);
  return Object.freeze(wire);
}

export function getQuoteJsonSchema() {
  return z.toJSONSchema(QuoteWireSchema, { target: 'draft-2020-12' });
}
