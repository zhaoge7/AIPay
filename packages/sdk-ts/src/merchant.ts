import { Buffer } from 'node:buffer';
import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';

import {
  DELIVERY_RECEIPT_SIGNATURE_DOMAIN,
  QUOTE_SIGNATURE_DOMAIN,
  canonicalizeDeliveryReceiptSigningPayload,
  canonicalizeQuoteSigningPayload,
  getDeliveryReceiptSigningPayload,
  getQuoteSigningPayload,
  parseDeliveryReceipt,
  parsePaymentProof,
  parseQuote,
  toDeliveryReceiptWire,
  toPaymentProofWire,
  toQuoteWire,
  type DeliveryReceiptWire,
  type PaymentProofWire,
  type QuoteWire,
  type ResourceId,
} from '@aipay/contracts';

import { normalizeBaseUrl, responseData, type FetchLike } from './http.js';
import {
  createPaymentRequirement,
  encodePaymentRequirement,
  type PaymentRequirement,
} from './protocol.js';

const placeholderSignature = 'A'.repeat(86);

interface QuoteDraft {
  readonly quoteId: ResourceId<'qte'>;
  readonly merchantId: ResourceId<'mch'>;
  readonly serviceId: ResourceId<'svc'>;
  readonly unit: string;
  readonly quantity: number;
  readonly unitPrice: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly subtotal: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly taxBehavior: 'inclusive' | 'exclusive';
  readonly taxAmount: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly total: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface MerchantClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly merchantId: ResourceId<'mch'>;
  readonly keyId: ResourceId<'key'>;
  readonly privateKeyPkcs8Base64: string;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
}

export class MerchantClient {
  readonly #baseUrl: URL;
  readonly #apiKey: string;
  readonly #merchantId: ResourceId<'mch'>;
  readonly #keyId: ResourceId<'key'>;
  readonly #privateKey: KeyObject;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;

