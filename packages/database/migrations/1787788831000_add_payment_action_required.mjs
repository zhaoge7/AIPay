export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.payment_attempts
      ADD COLUMN action_required BOOLEAN NOT NULL DEFAULT FALSE;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.payment_attempts
      DROP COLUMN IF EXISTS action_required;
  `);
};
