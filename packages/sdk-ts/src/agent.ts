import { Buffer } from 'node:buffer';
import { createHash, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';

import {
  parseQuote,
  parseResourceId,
  type PaymentProofWire,
  type ResourceId,
  type TransactionWire,
} from '@aipay/contracts';
import { buildSignatureBase, signatureBaseToBytes } from '@peac/http-signatures';

import { AIPayApiError, normalizeBaseUrl, responseData, type FetchLike } from './http.js';
import {
  decodePaymentRequirement,
  encodePaymentProof,
  PAYMENT_NEEDED_HEADER,
  PAYMENT_PROOF_HEADER,
  type PaymentRequirement,
} from './protocol.js';

const coveredComponents = [
  '@method',
  '@target-uri',
  'content-digest',
  'content-type',
  'x-aipay-agent-id',
] as const;

export interface CatalogService {
  readonly serviceId: ResourceId<'svc'>;
  readonly merchantId: ResourceId<'mch'>;
  readonly type: 'api' | 'mcp' | 'skill';
  readonly name: string;
  readonly merchantName: string;
  readonly category: string;
  readonly unit: string;
  readonly unitPrice: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly refundPolicy: 'full_on_delivery_failure' | 'non_refundable';
  readonly status: 'enabled';
}

export interface CatalogPage {
  readonly items: readonly Readonly<CatalogService>[];
  readonly nextCursor: ResourceId<'svc'> | null;
}

export interface PaymentAttempt {
  readonly paymentAttemptId: ResourceId<'pat'>;
  readonly transactionId: ResourceId<'txn'>;
  readonly reservationId: ResourceId<'rsv'> | null;
  readonly provider: string;
  readonly providerReference: string | null;
  readonly actionRequired: boolean;
  readonly status: 'pending' | 'succeeded' | 'failed' | 'unknown';
  readonly errorCode: string | null;
  readonly action: Readonly<{ type: 'redirect'; method: 'GET'; url: string }> | null;
}

export interface AgentClientOptions {
  readonly baseUrl: string;
  readonly agentId: ResourceId<'agt'>;
  readonly keyId: ResourceId<'key'>;
  readonly privateKeyPkcs8Base64: string;
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export interface PaidCallOptions {
  readonly mandateId: ResourceId<'mdt'>;
  readonly onPaymentAction?: (action: NonNullable<PaymentAttempt['action']>) => Promise<void>;
  readonly pollAttempts?: number;
  readonly pollIntervalMs?: number;
}

export class PaymentActionRequiredError extends Error {
  readonly attempt: Readonly<PaymentAttempt>;

  constructor(attempt: Readonly<PaymentAttempt>) {
    super('The payment provider requires an external action');
    this.name = 'PaymentActionRequiredError';
    this.attempt = attempt;
  }
}

export class PaymentNotCompletedError extends Error {
  readonly attempt: Readonly<PaymentAttempt>;

  constructor(attempt: Readonly<PaymentAttempt>) {
    super('The payment did not complete successfully');
    this.name = 'PaymentNotCompletedError';
    this.attempt = attempt;
  }
}

export class AgentClient {
  readonly #baseUrl: URL;
  readonly #agentId: ResourceId<'agt'>;
  readonly #keyId: ResourceId<'key'>;
  readonly #privateKey: KeyObject;
  readonly #fetch: FetchLike;
  readonly #now: () => Date;
  readonly #randomBytes: (size: number) => Uint8Array;

  constructor(options: AgentClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#agentId = options.agentId;
    this.#keyId = options.keyId;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#randomBytes = options.randomBytes ?? ((size) => randomBytes(size));

    try {
      this.#privateKey = createPrivateKey({
        key: Buffer.from(options.privateKeyPkcs8Base64, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
    } catch {
      throw new Error('Agent private key must be base64 PKCS8 Ed25519');
    }

    if (this.#privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('Agent private key must be Ed25519');
    }
  }

  async discoverServices(
    query: {
      readonly type?: CatalogService['type'];
      readonly category?: string;
      readonly merchantId?: ResourceId<'mch'>;
      readonly cursor?: ResourceId<'svc'>;
      readonly limit?: number;
    } = {},
  ): Promise<Readonly<CatalogPage>> {
    const search = new URLSearchParams();

    if (query.type !== undefined) {
      search.set('type', query.type);
    }

    if (query.category !== undefined) {
      search.set('category', query.category);
    }

    if (query.merchantId !== undefined) {
      search.set('merchantId', query.merchantId);
    }

    if (query.cursor !== undefined) {
      search.set('cursor', query.cursor);
    }

    if (query.limit !== undefined) {
      search.set('limit', String(query.limit));
    }

    const suffix = search.size === 0 ? '' : `?${search.toString()}`;
    return this.#request<CatalogPage>('GET', `v1/catalog/services${suffix}`);
  }

  createTransaction(input: {
    readonly quoteId: ResourceId<'qte'>;
    readonly mandateId: ResourceId<'mdt'>;
    readonly idempotencyKey: string;
  }): Promise<Readonly<TransactionWire>> {
    return this.#request('POST', 'v1/transactions', input);
  }

  payTransaction(transactionId: ResourceId<'txn'>): Promise<Readonly<PaymentAttempt>> {
    return this.#request('POST', `v1/agent/transactions/${transactionId}/payment`, {});
  }

  queryPayment(paymentAttemptId: ResourceId<'pat'>): Promise<Readonly<PaymentAttempt>> {
    return this.#request('POST', `v1/agent/payment-attempts/${paymentAttemptId}/query`, {});
  }

  issuePaymentProof(transactionId: ResourceId<'txn'>): Promise<Readonly<PaymentProofWire>> {
    return this.#request('POST', `v1/agent/transactions/${transactionId}/payment-proof`, {});
  }

  async acquirePaymentProof(
    requirement: PaymentRequirement,
    options: PaidCallOptions,
  ): Promise<Readonly<PaymentProofWire>> {
    const quote = parseQuote(requirement.quote);
    const idempotencyKey = `sdk.${createHash('sha256')
      .update(`${quote.quoteId}\0${options.mandateId}`, 'utf8')
      .digest('base64url')}`;
    const transaction = await this.createTransaction({
      quoteId: quote.quoteId,
      mandateId: options.mandateId,
      idempotencyKey,
    });
    const transactionId = parseResourceId(transaction.transactionId, 'txn');

    if (transaction.status === 'requires_confirmation') {
      throw new AIPayApiError({
        status: 409,
        code: 'TRANSACTION_STATE_CONFLICT',
        kind: 'rejected',
      });
    }

    let attempt = await this.payTransaction(transactionId);

    if (attempt.action !== null) {
      if (options.onPaymentAction === undefined) {
        throw new PaymentActionRequiredError(attempt);
      }

      await options.onPaymentAction(attempt.action);
    }

    const pollAttempts = options.pollAttempts ?? 10;
    const interval = options.pollIntervalMs ?? 1_000;

    for (
      let poll = 0;
      attempt.status !== 'succeeded' && attempt.status !== 'failed' && poll < pollAttempts;
      poll += 1
    ) {
      if (interval > 0) {
        await new Promise((resolve) => setTimeout(resolve, interval));
      }

      attempt = await this.queryPayment(attempt.paymentAttemptId);
    }

    if (attempt.status !== 'succeeded') {
      throw new PaymentNotCompletedError(attempt);
    }

    return this.issuePaymentProof(transactionId);
  }

  async callPaid(
    resourceUrl: string,
    init: RequestInit,
    options: PaidCallOptions,
  ): Promise<Response> {
    const initialRequest = new Request(resourceUrl, init);
    const initialResponse = await this.#fetch(initialRequest.clone());

    if (initialResponse.status !== 402) {
      return initialResponse;
    }

    const header = initialResponse.headers.get(PAYMENT_NEEDED_HEADER);

    if (header === null) {
      throw new AIPayApiError({ status: 402, code: 'UNEXPECTED_RESPONSE' });
    }

    const requirement = decodePaymentRequirement(header);

    if (
      requirement.resource.method !== initialRequest.method ||
      requirement.resource.url !== initialRequest.url
    ) {
      throw new Error('Payment requirement does not bind the requested resource');
    }

    const paymentProof = await this.acquirePaymentProof(requirement, options);
    const headers = new Headers(initialRequest.headers);
    headers.set(PAYMENT_PROOF_HEADER, encodePaymentProof(paymentProof));
    return this.#fetch(new Request(initialRequest, { headers }));
  }

  async #request<Data>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Data> {
    const url = new URL(path, this.#baseUrl).toString();
    const bodyText = method === 'GET' ? '' : JSON.stringify(body ?? {});
    const created = Math.floor(this.#now().getTime() / 1_000);
    const expires = created + 300;
    const nonceBytes = this.#randomBytes(16);

    if (nonceBytes.byteLength !== 16) {
      throw new Error('Agent nonce source must return 16 bytes');
    }

    const nonce = Buffer.from(nonceBytes).toString('base64url');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-digest': `sha-256=:${createHash('sha256').update(bodyText, 'utf8').digest('base64')}:`,
      'x-aipay-agent-id': this.#agentId,
    };
    const parameters = {
      keyid: this.#keyId,
      alg: 'ed25519',
      created,
      expires,
      nonce,
      tag: 'aipay-agent-v1',
      coveredComponents: [...coveredComponents],
    };
    const signatureBase = buildSignatureBase({ method, url, headers, body: bodyText }, parameters);
    const signature = sign(null, signatureBaseToBytes(signatureBase), this.#privateKey).toString(
      'base64',
    );
    const components = coveredComponents.map((component) => `"${component}"`).join(' ');
    headers['signature-input'] =
      `aipay=(${components});created=${String(created)};expires=${String(expires)};nonce="${nonce}";` +
      `keyid="${this.#keyId}";alg="ed25519";tag="aipay-agent-v1"`;
    headers.signature = `aipay=:${signature}:`;
    const response = await this.#fetch(url, {
      method,
      headers,
      ...(method === 'GET' ? {} : { body: bodyText }),
    });
    return responseData<Data>(response);
  }
}
