import { createHash, timingSafeEqual } from 'node:crypto';

import {
  createMoney,
  getResourceUuid,
  parseResourceId,
  parseTransaction,
  toTransactionWire,
  type ResourceId,
  type TransactionWire,
} from '@aipay/contracts';
import type { Database, DatabaseTransaction } from '@aipay/database';
import {
  evaluateAmountCountPolicy,
  evaluateApprovalPolicy,
  evaluateMerchantCategoryPolicy,
} from '@aipay/policy';

export type TransactionCreationErrorCode =
  | 'not_found'
  | 'mandate_inactive'
  | 'quote_expired'
  | 'quote_inactive'
  | 'agent_unavailable'
  | 'policy_denied'
  | 'limit_exceeded'
  | 'transaction_exists'
  | 'invalid_idempotency_key'
  | 'idempotency_conflict'
  | 'idempotency_in_progress';

export class TransactionCreationError extends Error {
  readonly code: TransactionCreationErrorCode;

  constructor(code: TransactionCreationErrorCode) {
    super('Transaction creation failed');
    this.name = 'TransactionCreationError';
    this.code = code;
  }
}

function hasDatabaseConstraint(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}

const transactionColumns = [
  'id',
  'quoteId',
  'mandateId',
  'principalId',
  'agentId',
  'merchantId',
  'serviceId',
  'currency',
  'amountMinor',
  'status',
  'createdAt',
  'updatedAt',
] as const;

