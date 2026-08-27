export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.mandates
      DROP CONSTRAINT mandates_spent_amount_check,
      DROP CONSTRAINT mandates_completed_count_check,
      ADD COLUMN reserved_amount_minor BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN reserved_transaction_count INTEGER NOT NULL DEFAULT 0,
      ADD CONSTRAINT mandates_usage_amount_check CHECK (
        spent_amount_minor >= 0 AND reserved_amount_minor >= 0 AND
        spent_amount_minor::NUMERIC + reserved_amount_minor::NUMERIC <= total_budget_amount_minor
      ),
      ADD CONSTRAINT mandates_usage_count_check CHECK (
        completed_transaction_count >= 0 AND reserved_transaction_count >= 0 AND
        completed_transaction_count + reserved_transaction_count <= max_transactions
      );

    CREATE TABLE aipay.budget_reservations (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      mandate_id UUID NOT NULL REFERENCES aipay.mandates(id),
      agent_id UUID NOT NULL REFERENCES aipay.agents(id),
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      amount_minor BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'held',
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ(3) NOT NULL,
      finalized_at TIMESTAMPTZ(3),
      CONSTRAINT budget_reservations_currency_check CHECK (currency = 'CNY'),
      CONSTRAINT budget_reservations_amount_check CHECK (amount_minor > 0),
      CONSTRAINT budget_reservations_status_check CHECK (
        status IN ('held', 'released', 'confirmed', 'expired')
      ),
      CONSTRAINT budget_reservations_validity_check CHECK (created_at < expires_at),
      CONSTRAINT budget_reservations_finalization_check CHECK (
        (status = 'held' AND finalized_at IS NULL) OR
        (status <> 'held' AND finalized_at IS NOT NULL AND finalized_at >= created_at)
      )
    );

    CREATE INDEX budget_reservations_mandate_idx
      ON aipay.budget_reservations(mandate_id, status, created_at);
    CREATE INDEX budget_reservations_expiry_idx
      ON aipay.budget_reservations(expires_at)
      WHERE status = 'held';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS aipay.budget_reservations;
    ALTER TABLE aipay.mandates
      DROP CONSTRAINT mandates_usage_count_check,
      DROP CONSTRAINT mandates_usage_amount_check,
      DROP COLUMN reserved_transaction_count,
      DROP COLUMN reserved_amount_minor,
      ADD CONSTRAINT mandates_spent_amount_check CHECK (
        spent_amount_minor >= 0 AND spent_amount_minor <= total_budget_amount_minor
      ),
      ADD CONSTRAINT mandates_completed_count_check CHECK (
        completed_transaction_count >= 0 AND completed_transaction_count <= max_transactions
      );
  `);
};
