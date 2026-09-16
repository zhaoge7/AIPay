import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';

import { getResourceUuid, type ResourceId } from '@aipay/contracts';
import type { Database, DatabaseTransaction } from '@aipay/database';
import type { A2MBillSigningInput, A2MPaymentVerification } from '@aipay/payment';
import { v7 as uuidv7 } from 'uuid';

import type { A2MRuntimeConfig } from './config.js';
import {
  MerchantInvocationError,
  type MerchantApiInvocationResult,
  type MerchantApiInvokerPort,
} from './merchant-invoker.js';
import type { A2MClientPort } from './service.js';
import {
  ApiRegistrationError,
  validateInvocationParameters,
} from '../services/api-registration.js';

const paymentWindowMs = 30 * 60 * 1_000;
const selectionVersion = 'category-quality-price-v1';

export type ApiInvocationErrorCode =
  | 'invalid_request'
  | 'service_unavailable'
  | 'idempotency_conflict'
  | 'order_expired'
  | 'platform_liquidity_unavailable'
  | 'invalid_payment_proof'
  | 'invocation_in_progress'
  | 'merchant_api_unavailable'
  | 'fulfillment_confirmation_failed';

export class ApiInvocationError extends Error {
  readonly code: ApiInvocationErrorCode;

  constructor(code: ApiInvocationErrorCode) {
    super('Aggregated API invocation failed');
    this.name = 'ApiInvocationError';
    this.code = code;
  }
}

export interface CreateApiInvocationInput {
  readonly intent: string;
  readonly category?: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
}

export interface AggregatedPaymentRequired {
  readonly headerValue: string;
  readonly outTradeNo: string;
  readonly resourceId: string;
  readonly amount: string;
  readonly currency: 'CNY';
  readonly goodsName: string;
  readonly selectedServiceId: ResourceId<'svc'>;
  readonly resolvedCategory: string;
}

export interface AggregatedFulfillment {
  readonly tradeNo: string;
  readonly outTradeNo: string;
  readonly resourceId: string;
  readonly selectedServiceId: ResourceId<'svc'>;
  readonly resolvedCategory: string;
  readonly alreadyFulfilled: boolean;
  readonly serviceResult: Readonly<Record<string, unknown>>;
}

interface DecodedPaymentProof {
  readonly paymentProof: string;
  readonly tradeNo: string;
  readonly clientSession: string | undefined;
}

interface Candidate {
  readonly serviceId: string;
  readonly merchantId: string;
  readonly merchantDeveloperId: string;
  readonly serviceName: string;
  readonly category: string;
  readonly amountMinor: string;
  readonly endpointUrl: string;
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly inputSchema: unknown;
  readonly timeoutMs: number;
  readonly registrationVersion: number;
  readonly successCount: string;
  readonly failureCount: string;
  readonly totalLatencyMs: string;
}

interface SelectedCandidate extends Candidate {
  readonly selectionScore: number;
  readonly semanticScore: number;
}

interface InvocationOrderSnapshot {
  readonly id: string;
  readonly outTradeNo: string;
  readonly merchantId: string;
  readonly serviceId: string;
  readonly amountMinor: string;
  readonly resourceId: string;
  readonly goodsName: string;
  readonly payBefore: Date;
  readonly orderStatus: 'pending_payment' | 'paid';
  readonly fulfillmentStatus: 'unfulfilled' | 'invoking' | 'pending_confirm' | 'fulfilled';
  readonly providerTradeNo: string | null;
  readonly paymentProofHash: Uint8Array | null;
  readonly serviceResult: unknown;
  readonly agentId: string;
  readonly requestHash: Uint8Array;
  readonly resolvedCategory: string;
  readonly intent: string;
  readonly invocationParameters: unknown;
  readonly apiRegistrationVersion: number;
  readonly invocationUrl: string;
  readonly invocationTimeoutMs: number;
  readonly invocationLeaseExpiresAt: Date | null;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function capabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Stored API capabilities are invalid');
  }

  return value as readonly string[];
}

function amountInYuan(amountMinor: string): string {
  const amount = BigInt(amountMinor);
  return `${(amount / 100n).toString()}.${(amount % 100n).toString().padStart(2, '0')}`;
}

function normalizeYuan(value: string): string | null {
  const match = /^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/u.exec(value);
  return match?.[1] === undefined
    ? null
    : `${BigInt(match[1]).toString()}.${(match[2] ?? '').padEnd(2, '0')}`;
}

