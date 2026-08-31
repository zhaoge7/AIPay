export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.transactions
      ADD COLUMN confirmation_required BOOLEAN NOT NULL DEFAULT FALSE;

    UPDATE aipay.transactions
      SET confirmation_required = TRUE
      WHERE status = 'requires_confirmation';

    ALTER TABLE aipay.transactions
      ADD CONSTRAINT transactions_confirmation_required_check CHECK (
        status <> 'requires_confirmation' OR confirmation_required
      );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.transactions
      DROP CONSTRAINT IF EXISTS transactions_confirmation_required_check,
      DROP COLUMN IF EXISTS confirmation_required;
  `);
};
