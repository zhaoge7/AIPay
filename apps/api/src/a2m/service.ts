import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual } from 'node:crypto';

import { getResourceUuid, type ResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { A2MBillSigningInput, A2MPaymentVerification, AlipayA2MClient } from '@aipay/payment';
import { v7 as uuidv7 } from 'uuid';

import type { A2MRuntimeConfig } from './config.js';

const paymentWindowMs = 30 * 60 * 1_000;

export type A2MErrorCode =
  'service_unavailable' | 'invalid_payment_proof' | 'fulfillment_confirmation_failed';

export class A2MError extends Error {
  readonly code: A2MErrorCode;

  constructor(code: A2MErrorCode) {
    super('A2M payment operation failed');
    this.name = 'A2MError';
    this.code = code;
  }
}

export interface A2MClientPort {
  readonly appId: string;
  readonly sellerId: string;
  readonly sellerName: string;
  readonly serviceId: string;
  readonly sandbox: boolean;
  signBill(input: A2MBillSigningInput): string;
  verifyPaymentProof(input: {
    readonly tradeNo: string;
    readonly paymentProof: string;
    readonly clientSession?: string;
  }): Promise<Readonly<A2MPaymentVerification>>;
  confirmFulfillment(tradeNo: string): Promise<boolean>;
}

export interface A2MPaymentRequired {
  readonly headerValue: string;
  readonly outTradeNo: string;
  readonly amount: string;
  readonly currency: 'CNY';
  readonly goodsName: string;
}

export interface A2MFulfilledResource {
  readonly tradeNo: string;
  readonly outTradeNo: string;
  readonly resourceId: string;
  readonly alreadyFulfilled: boolean;
  readonly serviceResult: Readonly<Record<string, unknown>>;
}

interface DecodedPaymentProof {
  readonly paymentProof: string;
  readonly tradeNo: string;
  readonly clientSession: string | undefined;
}

function amountInYuan(amountMinor: string): string {
  const amount = BigInt(amountMinor);
  return `${(amount / 100n).toString()}.${(amount % 100n).toString().padStart(2, '0')}`;
}

function normalizeYuan(value: string): string | null {
  const match = /^(0|[1-9]\d{0,8})(?:\.(\d{1,2}))?$/u.exec(value);

  if (match?.[1] === undefined) {
    return null;
  }

  return `${BigInt(match[1]).toString()}.${(match[2] ?? '').padEnd(2, '0')}`;
}

function chinaIso(date: Date): string {
  const local = new Date(date.getTime() + 8 * 60 * 60 * 1_000);
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${local.getUTCFullYear().toString()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}+08:00`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function requiredProofString(
  value: Readonly<Record<string, unknown>>,
  name: string,
  pattern: RegExp,
): string {
  const field = value[name];

  if (typeof field !== 'string' || !pattern.test(field)) {
    throw new A2MError('invalid_payment_proof');
  }

  return field;
}

function decodePaymentProof(value: string): Readonly<DecodedPaymentProof> {
  if (value.length < 16 || value.length > 16_384) {
    throw new A2MError('invalid_payment_proof');
  }

  let parsed: unknown;

  try {
    const isBase64Url = /^[A-Za-z0-9_-]+$/u.test(value);
    const isBase64 = /^[A-Za-z0-9+/]+={0,2}$/u.test(value) && value.length % 4 === 0;

    if (!isBase64Url && !isBase64) {
      throw new Error('invalid encoding');
    }

    const encoding = isBase64Url ? 'base64url' : 'base64';
    const bytes = Buffer.from(value, encoding);

    if (bytes.toString(encoding) !== value) {
      throw new Error('non-canonical');
    }

    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new A2MError('invalid_payment_proof');
  }

  const root = objectValue(parsed);
  const protocol = objectValue(root?.protocol);
  const method = objectValue(root?.method);

  if (root === null || protocol === null || method === null) {
    throw new A2MError('invalid_payment_proof');
  }

  const clientSession = method.client_session;

  if (
    clientSession !== undefined &&
    (typeof clientSession !== 'string' || clientSession.length > 1_024)
  ) {
    throw new A2MError('invalid_payment_proof');
  }

  return Object.freeze({
    paymentProof: requiredProofString(protocol, 'payment_proof', /^[\x21-\x7e]{1,4096}$/u),
    tradeNo: requiredProofString(protocol, 'trade_no', /^\d{16,64}$/u),
    clientSession,
  });
}

function proofHash(paymentProof: string): Buffer {
  return createHash('sha256').update(paymentProof, 'utf8').digest();
}

export class A2MService {
  readonly #database: Database;
  readonly #client: A2MClientPort;
  readonly #config: Readonly<A2MRuntimeConfig>;
  readonly #now: () => Date;

  constructor(
    database: Database,
    client: AlipayA2MClient | A2MClientPort,
    config: Readonly<A2MRuntimeConfig>,
    now: () => Date = () => new Date(),
  ) {
    this.#database = database;
    this.#client = client;
    this.#config = config;
    this.#now = now;
  }

  async createPaymentRequired(serviceId: ResourceId<'svc'>): Promise<Readonly<A2MPaymentRequired>> {
    const service = await this.#database
      .selectFrom('services')
      .innerJoin('merchants', 'merchants.id', 'services.merchantId')
      .select([
        'services.id',
        'services.merchantId',
        'services.name',
        'services.currency',
        'services.unitPriceAmountMinor',
        'services.status as serviceStatus',
        'merchants.status as merchantStatus',
      ])
      .where('services.id', '=', getResourceUuid(serviceId))
      .executeTakeFirst();

    if (
      service?.serviceStatus !== 'enabled' ||
      service.merchantStatus !== 'active' ||
      (this.#config.merchantId !== null &&
        service.merchantId !== getResourceUuid(this.#config.merchantId))
    ) {
      throw new A2MError('service_unavailable');
    }

    const now = this.#now();
    const payBefore = new Date(now.getTime() + paymentWindowMs);
    const outTradeNo = `A2M${uuidv7().replaceAll('-', '').toUpperCase()}`;
    const amount = amountInYuan(service.unitPriceAmountMinor);
    const resourceId = `/v1/a2m/resources/${serviceId}`;
    const signingInput: A2MBillSigningInput = {
      amount,
      currency: 'CNY',
      goods_name: service.name,
      out_trade_no: outTradeNo,
      pay_before: chinaIso(payBefore),
      resource_id: resourceId,
      seller_id: this.#client.sellerId,
      service_id: this.#client.serviceId,
    };
    const sellerSignature = this.#client.signBill(signingInput);
    await this.#database
      .insertInto('a2mOrders')
      .values({
        outTradeNo,
        merchantId: service.merchantId,
        serviceId: service.id,
        amountMinor: service.unitPriceAmountMinor,
        resourceId,
        goodsName: service.name,
        payBefore,
        providerTradeNo: null,
        paymentProofHash: null,
        serviceResult: null,
        fulfillmentErrorCode: null,
        fulfilledAt: null,
      })
      .executeTakeFirstOrThrow();
    const paymentNeeded = {
      protocol: {
        out_trade_no: outTradeNo,
        amount,
        currency: 'CNY',
        resource_id: resourceId,
        pay_before: signingInput.pay_before,
        seller_signature: sellerSignature,
        seller_sign_type: 'RSA2',
        seller_unique_id: this.#client.sellerId,
      },
      method: {
        seller_name: this.#client.sellerName,
        seller_id: this.#client.sellerId,
        seller_app_id: this.#client.appId,
        goods_name: service.name,
        seller_unique_id_key: 'seller_id',
        service_id: this.#client.serviceId,
      },
    };
    return Object.freeze({
      headerValue: base64UrlJson(paymentNeeded),
      outTradeNo,
      amount,
      currency: 'CNY',
      goodsName: service.name,
    });
  }

  async verifyAndFulfill(
    serviceId: ResourceId<'svc'>,
    encodedPaymentProof: string,
  ): Promise<Readonly<A2MFulfilledResource>> {
    const decoded = decodePaymentProof(encodedPaymentProof);
    const verification = await this.#client.verifyPaymentProof({
      tradeNo: decoded.tradeNo,
      paymentProof: decoded.paymentProof,
      ...(decoded.clientSession === undefined ? {} : { clientSession: decoded.clientSession }),
    });

    if (
      !verification.accepted ||
      !verification.active ||
      verification.tradeNo !== decoded.tradeNo ||
      verification.outTradeNo.length === 0
    ) {
      throw new A2MError('invalid_payment_proof');
    }

    const order = await this.#database
      .selectFrom('a2mOrders')
      .selectAll()
      .where('outTradeNo', '=', verification.outTradeNo)
      .executeTakeFirst();

    if (order === undefined) {
      throw new A2MError('invalid_payment_proof');
    }

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

    if (
      order.serviceId !== getResourceUuid(serviceId) ||
      observedAmount !== amountInYuan(order.amountMinor) ||
      observedResource !== order.resourceId
    ) {
      throw new A2MError('invalid_payment_proof');
    }

    const prepared = await this.#prepareFulfillment(
      order.outTradeNo,
      decoded.tradeNo,
      proofHash(decoded.paymentProof),
    );

    if (prepared.alreadyFulfilled) {
      return prepared;
    }

    if (!(await this.#client.confirmFulfillment(decoded.tradeNo))) {
      await this.#database
        .updateTable('a2mOrders')
        .set({ fulfillmentErrorCode: 'FULFILLMENT_CONFIRM_FAILED', updatedAt: this.#now() })
        .where('outTradeNo', '=', order.outTradeNo)
        .where('providerTradeNo', '=', decoded.tradeNo)
        .where('fulfillmentStatus', '=', 'pending_confirm')
        .executeTakeFirstOrThrow();
      throw new A2MError('fulfillment_confirmation_failed');
    }

    const fulfilledAt = this.#now();
    await this.#database
      .updateTable('a2mOrders')
      .set({
        fulfillmentStatus: 'fulfilled',
        fulfillmentErrorCode: null,
        fulfilledAt,
        updatedAt: fulfilledAt,
      })
      .where('outTradeNo', '=', order.outTradeNo)
      .where('providerTradeNo', '=', decoded.tradeNo)
      .where('fulfillmentStatus', '=', 'pending_confirm')
      .executeTakeFirstOrThrow();
    return Object.freeze({ ...prepared, alreadyFulfilled: false });
  }

  async #prepareFulfillment(
    outTradeNo: string,
    tradeNo: string,
    paymentProofHash: Buffer,
  ): Promise<Readonly<A2MFulfilledResource>> {
    const now = this.#now();

    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const order = await transaction
          .selectFrom('a2mOrders')
          .innerJoin('services', 'services.id', 'a2mOrders.serviceId')
          .select([
            'a2mOrders.id',
            'a2mOrders.outTradeNo',
            'a2mOrders.serviceId',
            'a2mOrders.resourceId',
            'a2mOrders.payBefore',
            'a2mOrders.orderStatus',
            'a2mOrders.fulfillmentStatus',
            'a2mOrders.providerTradeNo',
            'a2mOrders.paymentProofHash',
            'a2mOrders.serviceResult',
            'services.name as serviceName',
            'services.category',
            'services.unit',
          ])
          .where('a2mOrders.outTradeNo', '=', outTradeNo)
          .forUpdate('a2mOrders')
          .executeTakeFirstOrThrow();

        if (order.fulfillmentStatus === 'fulfilled') {
          if (
            order.providerTradeNo !== tradeNo ||
            order.paymentProofHash === null ||
            !timingSafeEqual(order.paymentProofHash, paymentProofHash)
          ) {
            throw new A2MError('invalid_payment_proof');
          }

          const result = objectValue(order.serviceResult);

          if (result === null) {
            throw new Error('Fulfilled A2M order has no resource');
          }

          return Object.freeze({
            tradeNo,
            outTradeNo,
            resourceId: order.resourceId,
            alreadyFulfilled: true,
            serviceResult: result,
          });
        }

        if (order.fulfillmentStatus === 'pending_confirm') {
          if (
            order.providerTradeNo !== tradeNo ||
            order.paymentProofHash === null ||
            !timingSafeEqual(order.paymentProofHash, paymentProofHash)
          ) {
            throw new A2MError('invalid_payment_proof');
          }

          const result = objectValue(order.serviceResult);

          if (result === null) {
            throw new Error('Pending A2M fulfillment has no resource');
          }

          return Object.freeze({
            tradeNo,
            outTradeNo,
            resourceId: order.resourceId,
            alreadyFulfilled: false,
            serviceResult: result,
          });
        }

        if (order.orderStatus !== 'pending_payment' || now >= order.payBefore) {
          throw new A2MError('invalid_payment_proof');
        }

        const serviceResult = Object.freeze({
          accessGranted: true,
          serviceId: `svc_${order.serviceId}`,
          serviceName: order.serviceName,
          category: order.category,
          unit: order.unit,
          resourceId: order.resourceId,
          generatedAt: chinaIso(now),
        });
        await transaction
          .updateTable('a2mOrders')
          .set({
            orderStatus: 'paid',
            fulfillmentStatus: 'pending_confirm',
            providerTradeNo: tradeNo,
            paymentProofHash,
            serviceResult,
            fulfillmentErrorCode: null,
            updatedAt: now,
          })
          .where('id', '=', order.id)
          .executeTakeFirstOrThrow();
        return Object.freeze({
          tradeNo,
          outTradeNo,
          resourceId: order.resourceId,
          alreadyFulfilled: false,
          serviceResult,
        });
      });
    } catch (error) {
      if (
        error instanceof A2MError ||
        (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
      ) {
        throw new A2MError('invalid_payment_proof');
      }

      throw error;
    }
  }
}
