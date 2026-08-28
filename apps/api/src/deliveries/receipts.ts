import { Buffer } from 'node:buffer';
import { createPublicKey, verify } from 'node:crypto';

import {
  DELIVERY_RECEIPT_SIGNATURE_DOMAIN,
  canonicalizeDeliveryReceiptSigningPayload,
  formatUtcDateTime,
  getDeliveryReceiptSigningPayload,
  getResourceUuid,
  parseDeliveryReceipt,
  toDeliveryReceiptWire,
  type DeliveryReceipt,
  type DeliveryReceiptWire,
  type ResourceId,
} from '@aipay/contracts';
import { enqueueOutboxEvent, type Database } from '@aipay/database';

import { applyDeliveryTimeout } from './timeouts.js';

const maximumFutureSkewMs = 5 * 60 * 1_000;

export type DeliveryReceiptErrorCode =
  | 'not_found'
  | 'invalid_state'
  | 'invalid_signature'
  | 'binding_mismatch'
  | 'invalid_delivery_time';

export class DeliveryReceiptError extends Error {
  readonly code: DeliveryReceiptErrorCode;

  constructor(code: DeliveryReceiptErrorCode) {
    super('Delivery Receipt operation failed');
    this.name = 'DeliveryReceiptError';
    this.code = code;
  }
}

function signingBytes(receipt: DeliveryReceipt): Buffer {
  return Buffer.concat([
    Buffer.from(DELIVERY_RECEIPT_SIGNATURE_DOMAIN, 'utf8'),
    Buffer.from(
      canonicalizeDeliveryReceiptSigningPayload(getDeliveryReceiptSigningPayload(receipt)),
      'utf8',
    ),
  ]);
}

function wireFromStored(row: {
  readonly id: string;
  readonly transactionId: string;
  readonly paymentProofId: string;
  readonly merchantId: string;
  readonly serviceId: string;
  readonly status: 'succeeded' | 'failed';
  readonly resultDigest: Uint8Array;
  readonly deliveredAt: Date;
  readonly errorCode: string | null;
  readonly proofKeyId: string;
  readonly proofValue: Uint8Array;
}): Readonly<DeliveryReceiptWire> {
  return toDeliveryReceiptWire(
    parseDeliveryReceipt({
      schemaVersion: '1',
      deliveryId: `dlv_${row.id}`,
      transactionId: `txn_${row.transactionId}`,
      paymentProofId: `ppf_${row.paymentProofId}`,
      merchantId: `mch_${row.merchantId}`,
      serviceId: `svc_${row.serviceId}`,
      status: row.status,
      resultDigest: `sha256:${Buffer.from(row.resultDigest).toString('hex')}`,
      deliveredAt: formatUtcDateTime(row.deliveredAt),
      errorCode: row.errorCode,
      proof: {
        scheme: 'aipay-jcs-ed25519-v1',
        keyId: `key_${row.proofKeyId}`,
        value: Buffer.from(row.proofValue).toString('base64url'),
      },
    }),
  );
}

export class DeliveryReceiptService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async verify(value: unknown): Promise<DeliveryReceipt> {
    let receipt: DeliveryReceipt;

    try {
      receipt = parseDeliveryReceipt(value);
    } catch {
      throw new DeliveryReceiptError('invalid_signature');
    }

    const key = await this.#database
      .selectFrom('signingKeys')
      .select(['ownerType', 'merchantId', 'publicKey', 'status'])
      .where('id', '=', getResourceUuid(receipt.proof.keyId))
      .executeTakeFirst();