function chinaIso(date: Date): string {
  const local = new Date(date.getTime() + 8 * 60 * 60 * 1_000);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${local.getUTCFullYear().toString()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}+08:00`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ApiInvocationError('invalid_request');
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const object = record(value);

  if (object === null) {
    throw new ApiInvocationError('invalid_request');
  }

  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}

function hash(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function hashesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function decodePaymentProof(value: string): Readonly<DecodedPaymentProof> {
  if (value.length < 16 || value.length > 16_384) {
    throw new ApiInvocationError('invalid_payment_proof');
  }

  try {
    const isBase64Url = /^[A-Za-z0-9_-]+$/u.test(value);
    const isBase64 = /^[A-Za-z0-9+/]+={0,2}$/u.test(value) && value.length % 4 === 0;

    if (!isBase64Url && !isBase64) throw new Error('invalid encoding');
    const encoding = isBase64Url ? 'base64url' : 'base64';
    const bytes = Buffer.from(value, encoding);

    if (bytes.toString(encoding) !== value) throw new Error('non-canonical');
    const root = record(JSON.parse(bytes.toString('utf8')));
    const protocol = record(root?.protocol);
    const method = record(root?.method);
    const paymentProof = protocol?.payment_proof;
    const tradeNo = protocol?.trade_no;
    const clientSession = method?.client_session;

    if (
      typeof paymentProof !== 'string' ||
      !/^[\x21-\x7e]{1,4096}$/u.test(paymentProof) ||
      typeof tradeNo !== 'string' ||
      !/^\d{16,64}$/u.test(tradeNo) ||
      (clientSession !== undefined &&
        (typeof clientSession !== 'string' || clientSession.length > 1_024))
    ) {
      throw new Error('invalid shape');
    }

    return Object.freeze({ paymentProof, tradeNo, clientSession });
  } catch (error) {
    if (error instanceof ApiInvocationError) throw error;
    throw new ApiInvocationError('invalid_payment_proof');
  }
}

function normalizeIntent(value: string): string {
  const intent = value.trim().replace(/\s+/gu, ' ');

  for (let index = 0; index < intent.length; index += 1) {
    const codeUnit = intent.charCodeAt(index);

    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      throw new ApiInvocationError('invalid_request');
    }
  }

  if (intent.length < 2 || intent.length > 500) {
    throw new ApiInvocationError('invalid_request');
  }

  return intent;
}

function normalizeIdempotencyKey(value: string): string {
  if (value.length < 16 || value.length > 128 || !/^[\x21-\x7e]+$/u.test(value)) {
    throw new ApiInvocationError('invalid_request');
  }

  return value;
}

function semanticScore(intent: string, candidate: Candidate): number {
  const normalizedIntent = intent.toLocaleLowerCase('zh-CN');
  let score = 0;
  const categoryTerms = candidate.category.split(/[._-]/u).filter((term) => term.length > 1);

  for (const term of categoryTerms) {
    if (normalizedIntent.includes(term)) score += 80;
  }

  const name = candidate.serviceName.toLocaleLowerCase('zh-CN');
  if (name.length > 1 && normalizedIntent.includes(name)) score += 400;

  for (const capability of candidate.capabilities) {
    const normalized = capability.toLocaleLowerCase('zh-CN');
    if (normalized.length > 1 && normalizedIntent.includes(normalized)) score += 300;
  }

  const descriptionTerms = candidate.description
    .toLocaleLowerCase('zh-CN')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length > 1);
  for (const term of new Set(descriptionTerms)) {
    if (normalizedIntent.includes(term)) score += 20;
  }

  return Math.min(score, 10_000);
}

function reliabilityBasisPoints(candidate: Candidate): number {
  const success = BigInt(candidate.successCount);
  const failure = BigInt(candidate.failureCount);
  return Number(((success + 5n) * 10_000n) / (success + failure + 10n));
}

function averageLatency(candidate: Candidate): number {
  const attempts = BigInt(candidate.successCount) + BigInt(candidate.failureCount);
  return attempts === 0n ? 5_000 : Number(BigInt(candidate.totalLatencyMs) / attempts);
}

function chooseCandidate(
  intent: string,
  requestedCategory: string | undefined,
  candidates: readonly Candidate[],
): Readonly<SelectedCandidate> {
  let resolvedCategory = requestedCategory;

  if (resolvedCategory === undefined) {
    const categoryScores = new Map<string, number>();

    for (const candidate of candidates) {
      const score = semanticScore(intent, candidate);
      categoryScores.set(
        candidate.category,
        Math.max(categoryScores.get(candidate.category) ?? 0, score),
      );
    }

    const bestCategory = [...categoryScores.entries()]
      .filter(([, score]) => score > 0)
      .sort(([leftCategory, leftScore], [rightCategory, rightScore]) =>
        rightScore === leftScore
          ? leftCategory.localeCompare(rightCategory)
          : rightScore - leftScore,
      )[0];
    resolvedCategory = bestCategory?.[0];
  }

  if (resolvedCategory === undefined) {
    throw new ApiInvocationError('service_unavailable');
  }

  const ranked = candidates
    .filter((candidate) => candidate.category === resolvedCategory)
    .map((candidate) => {
      const relevance = requestedCategory === undefined ? semanticScore(intent, candidate) : 1_000;
      const pricePenalty = Math.min(Number(BigInt(candidate.amountMinor)), 100_000);
      const latencyPenalty = Math.min(averageLatency(candidate), 30_000);
      const score =
        relevance * 100_000 +
        reliabilityBasisPoints(candidate) * 10 -
        pricePenalty -
        latencyPenalty;
      return Object.freeze({ ...candidate, semanticScore: relevance, selectionScore: score });
    })
    .sort((left, right) => {
      if (right.selectionScore !== left.selectionScore)
        return right.selectionScore - left.selectionScore;
      const priceComparison = BigInt(left.amountMinor) - BigInt(right.amountMinor);
      if (priceComparison !== 0n) return priceComparison < 0n ? -1 : 1;
      return left.serviceId.localeCompare(right.serviceId);
    });
  const selected = ranked[0];

  if (selected === undefined) {
    throw new ApiInvocationError('service_unavailable');
  }

  return selected;
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}

function asOrder(row: Record<string, unknown>): InvocationOrderSnapshot {
  const invocationParameters = record(row.invocationParameters);

  if (
    typeof row.id !== 'string' ||
    typeof row.outTradeNo !== 'string' ||
    typeof row.merchantId !== 'string' ||
    typeof row.serviceId !== 'string' ||
    typeof row.amountMinor !== 'string' ||
    typeof row.resourceId !== 'string' ||
    typeof row.goodsName !== 'string' ||
    !(row.payBefore instanceof Date) ||
    (row.orderStatus !== 'pending_payment' && row.orderStatus !== 'paid') ||
    !['unfulfilled', 'invoking', 'pending_confirm', 'fulfilled'].includes(
      String(row.fulfillmentStatus),
    ) ||
    typeof row.agentId !== 'string' ||
    !(row.requestHash instanceof Uint8Array) ||
    typeof row.resolvedCategory !== 'string' ||
    typeof row.intent !== 'string' ||
    invocationParameters === null ||
    typeof row.apiRegistrationVersion !== 'number' ||
    typeof row.invocationUrl !== 'string' ||
    typeof row.invocationTimeoutMs !== 'number'
  ) {
    throw new Error('Aggregated A2M order is incomplete');
  }

  return row as unknown as InvocationOrderSnapshot;
}

export class ApiInvocationService {
  readonly #database: Database;
  readonly #client: A2MClientPort;
  readonly #invoker: MerchantApiInvokerPort;
  readonly #now: () => Date;

  constructor(
    database: Database,
    client: A2MClientPort,
    config: Readonly<A2MRuntimeConfig>,
    invoker: MerchantApiInvokerPort,
    now: () => Date = () => new Date(),
  ) {
    this.#database = database;
    this.#client = client;
    this.#invoker = invoker;
    this.#now = now;

    if (
      config.appId !== client.appId ||
      config.sellerId !== client.sellerId ||
      config.serviceId !== client.serviceId ||
      config.sandbox !== client.sandbox
    ) {
      throw new Error('A2M invocation client and runtime configuration do not match');
    }
  }

  async createPaymentRequired(
    agentId: ResourceId<'agt'>,
    input: Readonly<CreateApiInvocationInput>,
  ): Promise<Readonly<AggregatedPaymentRequired>> {
    const intent = normalizeIntent(input.intent);
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const requestedCategory = input.category;

    if (requestedCategory !== undefined && !/^[a-z][a-z0-9._-]{0,63}$/u.test(requestedCategory)) {
      throw new ApiInvocationError('invalid_request');
    }

    const parameters = record(input.parameters);

    if (parameters === null) throw new ApiInvocationError('invalid_request');
    const requestDigest = hash(canonicalJson({ intent, requestedCategory, parameters }));
    const keyDigest = hash(idempotencyKey);
    const agentUuid = getResourceUuid(agentId);
    await this.#releaseExpiredReservations();
    const existing = await this.#existingOrder(agentUuid, keyDigest);

    if (existing !== null) {
      if (!hashesEqual(existing.requestHash, requestDigest)) {
        throw new ApiInvocationError('idempotency_conflict');
      }
      if (this.#now() >= existing.payBefore && existing.orderStatus === 'pending_payment') {
        throw new ApiInvocationError('order_expired');
      }
      return this.#paymentRequired(existing);
    }

    const candidates = await this.#loadCandidates();
    const selected = chooseCandidate(intent, requestedCategory, candidates);
    let validatedParameters: Readonly<Record<string, unknown>>;

    try {
      validatedParameters = validateInvocationParameters(selected.inputSchema, parameters);
    } catch (error) {
      if (error instanceof ApiRegistrationError && error.code === 'parameters_invalid') {
        throw new ApiInvocationError('invalid_request');
      }
      throw error;
    }

    const now = this.#now();
    const payBefore = new Date(now.getTime() + paymentWindowMs);
    const outTradeNo = `A2M${uuidv7().replaceAll('-', '').toUpperCase()}`;
    const resourceId = `/v1/a2m/invocations/${outTradeNo}`;

    try {
      const order = await this.#database.transaction().execute(async (transaction) => {
        const current = await transaction
          .selectFrom('apiRegistrations')
          .innerJoin('services', 'services.id', 'apiRegistrations.serviceId')
          .innerJoin('merchants', 'merchants.id', 'apiRegistrations.merchantId')
          .leftJoin(
            'developerPaymentControls',
            'developerPaymentControls.developerId',
            'merchants.developerId',
          )
          .select([
            'services.id as serviceId',
            'services.merchantId as merchantId',
            'services.name as goodsName',
            'services.unitPriceAmountMinor as amountMinor',
            'services.category as resolvedCategory',
            'apiRegistrations.version as registrationVersion',
            'apiRegistrations.endpointUrl as endpointUrl',
            'apiRegistrations.timeoutMs as timeoutMs',
          ])
          .where('services.id', '=', selected.serviceId)
          .where('services.status', '=', 'enabled')
          .where('merchants.status', '=', 'active')
          .where('apiRegistrations.status', '=', 'enabled')
          .where('apiRegistrations.version', '=', selected.registrationVersion)
          .where((expressions) =>
            expressions.or([
              expressions('developerPaymentControls.paymentsPaused', 'is', null),
              expressions('developerPaymentControls.paymentsPaused', '=', false),
            ]),
          )
          .forUpdate('apiRegistrations')
          .executeTakeFirst();

        if (
          current?.amountMinor !== selected.amountMinor ||
          current.resolvedCategory !== selected.category
        ) {
          throw new ApiInvocationError('service_unavailable');
        }

        const funding = await transaction
          .selectFrom('platformFundingAccounts')
          .select(['availableAmountMinor', 'reservedAmountMinor'])
          .where('currency', '=', 'CNY')
          .forUpdate()
          .executeTakeFirstOrThrow();

        if (BigInt(funding.availableAmountMinor) < BigInt(current.amountMinor)) {
          throw new ApiInvocationError('platform_liquidity_unavailable');
        }

        await transaction
          .updateTable('platformFundingAccounts')
          .set((expressions) => ({
            availableAmountMinor: expressions('availableAmountMinor', '-', current.amountMinor),
            reservedAmountMinor: expressions('reservedAmountMinor', '+', current.amountMinor),
            updatedAt: now,
          }))
          .where('currency', '=', 'CNY')
          .executeTakeFirstOrThrow();
        const inserted = await transaction
          .insertInto('a2mOrders')
          .values({
            outTradeNo,
            merchantId: current.merchantId,
            serviceId: current.serviceId,
            amountMinor: current.amountMinor,
            resourceId,
            goodsName: current.goodsName,
            payBefore,
            providerTradeNo: null,
            paymentProofHash: null,
            serviceResult: null,
            fulfillmentErrorCode: null,
            fulfilledAt: null,
            agentId: agentUuid,
            idempotencyKeyHash: keyDigest,
            requestHash: requestDigest,
            requestedCategory: requestedCategory ?? null,
            resolvedCategory: current.resolvedCategory,
            intent,
            invocationParameters: validatedParameters,
            selectionScore: selected.selectionScore,
            selectionVersion,
            apiRegistrationVersion: current.registrationVersion,
            invocationUrl: current.endpointUrl,
            invocationTimeoutMs: current.timeoutMs,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto('merchantAdvances')
          .values({
            a2mOrderId: inserted.id,
            merchantId: inserted.merchantId,
            amountMinor: inserted.amountMinor,
            advancedAt: null,
            paidAt: null,
            releasedAt: null,
            releaseReason: null,
          })
          .executeTakeFirstOrThrow();
        return asOrder(inserted);
      });
      return this.#paymentRequired(order);
    } catch (error) {
      if (!isUniqueViolation(error, 'a2m_orders_agent_idempotency_unique')) throw error;
      const raced = await this.#existingOrder(agentUuid, keyDigest);

      if (raced === null || !hashesEqual(raced.requestHash, requestDigest)) {
        throw new ApiInvocationError('idempotency_conflict');
      }

      return this.#paymentRequired(raced);
    }
  }

  async paymentRequiredForOrder(
    agentId: ResourceId<'agt'>,
    outTradeNo: string,
  ): Promise<Readonly<AggregatedPaymentRequired>> {
    const order = await this.#orderByReference(getResourceUuid(agentId), outTradeNo);

    if (order === null) throw new ApiInvocationError('service_unavailable');
    if (order.orderStatus !== 'pending_payment' || this.#now() >= order.payBefore) {
      throw new ApiInvocationError('order_expired');
    }
    return this.#paymentRequired(order);
  }

  async verifyAndFulfill(
    agentId: ResourceId<'agt'>,
    outTradeNo: string,
    encodedPaymentProof: string,
  ): Promise<Readonly<AggregatedFulfillment>> {
    const decoded = decodePaymentProof(encodedPaymentProof);
    const verification = await this.#client.verifyPaymentProof({
      tradeNo: decoded.tradeNo,
      paymentProof: decoded.paymentProof,
      ...(decoded.clientSession === undefined ? {} : { clientSession: decoded.clientSession }),
    });
    const agentUuid = getResourceUuid(agentId);
    const order = await this.#orderByReference(agentUuid, outTradeNo);

    if (order === null || !this.#verificationMatches(order, decoded.tradeNo, verification)) {
      throw new ApiInvocationError('invalid_payment_proof');
    }

    const prepared = await this.#prepareInvocation(
      agentUuid,
      order,
      decoded.tradeNo,
      hash(decoded.paymentProof),
    );
    let serviceResult = prepared.serviceResult;

    if (prepared.invokeMerchant) {
      let invoked: Readonly<MerchantApiInvocationResult>;

      try {
        invoked = await this.#invoker.invoke({
          outTradeNo: prepared.order.outTradeNo,
          serviceId: `svc_${prepared.order.serviceId}` as ResourceId<'svc'>,
          category: prepared.order.resolvedCategory,
          intent: prepared.order.intent,
          parameters: prepared.order.invocationParameters as Readonly<Record<string, unknown>>,
          endpointUrl: prepared.order.invocationUrl,
          timeoutMs: prepared.order.invocationTimeoutMs,
        });
      } catch (error) {
        const invocationError =
          error instanceof MerchantInvocationError
            ? error
            : new MerchantInvocationError('NETWORK_ERROR');
        await this.#recordInvocationFailure(prepared.order, invocationError);
        throw new ApiInvocationError('merchant_api_unavailable');
      }

      serviceResult = await this.#storeInvocationResult(prepared.order, invoked);
    }

    if (serviceResult === null) {
      throw new Error('Merchant invocation did not produce a persisted result');
    }

    if (prepared.alreadyFulfilled) {
      return this.#fulfilledView(prepared.order, decoded.tradeNo, serviceResult, true);
    }

    if (!(await this.#client.confirmFulfillment(decoded.tradeNo))) {
      await this.#database
        .updateTable('a2mOrders')
        .set({ fulfillmentErrorCode: 'FULFILLMENT_CONFIRM_FAILED', updatedAt: this.#now() })
        .where('id', '=', prepared.order.id)
        .where('providerTradeNo', '=', decoded.tradeNo)
        .where('fulfillmentStatus', '=', 'pending_confirm')
        .executeTakeFirst();
      throw new ApiInvocationError('fulfillment_confirmation_failed');
    }

    const fulfilledAt = this.#now();
    await this.#database.transaction().execute(async (transaction) => {
      const updated = await transaction
        .updateTable('a2mOrders')
        .set({
          fulfillmentStatus: 'fulfilled',
          fulfillmentErrorCode: null,
          fulfilledAt,
          updatedAt: fulfilledAt,
        })
        .where('id', '=', prepared.order.id)
        .where('providerTradeNo', '=', decoded.tradeNo)
        .where('fulfillmentStatus', '=', 'pending_confirm')
        .returning('id')
        .executeTakeFirst();

      if (updated !== undefined) {
        await transaction
          .insertInto('platformReceivables')
          .values({
            a2mOrderId: prepared.order.id,
            providerTradeNo: decoded.tradeNo,
            amountMinor: prepared.order.amountMinor,
            receivedAt: null,
          })
          .onConflict((conflict) => conflict.column('a2mOrderId').doNothing())
          .executeTakeFirst();
      }
    });
    return this.#fulfilledView(prepared.order, decoded.tradeNo, serviceResult, false);
  }

  async #loadCandidates(): Promise<readonly Candidate[]> {
    const rows = await this.#database
      .selectFrom('apiRegistrations')
      .innerJoin('services', 'services.id', 'apiRegistrations.serviceId')
      .innerJoin('merchants', 'merchants.id', 'apiRegistrations.merchantId')
      .leftJoin(
        'developerPaymentControls',
        'developerPaymentControls.developerId',
        'merchants.developerId',
      )
      .select([
        'services.id as serviceId',
        'services.merchantId as merchantId',
        'merchants.developerId as merchantDeveloperId',
        'services.name as serviceName',
        'services.category as category',
        'services.unitPriceAmountMinor as amountMinor',
        'apiRegistrations.endpointUrl as endpointUrl',
        'apiRegistrations.description as description',
        'apiRegistrations.capabilities as capabilities',
        'apiRegistrations.inputSchema as inputSchema',
        'apiRegistrations.timeoutMs as timeoutMs',
        'apiRegistrations.version as registrationVersion',
        'apiRegistrations.successCount as successCount',
        'apiRegistrations.failureCount as failureCount',
        'apiRegistrations.totalLatencyMs as totalLatencyMs',
      ])
      .where('services.serviceType', '=', 'api')
      .where('services.status', '=', 'enabled')
      .where('merchants.status', '=', 'active')
      .where('apiRegistrations.status', '=', 'enabled')
      .where((expressions) =>
        expressions.or([
          expressions('developerPaymentControls.paymentsPaused', 'is', null),
          expressions('developerPaymentControls.paymentsPaused', '=', false),
        ]),
      )
      .orderBy('services.id', 'asc')
      .limit(500)
      .execute();
    return rows.map((row) =>
      Object.freeze({ ...row, capabilities: capabilities(row.capabilities) }),
    );
  }

  async #existingOrder(
    agentId: string,
    keyDigest: Buffer,
  ): Promise<InvocationOrderSnapshot | null> {
    const row = await this.#database
      .selectFrom('a2mOrders')
      .selectAll()
      .where('agentId', '=', agentId)
      .where('idempotencyKeyHash', '=', keyDigest)
      .executeTakeFirst();
    return row === undefined ? null : asOrder(row);
  }

  async #orderByReference(
    agentId: string,
    outTradeNo: string,
  ): Promise<InvocationOrderSnapshot | null> {
    if (!/^A2M[0-9A-F]{32}$/u.test(outTradeNo)) return null;
    const row = await this.#database
      .selectFrom('a2mOrders')
      .selectAll()
      .where('agentId', '=', agentId)
      .where('outTradeNo', '=', outTradeNo)
      .executeTakeFirst();
    return row === undefined ? null : asOrder(row);
  }

  #paymentRequired(order: InvocationOrderSnapshot): Readonly<AggregatedPaymentRequired> {
    const amount = amountInYuan(order.amountMinor);
    const signingInput: A2MBillSigningInput = {
      amount,
      currency: 'CNY',
      goods_name: order.goodsName,
      out_trade_no: order.outTradeNo,
      pay_before: chinaIso(order.payBefore),
      resource_id: order.resourceId,
      seller_id: this.#client.sellerId,
      service_id: this.#client.serviceId,
    };
    const paymentNeeded = {
      protocol: {
        out_trade_no: order.outTradeNo,
        amount,
        currency: 'CNY',
        resource_id: order.resourceId,
        pay_before: signingInput.pay_before,
        seller_signature: this.#client.signBill(signingInput),
        seller_sign_type: 'RSA2',
        seller_unique_id: this.#client.sellerId,
      },
      method: {
        seller_name: this.#client.sellerName,
        seller_id: this.#client.sellerId,
        seller_app_id: this.#client.appId,
        goods_name: order.goodsName,
        seller_unique_id_key: 'seller_id',
        service_id: this.#client.serviceId,
      },
    };
    return Object.freeze({
      headerValue: Buffer.from(JSON.stringify(paymentNeeded), 'utf8').toString('base64url'),
      outTradeNo: order.outTradeNo,
      resourceId: order.resourceId,
      amount,
      currency: 'CNY',
      goodsName: order.goodsName,
      selectedServiceId: `svc_${order.serviceId}` as ResourceId<'svc'>,
      resolvedCategory: order.resolvedCategory,
    });
  }

  #verificationMatches(
    order: InvocationOrderSnapshot,
    decodedTradeNo: string,
    verification: Readonly<A2MPaymentVerification>,
  ): boolean {
    const observedAmount =
      verification.amount.length > 0
        ? normalizeYuan(verification.amount)
        : this.#client.sandbox
          ? amountInYuan(order.amountMinor)
          : null;
    const observedResource =
      verification.resourceId.length > 0
        ? verification.resourceId
        : this.#client.sandbox
          ? order.resourceId
          : '';
    return (
      verification.accepted &&
      verification.active &&
      verification.tradeNo === decodedTradeNo &&
      verification.outTradeNo === order.outTradeNo &&
      observedAmount === amountInYuan(order.amountMinor) &&
      observedResource === order.resourceId
    );
  }

  async #prepareInvocation(
    agentId: string,
    snapshot: InvocationOrderSnapshot,
    tradeNo: string,
    paymentProofHash: Buffer,
  ): Promise<
    Readonly<{
      order: InvocationOrderSnapshot;
      invokeMerchant: boolean;
      alreadyFulfilled: boolean;
      serviceResult: Readonly<Record<string, unknown>> | null;
    }>
  > {
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom('a2mOrders')
        .selectAll()
        .where('id', '=', snapshot.id)
        .where('agentId', '=', agentId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const order = asOrder(row);
      const existingResult = record(order.serviceResult);

      if (
        order.fulfillmentStatus === 'fulfilled' ||
        order.fulfillmentStatus === 'pending_confirm'
      ) {
        if (
          order.providerTradeNo !== tradeNo ||
          order.paymentProofHash === null ||
          !hashesEqual(order.paymentProofHash, paymentProofHash) ||
          existingResult === null
        ) {
          throw new ApiInvocationError('invalid_payment_proof');
        }

        return Object.freeze({
          order,
          invokeMerchant: false,
          alreadyFulfilled: order.fulfillmentStatus === 'fulfilled',
          serviceResult: existingResult,
        });
      }

      const now = this.#now();

      if (order.fulfillmentStatus === 'invoking') {
        if (
          order.providerTradeNo !== tradeNo ||
          order.paymentProofHash === null ||
          !hashesEqual(order.paymentProofHash, paymentProofHash)
        ) {
          throw new ApiInvocationError('invalid_payment_proof');
        }

        if (order.invocationLeaseExpiresAt !== null && order.invocationLeaseExpiresAt > now) {
          throw new ApiInvocationError('invocation_in_progress');
        }
      } else {
        if (order.orderStatus !== 'pending_payment' || now >= order.payBefore) {
          throw new ApiInvocationError('invalid_payment_proof');
        }

        await this.#advanceMerchantFunds(transaction, order, now);
      }

      const leaseExpiresAt = new Date(now.getTime() + order.invocationTimeoutMs + 5_000);
      const updated = await transaction
        .updateTable('a2mOrders')
        .set((expressions) => ({
          orderStatus: 'paid',
          fulfillmentStatus: 'invoking',
          providerTradeNo: tradeNo,
          paymentProofHash,
          fulfillmentErrorCode: null,
          invocationAttemptCount: expressions('invocationAttemptCount', '+', 1),
          invocationLeaseExpiresAt: leaseExpiresAt,
          updatedAt: now,
        }))
        .where('id', '=', order.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return Object.freeze({
        order: asOrder(updated as unknown as Record<string, unknown>),
        invokeMerchant: true,
        alreadyFulfilled: false,
        serviceResult: null,
      });
    });
  }

  async #advanceMerchantFunds(
    transaction: DatabaseTransaction,
    order: InvocationOrderSnapshot,
    now: Date,
  ): Promise<void> {
    const advance = await transaction
      .selectFrom('merchantAdvances')
      .selectAll()
      .where('a2mOrderId', '=', order.id)
      .forUpdate()
      .executeTakeFirstOrThrow();

    if (advance.status !== 'reserved' || advance.amountMinor !== order.amountMinor) {
      throw new ApiInvocationError('platform_liquidity_unavailable');
    }

    const funding = await transaction
      .updateTable('platformFundingAccounts')
      .set((expressions) => ({
        reservedAmountMinor: expressions('reservedAmountMinor', '-', order.amountMinor),
        updatedAt: now,
      }))
      .where('currency', '=', 'CNY')
      .where('reservedAmountMinor', '>=', order.amountMinor)
      .returning('currency')
      .executeTakeFirst();

    if (funding === undefined) {
      throw new ApiInvocationError('platform_liquidity_unavailable');
    }

    await transaction
      .insertInto('merchantSettlementAccounts')
      .values({ merchantId: order.merchantId })
      .onConflict((conflict) => conflict.columns(['merchantId', 'currency']).doNothing())
      .executeTakeFirst();
    await transaction
      .updateTable('merchantSettlementAccounts')
      .set((expressions) => ({
        pendingAmountMinor: expressions('pendingAmountMinor', '+', order.amountMinor),
        updatedAt: now,
      }))
      .where('merchantId', '=', order.merchantId)
      .where('currency', '=', 'CNY')
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable('merchantAdvances')
      .set({ status: 'advanced', advancedAt: now, updatedAt: now })
      .where('id', '=', advance.id)
      .where('status', '=', 'reserved')
      .executeTakeFirstOrThrow();
  }

  async #recordInvocationFailure(
    order: InvocationOrderSnapshot,
    error: MerchantInvocationError,
  ): Promise<void> {
    const now = this.#now();
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable('a2mOrders')
        .set({
          fulfillmentErrorCode: error.code,
          invocationLeaseExpiresAt: now,
          updatedAt: now,
        })
        .where('id', '=', order.id)
        .where('fulfillmentStatus', '=', 'invoking')
        .executeTakeFirst();
      await transaction
        .updateTable('apiRegistrations')
        .set((expressions) => ({
          failureCount: expressions('failureCount', '+', '1'),
          totalLatencyMs: expressions('totalLatencyMs', '+', String(Math.max(0, error.latencyMs))),
          lastInvokedAt: now,
          updatedAt: now,
        }))
        .where('serviceId', '=', order.serviceId)
        .where('version', '=', order.apiRegistrationVersion)
        .executeTakeFirst();
    });
  }

  async #storeInvocationResult(
    order: InvocationOrderSnapshot,
    invocation: Readonly<MerchantApiInvocationResult>,
  ): Promise<Readonly<Record<string, unknown>>> {
    const now = this.#now();
    return this.#database.transaction().execute(async (transaction) => {
      const locked = await transaction
        .selectFrom('a2mOrders')
        .select(['fulfillmentStatus', 'providerTradeNo', 'serviceResult'])
        .where('id', '=', order.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const existing = record(locked.serviceResult);

      if (
        locked.fulfillmentStatus === 'pending_confirm' ||
        locked.fulfillmentStatus === 'fulfilled'
      ) {
        if (locked.providerTradeNo !== order.providerTradeNo || existing === null) {
          throw new ApiInvocationError('invalid_payment_proof');
        }
        return existing;
      }

      if (
        locked.fulfillmentStatus !== 'invoking' ||
        locked.providerTradeNo !== order.providerTradeNo
      ) {
        throw new ApiInvocationError('invalid_payment_proof');
      }

      const advance = await transaction
        .selectFrom('merchantAdvances')
        .select(['id', 'status'])
        .where('a2mOrderId', '=', order.id)
        .forUpdate()
        .executeTakeFirstOrThrow();

      if (advance.status !== 'advanced') {
        throw new Error('Merchant advance is not pending settlement');
      }

      const account = await transaction
        .updateTable('merchantSettlementAccounts')
        .set((expressions) => ({
          pendingAmountMinor: expressions('pendingAmountMinor', '-', order.amountMinor),
          availableAmountMinor: expressions('availableAmountMinor', '+', order.amountMinor),
          updatedAt: now,
        }))
        .where('merchantId', '=', order.merchantId)
        .where('currency', '=', 'CNY')
        .where('pendingAmountMinor', '>=', order.amountMinor)
        .returning('merchantId')
        .executeTakeFirst();

      if (account === undefined) throw new Error('Merchant settlement account is inconsistent');
      await transaction
        .updateTable('merchantAdvances')
        .set({ status: 'paid', paidAt: now, updatedAt: now })
        .where('id', '=', advance.id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('a2mOrders')
        .set({
          fulfillmentStatus: 'pending_confirm',
          serviceResult: invocation.result,
          fulfillmentErrorCode: null,
          invocationLeaseExpiresAt: null,
          updatedAt: now,
        })
        .where('id', '=', order.id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('apiRegistrations')
        .set((expressions) => ({
          successCount: expressions('successCount', '+', '1'),
          totalLatencyMs: expressions(
            'totalLatencyMs',
            '+',
            String(Math.max(0, invocation.latencyMs)),
          ),
          lastInvokedAt: now,
          updatedAt: now,
        }))
        .where('serviceId', '=', order.serviceId)
        .where('version', '=', order.apiRegistrationVersion)
        .executeTakeFirst();
      return invocation.result;
    });
  }

  #fulfilledView(
    order: InvocationOrderSnapshot,
    tradeNo: string,
    serviceResult: Readonly<Record<string, unknown>>,
    alreadyFulfilled: boolean,
  ): Readonly<AggregatedFulfillment> {
    return Object.freeze({
      tradeNo,
      outTradeNo: order.outTradeNo,
      resourceId: order.resourceId,
      selectedServiceId: `svc_${order.serviceId}` as ResourceId<'svc'>,
      resolvedCategory: order.resolvedCategory,
      alreadyFulfilled,
      serviceResult,
    });
  }

  async #releaseExpiredReservations(): Promise<void> {
    const now = this.#now();
    await this.#database.transaction().execute(async (transaction) => {
      const expired = await transaction
        .selectFrom('merchantAdvances')
        .innerJoin('a2mOrders', 'a2mOrders.id', 'merchantAdvances.a2mOrderId')
        .select(['merchantAdvances.id', 'merchantAdvances.amountMinor'])
        .where('merchantAdvances.status', '=', 'reserved')
        .where('a2mOrders.orderStatus', '=', 'pending_payment')
        .where('a2mOrders.payBefore', '<=', now)
        .forUpdate('merchantAdvances')
        .execute();

      if (expired.length === 0) return;
      const total = expired
        .reduce((sum, advance) => sum + BigInt(advance.amountMinor), 0n)
        .toString();
      const funding = await transaction
        .updateTable('platformFundingAccounts')
        .set((expressions) => ({
          availableAmountMinor: expressions('availableAmountMinor', '+', total),
          reservedAmountMinor: expressions('reservedAmountMinor', '-', total),
          updatedAt: now,
        }))
        .where('currency', '=', 'CNY')
        .where('reservedAmountMinor', '>=', total)
        .returning('currency')
        .executeTakeFirst();

      if (funding === undefined) throw new Error('Platform funding reservation is inconsistent');
      await transaction
        .updateTable('merchantAdvances')
        .set({
          status: 'released',
          releasedAt: now,
          releaseReason: 'payment_window_expired',
          updatedAt: now,
        })
        .where(
          'id',
          'in',
          expired.map((advance) => advance.id),
        )
        .executeTakeFirst();
    });
  }
}
