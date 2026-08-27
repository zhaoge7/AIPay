export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.mandates
      ADD COLUMN spent_amount_minor BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN completed_transaction_count INTEGER NOT NULL DEFAULT 0,
      ADD CONSTRAINT mandates_spent_amount_check CHECK (
        spent_amount_minor >= 0 AND spent_amount_minor <= total_budget_amount_minor
      ),
      ADD CONSTRAINT mandates_completed_count_check CHECK (
        completed_transaction_count >= 0 AND completed_transaction_count <= max_transactions
      );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.mandates
      DROP CONSTRAINT IF EXISTS mandates_completed_count_check,
      DROP CONSTRAINT IF EXISTS mandates_spent_amount_check,
      DROP COLUMN IF EXISTS completed_transaction_count,
      DROP COLUMN IF EXISTS spent_amount_minor;
  `);
};