    if (
      key?.ownerType !== 'merchant' ||
      key.merchantId !== getResourceUuid(receipt.merchantId) ||
      key.status !== 'active'
    ) {
      throw new DeliveryReceiptError('invalid_signature');
    }

    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.publicKey]),
      format: 'der',
      type: 'spki',
    });
    const valid = verify(
      null,
      signingBytes(receipt),
      publicKey,
      Buffer.from(receipt.proof.value, 'base64url'),
    );

    if (!valid) {
      throw new DeliveryReceiptError('invalid_signature');
    }

    return receipt;
  }

  async submit(
    developerId: ResourceId<'dev'>,
    merchantId: ResourceId<'mch'>,
    deliveryId: ResourceId<'dlv'>,
    value: unknown,
  ): Promise<Readonly<DeliveryReceiptWire>> {
    const receipt = await this.verify(value);

    if (receipt.merchantId !== merchantId || receipt.deliveryId !== deliveryId) {
      throw new DeliveryReceiptError('binding_mismatch');
    }

    const now = this.#now();
    const outcome = await this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom('deliveries')
        .innerJoin('transactions', 'transactions.id', 'deliveries.transactionId')
        .innerJoin('paymentProofs', 'paymentProofs.id', 'deliveries.paymentProofId')
        .innerJoin('merchants', 'merchants.id', 'deliveries.merchantId')
        .select([
          'deliveries.id',
          'deliveries.transactionId',
          'deliveries.paymentProofId',
          'deliveries.merchantId',
          'deliveries.serviceId',
          'deliveries.refundPolicy',
          'deliveries.expiresAt',
          'deliveries.status',
          'deliveries.resultDigest',
          'deliveries.deliveredAt',
          'deliveries.errorCode',
          'deliveries.proofKeyId',
          'deliveries.proofValue',
          'deliveries.createdAt',
          'transactions.status as transactionStatus',
          'paymentProofs.status as paymentProofStatus',
          'merchants.developerId',
        ])
        .where('deliveries.id', '=', getResourceUuid(deliveryId))
        .forUpdate('deliveries')
        .forUpdate('transactions')
        .executeTakeFirst();

      if (row?.developerId !== getResourceUuid(developerId)) {
        throw new DeliveryReceiptError('not_found');
      }

      if (row.status === 'pending' && now >= row.expiresAt) {
        await applyDeliveryTimeout(transaction, row, now);
        return Object.freeze({ error: 'invalid_state' as const });
      }

      if (row.status === 'succeeded' || row.status === 'failed') {
        if (
          row.resultDigest === null ||
          row.deliveredAt === null ||
          row.proofKeyId === null ||
          row.proofValue === null
        ) {
          throw new DeliveryReceiptError('invalid_state');
        }

        const stored = wireFromStored({
          ...row,
          status: row.status,
          resultDigest: row.resultDigest,
          deliveredAt: row.deliveredAt,
          proofKeyId: row.proofKeyId,
          proofValue: row.proofValue,
        });

        if (JSON.stringify(stored) === JSON.stringify(toDeliveryReceiptWire(receipt))) {
          return Object.freeze({ receipt: stored });
        }

        throw new DeliveryReceiptError('invalid_state');
      }

      if (
        row.status !== 'pending' ||
        row.transactionStatus !== 'delivery_pending' ||
        row.paymentProofStatus !== 'consumed'
      ) {
        throw new DeliveryReceiptError('invalid_state');
      }

      if (
        row.transactionId !== getResourceUuid(receipt.transactionId) ||
        row.paymentProofId !== getResourceUuid(receipt.paymentProofId) ||
        row.merchantId !== getResourceUuid(receipt.merchantId) ||
        row.serviceId !== getResourceUuid(receipt.serviceId)
      ) {
        throw new DeliveryReceiptError('binding_mismatch');
      }

      const deliveredAt = new Date(receipt.deliveredAt);

      if (
        deliveredAt < row.createdAt ||
        deliveredAt.getTime() > now.getTime() + maximumFutureSkewMs
      ) {
        throw new DeliveryReceiptError('invalid_delivery_time');
      }

      const resultDigest = Buffer.from(receipt.resultDigest.slice('sha256:'.length), 'hex');
      await transaction
        .updateTable('deliveries')
        .set({
          status: receipt.status,
          resultDigest,
          deliveredAt,
          errorCode: receipt.errorCode,
          proofScheme: receipt.proof.scheme,
          proofKeyId: getResourceUuid(receipt.proof.keyId),
          proofValue: Buffer.from(receipt.proof.value, 'base64url'),
          updatedAt: now,
        })
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow();
      const transactionStatus =
        receipt.status === 'succeeded'
          ? 'delivered'
          : row.refundPolicy === 'full_on_delivery_failure'
            ? 'refund_pending'
            : 'delivery_review';
      await transaction
        .updateTable('transactions')
        .set({ status: transactionStatus, updatedAt: now })
        .where('id', '=', row.transactionId)
        .executeTakeFirstOrThrow();
      await enqueueOutboxEvent(transaction, {
        aggregateType: 'transaction',
        aggregateId: receipt.transactionId,
        eventType:
          receipt.status === 'succeeded' ? 'transaction.delivered' : 'transaction.delivery_failed',
        payload: {
          merchantId,
          transactionId: receipt.transactionId,
          paymentProofId: receipt.paymentProofId,
          deliveryId,
          deliveryStatus: receipt.status,
          resultDigest: receipt.resultDigest,
          errorCode: receipt.errorCode,
        },
      });
      return Object.freeze({ receipt: toDeliveryReceiptWire(receipt) });
    });

    if ('error' in outcome) {
      throw new DeliveryReceiptError(outcome.error);
    }

    return outcome.receipt;
  }
}