interface TransactionRow {
  readonly id: string;
  readonly quoteId: string;
  readonly mandateId: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly merchantId: string;
  readonly serviceId: string;
  readonly currency: 'CNY';
  readonly amountMinor: string;
  readonly status:
    | 'requires_confirmation'
    | 'authorized'
    | 'payment_pending'
    | 'payment_review'
    | 'paid'
    | 'delivery_pending'
    | 'delivery_review'
    | 'delivered'
    | 'refund_pending'
    | 'refund_review'
    | 'refunded'
    | 'settled'
    | 'failed'
    | 'cancelled';
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function rowToWire(row: TransactionRow): Readonly<TransactionWire> {
  const contract = parseTransaction({
    schemaVersion: '1',
    transactionId: `txn_${row.id}`,
    quoteId: `qte_${row.quoteId}`,
    mandateId: `mdt_${row.mandateId}`,
    principalId: `dev_${row.principalId}`,
    agentId: `agt_${row.agentId}`,
    merchantId: `mch_${row.merchantId}`,
    serviceId: `svc_${row.serviceId}`,
    amount: { currency: row.currency, amountMinor: row.amountMinor },
    status: row.status,
    paymentAttemptIds: [],
    deliveryId: null,
    refundIds: [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  return toTransactionWire(contract);
}

async function loadTransaction(
  transaction: DatabaseTransaction,
  transactionId: string,
): Promise<Readonly<TransactionWire>> {
  const row = await transaction
    .selectFrom('transactions')
    .select(transactionColumns)
    .where('id', '=', transactionId)
    .executeTakeFirstOrThrow();
  return rowToWire(row);
}

export class TransactionCreationService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async create(
    agentId: ResourceId<'agt'>,
    quoteId: ResourceId<'qte'>,
    mandateId: ResourceId<'mdt'>,
    idempotencyKey: string,
  ): Promise<Readonly<TransactionWire>> {
    if (!/^[A-Za-z0-9._~-]{16,128}$/u.test(idempotencyKey)) {
      throw new TransactionCreationError('invalid_idempotency_key');
    }

    const now = this.#now();
    const keyHash = createHash('sha256').update(idempotencyKey, 'utf8').digest();
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ quoteId, mandateId }), 'utf8')
      .digest();

    try {
      return await this.#database.transaction().execute(async (transaction) => {
        const idempotencyAgent = await transaction
          .selectFrom('agents')
          .select('status')
          .where('id', '=', getResourceUuid(agentId))
          .executeTakeFirst();

        if (idempotencyAgent?.status !== 'enabled') {
          throw new TransactionCreationError('agent_unavailable');
        }

        const insertedIdempotency = await transaction
          .insertInto('idempotencyRecords')
          .values({
            agentId: getResourceUuid(agentId),
            operation: 'transaction.create',
            keyHash,
            requestHash,
            transactionId: null,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
          })
          .onConflict((conflict) =>
            conflict.columns(['agentId', 'operation', 'keyHash']).doNothing(),
          )
          .returning('id')
          .executeTakeFirst();

        if (insertedIdempotency === undefined) {
          const existing = await transaction
            .selectFrom('idempotencyRecords')
            .select(['id', 'requestHash', 'transactionId'])
            .where('agentId', '=', getResourceUuid(agentId))
            .where('operation', '=', 'transaction.create')
            .where('keyHash', '=', keyHash)
            .forUpdate()
            .executeTakeFirstOrThrow();

          if (
            existing.requestHash.byteLength !== requestHash.byteLength ||
            !timingSafeEqual(existing.requestHash, requestHash)
          ) {
            throw new TransactionCreationError('idempotency_conflict');
          }

          if (existing.transactionId === null) {
            throw new TransactionCreationError('idempotency_in_progress');
          }

          return loadTransaction(transaction, existing.transactionId);
        }

        const idempotencyRecordId = insertedIdempotency.id;
        const mandate = await transaction
          .selectFrom('mandates')
          .select([
            'id',
            'principalId',
            'agentId',
            'status',
            'validUntil',
            'maxPerTransactionAmountMinor',
            'totalBudgetAmountMinor',
            'approvalRequiredAboveAmountMinor',
            'maxTransactions',
            'spentAmountMinor',
            'completedTransactionCount',
            'reservedAmountMinor',
            'reservedTransactionCount',
          ])
          .where('id', '=', getResourceUuid(mandateId))
          .forUpdate()
          .executeTakeFirst();

        if (mandate === undefined) {
          throw new TransactionCreationError('not_found');
        }

        if (mandate.status !== 'active' || now >= mandate.validUntil) {
          throw new TransactionCreationError('mandate_inactive');
        }

        if (mandate.agentId !== getResourceUuid(agentId)) {
          throw new TransactionCreationError('agent_unavailable');
        }

        const agent = await transaction
          .selectFrom('agents')
          .select('status')
          .where('id', '=', mandate.agentId)
          .executeTakeFirst();

        if (agent?.status !== 'enabled') {
          throw new TransactionCreationError('agent_unavailable');
        }

        const quote = await transaction
          .selectFrom('quotes')
          .innerJoin('services', 'services.id', 'quotes.serviceId')
          .innerJoin('merchants', 'merchants.id', 'quotes.merchantId')
          .select([
            'quotes.id',
            'quotes.merchantId',
            'quotes.serviceId',
            'quotes.currency',
            'quotes.totalAmountMinor',
            'quotes.expiresAt',
            'quotes.status as quoteStatus',
            'services.category',
            'services.status as serviceStatus',
            'merchants.status as merchantStatus',
          ])
          .where('quotes.id', '=', getResourceUuid(quoteId))
          .executeTakeFirst();

        if (quote === undefined) {
          throw new TransactionCreationError('not_found');
        }

        if (
          quote.quoteStatus !== 'active' ||
          quote.serviceStatus !== 'enabled' ||
          quote.merchantStatus !== 'active'
        ) {
          throw new TransactionCreationError('quote_inactive');
        }

        if (now >= quote.expiresAt) {
          throw new TransactionCreationError('quote_expired');
        }

        const allowedMerchants = await transaction
          .selectFrom('mandateAllowedMerchants')
          .select('merchantId')
          .where('mandateId', '=', mandate.id)
          .execute();
        const allowedCategories = await transaction
          .selectFrom('mandateAllowedCategories')
          .select('category')
          .where('mandateId', '=', mandate.id)
          .execute();
        const scopeDecision = evaluateMerchantCategoryPolicy(
          {
            allowedMerchantIds: allowedMerchants.map(({ merchantId }) =>
              parseResourceId(`mch_${merchantId}`, 'mch'),
            ),
            allowedCategories: allowedCategories.map(({ category }) => category),
          },
          {
            merchantId: parseResourceId(`mch_${quote.merchantId}`, 'mch'),
            category: quote.category,
          },
        );

        if (!scopeDecision.allowed) {
          throw new TransactionCreationError('policy_denied');
        }

        const amount = createMoney(quote.currency, quote.totalAmountMinor);
        const limitDecision = evaluateAmountCountPolicy(
          {
            maxPerTransaction: createMoney('CNY', mandate.maxPerTransactionAmountMinor),
            totalBudget: createMoney('CNY', mandate.totalBudgetAmountMinor),
            maxTransactions: mandate.maxTransactions,
          },
          {
            spentAmountMinor: (
              BigInt(mandate.spentAmountMinor) + BigInt(mandate.reservedAmountMinor)
            ).toString(),
            completedTransactionCount:
              mandate.completedTransactionCount + mandate.reservedTransactionCount,
          },
          amount,
        );

        if (!limitDecision.allowed) {
          throw new TransactionCreationError('limit_exceeded');
        }

        const approval = evaluateApprovalPolicy(
          {
            approvalRequiredAbove: createMoney('CNY', mandate.approvalRequiredAboveAmountMinor),
          },
          amount,
        );
        const row = await transaction
          .insertInto('transactions')
          .values({
            quoteId: quote.id,
            mandateId: mandate.id,
            principalId: mandate.principalId,
            agentId: mandate.agentId,
            merchantId: quote.merchantId,
            serviceId: quote.serviceId,
            amountMinor: amount.amountMinor,
            status: approval.requiresConfirmation ? 'requires_confirmation' : 'authorized',
          })
          .returning(transactionColumns)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable('idempotencyRecords')
          .set({ transactionId: row.id })
          .where('id', '=', idempotencyRecordId)
          .executeTakeFirstOrThrow();
        return rowToWire(row);
      });
    } catch (error) {
      if (hasDatabaseConstraint(error, 'transactions_quote_unique')) {
        throw new TransactionCreationError('transaction_exists');
      }

      throw error;
    }
  }
}