  constructor(options: MerchantClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#apiKey = options.apiKey;
    this.#merchantId = options.merchantId;
    this.#keyId = options.keyId;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());

    try {
      this.#privateKey = createPrivateKey({
        key: Buffer.from(options.privateKeyPkcs8Base64, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
    } catch {
      throw new Error('Merchant private key must be base64 PKCS8 Ed25519');
    }

    if (this.#privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('Merchant private key must be Ed25519');
    }
  }

  async createQuote(input: {
    readonly serviceId: ResourceId<'svc'>;
    readonly quantity?: number;
    readonly taxBehavior?: 'inclusive' | 'exclusive';
    readonly taxAmountMinor?: string;
    readonly expiresInSeconds?: number;
  }): Promise<Readonly<QuoteWire>> {
    const draft = await this.#request<QuoteDraft>(`v1/merchants/${this.#merchantId}/quotes`, {
      serviceId: input.serviceId,
      quantity: input.quantity ?? 1,
      taxBehavior: input.taxBehavior ?? 'inclusive',
      taxAmount: { currency: 'CNY', amountMinor: input.taxAmountMinor ?? '0' },
      expiresInSeconds: input.expiresInSeconds ?? 300,
    });
    const placeholder = parseQuote({
      schemaVersion: '1',
      quoteId: draft.quoteId,
      merchantId: draft.merchantId,
      serviceId: draft.serviceId,
      unit: draft.unit,
      quantity: draft.quantity,
      unitPrice: draft.unitPrice,
      subtotal: draft.subtotal,
      taxBehavior: draft.taxBehavior,
      taxAmount: draft.taxAmount,
      total: draft.total,
      issuedAt: draft.issuedAt,
      expiresAt: draft.expiresAt,
      proof: {
        scheme: 'aipay-jcs-ed25519-v1',
        keyId: this.#keyId,
        value: placeholderSignature,
      },
    });
    const signature = sign(
      null,
      Buffer.concat([
        Buffer.from(QUOTE_SIGNATURE_DOMAIN, 'utf8'),
        Buffer.from(canonicalizeQuoteSigningPayload(getQuoteSigningPayload(placeholder)), 'utf8'),
      ]),
      this.#privateKey,
    ).toString('base64url');
    const quote = await this.#request<QuoteWire>(`v1/quotes/${draft.quoteId}/activate`, {
      keyId: this.#keyId,
      signature,
    });
    return toQuoteWire(parseQuote(quote));
  }

  async createPaymentRequirement(input: {
    readonly serviceId: ResourceId<'svc'>;
    readonly resourceUrl: string;
    readonly method?: string;
  }): Promise<Readonly<{ requirement: PaymentRequirement; headerValue: string }>> {
    const quote = await this.createQuote({ serviceId: input.serviceId });
    const requirement = createPaymentRequirement({
      quote,
      resourceUrl: input.resourceUrl,
      ...(input.method === undefined ? {} : { method: input.method }),
    });
    return Object.freeze({ requirement, headerValue: encodePaymentRequirement(requirement) });
  }

  verifyPaymentProof(paymentProof: PaymentProofWire): Promise<Readonly<{ valid: true }>> {
    return this.#request(
      'v1/payment-proofs/verify',
      toPaymentProofWire(parsePaymentProof(paymentProof)),
    );
  }

  consumePaymentProof(paymentProof: PaymentProofWire): Promise<
    Readonly<{
      paymentProofId: ResourceId<'ppf'>;
      deliveryId: ResourceId<'dlv'>;
      consumedAt: string;
    }>
  > {
    return this.#request(`v1/merchants/${this.#merchantId}/payment-proofs/consume`, {
      paymentProof: toPaymentProofWire(parsePaymentProof(paymentProof)),
    });
  }

  recoverPaymentProofConsumption(paymentProof: PaymentProofWire): Promise<
    Readonly<{
      paymentProofId: ResourceId<'ppf'>;
      deliveryId: ResourceId<'dlv'>;
      consumedAt: string;
    }>
  > {
    return this.#request(`v1/merchants/${this.#merchantId}/payment-proofs/recover`, {
      paymentProof: toPaymentProofWire(parsePaymentProof(paymentProof)),
    });
  }

  async submitDeliveryReceipt(input: {
    readonly deliveryId: ResourceId<'dlv'>;
    readonly paymentProof: PaymentProofWire;
    readonly status: 'succeeded' | 'failed';
    readonly result: string | Uint8Array;
    readonly errorCode?: string;
  }): Promise<Readonly<DeliveryReceiptWire>> {
    const paymentProof = parsePaymentProof(input.paymentProof);
    const result =
      typeof input.result === 'string' ? Buffer.from(input.result) : Buffer.from(input.result);
    const placeholder = parseDeliveryReceipt({
      schemaVersion: '1',
      deliveryId: input.deliveryId,
      transactionId: paymentProof.transactionId,
      paymentProofId: paymentProof.paymentProofId,
      merchantId: paymentProof.merchantId,
      serviceId: paymentProof.serviceId,
      status: input.status,
      resultDigest: `sha256:${createHash('sha256').update(result).digest('hex')}`,
      deliveredAt: this.#now().toISOString(),
      errorCode: input.status === 'succeeded' ? null : (input.errorCode ?? 'DELIVERY_FAILED'),
      proof: {
        scheme: 'aipay-jcs-ed25519-v1',
        keyId: this.#keyId,
        value: placeholderSignature,
      },
    });
    const signature = sign(
      null,
      Buffer.concat([
        Buffer.from(DELIVERY_RECEIPT_SIGNATURE_DOMAIN, 'utf8'),
        Buffer.from(
          canonicalizeDeliveryReceiptSigningPayload(getDeliveryReceiptSigningPayload(placeholder)),
          'utf8',
        ),
      ]),
      this.#privateKey,
    ).toString('base64url');
    const receipt = toDeliveryReceiptWire(
      parseDeliveryReceipt({
        ...toDeliveryReceiptWire(placeholder),
        proof: { ...placeholder.proof, value: signature },
      }),
    );
    return this.#request(
      `v1/merchants/${this.#merchantId}/deliveries/${input.deliveryId}/receipt`,
      receipt,
    );
  }

  async #request<Data>(path: string, body: unknown): Promise<Data> {
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return responseData<Data>(response);
  }
}
