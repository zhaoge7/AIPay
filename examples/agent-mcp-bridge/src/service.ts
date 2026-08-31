import { Buffer } from 'node:buffer';

import {
  AIPayApiError,
  decodePaymentRequirement,
  encodePaymentProof,
  PAYMENT_NEEDED_HEADER,
  PAYMENT_PROOF_HEADER,
  PaymentActionRequiredError,
  PaymentNotCompletedError,
  type PaymentAttempt,
  type PaymentProofWire,
  type ResourceId,
} from '@aipay/sdk-ts';

import type { AgentBridgeConfig } from './config.js';
import { BridgeTokenError, BridgeTokenSigner } from './tokens.js';

const maximumResultBytes = 256 * 1024;
const queryValuePattern = /^[\p{L}\p{N}\p{P}\p{Zs}]{1,500}$/u;

export interface AgentPaymentPort {
  acquirePaymentProof(
    requirement: ReturnType<typeof decodePaymentRequirement>,
    options: Readonly<{ mandateId: ResourceId<'mdt'>; pollAttempts: number }>,
  ): Promise<Readonly<PaymentProofWire>>;
  queryPayment(paymentAttemptId: ResourceId<'pat'>): Promise<Readonly<PaymentAttempt>>;
  issuePaymentProof(transactionId: ResourceId<'txn'>): Promise<Readonly<PaymentProofWire>>;
}

export type BridgeFetch = typeof fetch;

export class AgentBridgeError extends Error {
  readonly code:
    | 'invalid_input'
    | 'invalid_token'
    | 'resource_failed'
    | 'payment_protocol_invalid'
    | 'payment_failed'
    | 'aipay_rejected';

  constructor(code: AgentBridgeError['code']) {
    super(`Agent bridge operation failed: ${code}`);
    this.name = 'AgentBridgeError';
    this.code = code;
  }
}

export class AgentBridgeService {
  readonly #config: AgentBridgeConfig;
  readonly #agent: AgentPaymentPort;
  readonly #fetch: BridgeFetch;
  readonly #tokens: BridgeTokenSigner;
  readonly #paths: ReadonlySet<string>;
  readonly #queryKeys: ReadonlySet<string>;

  constructor(
    config: AgentBridgeConfig,
    agent: AgentPaymentPort,
    fetchImplementation: BridgeFetch = fetch,
    tokens = new BridgeTokenSigner(config.bearerToken),
  ) {
    this.#config = config;
    this.#agent = agent;
    this.#fetch = fetchImplementation;
    this.#tokens = tokens;
    this.#paths = new Set(config.allowedPaths);
    this.#queryKeys = new Set(config.allowedQueryKeys);
  }

