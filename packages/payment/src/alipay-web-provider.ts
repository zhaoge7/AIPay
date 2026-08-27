import { TextDecoder } from 'node:util';

import { AlipaySdk } from 'alipay-sdk';

import { createMoney, formatUtcDateTime, type UtcDateTime } from '@aipay/contracts';

import {
  PaymentProviderError,
  type CreatePaymentRequest,
  type PaymentProvider,
  type ProviderPaymentResult,
  type ProviderRefundResult,
  type ProviderWebhookAcknowledgement,
  type ProviderWebhookEvent,
  type ProviderWebhookRequest,
} from './index.js';

const officialGateways = new Set([
  'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
  'https://openapi.alipay.com/gateway.do',
]);
const maximumAmountMinor = 10_000_000_000n;
const maximumNotificationAgeMs = 26 * 60 * 60 * 1_000;
const maximumFutureSkewMs = 5 * 60 * 1_000;

export interface AlipayWebPaymentProviderOptions {
  readonly appId: string;
  readonly sellerId: string;
  readonly privateKeyPkcs8Base64: string;
  readonly alipayPublicKeySpkiBase64: string;
  readonly gatewayUrl: string;
  readonly returnUrl?: string;
  readonly now?: () => Date;
}

function invalidWebhook(code: string): PaymentProviderError {
  return new PaymentProviderError({ provider: 'alipay_web', kind: 'invalid_webhook', code });
}

function regexGroup(match: RegExpExecArray, index: number, errorCode: string): string {
  const value = match[index];

  if (value === undefined) {
    throw invalidWebhook(errorCode);
  }

  return value;
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

function paymentIdFromOutTradeNo(value: string): string {
  if (!/^AIPAY[0-9A-F]{32}$/u.test(value)) {
    throw invalidWebhook('ORDER_MISMATCH');
  }

  return providerPaymentId(value);
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

function parseFormBody(body: Uint8Array): Readonly<Record<string, string>> {
  let decoded: string;

  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw invalidWebhook('MALFORMED_WEBHOOK');
  }

  if (body.byteLength === 0 || body.byteLength > 64 * 1_024) {
    throw invalidWebhook('MALFORMED_WEBHOOK');
  }

  const parameters = new URLSearchParams(decoded);
  const result: Record<string, string> = {};

  for (const [name, value] of parameters) {
    if (name.length === 0 || Object.hasOwn(result, name)) {
      throw invalidWebhook('MALFORMED_WEBHOOK');
    }

    result[name] = value;
  }

  return Object.freeze(result);
}

function requiredParameter(parameters: Readonly<Record<string, string>>, name: string): string {
  const value = parameters[name];

  if (value === undefined || value.length === 0) {
    throw invalidWebhook('MALFORMED_WEBHOOK');
  }

  return value;
}

function boundedParameter(
  parameters: Readonly<Record<string, string>>,
  name: string,
  maximumLength: number,
  pattern?: RegExp,
): string {
  const value = requiredParameter(parameters, name);

  if (value.length > maximumLength || (pattern !== undefined && !pattern.test(value))) {
    throw invalidWebhook('MALFORMED_WEBHOOK');
  }

  return value;
}

function notificationTime(value: string): UtcDateTime {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(value);

  if (match === null) {
    throw invalidWebhook('MALFORMED_WEBHOOK');
  }

  const year = regexGroup(match, 1, 'MALFORMED_WEBHOOK');
  const month = regexGroup(match, 2, 'MALFORMED_WEBHOOK');
  const day = regexGroup(match, 3, 'MALFORMED_WEBHOOK');
  const hour = regexGroup(match, 4, 'MALFORMED_WEBHOOK');
  const minute = regexGroup(match, 5, 'MALFORMED_WEBHOOK');
  const second = regexGroup(match, 6, 'MALFORMED_WEBHOOK');
  const timestamp = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour) - 8,
    Number(minute),
    Number(second),
  );
  const date = new Date(timestamp);
  const local = new Date(timestamp + 8 * 60 * 60 * 1_000);

  if (
    local.getUTCFullYear() !== Number(year) ||
    local.getUTCMonth() + 1 !== Number(month) ||
    local.getUTCDate() !== Number(day) ||
    local.getUTCHours() !== Number(hour) ||
    local.getUTCMinutes() !== Number(minute) ||
    local.getUTCSeconds() !== Number(second)
  ) {
    throw invalidWebhook('MALFORMED_WEBHOOK');
  }

  return formatUtcDateTime(date);
}

