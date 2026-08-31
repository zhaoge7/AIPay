import { Buffer } from 'node:buffer';

import pg from 'pg';

const { Pool } = pg;

export type AdapterDeliveryState = 'claimed' | 'consumed' | 'result_ready' | 'completed';
export type AdapterDeliveryOutcome = 'succeeded' | 'failed';

export interface AdapterDeliveryRecord {
  readonly paymentProofId: string;
  readonly resourceUrl: string;
  readonly proofDigest: Buffer;
  readonly state: AdapterDeliveryState;
  readonly deliveryId: string | null;
  readonly consumedAt: string | null;
  readonly outcome: AdapterDeliveryOutcome | null;
  readonly resultText: string | null;
  readonly completedAt: string | null;
}

export interface AdapterDeliveryStore {
  initialize(): Promise<void>;
  withProofLock<Result>(paymentProofId: string, operation: () => Promise<Result>): Promise<Result>;
  claim(paymentProofId: string, resourceUrl: string, proofDigest: Buffer): Promise<void>;
  get(paymentProofId: string): Promise<Readonly<AdapterDeliveryRecord>>;
  markConsumed(paymentProofId: string, deliveryId: string, consumedAt: string): Promise<void>;
  markResult(
    paymentProofId: string,
    outcome: AdapterDeliveryOutcome,
    resultText: string,
  ): Promise<void>;
  markCompleted(paymentProofId: string): Promise<void>;
}

interface DeliveryRow {
  payment_proof_id: string;
  resource_url: string;
  proof_digest: Buffer;
  state: AdapterDeliveryState;
  delivery_id: string | null;
  consumed_at: Date | null;
  outcome: AdapterDeliveryOutcome | null;
  result_text: string | null;
  completed_at: Date | null;
}

function record(row: DeliveryRow): Readonly<AdapterDeliveryRecord> {
  return Object.freeze({
    paymentProofId: row.payment_proof_id,
    resourceUrl: row.resource_url,
    proofDigest: Buffer.from(row.proof_digest),
    state: row.state,
    deliveryId: row.delivery_id,
    consumedAt: row.consumed_at?.toISOString() ?? null,
    outcome: row.outcome,
    resultText: row.result_text,
    completedAt: row.completed_at?.toISOString() ?? null,
  });
}

export class PostgresAdapterDeliveryStore implements AdapterDeliveryStore {
  readonly #pool: InstanceType<typeof Pool>;

  constructor(databaseUrl: string) {
    this.#pool = new Pool({ connectionString: databaseUrl, max: 8 });
  }

  async initialize(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS aipay_merchant_adapter_deliveries (
        payment_proof_id TEXT PRIMARY KEY,
        resource_url TEXT NOT NULL,
        proof_digest BYTEA NOT NULL,
        state TEXT NOT NULL,
        delivery_id TEXT,
        consumed_at TIMESTAMPTZ(3),
        outcome TEXT,
        result_text TEXT,
        completed_at TIMESTAMPTZ(3),
        created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT adapter_proof_id_check CHECK (payment_proof_id ~ '^ppf_[0-9a-f-]{36}$'),
        CONSTRAINT adapter_digest_check CHECK (octet_length(proof_digest) = 32),
        CONSTRAINT adapter_state_check CHECK (state IN ('claimed', 'consumed', 'result_ready', 'completed')),
        CONSTRAINT adapter_outcome_check CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed')),
        CONSTRAINT adapter_result_size_check CHECK (result_text IS NULL OR octet_length(result_text) <= 262144),
        CONSTRAINT adapter_state_fields_check CHECK (
          (state = 'claimed' AND delivery_id IS NULL AND consumed_at IS NULL AND outcome IS NULL AND result_text IS NULL AND completed_at IS NULL) OR
          (state = 'consumed' AND delivery_id IS NOT NULL AND consumed_at IS NOT NULL AND outcome IS NULL AND result_text IS NULL AND completed_at IS NULL) OR
          (state = 'result_ready' AND delivery_id IS NOT NULL AND consumed_at IS NOT NULL AND outcome IS NOT NULL AND result_text IS NOT NULL AND completed_at IS NULL) OR
          (state = 'completed' AND delivery_id IS NOT NULL AND consumed_at IS NOT NULL AND outcome IS NOT NULL AND result_text IS NOT NULL AND completed_at IS NOT NULL)
        )
      )
    `);
  }

  async withProofLock<Result>(
    paymentProofId: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const client = await this.#pool.connect();

    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [paymentProofId]);

      try {
        return await operation();
      } finally {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [paymentProofId]);
      }
    } finally {
      client.release();
    }
  }

  async claim(paymentProofId: string, resourceUrl: string, proofDigest: Buffer): Promise<void> {
    await this.#pool.query(
      `INSERT INTO aipay_merchant_adapter_deliveries
        (payment_proof_id, resource_url, proof_digest, state)
       VALUES ($1, $2, $3, 'claimed')
       ON CONFLICT (payment_proof_id) DO NOTHING`,
      [paymentProofId, resourceUrl, proofDigest],
    );
  }

  async get(paymentProofId: string): Promise<Readonly<AdapterDeliveryRecord>> {
    const result = await this.#pool.query<DeliveryRow>(
      `SELECT payment_proof_id, resource_url, proof_digest, state, delivery_id,
              consumed_at, outcome, result_text, completed_at
         FROM aipay_merchant_adapter_deliveries
        WHERE payment_proof_id = $1`,
      [paymentProofId],
    );
    const row = result.rows[0];

    if (row === undefined) throw new Error('Adapter delivery claim is missing');
    return record(row);
  }

  async markConsumed(
    paymentProofId: string,
    deliveryId: string,
    consumedAt: string,
  ): Promise<void> {
    await this.#update(
      `UPDATE aipay_merchant_adapter_deliveries
          SET state = 'consumed', delivery_id = $2, consumed_at = $3, updated_at = CURRENT_TIMESTAMP
        WHERE payment_proof_id = $1 AND state = 'claimed'`,
      [paymentProofId, deliveryId, consumedAt],
    );
  }

  async markResult(
    paymentProofId: string,
    outcome: AdapterDeliveryOutcome,
    resultText: string,
  ): Promise<void> {
    await this.#update(
      `UPDATE aipay_merchant_adapter_deliveries
          SET state = 'result_ready', outcome = $2, result_text = $3, updated_at = CURRENT_TIMESTAMP
        WHERE payment_proof_id = $1 AND state = 'consumed'`,
      [paymentProofId, outcome, resultText],
    );
  }

  async markCompleted(paymentProofId: string): Promise<void> {
    await this.#update(
      `UPDATE aipay_merchant_adapter_deliveries
          SET state = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE payment_proof_id = $1 AND state = 'result_ready'`,
      [paymentProofId],
    );
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #update(query: string, values: readonly unknown[]): Promise<void> {
    const result = await this.#pool.query(query, values as unknown[]);

    if (result.rowCount !== 1) throw new Error('Adapter delivery state transition failed');
  }
}
