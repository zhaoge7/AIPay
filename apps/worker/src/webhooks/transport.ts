import { Buffer } from 'node:buffer';
import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';

import ipaddr from 'ipaddr.js';

export interface WebhookTransportRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface WebhookTransportResponse {
  readonly statusCode: number;
}

export interface WebhookTransport {
  deliver(request: WebhookTransportRequest): Promise<Readonly<WebhookTransportResponse>>;
}

export class WebhookTransportError extends Error {
  readonly code: 'INVALID_TARGET' | 'TIMEOUT' | 'NETWORK_ERROR';

  constructor(code: WebhookTransportError['code']) {
    super('Webhook transport failed');
    this.name = 'WebhookTransportError';
    this.code = code;
  }
}

export interface SafeWebhookTransportOptions {
  readonly allowLoopbackHttp?: boolean;
  readonly timeoutMs?: number;
}

function addressRange(address: string) {
  const parsed = ipaddr.process(address);
  return parsed.range();
}

function isAllowedRange(range: string, allowLoopback: boolean): boolean {
  return range === 'unicast' || (allowLoopback && range === 'loopback');
}

export class SafeWebhookTransport implements WebhookTransport {
  readonly #allowLoopbackHttp: boolean;
  readonly #timeoutMs: number;

  constructor(options: SafeWebhookTransportOptions = {}) {
    this.#allowLoopbackHttp = options.allowLoopbackHttp ?? false;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
  }

  async deliver(request: WebhookTransportRequest): Promise<Readonly<WebhookTransportResponse>> {
    let target: URL;

    try {
      target = new URL(request.url);
    } catch {
      throw new WebhookTransportError('INVALID_TARGET');
    }

    if (
      (target.protocol !== 'https:' && target.protocol !== 'http:') ||
      target.username.length > 0 ||
      target.password.length > 0 ||
      target.hash.length > 0
    ) {
      throw new WebhookTransportError('INVALID_TARGET');
    }

    const hostname = target.hostname.replace(/^\[|\]$/gu, '');
    let addresses: LookupAddress[];

    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new WebhookTransportError('NETWORK_ERROR');
    }

    if (addresses.length === 0) {
      throw new WebhookTransportError('NETWORK_ERROR');
    }

    const ranges = addresses.map(({ address }) => addressRange(address));
    const isLoopbackOnly = ranges.every((range) => range === 'loopback');

    if (
      !ranges.every((range) => isAllowedRange(range, this.#allowLoopbackHttp)) ||
      (target.protocol === 'http:' && !(this.#allowLoopbackHttp && isLoopbackOnly))
    ) {
      throw new WebhookTransportError('INVALID_TARGET');
    }

    const [selected] = addresses;

    if (selected === undefined) {
      throw new WebhookTransportError('NETWORK_ERROR');
    }

    const body = Buffer.from(request.body);
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
            ...request.headers,
            host: target.host,
            'content-length': String(body.byteLength),
          },
          timeout: this.#timeoutMs,
        },
        (response) => {
          response.resume();
          response.once('end', () => {
            resolve(Object.freeze({ statusCode: response.statusCode ?? 0 }));
          });
        },
      );
      outbound.once('timeout', () => {
        outbound.destroy(new WebhookTransportError('TIMEOUT'));
      });
      outbound.once('error', (error) => {
        reject(
          error instanceof WebhookTransportError
            ? error
            : new WebhookTransportError('NETWORK_ERROR'),
        );
      });
      outbound.end(body);
    });
  }
}
