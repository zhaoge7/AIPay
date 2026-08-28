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
  PAYMENT_PROOF_SIGNATURE_DOMAIN,
  canonicalizePaymentProofSigningPayload,
  createMoney,
  formatUtcDateTime,
  getPaymentProofSigningPayload,
  getResourceUuid,
  parsePaymentProof,
  parseResourceId,
  toPaymentProofWire,
  type PaymentProof,
  type PaymentProofWire,
  type ResourceId,
} from '@aipay/contracts';
import { enqueueOutboxEvent, type Database, type DatabaseTransaction } from '@aipay/database';
import { v7 as uuidv7 } from 'uuid';

const defaultValidityMs = 5 * 60 * 1_000;
const placeholderSignature = 'A'.repeat(86);

export type PaymentProofErrorCode =
  | 'not_found'
  | 'invalid_state'
  | 'expired'
  | 'invalid_signature'
  | 'already_consumed'
  | 'binding_mismatch'
  | 'issuer_key_conflict';

export class PaymentProofError extends Error {
  readonly code: PaymentProofErrorCode;

  constructor(code: PaymentProofErrorCode) {
    super('Payment Proof operation failed');
    this.name = 'PaymentProofError';
    this.code = code;
  }
}

export interface PaymentProofIssuerOptions {
  readonly keyId: string;
  readonly privateKeyPkcs8Base64: string;
  readonly validityMs?: number;
  readonly now?: () => Date;
}

function signingBytes(paymentProof: PaymentProof): Buffer {
  return Buffer.concat([
    Buffer.from(PAYMENT_PROOF_SIGNATURE_DOMAIN, 'utf8'),
    Buffer.from(
      canonicalizePaymentProofSigningPayload(getPaymentProofSigningPayload(paymentProof)),
      'utf8',
    ),
  ]);
}

function wireFromRow(row: {
  readonly id: string;
  readonly transactionId: string;
  readonly paymentAttemptId: string;
  readonly merchantId: string;
  readonly serviceId: string;
  readonly currency: 'CNY';
  readonly amountMinor: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly proofKeyId: string;
  readonly proofValue: Uint8Array;
}): Readonly<PaymentProofWire> {
  return toPaymentProofWire(
    parsePaymentProof({
      schemaVersion: '1',
      paymentProofId: `ppf_${row.id}`,
      transactionId: `txn_${row.transactionId}`,
      paymentAttemptId: `pat_${row.paymentAttemptId}`,
      merchantId: `mch_${row.merchantId}`,
      serviceId: `svc_${row.serviceId}`,
      amount: { currency: row.currency, amountMinor: row.amountMinor },
      issuedAt: formatUtcDateTime(row.issuedAt),
      expiresAt: formatUtcDateTime(row.expiresAt),
      proof: {
        scheme: 'aipay-jcs-ed25519-v1',
        keyId: `key_${row.proofKeyId}`,
        value: Buffer.from(row.proofValue).toString('base64url'),
      },
    }),
  );
}

const proofColumns = [
  'id',
  'transactionId',
  'paymentAttemptId',
  'merchantId',
  'serviceId',
  'currency',
  'amountMinor',
  'issuedAt',
  'expiresAt',
  'proofKeyId',
  'proofValue',
] as const;

export class PaymentProofIssuer {
  readonly #database: Database;
  readonly #keyId: ResourceId<'key'>;
  readonly #privateKey: KeyObject;
  readonly #publicKeyRaw: Buffer;
  readonly #validityMs: number;
  readonly #now: () => Date;