function notificationAmount(value: string) {
  const match = /^(0|[1-9]\d{0,8})\.(\d{2})$/u.exec(value);

  if (match === null) {
    throw invalidWebhook('AMOUNT_MISMATCH');
  }

  const yuan = regexGroup(match, 1, 'AMOUNT_MISMATCH');
  const cents = regexGroup(match, 2, 'AMOUNT_MISMATCH');
  return createMoney('CNY', (BigInt(yuan) * 100n + BigInt(cents)).toString());
}

function notificationStatus(value: string) {
  switch (value) {
    case 'WAIT_BUYER_PAY':
      return Object.freeze({ status: 'pending' as const, failureCode: null });
    case 'TRADE_SUCCESS':
    case 'TRADE_FINISHED':
      return Object.freeze({ status: 'succeeded' as const, failureCode: null });
    case 'TRADE_CLOSED':
      return Object.freeze({ status: 'failed' as const, failureCode: 'TRADE_CLOSED' });
    default:
      throw invalidWebhook('UNSUPPORTED_TRADE_STATUS');
  }
}

export class AlipayWebPaymentProvider implements PaymentProvider {
  readonly name = 'alipay_web';
  readonly capabilities = Object.freeze({
    supportsActiveQuery: false,
    supportsRefunds: false,
    supportsWebhookSignatures: true,
  });
  readonly #client: AlipaySdk;
  readonly #appId: string;
  readonly #sellerId: string;
  readonly #returnUrl: string | undefined;
  readonly #now: () => Date;

  constructor(options: AlipayWebPaymentProviderOptions) {
    if (!officialGateways.has(options.gatewayUrl)) {
      throw new Error('Alipay gateway must be an official endpoint');
    }

    this.#returnUrl = optionalHttpsUrl(options.returnUrl);
    this.#now = options.now ?? (() => new Date());
    this.#appId = options.appId;
    this.#sellerId = options.sellerId;
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

  async verifyWebhook(request: ProviderWebhookRequest): Promise<ProviderWebhookEvent> {
    await Promise.resolve();
    const contentType = Object.entries(request.headers).find(
      ([name]) => name.toLowerCase() === 'content-type',
    )?.[1];

    if (
      contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded'
    ) {
      throw invalidWebhook('INVALID_CONTENT_TYPE');
    }

    const parameters = parseFormBody(request.rawBody);

    if (
      parameters.sign_type !== 'RSA2' ||
      !this.#client.checkNotifySignV2(parameters) ||
      parameters.app_id !== this.#appId ||
      parameters.seller_id !== this.#sellerId ||
      parameters.notify_type !== 'trade_status_sync'
    ) {
      throw invalidWebhook('INVALID_SIGNATURE');
    }

    const outTradeNumber = boundedParameter(parameters, 'out_trade_no', 64, /^AIPAY[0-9A-F]{32}$/u);
    const state = notificationStatus(requiredParameter(parameters, 'trade_status'));
    const notifyTime = requiredParameter(parameters, 'notify_time');
    const notifiedAt = notificationTime(notifyTime);
    const receivedAt = new Date(request.receivedAt);
    const notificationAgeMs = receivedAt.getTime() - new Date(notifiedAt).getTime();

    if (
      !Number.isFinite(notificationAgeMs) ||
      notificationAgeMs > maximumNotificationAgeMs ||
      notificationAgeMs < -maximumFutureSkewMs
    ) {
      throw invalidWebhook('EXPIRED_WEBHOOK');
    }

    const occurredAt = notificationTime(parameters.gmt_payment ?? notifyTime);

    return Object.freeze({
      eventId: boundedParameter(parameters, 'notify_id', 128),
      eventType: 'payment.updated',
      providerPaymentId: paymentIdFromOutTradeNo(outTradeNumber),
      providerTransactionId: boundedParameter(parameters, 'trade_no', 64, /^\d{16,64}$/u),
      amount: notificationAmount(requiredParameter(parameters, 'total_amount')),
      status: state.status,
      occurredAt,
      failureCode: state.failureCode,
    });
  }

  acknowledgeWebhook(): ProviderWebhookAcknowledgement {
    return Object.freeze({
      statusCode: 200,
      headers: Object.freeze({ 'content-type': 'text/plain; charset=utf-8' }),
      body: 'success',
    });
  }
}
