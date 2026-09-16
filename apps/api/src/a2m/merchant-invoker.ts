import { Buffer } from 'node:buffer';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';

import { parseResourceId, type ResourceId } from '@aipay/contracts';
import ipaddr from 'ipaddr.js';

const signatureDomain = Buffer.from('AIPAY-MERCHANT-INVOKE-V1\0', 'utf8');
const maximumResponseBytes = 1_048_576;

export type MerchantInvocationErrorCode =
  'INVALID_TARGET' | 'TIMEOUT' | 'NETWORK_ERROR' | 'MERCHANT_REJECTED' | 'INVALID_RESPONSE';

export class MerchantInvocationError extends Error {
  readonly code: MerchantInvocationErrorCode;
  readonly latencyMs: number;

  constructor(code: MerchantInvocationErrorCode, latencyMs = 0) {
    super('Merchant API invocation failed');
    this.name = 'MerchantInvocationError';
    this.code = code;
    this.latencyMs = latencyMs;
  }
}

export interface MerchantApiInvocation {
  readonly outTradeNo: string;
  readonly serviceId: ResourceId<'svc'>;
  readonly category: string;
  readonly intent: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly endpointUrl: string;
  readonly timeoutMs: number;
}

export interface MerchantApiInvocationResult {
  readonly result: Readonly<Record<string, unknown>>;
  readonly latencyMs: number;
}

export interface MerchantApiInvokerPort {
  invoke(input: Readonly<MerchantApiInvocation>): Promise<Readonly<MerchantApiInvocationResult>>;
}

export class MerchantInvocationSigner {
  readonly #keyId: ResourceId<'key'>;
  readonly #privateKey: KeyObject;

  constructor(keyId: string, privateKeyPkcs8Base64: string) {
    this.#keyId = parseResourceId(keyId, 'key');
    this.#privateKey = createPrivateKey({
      key: Buffer.from(privateKeyPkcs8Base64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });

    if (this.#privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('Merchant invocation signing key must be Ed25519');
    }
  }

  headers(
    outTradeNo: string,
    body: Uint8Array,
    now = new Date(),
  ): Readonly<Record<string, string>> {
    const timestamp = Math.floor(now.getTime() / 1_000).toString();
    const signingBytes = Buffer.concat([
      signatureDomain,
      Buffer.from(outTradeNo, 'utf8'),
      Buffer.from('\n', 'utf8'),
      Buffer.from(timestamp, 'utf8'),
      Buffer.from('\n', 'utf8'),
      Buffer.from(body),
    ]);
    const signature = sign(null, signingBytes, this.#privateKey).toString('base64url');
    return Object.freeze({
      'x-aipay-invocation-id': outTradeNo,
      'x-aipay-key-id': this.#keyId,
      'x-aipay-timestamp': timestamp,
      'x-aipay-signature': `ed25519=:${signature}:`,
    });
  }
}

export interface HttpMerchantApiInvokerOptions {
  readonly allowLoopbackHttp?: boolean;
  readonly maximumResponseBytes?: number;
  readonly now?: () => Date;
}

function isAllowedRange(range: string, allowLoopback: boolean): boolean {
  return range === 'unicast' || (allowLoopback && range === 'loopback');
}

function responseRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export class HttpMerchantApiInvoker implements MerchantApiInvokerPort {
  readonly #signer: MerchantInvocationSigner;
  readonly #allowLoopbackHttp: boolean;
  readonly #maximumResponseBytes: number;
  readonly #now: () => Date;

  constructor(signer: MerchantInvocationSigner, options: HttpMerchantApiInvokerOptions = {}) {
    this.#signer = signer;
    this.#allowLoopbackHttp = options.allowLoopbackHttp ?? false;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? maximumResponseBytes;
    this.#now = options.now ?? (() => new Date());

    if (
      !Number.isInteger(this.#maximumResponseBytes) ||
      this.#maximumResponseBytes < 1_024 ||
      this.#maximumResponseBytes > 10 * 1_024 * 1_024
    ) {
      throw new Error('Merchant invocation response limit is invalid');
    }
  }

  async invoke(
    input: Readonly<MerchantApiInvocation>,
  ): Promise<Readonly<MerchantApiInvocationResult>> {
    const startedAt = this.#now().getTime();
    let target: URL;

    try {
      target = new URL(input.endpointUrl);
    } catch {
      throw new MerchantInvocationError('INVALID_TARGET');
    }

    if (
      (target.protocol !== 'https:' && target.protocol !== 'http:') ||
      target.username.length > 0 ||
      target.password.length > 0 ||
      target.hash.length > 0
    ) {
      throw new MerchantInvocationError('INVALID_TARGET');
    }

    const hostname = target.hostname.replace(/^\[|\]$/gu, '');
    let addresses: LookupAddress[];

    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new MerchantInvocationError('NETWORK_ERROR', this.#now().getTime() - startedAt);
    }

    let ranges: string[];

    try {
      ranges = addresses.map(({ address }) => ipaddr.process(address).range());
    } catch {
      throw new MerchantInvocationError('INVALID_TARGET', this.#now().getTime() - startedAt);
    }

    const loopbackOnly = ranges.length > 0 && ranges.every((range) => range === 'loopback');

    if (
      ranges.length === 0 ||
      !ranges.every((range) => isAllowedRange(range, this.#allowLoopbackHttp)) ||
      (target.protocol === 'http:' && !(this.#allowLoopbackHttp && loopbackOnly))
    ) {
      throw new MerchantInvocationError('INVALID_TARGET', this.#now().getTime() - startedAt);
    }

    const selected = addresses[0];

    if (selected === undefined) {
      throw new MerchantInvocationError('NETWORK_ERROR', this.#now().getTime() - startedAt);
    }

    const body = Buffer.from(
      JSON.stringify({
        schemaVersion: '1',
        invocationId: input.outTradeNo,
        serviceId: input.serviceId,
        category: input.category,
        intent: input.intent,
        parameters: input.parameters,
      }),
      'utf8',
    );
    const headers = this.#signer.headers(input.outTradeNo, body, this.#now());
    const transport = target.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const outbound = transport.request(
        {
          protocol: target.protocol,
          hostname: selected.address,
          family: selected.family,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: 'POST',
          servername: target.protocol === 'https:' ? hostname : undefined,
          headers: {
            ...headers,
            host: target.host,
            accept: 'application/json',
            'content-type': 'application/json',
            'content-length': String(body.byteLength),
          },
          timeout: input.timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;

          response.on('data', (chunk: Buffer) => {
            size += chunk.byteLength;

            if (size > this.#maximumResponseBytes) {
              response.destroy(new MerchantInvocationError('INVALID_RESPONSE'));
              return;
            }

            chunks.push(Buffer.from(chunk));
          });
          response.once('error', () => {
            reject(
              new MerchantInvocationError('INVALID_RESPONSE', this.#now().getTime() - startedAt),
            );
          });
          response.once('end', () => {
            const latencyMs = Math.max(0, this.#now().getTime() - startedAt);

            if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
              reject(new MerchantInvocationError('MERCHANT_REJECTED', latencyMs));
              return;
            }

            let parsed: unknown;

            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch {
              reject(new MerchantInvocationError('INVALID_RESPONSE', latencyMs));
              return;
            }

            const result = responseRecord(parsed);

            if (result === null) {
              reject(new MerchantInvocationError('INVALID_RESPONSE', latencyMs));
              return;
            }

            resolve(Object.freeze({ result: Object.freeze({ ...result }), latencyMs }));
          });
        },
      );
      outbound.once('timeout', () => {
        outbound.destroy(new MerchantInvocationError('TIMEOUT'));
      });
      outbound.once('error', (error) => {
        reject(
          error instanceof MerchantInvocationError
            ? new MerchantInvocationError(error.code, this.#now().getTime() - startedAt)
            : new MerchantInvocationError('NETWORK_ERROR', this.#now().getTime() - startedAt),
        );
      });
      outbound.end(body);
    });
  }
}
