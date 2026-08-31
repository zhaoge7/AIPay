import {
  createMoney,
  formatUtcDateTime,
  getResourceUuid,
  parseResourceId,
  type ResourceId,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';
import {
  evaluateAmountCountPolicy,
  evaluateApprovalPolicy,
  evaluateMerchantCategoryPolicy,
} from '@aipay/policy';

import { developerPaymentsPaused } from '../controls/service.js';

export type ManualApprovalErrorCode =
  | 'not_found'
  | 'inactive_mandate'
  | 'agent_unavailable'
  | 'quote_expired'
  | 'service_unavailable'
  | 'policy_denied'
  | 'approval_not_required'
  | 'limit_exceeded'
  | 'intent_exists'
  | 'invalid_state';

export class ManualApprovalError extends Error {
  readonly code: ManualApprovalErrorCode;

  constructor(code: ManualApprovalErrorCode) {
    super('Manual approval operation failed');
    this.name = 'ManualApprovalError';
    this.code = code;
  }
}

export interface ApprovalTransactionView {
  readonly transactionId: ResourceId<'txn'>;
  readonly quoteId: ResourceId<'qte'>;
  readonly mandateId: ResourceId<'mdt'>;
  readonly agentId: ResourceId<'agt'>;
  readonly merchantId: ResourceId<'mch'>;
  readonly serviceId: ResourceId<'svc'>;
  readonly amount: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly status: 'requires_confirmation' | 'authorized' | 'cancelled';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PendingApprovalView extends ApprovalTransactionView {
  readonly agentName: string;
  readonly merchantName: string;
  readonly serviceName: string;
  readonly mandatePurpose: string;
  readonly totalBudget: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly spentAmount: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly reservedAmount: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly remainingBudget: Readonly<{ currency: 'CNY'; amountMinor: string }>;
}

interface ApprovalTransactionRow {
  readonly id: string;
  readonly quoteId: string;
  readonly mandateId: string;
  readonly agentId: string;
  readonly merchantId: string;
  readonly serviceId: string;
  readonly currency: 'CNY';
  readonly amountMinor: string;
  readonly status:
    | 'requires_confirmation'
    | 'authorized'
    | 'cancelled'
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
    | 'failed';
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const transactionColumns = [
  'id',
  'quoteId',
  'mandateId',
  'agentId',
  'merchantId',
  'serviceId',
  'currency',
  'amountMinor',
  'status',
  'createdAt',
  'updatedAt',
] as const;

function toView(row: ApprovalTransactionRow): Readonly<ApprovalTransactionView> {
  if (
    row.status !== 'requires_confirmation' &&
    row.status !== 'authorized' &&
    row.status !== 'cancelled'
  ) {
    throw new ManualApprovalError('invalid_state');
  }

  return Object.freeze({
    transactionId: parseResourceId(`txn_${row.id}`, 'txn'),
    quoteId: parseResourceId(`qte_${row.quoteId}`, 'qte'),
    mandateId: parseResourceId(`mdt_${row.mandateId}`, 'mdt'),
    agentId: parseResourceId(`agt_${row.agentId}`, 'agt'),
    merchantId: parseResourceId(`mch_${row.merchantId}`, 'mch'),
    serviceId: parseResourceId(`svc_${row.serviceId}`, 'svc'),
    amount: createMoney(row.currency, row.amountMinor),
    status: row.status,
    createdAt: formatUtcDateTime(row.createdAt),
    updatedAt: formatUtcDateTime(row.updatedAt),
  });
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

export class ManualApprovalService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async listPending(
    principalId: ResourceId<'dev'>,
  ): Promise<readonly Readonly<PendingApprovalView>[]> {
    const rows = await this.#database
      .selectFrom('transactions')
      .innerJoin('agents', 'agents.id', 'transactions.agentId')
      .innerJoin('merchants', 'merchants.id', 'transactions.merchantId')
      .innerJoin('services', 'services.id', 'transactions.serviceId')
      .innerJoin('mandates', 'mandates.id', 'transactions.mandateId')
      .select([
        ...transactionColumns.map((column) => `transactions.${column}` as const),
        'agents.name as agentName',
        'merchants.name as merchantName',
        'services.name as serviceName',
        'mandates.purpose as mandatePurpose',
        'mandates.totalBudgetAmountMinor',
        'mandates.spentAmountMinor',
        'mandates.reservedAmountMinor',
      ])
      .where('transactions.principalId', '=', getResourceUuid(principalId))
      .where('transactions.status', '=', 'requires_confirmation')
      .orderBy('transactions.createdAt', 'asc')
      .orderBy('transactions.id', 'asc')
      .execute();

    return Object.freeze(
      rows.map((row) => {
        const transaction = toView(row);
        const remaining =
          BigInt(row.totalBudgetAmountMinor) -
          BigInt(row.spentAmountMinor) -
          BigInt(row.reservedAmountMinor);
        return Object.freeze({
          ...transaction,
          agentName: row.agentName,
          merchantName: row.merchantName,
          serviceName: row.serviceName,
          mandatePurpose: row.mandatePurpose,
          totalBudget: createMoney('CNY', row.totalBudgetAmountMinor),
          spentAmount: createMoney('CNY', row.spentAmountMinor),
          reservedAmount: createMoney('CNY', row.reservedAmountMinor),
          remainingBudget: createMoney('CNY', remaining.toString()),
        });
      }),
    );
  }

  async createPendingIntent(
    mandateId: ResourceId<'mdt'>,
    quoteId: ResourceId<'qte'>,
    agentId: ResourceId<'agt'>,
  ): Promise<Readonly<ApprovalTransactionView>> {
    const now = this.#now();

    try {
      return await this.#database.transaction().execute(async (transaction) => {
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
          throw new ManualApprovalError('not_found');
        }

        if (mandate.status !== 'active' || now >= mandate.validUntil) {
          throw new ManualApprovalError('inactive_mandate');
        }

        if (mandate.agentId !== getResourceUuid(agentId)) {
          throw new ManualApprovalError('agent_unavailable');
        }

        const agent = await transaction
          .selectFrom('agents')
          .select('status')
          .where('id', '=', mandate.agentId)
          .executeTakeFirst();

        if (agent?.status !== 'enabled') {
          throw new ManualApprovalError('agent_unavailable');
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
          throw new ManualApprovalError('service_unavailable');
        }

        if (
          quote.quoteStatus !== 'active' ||
          quote.serviceStatus !== 'enabled' ||
          quote.merchantStatus !== 'active'
        ) {
          throw new ManualApprovalError('service_unavailable');
        }

        if (now >= quote.expiresAt) {
          throw new ManualApprovalError('quote_expired');
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
        const merchantCategoryDecision = evaluateMerchantCategoryPolicy(
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

        if (!merchantCategoryDecision.allowed) {
          throw new ManualApprovalError('policy_denied');
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
          throw new ManualApprovalError('limit_exceeded');
        }

        const approval = evaluateApprovalPolicy(
          {
            approvalRequiredAbove: createMoney('CNY', mandate.approvalRequiredAboveAmountMinor),
          },
          amount,
        );

        if (!approval.requiresConfirmation) {
          throw new ManualApprovalError('approval_not_required');
        }

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
            confirmationRequired: true,
            status: 'requires_confirmation',
          })
          .returning(transactionColumns)
          .executeTakeFirstOrThrow();
        return toView(row);
      });
    } catch (error) {
      if (hasDatabaseConstraint(error, 'transactions_quote_unique')) {
        throw new ManualApprovalError('intent_exists');
      }

      throw error;
    }
  }

  async decide(
    principalId: ResourceId<'dev'>,
    transactionId: ResourceId<'txn'>,
    action: 'approve' | 'reject',
  ): Promise<Readonly<ApprovalTransactionView>> {
    const now = this.#now();

    return this.#database.transaction().execute(async (transaction) => {
      const reference = await transaction
        .selectFrom('transactions')
        .select(['mandateId', 'quoteId'])
        .where('id', '=', getResourceUuid(transactionId))
        .executeTakeFirst();

      if (reference === undefined) {
        throw new ManualApprovalError('not_found');
      }

      const mandate = await transaction
        .selectFrom('mandates')
        .select(['id', 'principalId', 'agentId', 'status', 'validUntil'])
        .where('id', '=', reference.mandateId)
        .where('principalId', '=', getResourceUuid(principalId))
        .forUpdate()
        .executeTakeFirst();

      if (mandate === undefined) {
        throw new ManualApprovalError('not_found');
      }

      const row = await transaction
        .selectFrom('transactions')
        .select(transactionColumns)
        .where('id', '=', getResourceUuid(transactionId))
        .forUpdate()
        .executeTakeFirstOrThrow();
      const expectedStatus = action === 'approve' ? 'authorized' : 'cancelled';

      if (row.status === expectedStatus) {
        return toView(row);
      }

      if (row.status !== 'requires_confirmation') {
        throw new ManualApprovalError('invalid_state');
      }

      if (action === 'approve') {
        if (await developerPaymentsPaused(transaction, mandate.principalId)) {
          throw new ManualApprovalError('inactive_mandate');
        }

        if (mandate.status !== 'active' || now >= mandate.validUntil) {
          throw new ManualApprovalError('inactive_mandate');
        }

        const agent = await transaction
          .selectFrom('agents')
          .select('status')
          .where('id', '=', mandate.agentId)
          .executeTakeFirst();
        const quote = await transaction
          .selectFrom('quotes')
          .select('expiresAt')
          .where('id', '=', reference.quoteId)
          .executeTakeFirstOrThrow();

        if (agent?.status !== 'enabled') {
          throw new ManualApprovalError('agent_unavailable');
        }

        if (now >= quote.expiresAt) {
          throw new ManualApprovalError('quote_expired');
        }
      }

      const updated = await transaction
        .updateTable('transactions')
        .set({ status: expectedStatus, updatedAt: now })
        .where('id', '=', row.id)
        .returning(transactionColumns)
        .executeTakeFirstOrThrow();
      return toView(updated);
    });
  }
}
