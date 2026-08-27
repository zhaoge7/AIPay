import { Buffer } from 'node:buffer';
import { createPublicKey, verify, type KeyObject } from 'node:crypto';

import {
  QUOTE_SIGNATURE_DOMAIN,
  canonicalizeQuoteSigningPayload,
  formatUtcDateTime,
  getQuoteSigningPayload,
  getResourceUuid,
  parseQuote,
  parseResourceId,
  toQuoteWire,
  type Quote,
  type QuoteWire,
  type ResourceId,
} from '@aipay/contracts';
import type { Database, DatabaseTransaction } from '@aipay/database';

const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

export type QuoteSigningErrorCode =
  | 'not_found'
  | 'invalid_public_key'
  | 'key_unavailable'
  | 'expired'
  | 'invalid_state'
  | 'invalid_signature';

export class QuoteSigningError extends Error {
  readonly code: QuoteSigningErrorCode;

  constructor(code: QuoteSigningErrorCode) {
    super('Quote signing operation failed');
    this.name = 'QuoteSigningError';
    this.code = code;
  }
}

export interface MerchantSigningKeyView {
  readonly keyId: ResourceId<'key'>;
  readonly merchantId: ResourceId<'mch'>;
  readonly algorithm: 'ed25519';
  readonly publicKey: string;
  readonly status: 'active';
  readonly createdAt: string;
}

interface QuoteRow {
  readonly id: string;
  readonly merchantId: string;
  readonly serviceId: string;
  readonly unit: string;
  readonly quantity: number;
  readonly currency: 'CNY';
  readonly unitPriceAmountMinor: string;
  readonly subtotalAmountMinor: string;
  readonly taxBehavior: 'inclusive' | 'exclusive';
  readonly taxAmountMinor: string;
  readonly totalAmountMinor: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly proofKeyId: string | null;
  readonly proofValue: Uint8Array | null;
  readonly status: 'draft' | 'active' | 'expired';
}

const quoteColumns = [
  'id',
  'merchantId',
  'serviceId',
  'unit',
  'quantity',
  'currency',
  'unitPriceAmountMinor',
  'subtotalAmountMinor',
  'taxBehavior',
  'taxAmountMinor',
  'totalAmountMinor',
  'issuedAt',
  'expiresAt',
  'proofKeyId',
  'proofValue',
  'status',
] as const;

function parsePublicKey(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new QuoteSigningError('invalid_public_key');
  }

  const key = Buffer.from(value, 'base64url');

  if (key.byteLength !== 32 || key.toString('base64url') !== value) {
    throw new QuoteSigningError('invalid_public_key');
  }

  return key;
}

