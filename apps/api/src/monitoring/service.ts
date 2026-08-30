import type { Database } from '@aipay/database';
import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';

const paymentWindowMs = 5 * 60 * 1_000;

export interface MonitoringSnapshot {
  readonly paymentAttempts: number;
  readonly paymentFailures: number;
  readonly paymentFailureRatio: number;
  readonly outboxBacklog: number;
  readonly webhookBacklog: number;
  readonly reconciliationUnresolved: number;
  readonly mandatesNearExhaustion: number;
  readonly maximumBudgetUtilizationRatio: number;
}

export class MonitoringService {
  readonly #database: Database;
  readonly #registry = new Registry();
  readonly #now: () => Date;
  readonly #metrics: Readonly<Record<keyof MonitoringSnapshot, Gauge>>;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
    collectDefaultMetrics({ register: this.#registry, prefix: 'aipay_process_' });
    this.#metrics = Object.freeze({
      paymentAttempts: new Gauge({
        name: 'aipay_payment_attempts_window',
        help: 'Payment attempts created in the last five minutes',
        registers: [this.#registry],
      }),
      paymentFailures: new Gauge({
        name: 'aipay_payment_failures_window',
        help: 'Failed payment attempts created in the last five minutes',
        registers: [this.#registry],
      }),
      paymentFailureRatio: new Gauge({
        name: 'aipay_payment_failure_ratio',
        help: 'Failed payment attempt ratio over the last five minutes',
        registers: [this.#registry],
      }),
      outboxBacklog: new Gauge({
        name: 'aipay_outbox_backlog',
        help: 'Pending or processing transactional Outbox events',
        registers: [this.#registry],
      }),
      webhookBacklog: new Gauge({
        name: 'aipay_webhook_delivery_backlog',
        help: 'Pending merchant Webhook deliveries',
        registers: [this.#registry],
      }),
      reconciliationUnresolved: new Gauge({
        name: 'aipay_reconciliation_unresolved',
        help: 'Reconciliation items requiring review or with query failures',
        registers: [this.#registry],
      }),
      mandatesNearExhaustion: new Gauge({
        name: 'aipay_mandates_near_exhaustion',
        help: 'Active Mandates with at least ninety percent budget utilization',
        registers: [this.#registry],
      }),
      maximumBudgetUtilizationRatio: new Gauge({
        name: 'aipay_budget_maximum_utilization_ratio',
        help: 'Maximum active Mandate spent plus reserved budget ratio',
        registers: [this.#registry],
      }),
    });
  }

  async snapshot(): Promise<Readonly<MonitoringSnapshot>> {
    const windowStart = new Date(this.#now().getTime() - paymentWindowMs);
    const [attempts, failures, outbox, webhooks, reconciliation, mandates] = await Promise.all([
      this.#database
        .selectFrom('paymentAttempts')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('createdAt', '>=', windowStart)
        .executeTakeFirstOrThrow(),
      this.#database
        .selectFrom('paymentAttempts')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('createdAt', '>=', windowStart)
        .where('status', '=', 'failed')
        .executeTakeFirstOrThrow(),
      this.#database
        .selectFrom('outboxEvents')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('status', 'in', ['pending', 'processing'])
        .executeTakeFirstOrThrow(),
      this.#database
        .selectFrom('webhookDeliveries')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('status', '=', 'pending')
        .executeTakeFirstOrThrow(),
      this.#database
        .selectFrom('reconciliationItems')
        .select(({ fn }) => fn.countAll().as('count'))
        .where('resolution', 'in', ['manual_review', 'query_failed'])
        .executeTakeFirstOrThrow(),
      this.#database
        .selectFrom('mandates')
        .select(['totalBudgetAmountMinor', 'spentAmountMinor', 'reservedAmountMinor'])
        .where('status', '=', 'active')
        .execute(),
    ]);
    const paymentAttempts = Number(attempts.count);
    const paymentFailures = Number(failures.count);
    const utilization = mandates.map(
      (mandate) =>
        Number(
          ((BigInt(mandate.spentAmountMinor) + BigInt(mandate.reservedAmountMinor)) * 10_000n) /
            BigInt(mandate.totalBudgetAmountMinor),
        ) / 10_000,
    );
    return Object.freeze({
      paymentAttempts,
      paymentFailures,
      paymentFailureRatio: paymentAttempts === 0 ? 0 : paymentFailures / paymentAttempts,
      outboxBacklog: Number(outbox.count),
      webhookBacklog: Number(webhooks.count),
      reconciliationUnresolved: Number(reconciliation.count),
      mandatesNearExhaustion: utilization.filter((ratio) => ratio >= 0.9).length,
      maximumBudgetUtilizationRatio: utilization.length === 0 ? 0 : Math.max(...utilization),
    });
  }

  async metrics(): Promise<string> {
    const snapshot = await this.snapshot();

    for (const [name, value] of Object.entries(snapshot)) {
      this.#metrics[name as keyof MonitoringSnapshot].set(value);
    }

    return this.#registry.metrics();
  }

  get contentType(): string {
    return this.#registry.contentType;
  }
}
