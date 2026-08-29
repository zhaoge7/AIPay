import { Buffer } from 'node:buffer';
import { createPrivateKey, createSign, type KeyObject } from 'node:crypto';

import { AlipaySdk } from 'alipay-sdk';

import { PaymentProviderError } from './index.js';

const officialGateways = new Set([
  'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
  'https://openapi.alipay.com/gateway.do',
]);

interface AlipayA2MSdkPort {
  exec(
    method: string,
    parameters: Readonly<Record<string, unknown>>,
    options?: Readonly<{ validateSign: boolean }>,
  ): Promise<Readonly<Record<string, unknown>>>;
}

export interface AlipayA2MClientOptions {
  readonly appId: string;
  readonly privateKeyPkcs1Base64: string;
  readonly alipayPublicKeySpkiBase64: string;
  readonly gatewayUrl: string;
  readonly sellerId: string;
  readonly sellerName: string;
  readonly serviceId: string;
  readonly sandbox: boolean;
}

export interface A2MBillSigningInput {
  readonly amount: string;
  readonly currency: 'CNY';
  readonly goods_name: string;
  readonly out_trade_no: string;
  readonly pay_before: string;
  readonly resource_id: string;
  readonly seller_id: string;
  readonly service_id: string;
}

export interface A2MPaymentVerification {
  readonly accepted: boolean;
  readonly active: boolean;
  readonly tradeNo: string;
  readonly outTradeNo: string;
  readonly amount: string;
  readonly resourceId: string;
}

function responseRecord(response: Readonly<Record<string, unknown>>) {
  const nested =
    response.alipay_aipay_agent_payment_verify_response ??
    response.alipayAipayAgentPaymentVerifyResponse;
  return typeof nested === 'object' && nested !== null
    ? (nested as Readonly<Record<string, unknown>>)
    : response;
}

function stringField(value: Readonly<Record<string, unknown>>, ...names: string[]): string {
  for (const name of names) {
    const field = value[name];

    if (typeof field === 'string') {
      return field;
    }
  }

  return '';
}

export class AlipayA2MClient {
  readonly #options: Readonly<AlipayA2MClientOptions>;
  readonly #sdk: AlipayA2MSdkPort;
  readonly #sellerPrivateKey: KeyObject;

  constructor(options: AlipayA2MClientOptions, sdk?: AlipayA2MSdkPort) {
    if (!officialGateways.has(options.gatewayUrl)) {
      throw new Error('Alipay A2M gateway must be official');
    }

    if (options.sandbox !== options.gatewayUrl.includes('sandbox')) {
      throw new Error('Alipay A2M mode and gateway mismatch');
    }

    if (options.sandbox && options.serviceId !== 'api_mock_service_id') {
      throw new Error('Alipay A2M sandbox service ID is invalid');
    }

    if (!options.sandbox && options.serviceId === 'api_mock_service_id') {
      throw new Error('Alipay A2M mock service ID is forbidden in production');
    }

    try {
      this.#sellerPrivateKey = createPrivateKey({
        key: Buffer.from(options.privateKeyPkcs1Base64, 'base64'),
        format: 'der',
        type: 'pkcs1',
      });
    } catch {
      throw new Error('Alipay A2M private key must be PKCS1');
    }

    this.#options = Object.freeze({ ...options });
    this.#sdk =
      sdk ??
      new AlipaySdk({
        appId: options.appId,
        privateKey: options.privateKeyPkcs1Base64,
        alipayPublicKey: options.alipayPublicKeySpkiBase64,
        gateway: options.gatewayUrl,
        keyType: 'PKCS1',
        signType: 'RSA2',
        camelcase: true,
        timeout: 30_000,
      });
  }

  get appId(): string {
    return this.#options.appId;
  }

  get sellerId(): string {
    return this.#options.sellerId;
  }

  get sellerName(): string {
    return this.#options.sellerName;
  }

  get serviceId(): string {
    return this.#options.serviceId;
  }

  get sandbox(): boolean {
    return this.#options.sandbox;
  }

  signBill(input: A2MBillSigningInput): string {
    const content = Object.entries(input)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${String(value)}`)
      .join('&');
    return createSign('RSA-SHA256').update(content, 'utf8').sign(this.#sellerPrivateKey, 'base64');
  }

  async verifyPaymentProof(input: {
    readonly tradeNo: string;
    readonly paymentProof: string;
    readonly clientSession?: string;
  }): Promise<Readonly<A2MPaymentVerification>> {
    let response: Readonly<Record<string, unknown>>;

    try {
      response = await this.#sdk.exec(
        'alipay.aipay.agent.payment.verify',
        {
          bizContent: {
            tradeNo: input.tradeNo,
            paymentProof: input.paymentProof,
            ...(input.clientSession === undefined ? {} : { clientSession: input.clientSession }),
          },
        },
        { validateSign: true },
      );
    } catch {
      throw new PaymentProviderError({
        provider: 'alipay_a2m',
        kind: 'retryable',
        code: 'A2M_VERIFY_UNAVAILABLE',
      });
    }

    const data = responseRecord(response);
    const code = data.code;
    const accepted = code === '10000' || code === 10000;
    return Object.freeze({
      accepted,
      active: data.active === true,
      tradeNo: stringField(data, 'tradeNo', 'trade_no'),
      outTradeNo: stringField(data, 'outTradeNo', 'out_trade_no'),
      amount: stringField(data, 'amount'),
      resourceId: stringField(data, 'resourceId', 'resource_id'),
    });
  }

  async confirmFulfillment(tradeNo: string): Promise<boolean> {
    if (tradeNo.length === 0) {
      return false;
    }

    try {
      const response = await this.#sdk.exec(
        'alipay.aipay.agent.fulfillment.confirm',
        { bizContent: { tradeNo } },
        { validateSign: true },
      );
      const nested =
        response.alipay_aipay_agent_fulfillment_confirm_response ??
        response.alipayAipayAgentFulfillmentConfirmResponse;
      const data =
        typeof nested === 'object' && nested !== null
          ? (nested as Readonly<Record<string, unknown>>)
          : response;
      return data.code === '10000' || data.code === 10000;
    } catch {
      return false;
    }
  }
}