function publicKeyObject(raw: Uint8Array): KeyObject {
  if (raw.byteLength !== 32) {
    throw new QuoteSigningError('invalid_public_key');
  }

  return createPublicKey({
    key: Buffer.concat([ed25519SpkiPrefix, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  });
}

function signingBytes(quote: Quote): Buffer {
  const canonical = canonicalizeQuoteSigningPayload(getQuoteSigningPayload(quote));
  return Buffer.concat([
    Buffer.from(QUOTE_SIGNATURE_DOMAIN, 'utf8'),
    Buffer.from(canonical, 'utf8'),
  ]);
}

function toWire(row: QuoteRow, keyId: ResourceId<'key'>, proofValue: string): QuoteWire {
  return {
    schemaVersion: '1',
    quoteId: `qte_${row.id}`,
    merchantId: `mch_${row.merchantId}`,
    serviceId: `svc_${row.serviceId}`,
    unit: row.unit,
    quantity: row.quantity,
    unitPrice: { currency: row.currency, amountMinor: row.unitPriceAmountMinor },
    subtotal: { currency: row.currency, amountMinor: row.subtotalAmountMinor },
    taxBehavior: row.taxBehavior,
    taxAmount: { currency: row.currency, amountMinor: row.taxAmountMinor },
    total: { currency: row.currency, amountMinor: row.totalAmountMinor },
    issuedAt: formatUtcDateTime(row.issuedAt),
    expiresAt: formatUtcDateTime(row.expiresAt),
    proof: {
      scheme: 'aipay-jcs-ed25519-v1',
      keyId,
      value: proofValue,
    },
  };
}

async function keyForQuote(
  transaction: DatabaseTransaction,
  merchantId: string,
  keyId: ResourceId<'key'>,
) {
  return transaction
    .selectFrom('signingKeys')
    .select(['id', 'ownerType', 'merchantId', 'publicKey', 'status'])
    .where('id', '=', getResourceUuid(keyId))
    .where('ownerType', '=', 'merchant')
    .where('merchantId', '=', merchantId)
    .where('status', '=', 'active')
    .executeTakeFirst();
}

export class QuoteSigningService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async registerMerchantKey(
    developerId: ResourceId<'dev'>,
    merchantId: ResourceId<'mch'>,
    publicKeyValue: string,
  ): Promise<Readonly<MerchantSigningKeyView>> {
    const publicKey = parsePublicKey(publicKeyValue);

    try {
      const row = await this.#database.transaction().execute(async (transaction) => {
        const merchant = await transaction
          .selectFrom('merchants')
          .select('id')
          .where('id', '=', getResourceUuid(merchantId))
          .where('developerId', '=', getResourceUuid(developerId))
          .where('status', '<>', 'closed')
          .forUpdate()
          .executeTakeFirst();

        if (merchant === undefined) {
          throw new QuoteSigningError('not_found');
        }

        return transaction
          .insertInto('signingKeys')
          .values({
            ownerType: 'merchant',
            developerId: null,
            agentId: null,
            merchantId: merchant.id,
            publicKey,
            revokedAt: null,
          })
          .returning(['id', 'merchantId', 'algorithm', 'publicKey', 'status', 'createdAt'])
          .executeTakeFirstOrThrow();
      });

      return Object.freeze({
        keyId: parseResourceId(`key_${row.id}`, 'key'),
        merchantId,
        algorithm: row.algorithm,
        publicKey: Buffer.from(row.publicKey).toString('base64url'),
        status: 'active',
        createdAt: formatUtcDateTime(row.createdAt),
      });
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505'
      ) {
        throw new QuoteSigningError('key_unavailable');
      }

      throw error;
    }
  }

  async activate(
    developerId: ResourceId<'dev'>,
    quoteId: ResourceId<'qte'>,
    keyId: ResourceId<'key'>,
    signatureValue: string,
  ): Promise<Readonly<QuoteWire>> {
    if (!/^[A-Za-z0-9_-]{85}[AQgw]$/u.test(signatureValue)) {
      throw new QuoteSigningError('invalid_signature');
    }

    const now = this.#now();

    const outcome = await this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom('quotes')
        .innerJoin('merchants', 'merchants.id', 'quotes.merchantId')
        .select(quoteColumns.map((column) => `quotes.${column}` as const))
        .where('quotes.id', '=', getResourceUuid(quoteId))
        .where('merchants.developerId', '=', getResourceUuid(developerId))
        .forUpdate('quotes')
        .executeTakeFirst();

      if (row === undefined) {
        throw new QuoteSigningError('not_found');
      }

      if (row.status === 'active') {
        if (
          row.proofKeyId === getResourceUuid(keyId) &&
          row.proofValue !== null &&
          Buffer.from(row.proofValue).toString('base64url') === signatureValue
        ) {
          return Object.freeze({
            wire: toQuoteWire(parseQuote(toWire(row, keyId, signatureValue))),
          });
        }

        throw new QuoteSigningError('invalid_state');
      }

      if (row.status !== 'draft') {
        throw new QuoteSigningError('invalid_state');
      }

      if (now >= row.expiresAt) {
        await transaction
          .updateTable('quotes')
          .set({ status: 'expired' })
          .where('id', '=', row.id)
          .executeTakeFirstOrThrow();
        return Object.freeze({ error: 'expired' as const });
      }

      const key = await keyForQuote(transaction, row.merchantId, keyId);

      if (key === undefined) {
        throw new QuoteSigningError('key_unavailable');
      }

      const wire = toWire(row, keyId, signatureValue);
      const quote = parseQuote(wire);
      const valid = verify(
        null,
        signingBytes(quote),
        publicKeyObject(key.publicKey),
        Buffer.from(signatureValue, 'base64url'),
      );

      if (!valid) {
        throw new QuoteSigningError('invalid_signature');
      }

      await transaction
        .updateTable('quotes')
        .set({
          proofKeyId: getResourceUuid(keyId),
          proofValue: Buffer.from(signatureValue, 'base64url'),
          status: 'active',
        })
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow();
      return Object.freeze({ wire: toQuoteWire(quote) });
    });

    if ('error' in outcome) {
      throw new QuoteSigningError(outcome.error);
    }

    return outcome.wire;
  }

  async verify(value: unknown): Promise<Quote> {
    let quote: Quote;

    try {
      quote = parseQuote(value);
    } catch {
      throw new QuoteSigningError('invalid_signature');
    }

    const key = await this.#database
      .selectFrom('signingKeys')
      .select(['ownerType', 'merchantId', 'publicKey', 'status'])
      .where('id', '=', getResourceUuid(quote.proof.keyId))
      .executeTakeFirst();

    if (key === undefined) {
      throw new QuoteSigningError('invalid_signature');
    }

    if (
      key.ownerType !== 'merchant' ||
      key.merchantId !== getResourceUuid(quote.merchantId) ||
      key.status !== 'active'
    ) {
      throw new QuoteSigningError('invalid_signature');
    }

    const valid = verify(
      null,
      signingBytes(quote),
      publicKeyObject(key.publicKey),
      Buffer.from(quote.proof.value, 'base64url'),
    );

    if (!valid) {
      throw new QuoteSigningError('invalid_signature');
    }

    return quote;
  }
}
