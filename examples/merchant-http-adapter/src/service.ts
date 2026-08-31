import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';

import {
  parsePaymentProof,
  parseResourceId,
  toPaymentProofWire,
  type DeliveryReceiptWire,
  type PaymentProofWire,
  type ResourceId,
} from '@aipay/contracts';
import {
  AIPayApiError,
  PAYMENT_NEEDED_HEADER,
  decodePaymentProof,
  type PaymentRequirement,
} from '@aipay/sdk-ts';

import type { MerchantAdapterConfig } from './config.js';
import type {
  AdapterDeliveryOutcome,
  AdapterDeliveryRecord,
  AdapterDeliveryStore,
} from './store.js';

const maximumResultBytes = 256 * 1024;
const queryValuePattern = /^[\p{L}\p{N}\p{P}\p{Zs}]{1,500}$/u;

export interface MerchantPaymentPort {
  createPaymentRequirement(input: {
    readonly serviceId: ResourceId<'svc'>;
    readonly resourceUrl: string;
    readonly method?: string;
  }): Promise<Readonly<{ requirement: PaymentRequirement; headerValue: string }>>;
  consumePaymentProof(paymentProof: PaymentProofWire): Promise<
    Readonly<{
      paymentProofId: ResourceId<'ppf'>;
      deliveryId: ResourceId<'dlv'>;
      consumedAt: string;
    }>
  >;
  recoverPaymentProofConsumption(paymentProof: PaymentProofWire): Promise<
    Readonly<{
      paymentProofId: ResourceId<'ppf'>;
      deliveryId: ResourceId<'dlv'>;
      consumedAt: string;
    }>
  >;
  submitDeliveryReceipt(input: {
    readonly deliveryId: ResourceId<'dlv'>;
    readonly paymentProof: PaymentProofWire;
    readonly status: AdapterDeliveryOutcome;
    readonly result: string | Uint8Array;
    readonly errorCode?: string;
  }): Promise<Readonly<DeliveryReceiptWire>>;
}

export type AdapterFetch = typeof fetch;

export interface MerchantAdapterResponse {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export class MerchantAdapterError extends Error {
  readonly code:
    | 'invalid_request'
    | 'invalid_payment_proof'
    | 'payment_state_conflict'
    | 'upstream_failed'
    | 'aipay_failed';

  constructor(code: MerchantAdapterError['code']) {
    super(`Merchant adapter operation failed: ${code}`);
    this.name = 'MerchantAdapterError';
    this.code = code;
  }
}

export class MerchantAdapterService {
  readonly #config: MerchantAdapterConfig;
  readonly #merchant: MerchantPaymentPort;
  readonly #store: AdapterDeliveryStore;
  readonly #fetch: AdapterFetch;
  readonly #queryKeys: ReadonlySet<string>;

  constructor(
    config: MerchantAdapterConfig,
    merchant: MerchantPaymentPort,
    store: AdapterDeliveryStore,
    fetchImplementation: AdapterFetch = fetch,
  ) {
    this.#config = config;
    this.#merchant = merchant;
    this.#store = store;
    this.#fetch = fetchImplementation;
    this.#queryKeys = new Set(config.allowedQueryKeys);
  }

  async handle(resourceUrl: string, paymentProofHeader?: string): Promise<MerchantAdapterResponse> {
    const canonicalUrl = this.#canonicalResourceUrl(resourceUrl);

    if (paymentProofHeader === undefined) {
      const payment = await this.#merchant.createPaymentRequirement({
        serviceId: this.#config.serviceId,
        resourceUrl: canonicalUrl,
        method: 'GET',
      });
      return Object.freeze({
        statusCode: 402,
        headers: Object.freeze({ [PAYMENT_NEEDED_HEADER]: payment.headerValue }),
        body: Object.freeze({
          code: 'PAYMENT_NEEDED',
          quoteId: payment.requirement.quote.quoteId,
        }),
      });
    }

    let proof: Readonly<PaymentProofWire>;

    try {
      proof = toPaymentProofWire(parsePaymentProof(decodePaymentProof(paymentProofHeader)));
    } catch {
      throw new MerchantAdapterError('invalid_payment_proof');
    }

    if (
      proof.merchantId !== this.#config.merchantId ||
      proof.serviceId !== this.#config.serviceId
    ) {
      throw new MerchantAdapterError('invalid_payment_proof');
    }

    const proofDigest = createHash('sha256').update(JSON.stringify(proof), 'utf8').digest();
    return this.#store.withProofLock(proof.paymentProofId, async () => {
      await this.#store.claim(proof.paymentProofId, canonicalUrl, proofDigest);
      let delivery = await this.#store.get(proof.paymentProofId);
      this.#assertClaim(delivery, canonicalUrl, proofDigest);

