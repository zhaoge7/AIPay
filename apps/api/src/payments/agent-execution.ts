import { getResourceUuid, parseResourceId, type ResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { PaymentProvider } from '@aipay/payment';

import { BudgetReservationError, BudgetReservationService } from '../mandates/reservations.js';
import {
  PaymentExecutionError,
  PaymentExecutionService,
  type PaymentAttemptView,
} from './execution.js';

export type AgentPaymentErrorCode = 'not_found' | 'invalid_state' | 'budget_denied';

export class AgentPaymentError extends Error {
  readonly code: AgentPaymentErrorCode;

  constructor(code: AgentPaymentErrorCode) {
    super('Agent payment operation failed');
    this.name = 'AgentPaymentError';
    this.code = code;
  }
}

interface OwnedTransaction {
  readonly transactionId: ResourceId<'txn'>;
  readonly mandateId: ResourceId<'mdt'>;
  readonly amountMinor: string;
  readonly status: string;
}

export class AgentPaymentExecutionService {
  readonly #database: Database;
  readonly #provider: PaymentProvider;
  readonly #execution: PaymentExecutionService;
  readonly #reservations: BudgetReservationService;

  constructor(database: Database, provider: PaymentProvider, callbackUrl: string) {
    this.#database = database;
    this.#provider = provider;
    this.#execution = new PaymentExecutionService(database, callbackUrl);
    this.#reservations = new BudgetReservationService(database);
  }

  async create(
    agentId: ResourceId<'agt'>,
    transactionId: ResourceId<'txn'>,
  ): Promise<Readonly<PaymentAttemptView>> {
    const owned = await this.#ownedTransaction(agentId, transactionId);

    if (owned.status === 'payment_pending' || owned.status === 'payment_review') {
      const existing = await this.#execution.latest(transactionId);

      if (existing === null) {
        throw new AgentPaymentError('invalid_state');
      }

      try {
        const retried = await this.#execution.retryCreate(
          existing.paymentAttemptId,
          this.#provider,
        );
        await this.#finalize(retried);
        return retried;
      } catch (error) {
        await this.#finalizeLatest(transactionId);
        throw error;
      }
    }

    if (owned.status === 'paid' || owned.status === 'failed') {
      const existing = await this.#execution.latest(transactionId);

      if (existing === null) {
        throw new AgentPaymentError('invalid_state');
      }

      await this.#finalize(existing);
      return existing;
    }

    if (owned.status !== 'authorized') {
      throw new AgentPaymentError('invalid_state');
    }

    let reservationId: ResourceId<'rsv'>;

    try {
      const reservation = await this.#reservations.reserve(
        owned.mandateId,
        agentId,
        owned.amountMinor,
      );
      reservationId = reservation.reservationId;
    } catch (error) {
      if (error instanceof BudgetReservationError) {
        throw new AgentPaymentError('budget_denied');
      }

      throw error;
    }

    try {
      const attempt = await this.#execution.create(transactionId, this.#provider, reservationId);
      await this.#finalize(attempt);
      return attempt;
    } catch (error) {
      const attempt = await this.#execution.latest(transactionId);

      if (attempt?.reservationId !== reservationId) {
        await this.#reservations.release(reservationId, 'cancelled');
      } else {
        await this.#finalize(attempt);
      }

      throw error;
    }
  }

  async query(
    agentId: ResourceId<'agt'>,
    paymentAttemptId: ResourceId<'pat'>,
  ): Promise<Readonly<PaymentAttemptView>> {
    const ownership = await this.#database
      .selectFrom('paymentAttempts')
      .innerJoin('transactions', 'transactions.id', 'paymentAttempts.transactionId')
      .select('paymentAttempts.id')
      .where('paymentAttempts.id', '=', getResourceUuid(paymentAttemptId))
      .where('transactions.agentId', '=', getResourceUuid(agentId))
      .executeTakeFirst();

    if (ownership === undefined) {
      throw new AgentPaymentError('not_found');
    }

    try {
      const attempt = await this.#execution.query(paymentAttemptId, this.#provider);
      await this.#finalize(attempt);
      return attempt;
    } catch (error) {
      if (error instanceof PaymentExecutionError && error.code === 'not_found') {
        throw new AgentPaymentError('not_found');
      }

      const transaction = await this.#database
        .selectFrom('paymentAttempts')
        .select('transactionId')
        .where('id', '=', getResourceUuid(paymentAttemptId))
        .executeTakeFirst();

      if (transaction !== undefined) {
        await this.#finalizeLatest(parseResourceId(`txn_${transaction.transactionId}`, 'txn'));
      }

      throw error;
    }
  }

  async #ownedTransaction(
    agentId: ResourceId<'agt'>,
    transactionId: ResourceId<'txn'>,
  ): Promise<Readonly<OwnedTransaction>> {
    const transaction = await this.#database
      .selectFrom('transactions')
      .select(['id', 'mandateId', 'amountMinor', 'status'])
      .where('id', '=', getResourceUuid(transactionId))
      .where('agentId', '=', getResourceUuid(agentId))
      .executeTakeFirst();

    if (transaction === undefined) {
      throw new AgentPaymentError('not_found');
    }

    return Object.freeze({
      transactionId,
      mandateId: parseResourceId(`mdt_${transaction.mandateId}`, 'mdt'),
      amountMinor: transaction.amountMinor,
      status: transaction.status,
    });
  }

  async #finalizeLatest(transactionId: ResourceId<'txn'>): Promise<void> {
    const attempt = await this.#execution.latest(transactionId);

    if (attempt !== null) {
      await this.#finalize(attempt);
    }
  }

  async #finalize(attempt: Readonly<PaymentAttemptView>): Promise<void> {
    if (attempt.reservationId === null) {
      return;
    }

    if (attempt.status === 'succeeded') {
      await this.#reservations.confirm(attempt.reservationId);
    } else if (attempt.status === 'failed') {
      await this.#reservations.release(attempt.reservationId, 'payment_failed');
    }
  }
}
