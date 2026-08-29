import { Buffer } from 'node:buffer';

import {
  parsePaymentProof,
  parseQuote,
  toPaymentProofWire,
  toQuoteWire,
  type PaymentProofWire,
  type QuoteWire,
} from '@aipay/contracts';

export const PAYMENT_NEEDED_HEADER = 'payment-needed';
export const PAYMENT_PROOF_HEADER = 'payment-proof';

export interface PaymentRequirement {
  readonly schemaVersion: '1';
  readonly scheme: 'aipay';
  readonly quote: Readonly<QuoteWire>;
  readonly resource: Readonly<{ method: string; url: string }>;
}

function object(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function decodeBase64UrlJson(value: string): unknown {
  if (value.length < 16 || value.length > 65_536 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new Error('AIPay payment header is invalid');
  }

  const bytes = Buffer.from(value, 'base64url');

  if (bytes.toString('base64url') !== value) {
    throw new Error('AIPay payment header encoding is not canonical');
  }

  return JSON.parse(bytes.toString('utf8')) as unknown;
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function createPaymentRequirement(input: {
  readonly quote: QuoteWire;
  readonly resourceUrl: string;
  readonly method?: string;
}): Readonly<PaymentRequirement> {
  const url = new URL(input.resourceUrl);

  if (url.username.length > 0 || url.password.length > 0 || url.hash.length > 0) {
    throw new Error('Paid resource URL is invalid');
  }

  const method = (input.method ?? 'GET').toUpperCase();

  if (!/^[A-Z]+$/u.test(method)) {
    throw new Error('Paid resource method is invalid');
  }

  return Object.freeze({
    schemaVersion: '1',
    scheme: 'aipay',
    quote: toQuoteWire(parseQuote(input.quote)),
    resource: Object.freeze({ method, url: url.toString() }),
  });
}

export function encodePaymentRequirement(requirement: PaymentRequirement): string {
  return encodeBase64UrlJson(requirement);
}

export function decodePaymentRequirement(value: string): Readonly<PaymentRequirement> {
  const root = object(decodeBase64UrlJson(value));
  const resource = object(root?.resource);

  if (
    root?.schemaVersion !== '1' ||
    root.scheme !== 'aipay' ||
    resource === null ||
    typeof resource.method !== 'string' ||
    typeof resource.url !== 'string'
  ) {
    throw new Error('AIPay payment requirement is invalid');
  }

  return createPaymentRequirement({
    quote: toQuoteWire(parseQuote(root.quote)),
    resourceUrl: resource.url,
    method: resource.method,
  });
}

export function encodePaymentProof(paymentProof: PaymentProofWire): string {
  return encodeBase64UrlJson(toPaymentProofWire(parsePaymentProof(paymentProof)));
}

export function decodePaymentProof(value: string): Readonly<PaymentProofWire> {
  return toPaymentProofWire(parsePaymentProof(decodeBase64UrlJson(value)));
}
