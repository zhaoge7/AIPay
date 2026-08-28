export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE aipay.refund_provider_calls (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      refund_id UUID NOT NULL REFERENCES aipay.refunds(id),
      operation TEXT NOT NULL,
      request_digest BYTEA NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'started',
      provider_status TEXT,
      provider_reference TEXT,
      error_kind TEXT,
      error_code TEXT,
      started_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ(3),
      duration_ms INTEGER,
      CONSTRAINT refund_provider_calls_operation_check CHECK (operation IN ('refund.create', 'refund.query')),
      CONSTRAINT refund_provider_calls_digest_check CHECK (octet_length(request_digest) = 32),
      CONSTRAINT refund_provider_calls_outcome_check CHECK (outcome IN ('started', 'succeeded', 'failed')),
      CONSTRAINT refund_provider_calls_status_check CHECK (
        provider_status IS NULL OR provider_status IN ('pending', 'succeeded', 'failed', 'unknown')
      ),
      CONSTRAINT refund_provider_calls_duration_check CHECK (duration_ms IS NULL OR duration_ms >= 0),
      CONSTRAINT refund_provider_calls_result_check CHECK (
        (outcome = 'started' AND completed_at IS NULL AND duration_ms IS NULL AND provider_status IS NULL AND error_kind IS NULL AND error_code IS NULL) OR
        (outcome = 'succeeded' AND completed_at IS NOT NULL AND duration_ms >= 0 AND provider_status IS NOT NULL AND error_kind IS NULL AND error_code IS NULL) OR
        (outcome = 'failed' AND completed_at IS NOT NULL AND duration_ms >= 0 AND provider_status IS NOT NULL AND error_kind IS NOT NULL AND error_code IS NOT NULL)
      )
    );

    CREATE INDEX refund_provider_calls_refund_idx
      ON aipay.refund_provider_calls(refund_id, started_at);
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS aipay.refund_provider_calls;');
};
