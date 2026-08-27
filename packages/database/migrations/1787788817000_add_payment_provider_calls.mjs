export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.payment_attempts
      DROP CONSTRAINT payment_attempts_error_check,
      ADD CONSTRAINT payment_attempts_error_check CHECK (
        (status IN ('failed', 'unknown') AND error_code IS NOT NULL) OR
        (status IN ('pending', 'succeeded') AND error_code IS NULL)
      );

    CREATE TABLE aipay.payment_provider_calls (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      payment_attempt_id UUID NOT NULL REFERENCES aipay.payment_attempts(id) ON DELETE CASCADE,
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
      CONSTRAINT payment_provider_calls_operation_check CHECK (
        operation IN ('payment.create', 'payment.query')
      ),
      CONSTRAINT payment_provider_calls_digest_check CHECK (octet_length(request_digest) = 32),
      CONSTRAINT payment_provider_calls_outcome_check CHECK (outcome IN ('started', 'succeeded', 'failed')),
      CONSTRAINT payment_provider_calls_status_check CHECK (
        provider_status IS NULL OR provider_status IN ('pending', 'succeeded', 'failed', 'unknown')
      ),
      CONSTRAINT payment_provider_calls_completion_check CHECK (
        (outcome = 'started' AND completed_at IS NULL AND duration_ms IS NULL AND error_kind IS NULL AND error_code IS NULL) OR
        (outcome = 'succeeded' AND completed_at IS NOT NULL AND duration_ms >= 0 AND error_kind IS NULL AND error_code IS NULL) OR
        (outcome = 'failed' AND completed_at IS NOT NULL AND duration_ms >= 0 AND error_kind IS NOT NULL AND error_code IS NOT NULL)
      )
    );

    CREATE INDEX payment_provider_calls_attempt_idx
      ON aipay.payment_provider_calls(payment_attempt_id, started_at, id);
    CREATE INDEX payment_provider_calls_incomplete_idx
      ON aipay.payment_provider_calls(started_at)
      WHERE outcome = 'started';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS aipay.payment_provider_calls;
    ALTER TABLE aipay.payment_attempts
      DROP CONSTRAINT payment_attempts_error_check,
      ADD CONSTRAINT payment_attempts_error_check CHECK (
        (status = 'failed' AND error_code IS NOT NULL) OR
        (status <> 'failed' AND error_code IS NULL)
      );
  `);
};