  async start(path: string, query: Readonly<Record<string, string>>) {
    const resourceUrl = this.#resourceUrl(path, query);
    let response: Response;

    try {
      response = await this.#fetch(resourceUrl, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AgentBridgeError('resource_failed');
    }

    if (response.status !== 402) throw new AgentBridgeError('payment_protocol_invalid');
    const paymentNeeded = response.headers.get(PAYMENT_NEEDED_HEADER);

    if (paymentNeeded === null) throw new AgentBridgeError('payment_protocol_invalid');
    let requirement;

    try {
      requirement = decodePaymentRequirement(paymentNeeded);
    } catch {
      throw new AgentBridgeError('payment_protocol_invalid');
    }

    if (requirement.resource.method !== 'GET' || requirement.resource.url !== resourceUrl) {
      throw new AgentBridgeError('payment_protocol_invalid');
    }

    try {
      const proof = await this.#agent.acquirePaymentProof(requirement, {
        mandateId: this.#config.mandateId,
        pollAttempts: 0,
      });
      return this.#deliveryReady(proof, resourceUrl);
    } catch (error) {
      if (error instanceof PaymentActionRequiredError) {
        return this.#paymentAction(error.attempt, resourceUrl);
      }

      if (error instanceof PaymentNotCompletedError) {
        return this.#paymentIncomplete(error.attempt, resourceUrl);
      }

      if (error instanceof AIPayApiError) throw new AgentBridgeError('aipay_rejected');
      throw error;
    }
  }

  async resume(resumeToken: string) {
    let token;

    try {
      token = this.#tokens.verifyResume(resumeToken);
      this.#assertAllowedUrl(token.resourceUrl);
    } catch (error) {
      if (error instanceof BridgeTokenError || error instanceof AgentBridgeError) {
        throw new AgentBridgeError('invalid_token');
      }
      throw error;
    }

    let attempt: Readonly<PaymentAttempt>;

    try {
      attempt = await this.#agent.queryPayment(token.paymentAttemptId);
    } catch (error) {
      if (error instanceof AIPayApiError) throw new AgentBridgeError('aipay_rejected');
      throw error;
    }

    if (attempt.transactionId !== token.transactionId) {
      throw new AgentBridgeError('invalid_token');
    }

    if (attempt.status === 'failed') {
      return Object.freeze({
        status: 'payment_failed' as const,
        paymentAttemptId: attempt.paymentAttemptId,
        transactionId: attempt.transactionId,
        errorCode: attempt.errorCode,
      });
    }

    if (attempt.status !== 'succeeded') {
      return Object.freeze({
        status: 'payment_pending' as const,
        paymentAttemptId: attempt.paymentAttemptId,
        transactionId: attempt.transactionId,
        resumeToken,
      });
    }

    try {
      const proof = await this.#agent.issuePaymentProof(attempt.transactionId);
      return this.#deliveryReady(proof, token.resourceUrl);
    } catch (error) {
      if (error instanceof AIPayApiError) throw new AgentBridgeError('aipay_rejected');
      throw error;
    }
  }

  async deliver(deliveryToken: string) {
    let token;

    try {
      token = this.#tokens.verifyDelivery(deliveryToken);
      this.#assertAllowedUrl(token.resourceUrl);
    } catch (error) {
      if (error instanceof BridgeTokenError || error instanceof AgentBridgeError) {
        throw new AgentBridgeError('invalid_token');
      }
      throw error;
    }

    let response: Response;

    try {
      response = await this.#fetch(token.resourceUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          [PAYMENT_PROOF_HEADER]: encodePaymentProof(token.paymentProof),
        },
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AgentBridgeError('resource_failed');
    }

    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
      throw new AgentBridgeError('resource_failed');
    }

    const declaredLength = Number(response.headers.get('content-length'));

    if (Number.isFinite(declaredLength) && declaredLength > maximumResultBytes) {
      throw new AgentBridgeError('resource_failed');
    }

    const bytes = Buffer.from(await response.arrayBuffer());

    if (bytes.byteLength > maximumResultBytes) throw new AgentBridgeError('resource_failed');
    let result: unknown;

    try {
      result = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new AgentBridgeError('resource_failed');
    }

    return Object.freeze({
      status: 'delivered' as const,
      transactionId: token.paymentProof.transactionId,
      paymentProofId: token.paymentProof.paymentProofId,
      resourceUrl: token.resourceUrl,
      result,
    });
  }

  #paymentAction(attempt: Readonly<PaymentAttempt>, resourceUrl: string) {
    if (attempt.action === null) return this.#paymentIncomplete(attempt, resourceUrl);

    return Object.freeze({
      status: 'payment_action_required' as const,
      paymentAttemptId: attempt.paymentAttemptId,
      transactionId: attempt.transactionId,
      action: attempt.action,
      resumeToken: this.#tokens.issueResume(
        attempt.paymentAttemptId,
        attempt.transactionId,
        resourceUrl,
      ),
    });
  }

  #paymentIncomplete(attempt: Readonly<PaymentAttempt>, resourceUrl: string) {
    if (attempt.status === 'failed') {
      return Object.freeze({
        status: 'payment_failed' as const,
        paymentAttemptId: attempt.paymentAttemptId,
        transactionId: attempt.transactionId,
        errorCode: attempt.errorCode,
      });
    }

    return Object.freeze({
      status: 'payment_pending' as const,
      paymentAttemptId: attempt.paymentAttemptId,
      transactionId: attempt.transactionId,
      resumeToken: this.#tokens.issueResume(
        attempt.paymentAttemptId,
        attempt.transactionId,
        resourceUrl,
      ),
    });
  }

  #deliveryReady(paymentProof: Readonly<PaymentProofWire>, resourceUrl: string) {
    return Object.freeze({
      status: 'delivery_ready' as const,
      transactionId: paymentProof.transactionId,
      paymentProofId: paymentProof.paymentProofId,
      deliveryToken: this.#tokens.issueDelivery(paymentProof, resourceUrl),
    });
  }

  #resourceUrl(path: string, query: Readonly<Record<string, string>>): string {
    if (!this.#paths.has(path)) throw new AgentBridgeError('invalid_input');
    const url = new URL(path, `${this.#config.resourceOrigin}/`);

    for (const [key, value] of Object.entries(query)) {
      if (!this.#queryKeys.has(key) || !queryValuePattern.test(value)) {
        throw new AgentBridgeError('invalid_input');
      }
      url.searchParams.append(key, value);
    }

    const resourceUrl = url.toString();
    this.#assertAllowedUrl(resourceUrl);
    return resourceUrl;
  }

  #assertAllowedUrl(value: string): void {
    let url: URL;

    try {
      url = new URL(value);
    } catch {
      throw new AgentBridgeError('invalid_token');
    }

    if (
      url.origin !== this.#config.resourceOrigin ||
      !this.#paths.has(url.pathname) ||
      [...url.searchParams].some(
        ([key, queryValue]) => !this.#queryKeys.has(key) || !queryValuePattern.test(queryValue),
      )
    ) {
      throw new AgentBridgeError('invalid_token');
    }
  }
}
