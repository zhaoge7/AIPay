export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE aipay.webhook_deliveries (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      outbox_event_id UUID NOT NULL UNIQUE REFERENCES aipay.outbox_events(id),
      merchant_id UUID NOT NULL REFERENCES aipay.merchants(id),
      target_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_status_code INTEGER,
      last_error_code TEXT,
      delivered_at TIMESTAMPTZ(3),
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT webhook_deliveries_target_check CHECK (target_url ~ '^https?://'),
      CONSTRAINT webhook_deliveries_status_check CHECK (status IN ('pending', 'delivered', 'dead_letter')),
      CONSTRAINT webhook_deliveries_attempt_check CHECK (attempt_count >= 0),
      CONSTRAINT webhook_deliveries_result_check CHECK (
        (status = 'delivered' AND delivered_at IS NOT NULL AND last_error_code IS NULL) OR
        (status <> 'delivered' AND delivered_at IS NULL)
      )
    );

    CREATE INDEX webhook_deliveries_pending_idx
      ON aipay.webhook_deliveries(next_attempt_at, id)
      WHERE status = 'pending';
    CREATE INDEX webhook_deliveries_merchant_idx
      ON aipay.webhook_deliveries(merchant_id, created_at);

    CREATE TABLE aipay.webhook_delivery_attempts (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      delivery_id UUID NOT NULL REFERENCES aipay.webhook_deliveries(id) ON DELETE CASCADE,
      attempt_number INTEGER NOT NULL,
      request_digest BYTEA NOT NULL,
      signing_key_id UUID NOT NULL REFERENCES aipay.signing_keys(id),
      outcome TEXT NOT NULL DEFAULT 'started',
      response_status_code INTEGER,
      error_code TEXT,
      started_at TIMESTAMPTZ(3) NOT NULL,
      completed_at TIMESTAMPTZ(3),
      duration_ms INTEGER,
      CONSTRAINT webhook_delivery_attempts_number_unique UNIQUE (delivery_id, attempt_number),
      CONSTRAINT webhook_delivery_attempts_digest_check CHECK (octet_length(request_digest) = 32),
      CONSTRAINT webhook_delivery_attempts_outcome_check CHECK (outcome IN ('started', 'delivered', 'failed')),
      CONSTRAINT webhook_delivery_attempts_duration_check CHECK (duration_ms IS NULL OR duration_ms >= 0),
      CONSTRAINT webhook_delivery_attempts_result_check CHECK (
        (outcome = 'started' AND completed_at IS NULL AND duration_ms IS NULL AND response_status_code IS NULL AND error_code IS NULL) OR
        (outcome = 'delivered' AND completed_at IS NOT NULL AND duration_ms >= 0 AND response_status_code BETWEEN 200 AND 299 AND error_code IS NULL) OR
        (outcome = 'failed' AND completed_at IS NOT NULL AND duration_ms >= 0 AND error_code IS NOT NULL)
      )
    );

    CREATE INDEX webhook_delivery_attempts_delivery_idx
      ON aipay.webhook_delivery_attempts(delivery_id, attempt_number);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS aipay.webhook_delivery_attempts;
    DROP TABLE IF EXISTS aipay.webhook_deliveries;
  `);
};