  constructor(database: Database, options: PaymentProofIssuerOptions) {
    this.#database = database;

    try {
      this.#keyId = parseResourceId(options.keyId, 'key');
      this.#privateKey = createPrivateKey({
        key: Buffer.from(options.privateKeyPkcs8Base64, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
    } catch {
      throw new PaymentProofError('issuer_key_conflict');
    }

    if (this.#privateKey.asymmetricKeyType !== 'ed25519') {
      throw new PaymentProofError('issuer_key_conflict');
    }

    this.#publicKeyRaw = Buffer.from(
      createPublicKey(this.#privateKey).export({ format: 'der', type: 'spki' }),
    ).subarray(-32);
    this.#validityMs = options.validityMs ?? defaultValidityMs;
    this.#now = options.now ?? (() => new Date());

    if (
      !Number.isInteger(this.#validityMs) ||
      this.#validityMs < 1_000 ||
      this.#validityMs > 15 * 60 * 1_000
    ) {
      throw new PaymentProofError('invalid_state');
    }
  }

  async #ensurePublicKey(transaction: DatabaseTransaction): Promise<void> {
    const keyId = getResourceUuid(this.#keyId);
    const existing = await transaction
      .selectFrom('signingKeys')
      .select(['ownerType', 'publicKey', 'status'])
      .where('id', '=', keyId)
      .forUpdate()
      .executeTakeFirst();

    if (existing === undefined) {
      await transaction
        .insertInto('signingKeys')
        .values({
          id: keyId,
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
      throw new PaymentProofError('issuer_key_conflict');
    }
  }

  async issue(
    developerId: ResourceId<'dev'>,
    transactionId: ResourceId<'txn'>,
  ): Promise<Readonly<PaymentProofWire>> {
    const now = this.#now();

    return this.#database.transaction().execute(async (transaction) => {
      const paymentTransaction = await transaction
        .selectFrom('transactions')
        .select([
          'id',
          'principalId',
          'merchantId',
          'serviceId',
          'currency',
          'amountMinor',
          'status',
        ])
        .where('id', '=', getResourceUuid(transactionId))
        .where('principalId', '=', getResourceUuid(developerId))
        .forUpdate()
        .executeTakeFirst();

      if (paymentTransaction === undefined) {
        throw new PaymentProofError('not_found');
      }

      const existing = await transaction
        .selectFrom('paymentProofs')
        .select([...proofColumns, 'status'])
        .where('transactionId', '=', paymentTransaction.id)
        .where('status', '=', 'active')
        .forUpdate()
        .executeTakeFirst();

      if (existing !== undefined && now < existing.expiresAt) {
        return wireFromRow(existing);
      }

      if (existing !== undefined) {
        await transaction
          .updateTable('paymentProofs')
          .set({ status: 'expired' })
          .where('id', '=', existing.id)
          .executeTakeFirstOrThrow();
      }

      if (paymentTransaction.status !== 'paid') {
        throw new PaymentProofError('invalid_state');
      }

      const attempt = await transaction
        .selectFrom('paymentAttempts')
        .select(['id', 'status'])
        .where('transactionId', '=', paymentTransaction.id)
        .where('status', '=', 'succeeded')
        .orderBy('attemptNumber', 'desc')
        .executeTakeFirst();

      if (attempt === undefined) {
        throw new PaymentProofError('invalid_state');
      }

      await this.#ensurePublicKey(transaction);
      const paymentProofId = parseResourceId(`ppf_${uuidv7()}`, 'ppf');
      const expiresAt = new Date(now.getTime() + this.#validityMs);
      const placeholder = parsePaymentProof({
        schemaVersion: '1',
        paymentProofId,
        transactionId,
        paymentAttemptId: `pat_${attempt.id}`,
        merchantId: `mch_${paymentTransaction.merchantId}`,
        serviceId: `svc_${paymentTransaction.serviceId}`,
        amount: createMoney(paymentTransaction.currency, paymentTransaction.amountMinor),
        issuedAt: formatUtcDateTime(now),
        expiresAt: formatUtcDateTime(expiresAt),
        proof: {
          scheme: 'aipay-jcs-ed25519-v1',
          keyId: this.#keyId,
          value: placeholderSignature,
        },
      });
      const signature = sign(null, signingBytes(placeholder), this.#privateKey);
      const wire = toPaymentProofWire(
        parsePaymentProof({
          ...toPaymentProofWire(placeholder),
          proof: { ...placeholder.proof, value: signature.toString('base64url') },
        }),
      );
      await transaction
        .insertInto('paymentProofs')
        .values({
          id: getResourceUuid(paymentProofId),
          transactionId: paymentTransaction.id,
          paymentAttemptId: attempt.id,
          merchantId: paymentTransaction.merchantId,
          serviceId: paymentTransaction.serviceId,
          amountMinor: paymentTransaction.amountMinor,
          issuedAt: now,
          expiresAt,
          proofKeyId: getResourceUuid(this.#keyId),
          proofValue: signature,
          consumedAt: null,
        })
        .executeTakeFirstOrThrow();
      return wire;
    });
  }

  async #verifySignature(value: unknown): Promise<PaymentProof> {
    let paymentProof: PaymentProof;

    try {
      paymentProof = parsePaymentProof(value);
    } catch {
      throw new PaymentProofError('invalid_signature');
    }

    const key = await this.#database
      .selectFrom('signingKeys')
      .select(['ownerType', 'publicKey', 'status'])
      .where('id', '=', getResourceUuid(paymentProof.proof.keyId))
      .executeTakeFirst();

    if (key?.ownerType !== 'system' || key.status !== 'active') {
      throw new PaymentProofError('invalid_signature');
    }

    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.publicKey]),
      format: 'der',
      type: 'spki',
    });
    const valid = verify(
      null,
      signingBytes(paymentProof),
      publicKey,
      Buffer.from(paymentProof.proof.value, 'base64url'),
    );

    if (!valid) {
      throw new PaymentProofError('invalid_signature');
    }

    return paymentProof;
  }

