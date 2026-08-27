import { Buffer } from 'node:buffer';
import {
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';

import {
  MANDATE_SIGNATURE_DOMAIN,
  canonicalizeMandateSigningPayload,
  formatUtcDateTime,
  getMandateSigningPayload,
  getResourceUuid,
  parseMandate,
  parseResourceId,
  toMandateWire,
  type Mandate,
  type MandateWire,
  type ResourceId,
} from '@aipay/contracts';
import type { Database, DatabaseTransaction } from '@aipay/database';

const placeholderSignature = 'A'.repeat(86);
const ed25519SpkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');

export type MandateIssuerErrorCode =
  'not_found' | 'not_draft' | 'expired' | 'issuer_key_conflict' | 'invalid_signature';

export class MandateIssuerError extends Error {
  readonly code: MandateIssuerErrorCode;

  constructor(code: MandateIssuerErrorCode) {
    super('Mandate issuance or verification failed');
    this.name = 'MandateIssuerError';
    this.code = code;
  }
}

export interface MandateIssuerOptions {
  readonly keyId: string;
  readonly privateKeyPkcs8Base64: string;
  readonly now?: () => Date;
}

function signingBytes(mandate: Mandate): Buffer {
  const canonical = canonicalizeMandateSigningPayload(getMandateSigningPayload(mandate));
  return Buffer.concat([
    Buffer.from(MANDATE_SIGNATURE_DOMAIN, 'utf8'),
    Buffer.from(canonical, 'utf8'),
  ]);
}

function publicKeyFromRaw(raw: Uint8Array): KeyObject {
  if (raw.byteLength !== 32) {
    throw new MandateIssuerError('issuer_key_conflict');
  }

  return createPublicKey({
    key: Buffer.concat([ed25519SpkiPrefix, Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  });
}

function instructionHash(value: Uint8Array): string {
  return `sha256:${Buffer.from(value).toString('hex')}`;
}

interface MandateRow {
  readonly id: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly purpose: string;
  readonly currency: 'CNY';
  readonly maxPerTransactionAmountMinor: string;
  readonly totalBudgetAmountMinor: string;
  readonly approvalRequiredAboveAmountMinor: string;
  readonly maxTransactions: number;
  readonly issuedAt: Date;
  readonly validUntil: Date;
  readonly instructionHash: Uint8Array;
  readonly status: 'draft' | 'active' | 'paused' | 'revoked' | 'expired';
}

async function buildWire(
  transaction: DatabaseTransaction,
  row: MandateRow,
  keyId: ResourceId<'key'>,
  issuedAt: Date,
  proofValue: string,
): Promise<MandateWire> {
  const merchants = await transaction
    .selectFrom('mandateAllowedMerchants')
    .select('merchantId')
    .where('mandateId', '=', row.id)
    .orderBy('merchantId', 'asc')
    .execute();
  const categories = await transaction
    .selectFrom('mandateAllowedCategories')
    .select('category')
    .where('mandateId', '=', row.id)
    .orderBy('category', 'asc')
    .execute();

  return {
    schemaVersion: '1',
    mandateId: `mdt_${row.id}`,
    principalId: `dev_${row.principalId}`,
    agentId: `agt_${row.agentId}`,
    purpose: row.purpose,
    allowedMerchantIds: merchants.map(({ merchantId }) => `mch_${merchantId}`),
    allowedCategories: categories.map(({ category }) => category),
    maxPerTransaction: {
      currency: row.currency,
      amountMinor: row.maxPerTransactionAmountMinor,
    },
    totalBudget: { currency: row.currency, amountMinor: row.totalBudgetAmountMinor },
    approvalRequiredAbove: {
      currency: row.currency,
      amountMinor: row.approvalRequiredAboveAmountMinor,
    },
    maxTransactions: row.maxTransactions,
    issuedAt: formatUtcDateTime(issuedAt),
    validUntil: formatUtcDateTime(row.validUntil),
    instructionHash: instructionHash(row.instructionHash),
    proof: {
      scheme: 'aipay-jcs-ed25519-v1',
      keyId,
      value: proofValue,
    },
  };
}

export class MandateIssuer {
  readonly #database: Database;
  readonly #keyId: ResourceId<'key'>;
  readonly #privateKey: KeyObject;
  readonly #publicKeyRaw: Buffer;
  readonly #now: () => Date;

  constructor(database: Database, options: MandateIssuerOptions) {
    this.#database = database;

    try {
      this.#keyId = parseResourceId(options.keyId, 'key');
      this.#privateKey = createPrivateKey({
        key: Buffer.from(options.privateKeyPkcs8Base64, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
    } catch {
      throw new MandateIssuerError('issuer_key_conflict');
    }

    if (this.#privateKey.asymmetricKeyType !== 'ed25519') {
      throw new MandateIssuerError('issuer_key_conflict');
    }

    const publicDer = createPublicKey(this.#privateKey).export({ format: 'der', type: 'spki' });
    this.#publicKeyRaw = Buffer.from(publicDer).subarray(-32);
    this.#now = options.now ?? (() => new Date());
  }

  async #ensurePublicKey(transaction: DatabaseTransaction): Promise<void> {
    const keyUuid = getResourceUuid(this.#keyId);
    const existing = await transaction
      .selectFrom('signingKeys')
      .select(['ownerType', 'algorithm', 'publicKey', 'status'])
      .where('id', '=', keyUuid)
      .forUpdate()
      .executeTakeFirst();

    if (existing === undefined) {
      await transaction
        .insertInto('signingKeys')
        .values({
          id: keyUuid,
          ownerType: 'system',
          developerId: null,
          agentId: null,
          merchantId: null,
          publicKey: this.#publicKeyRaw,
          revokedAt: null,
        })
        .executeTakeFirstOrThrow();
      return;
    }

    if (
      existing.ownerType !== 'system' ||
      existing.status !== 'active' ||
      existing.publicKey.byteLength !== this.#publicKeyRaw.byteLength ||
      !timingSafeEqual(existing.publicKey, this.#publicKeyRaw)
    ) {
      throw new MandateIssuerError('issuer_key_conflict');
    }
  }

  async issue(
    principalId: ResourceId<'dev'>,
    mandateId: ResourceId<'mdt'>,
  ): Promise<Readonly<MandateWire>> {
    const now = this.#now();

    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom('mandates')
        .select([
          'id',
          'principalId',
          'agentId',
          'purpose',
          'currency',
          'maxPerTransactionAmountMinor',
          'totalBudgetAmountMinor',
          'approvalRequiredAboveAmountMinor',
          'maxTransactions',
          'issuedAt',
          'validUntil',
          'instructionHash',
          'status',
        ])
        .where('id', '=', getResourceUuid(mandateId))
        .where('principalId', '=', getResourceUuid(principalId))
        .forUpdate()
        .executeTakeFirst();

      if (row === undefined) {
        throw new MandateIssuerError('not_found');
      }

      if (row.status !== 'draft') {
        throw new MandateIssuerError('not_draft');
      }

      if (now >= row.validUntil) {
        throw new MandateIssuerError('expired');
      }

      await this.#ensurePublicKey(transaction);
      const placeholderWire = await buildWire(
        transaction,
        row,
        this.#keyId,
        now,
        placeholderSignature,
      );
      const placeholderMandate = parseMandate(placeholderWire);
      const signature = sign(null, signingBytes(placeholderMandate), this.#privateKey);
      const wire = {
        ...placeholderWire,
        proof: { ...placeholderWire.proof, value: signature.toString('base64url') },
      };
      const mandate = parseMandate(wire);

      await transaction
        .updateTable('mandates')
        .set({
          issuedAt: now,
          proofKeyId: getResourceUuid(this.#keyId),
          proofValue: signature,
          status: 'active',
        })
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow();

      return toMandateWire(mandate);
    });
  }
}

export class MandateVerifier {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async verify(value: unknown): Promise<Mandate> {
    let mandate: Mandate;

    try {
      mandate = parseMandate(value);
    } catch {
      throw new MandateIssuerError('invalid_signature');
    }

    const key = await this.#database
      .selectFrom('signingKeys')
      .select(['ownerType', 'algorithm', 'publicKey', 'status'])
      .where('id', '=', getResourceUuid(mandate.proof.keyId))
      .executeTakeFirst();

    if (key === undefined) {
      throw new MandateIssuerError('invalid_signature');
    }

    if (key.ownerType !== 'system' || key.status !== 'active') {
      throw new MandateIssuerError('invalid_signature');
    }

    let valid: boolean;

    try {
      valid = verify(
        null,
        signingBytes(mandate),
        publicKeyFromRaw(key.publicKey),
        Buffer.from(mandate.proof.value, 'base64url'),
      );
    } catch {
      throw new MandateIssuerError('invalid_signature');
    }

    if (!valid) {
      throw new MandateIssuerError('invalid_signature');
    }

    return mandate;
  }
}