      if (delivery.state === 'claimed') {
        const consumed = await this.#consumeOrRecover(proof);
        await this.#store.markConsumed(
          proof.paymentProofId,
          consumed.deliveryId,
          consumed.consumedAt,
        );
        delivery = await this.#store.get(proof.paymentProofId);
      }

      if (delivery.state === 'consumed') {
        const upstream = await this.#callUpstream(canonicalUrl, proof.paymentProofId);
        await this.#store.markResult(proof.paymentProofId, upstream.outcome, upstream.resultText);
        delivery = await this.#store.get(proof.paymentProofId);
      }

      if (delivery.state === 'result_ready') {
        if (
          delivery.deliveryId === null ||
          delivery.outcome === null ||
          delivery.resultText === null
        ) {
          throw new Error('Adapter result-ready state is incomplete');
        }
        await this.#merchant.submitDeliveryReceipt({
          deliveryId: parseResourceId(delivery.deliveryId, 'dlv'),
          paymentProof: proof,
          status: delivery.outcome,
          result: delivery.resultText,
          ...(delivery.outcome === 'failed' ? { errorCode: 'UPSTREAM_DELIVERY_FAILED' } : {}),
        });
        await this.#store.markCompleted(proof.paymentProofId);
        delivery = await this.#store.get(proof.paymentProofId);
      }

      return this.#completedResponse(delivery);
    });
  }

  async #consumeOrRecover(paymentProof: Readonly<PaymentProofWire>) {
    try {
      return await this.#merchant.consumePaymentProof(paymentProof);
    } catch (error) {
      if (error instanceof AIPayApiError && error.status === 409) {
        try {
          return await this.#merchant.recoverPaymentProofConsumption(paymentProof);
        } catch (recoveryError) {
          if (recoveryError instanceof AIPayApiError) {
            throw new MerchantAdapterError('payment_state_conflict');
          }
          throw recoveryError;
        }
      }

      if (error instanceof AIPayApiError) throw new MerchantAdapterError('aipay_failed');
      throw error;
    }
  }

  async #callUpstream(resourceUrl: string, paymentProofId: string) {
    const incoming = new URL(resourceUrl);
    const upstream = new URL(this.#config.upstreamPath, `${this.#config.upstreamOrigin}/`);

    for (const [key, value] of incoming.searchParams) upstream.searchParams.append(key, value);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'idempotency-key': paymentProofId,
    };

    if (this.#config.upstreamApiKeyLocation === 'query') {
      upstream.searchParams.set(this.#config.upstreamApiKeyName, this.#config.upstreamApiKeyValue);
    } else {
      headers[this.#config.upstreamApiKeyName] = this.#config.upstreamApiKeyValue;
    }

    try {
      const response = await this.#fetch(upstream, {
        method: 'GET',
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      const declaredLength = Number(response.headers.get('content-length'));

      if (
        !response.ok ||
        !response.headers.get('content-type')?.includes('application/json') ||
        (Number.isFinite(declaredLength) && declaredLength > maximumResultBytes)
      ) {
        throw new MerchantAdapterError('upstream_failed');
      }

      const bytes = Buffer.from(await response.arrayBuffer());

      if (bytes.byteLength > maximumResultBytes) throw new MerchantAdapterError('upstream_failed');
      const result = JSON.parse(bytes.toString('utf8')) as unknown;
      return Object.freeze({
        outcome: 'succeeded' as const,
        resultText: JSON.stringify(result),
      });
    } catch {
      return Object.freeze({
        outcome: 'failed' as const,
        resultText: JSON.stringify({ code: 'UPSTREAM_DELIVERY_FAILED' }),
      });
    }
  }

  #canonicalResourceUrl(value: string): string {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw new MerchantAdapterError('invalid_request');
    }

    if (
      url.origin !== this.#config.publicOrigin ||
      url.pathname !== this.#config.resourcePath ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0
    ) {
      throw new MerchantAdapterError('invalid_request');
    }

    const seen = new Set<string>();

    for (const [key, queryValue] of url.searchParams) {
      if (seen.has(key) || !this.#queryKeys.has(key) || !queryValuePattern.test(queryValue)) {
        throw new MerchantAdapterError('invalid_request');
      }
      seen.add(key);
    }

    return url.toString();
  }

  #assertClaim(record: AdapterDeliveryRecord, resourceUrl: string, proofDigest: Buffer): void {
    if (
      record.resourceUrl !== resourceUrl ||
      record.proofDigest.byteLength !== proofDigest.byteLength ||
      !timingSafeEqual(record.proofDigest, proofDigest)
    ) {
      throw new MerchantAdapterError('invalid_payment_proof');
    }
  }

  #completedResponse(record: AdapterDeliveryRecord): MerchantAdapterResponse {
    if (record.state !== 'completed' || record.outcome === null || record.resultText === null) {
      throw new Error('Adapter delivery did not reach a completed state');
    }
    let body: unknown;

    try {
      body = JSON.parse(record.resultText) as unknown;
    } catch {
      throw new Error('Adapter stored result is invalid');
    }

    return Object.freeze({
      statusCode: record.outcome === 'succeeded' ? 200 : 502,
      headers: Object.freeze({ 'cache-control': 'private, no-store' }),
      body,
    });
  }
}
