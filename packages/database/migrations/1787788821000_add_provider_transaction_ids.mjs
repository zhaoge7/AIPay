export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.payment_attempts
      ADD COLUMN provider_transaction_id TEXT,
      ADD CONSTRAINT payment_attempts_provider_transaction_id_check CHECK (
        provider_transaction_id IS NULL OR char_length(provider_transaction_id) BETWEEN 1 AND 128
      );

    ALTER TABLE aipay.payment_provider_calls
      ADD COLUMN provider_transaction_id TEXT,
      ADD CONSTRAINT payment_provider_calls_provider_transaction_id_check CHECK (
        provider_transaction_id IS NULL OR char_length(provider_transaction_id) BETWEEN 1 AND 128
      );

    CREATE INDEX payment_attempts_provider_transaction_idx
      ON aipay.payment_attempts(provider, provider_transaction_id)
      WHERE provider_transaction_id IS NOT NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS aipay.payment_attempts_provider_transaction_idx;
    ALTER TABLE aipay.payment_provider_calls DROP COLUMN IF EXISTS provider_transaction_id;
    ALTER TABLE aipay.payment_attempts DROP COLUMN IF EXISTS provider_transaction_id;
  `);
};
