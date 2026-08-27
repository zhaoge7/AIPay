export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE aipay.idempotency_records (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      agent_id UUID NOT NULL REFERENCES aipay.agents(id) ON DELETE CASCADE,
      operation TEXT NOT NULL,
      key_hash BYTEA NOT NULL,
      request_hash BYTEA NOT NULL,
      transaction_id UUID REFERENCES aipay.transactions(id),
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ(3) NOT NULL,
      CONSTRAINT idempotency_records_scope_unique UNIQUE (agent_id, operation, key_hash),
      CONSTRAINT idempotency_records_key_hash_check CHECK (octet_length(key_hash) = 32),
      CONSTRAINT idempotency_records_request_hash_check CHECK (octet_length(request_hash) = 32),
      CONSTRAINT idempotency_records_operation_check CHECK (operation ~ '^[a-z][a-z0-9_.-]{0,63}$'),
      CONSTRAINT idempotency_records_validity_check CHECK (created_at < expires_at)
    );

    CREATE UNIQUE INDEX idempotency_records_transaction_unique
      ON aipay.idempotency_records(transaction_id)
      WHERE transaction_id IS NOT NULL;
    CREATE INDEX idempotency_records_expiry_idx ON aipay.idempotency_records(expires_at);
  `);
};

export const down = (pgm) => {
  pgm.dropTable({ schema: 'aipay', name: 'idempotency_records' }, { ifExists: true });
};