  async verify(value: unknown): Promise<PaymentProof> {
    const paymentProof = await this.#verifySignature(value);

    if (this.#now() >= new Date(paymentProof.expiresAt)) {
      throw new PaymentProofError('expired');
    }

    return paymentProof;
  }

  async consume(
    developerId: ResourceId<'dev'>,
    merchantId: ResourceId<'mch'>,
    value: unknown,
  ): Promise<Readonly<{ paymentProofId: ResourceId<'ppf'>; consumedAt: string }>> {
    const paymentProof = await this.#verifySignature(value);
    const now = this.#now();
    const outcome = await this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom('paymentProofs')
        .innerJoin('transactions', 'transactions.id', 'paymentProofs.transactionId')
        .innerJoin('paymentAttempts', 'paymentAttempts.id', 'paymentProofs.paymentAttemptId')
        .innerJoin('merchants', 'merchants.id', 'paymentProofs.merchantId')
        .select([
          ...proofColumns.map((column) => `paymentProofs.${column}` as const),
          'paymentProofs.status',
          'transactions.status as transactionStatus',
          'paymentAttempts.status as attemptStatus',
          'merchants.developerId',
        ])
        .where('paymentProofs.id', '=', getResourceUuid(paymentProof.paymentProofId))
        .forUpdate('paymentProofs')
        .forUpdate('transactions')
        .executeTakeFirst();

      if (row?.developerId !== getResourceUuid(developerId)) {
        throw new PaymentProofError('not_found');
      }

      if (
        paymentProof.merchantId !== merchantId ||
        row.merchantId !== getResourceUuid(merchantId) ||
        row.transactionId !== getResourceUuid(paymentProof.transactionId) ||
        row.paymentAttemptId !== getResourceUuid(paymentProof.paymentAttemptId) ||
        row.serviceId !== getResourceUuid(paymentProof.serviceId) ||
        row.amountMinor !== paymentProof.amount.amountMinor ||
        row.proofKeyId !== getResourceUuid(paymentProof.proof.keyId) ||
        row.proofValue.byteLength !== 64 ||
        !timingSafeEqual(row.proofValue, Buffer.from(paymentProof.proof.value, 'base64url'))
      ) {
        throw new PaymentProofError('binding_mismatch');
      }

      if (row.status === 'consumed') {
        throw new PaymentProofError('already_consumed');
      }

      if (row.status === 'expired' || now >= row.expiresAt) {
        if (row.status === 'active') {
          await transaction
            .updateTable('paymentProofs')
            .set({ status: 'expired' })
            .where('id', '=', row.id)
            .executeTakeFirstOrThrow();
        }

        return Object.freeze({ error: 'expired' as const });
      }

      if (row.transactionStatus !== 'paid' || row.attemptStatus !== 'succeeded') {
        throw new PaymentProofError('invalid_state');
      }

      await transaction
        .updateTable('paymentProofs')
        .set({ status: 'consumed', consumedAt: now })
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable('transactions')
        .set({ status: 'delivery_pending', updatedAt: now })
        .where('id', '=', row.transactionId)
        .executeTakeFirstOrThrow();
      await enqueueOutboxEvent(transaction, {
        aggregateType: 'transaction',
        aggregateId: paymentProof.transactionId,
        eventType: 'transaction.delivery_started',
        payload: {
          merchantId,
          transactionId: paymentProof.transactionId,
          paymentProofId: paymentProof.paymentProofId,
          serviceId: paymentProof.serviceId,
        },
      });
      return Object.freeze({ consumedAt: formatUtcDateTime(now) });
    });

    if ('error' in outcome) {
      throw new PaymentProofError(outcome.error);
    }

    return Object.freeze({ paymentProofId: paymentProof.paymentProofId, ...outcome });
  }
}
