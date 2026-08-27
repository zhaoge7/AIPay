import { AlipaySdk } from 'alipay-sdk';

import { formatUtcDateTime } from '@aipay/contracts';

import {
  PaymentProviderError,
  type CreatePaymentRequest,
  type PaymentProvider,
  type ProviderPaymentResult,
  type ProviderRefundResult,
  type ProviderWebhookAcknowledgement,
  type ProviderWebhookEvent,
} from './index.js';

const officialGateways = new Set([
  'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
  'https://openapi.alipay.com/gateway.do',
]);
const maximumAmountMinor = 10_000_000_000n;

export interface AlipayWebPaymentProviderOptions {
  readonly appId: string;
  readonly privateKeyPkcs8Base64: string;
  readonly alipayPublicKeySpkiBase64: string;
  readonly gatewayUrl: string;
  readonly returnUrl?: string;
  readonly now?: () => Date;
}

function unavailable(operation: string): PaymentProviderError {
  return new PaymentProviderError({
    provider: 'alipay_web',
    kind: 'fatal',
    code: `${operation}_NOT_AVAILABLE`,
  });
}

function outTradeNo(paymentAttemptId: string): string {
  return `AIPAY${paymentAttemptId.slice(4).replaceAll('-', '').toUpperCase()}`;
}

function providerPaymentId(outTradeNumber: string): string {
  return `alipay_out_${outTradeNumber}`;
}

function amountInYuan(amountMinor: string): string {
  const amount = BigInt(amountMinor);

  if (amount < 1n || amount > maximumAmountMinor) {
    throw new PaymentProviderError({
      provider: 'alipay_web',
      kind: 'invalid_request',
      code: 'INVALID_AMOUNT',
    });
  }

  return `${(amount / 100n).toString()}.${(amount % 100n).toString().padStart(2, '0')}`;
}

function subject(description: string): string {
  const normalized = description.replace(/[&/=]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return normalized.length === 0 ? 'AIPay payment' : normalized.slice(0, 256);
}

function assertCnyCurrency(currency: string): void {
  if (currency !== 'CNY') {
    throw new PaymentProviderError({
      provider: 'alipay_web',
      kind: 'invalid_request',
      code: 'UNSUPPORTED_CURRENCY',
    });
  }
}

function optionalHttpsUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const parsed = new URL(value);

    if (
      parsed.protocol !== 'https:' ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.hash.length > 0
    ) {
      throw new Error('invalid');
    }

    return parsed.href;
  } catch {
    throw new Error('Alipay return URL must be HTTPS');
  }
}

export class AlipayWebPaymentProvider implements PaymentProvider {
  readonly name = 'alipay_web';
  readonly capabilities = Object.freeze({
    supportsActiveQuery: false,
    supportsRefunds: false,
    supportsWebhookSignatures: false,
  });
  readonly #client: AlipaySdk;
  readonly #returnUrl: string | undefined;
  readonly #now: () => Date;

  constructor(options: AlipayWebPaymentProviderOptions) {
    if (!officialGateways.has(options.gatewayUrl)) {
      throw new Error('Alipay gateway must be an official endpoint');
    }

    this.#returnUrl = optionalHttpsUrl(options.returnUrl);
    this.#now = options.now ?? (() => new Date());
    this.#client = new AlipaySdk({
      appId: options.appId,
      privateKey: options.privateKeyPkcs8Base64,
      alipayPublicKey: options.alipayPublicKeySpkiBase64,
      gateway: options.gatewayUrl,
      keyType: 'PKCS8',
      signType: 'RSA2',
      camelcase: true,
    });
  }

  async createPayment(request: CreatePaymentRequest): Promise<Readonly<ProviderPaymentResult>> {
    await Promise.resolve();

    assertCnyCurrency(request.amount.currency);

    const orderNumber = outTradeNo(request.paymentAttemptId);
    const actionUrl = this.#client.pageExec('alipay.trade.page.pay', 'GET', {
      notifyUrl: request.callbackUrl,
      ...(this.#returnUrl === undefined ? {} : { returnUrl: this.#returnUrl }),
      bizContent: {
        outTradeNo: orderNumber,
        totalAmount: amountInYuan(request.amount.amountMinor),
        subject: subject(request.description),
        productCode: 'FAST_INSTANT_TRADE_PAY',
      },
    });
    const target = new URL(actionUrl);

    if (!officialGateways.has(`${target.origin}${target.pathname}`)) {
      throw new PaymentProviderError({
        provider: this.name,
        kind: 'fatal',
        code: 'INVALID_ACTION_URL',
      });
    }

    return Object.freeze({
      providerPaymentId: providerPaymentId(orderNumber),
      status: 'pending',
      occurredAt: formatUtcDateTime(this.#now()),
      failureCode: null,
      action: Object.freeze({ type: 'redirect', method: 'GET', url: actionUrl }),
    });
  }

  async queryPayment(): Promise<Readonly<ProviderPaymentResult>> {
    await Promise.resolve();
    throw unavailable('QUERY_PAYMENT');
  }

  async createRefund(): Promise<Readonly<ProviderRefundResult>> {
    await Promise.resolve();
    throw unavailable('CREATE_REFUND');
  }

  async queryRefund(): Promise<Readonly<ProviderRefundResult>> {
    await Promise.resolve();
    throw unavailable('QUERY_REFUND');
  }

  async verifyWebhook(): Promise<ProviderWebhookEvent> {
    await Promise.resolve();
    throw new PaymentProviderError({
      provider: this.name,
      kind: 'invalid_webhook',
      code: 'WEBHOOK_NOT_AVAILABLE',
    });
  }

  acknowledgeWebhook(): ProviderWebhookAcknowledgement {
    return Object.freeze({
      statusCode: 503,
      headers: Object.freeze({ 'content-type': 'text/plain; charset=utf-8' }),
      body: 'failure',
    });
  }
}
