import { Buffer } from 'node:buffer';
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

import { getResourceUuid, parseResourceId, type ResourceId } from '@aipay/contracts';

const webhookDomain = Buffer.from('AIPAY-WEBHOOK-V1\0', 'utf8');

export interface WebhookSignature {
  readonly keyId: ResourceId<'key'>;
  readonly timestamp: string;
  readonly signature: string;
  readonly headers: Readonly<Record<string, string>>;
}

function signingBytes(eventId: ResourceId<'obx'>, timestamp: string, body: Uint8Array) {
  return Buffer.concat([
    webhookDomain,
    Buffer.from(eventId, 'utf8'),
    Buffer.from('\n', 'utf8'),
    Buffer.from(timestamp, 'utf8'),
    Buffer.from('\n', 'utf8'),
    Buffer.from(body),
  ]);
}

export class Ed25519WebhookSigner {
  readonly #keyId: ResourceId<'key'>;
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;

  constructor(keyId: string, privateKeyPkcs8Base64: string) {
    this.#keyId = parseResourceId(keyId, 'key');
    this.#privateKey = createPrivateKey({
      key: Buffer.from(privateKeyPkcs8Base64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });

    if (this.#privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('Webhook signing key must be Ed25519');
    }

    this.#publicKey = createPublicKey(this.#privateKey);
  }

  get keyId(): ResourceId<'key'> {
    return this.#keyId;
  }

  get keyUuid(): string {
    return getResourceUuid(this.#keyId);
  }

  publicKeySpkiBase64(): string {
    return this.#publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  }

  sign(eventId: ResourceId<'obx'>, body: Uint8Array, now = new Date()): WebhookSignature {
    const timestamp = Math.floor(now.getTime() / 1_000).toString();
    const signature = sign(null, signingBytes(eventId, timestamp, body), this.#privateKey).toString(
      'base64url',
    );
    return Object.freeze({
      keyId: this.#keyId,
      timestamp,
      signature,
      headers: Object.freeze({
        'x-aipay-event-id': eventId,
        'x-aipay-key-id': this.#keyId,
        'x-aipay-timestamp': timestamp,
        'x-aipay-signature': `ed25519=:${signature}:`,
      }),
    });
  }

  verify(
    eventId: ResourceId<'obx'>,
    timestamp: string,
    body: Uint8Array,
    signature: string,
  ): boolean {
    return verify(
      null,
      signingBytes(eventId, timestamp, body),
      this.#publicKey,
      Buffer.from(signature, 'base64url'),
    );
  }
}
