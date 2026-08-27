export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE aipay.provider_webhook_events (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_digest BYTEA NOT NULL,
      payment_attempt_id UUID REFERENCES aipay.payment_attempts(id),
      outcome TEXT NOT NULL DEFAULT 'processing',
      received_at TIMESTAMPTZ(3) NOT NULL,
      occurred_at TIMESTAMPTZ(3) NOT NULL,
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT provider_webhook_events_identity_unique UNIQUE (provider, provider_event_id),
      CONSTRAINT provider_webhook_events_provider_check CHECK (provider ~ '^[a-z][a-z0-9_]{0,63}$'),
      CONSTRAINT provider_webhook_events_id_length_check CHECK (char_length(provider_event_id) BETWEEN 1 AND 128),
      CONSTRAINT provider_webhook_events_type_check CHECK (event_type IN ('payment.updated', 'refund.updated')),
      CONSTRAINT provider_webhook_events_digest_check CHECK (octet_length(payload_digest) = 32),
      CONSTRAINT provider_webhook_events_outcome_check CHECK (outcome IN ('processing', 'applied', 'ignored')),
      CONSTRAINT provider_webhook_events_result_check CHECK (
        (outcome = 'processing' AND payment_attempt_id IS NULL) OR
        (outcome <> 'processing' AND payment_attempt_id IS NOT NULL)
      )
    );

    CREATE INDEX provider_webhook_events_attempt_idx
      ON aipay.provider_webhook_events(payment_attempt_id, occurred_at)
      WHERE payment_attempt_id IS NOT NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS aipay.provider_webhook_events;');
};
