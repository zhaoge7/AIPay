import { Buffer } from 'node:buffer';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import {
  parsePaymentProof,
  parseResourceId,
  toPaymentProofWire,
  type PaymentProofWire,
  type ResourceId,
} from '@aipay/contracts';
import * as z from 'zod/v4';

const utcPattern = /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
const resumePayloadSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  kind: z.literal('resume'),
  paymentAttemptId: z.string(),
  transactionId: z.string(),
  resourceUrl: z.url(),
  expiresAt: z.string().regex(utcPattern),
});
const deliveryPayloadSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  kind: z.literal('delivery'),
  paymentProof: z.unknown(),
  resourceUrl: z.url(),
  expiresAt: z.string().regex(utcPattern),
});

export interface ResumeTokenPayload {
  readonly kind: 'resume';
  readonly paymentAttemptId: ResourceId<'pat'>;
  readonly transactionId: ResourceId<'txn'>;
  readonly resourceUrl: string;
  readonly expiresAt: string;
}

export interface DeliveryTokenPayload {
  readonly kind: 'delivery';
  readonly paymentProof: Readonly<PaymentProofWire>;
  readonly resourceUrl: string;
  readonly expiresAt: string;
}

export class BridgeTokenError extends Error {
  constructor() {
    super('Agent bridge token is invalid');
    this.name = 'BridgeTokenError';
  }
}

export class BridgeTokenSigner {
  readonly #key: Buffer;
  readonly #now: () => Date;

  constructor(secret: string, now: () => Date = () => new Date()) {
    this.#key = createHash('sha256')
      .update('AIPAY-AGENT-BRIDGE-TOKEN-V1\0')
      .update(secret)
      .digest();
    this.#now = now;
  }

  issueResume(
    paymentAttemptId: ResourceId<'pat'>,
    transactionId: ResourceId<'txn'>,
    resourceUrl: string,
  ): string {
    return this.#sign({
      schemaVersion: '1',
      kind: 'resume',
      paymentAttemptId,
      transactionId,
      resourceUrl,
      expiresAt: new Date(this.#now().getTime() + 15 * 60_000).toISOString(),
    });
  }

  issueDelivery(paymentProof: Readonly<PaymentProofWire>, resourceUrl: string): string {
    return this.#sign({
      schemaVersion: '1',
      kind: 'delivery',
      paymentProof: toPaymentProofWire(parsePaymentProof(paymentProof)),
      resourceUrl,
      expiresAt: paymentProof.expiresAt,
    });
  }

  verifyResume(token: string): Readonly<ResumeTokenPayload> {
    const parsed = resumePayloadSchema.safeParse(this.#verify(token));

    if (!parsed.success || this.#expired(parsed.data.expiresAt)) throw new BridgeTokenError();

    try {
      return Object.freeze({
        kind: 'resume',
        paymentAttemptId: parseResourceId(parsed.data.paymentAttemptId, 'pat'),
        transactionId: parseResourceId(parsed.data.transactionId, 'txn'),
        resourceUrl: parsed.data.resourceUrl,
        expiresAt: parsed.data.expiresAt,
      });
    } catch {
      throw new BridgeTokenError();
    }
  }

  verifyDelivery(token: string): Readonly<DeliveryTokenPayload> {
    const parsed = deliveryPayloadSchema.safeParse(this.#verify(token));

    if (!parsed.success || this.#expired(parsed.data.expiresAt)) throw new BridgeTokenError();

    try {
      return Object.freeze({
        kind: 'delivery',
        paymentProof: toPaymentProofWire(parsePaymentProof(parsed.data.paymentProof)),
        resourceUrl: parsed.data.resourceUrl,
        expiresAt: parsed.data.expiresAt,
      });
    } catch {
      throw new BridgeTokenError();
    }
  }

  #sign(payload: object): string {
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const signature = createHmac('sha256', this.#key).update(encoded, 'ascii').digest('base64url');
    return `${encoded}.${signature}`;
  }

  #verify(token: string): unknown {
    if (token.length < 32 || token.length > 16_384) throw new BridgeTokenError();
    const segments = token.split('.');

    if (segments.length !== 2) throw new BridgeTokenError();
    const [encoded, signature] = segments;

    if (
      encoded === undefined ||
      signature === undefined ||
      !/^[A-Za-z0-9_-]+$/u.test(encoded) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(signature)
    ) {
      throw new BridgeTokenError();
    }

    const expected = createHmac('sha256', this.#key).update(encoded, 'ascii').digest();
    let supplied: Buffer;

    try {
      supplied = Buffer.from(signature, 'base64url');

      if (supplied.toString('base64url') !== signature) throw new BridgeTokenError();
    } catch {
      throw new BridgeTokenError();
    }

    if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
      throw new BridgeTokenError();
    }

    try {
      const bytes = Buffer.from(encoded, 'base64url');

      if (bytes.toString('base64url') !== encoded) throw new BridgeTokenError();
      return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new BridgeTokenError();
    }
  }

  #expired(expiresAt: string): boolean {
    return this.#now().getTime() >= Date.parse(expiresAt);
  }
}
