export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.quotes
      ALTER COLUMN proof_key_id DROP NOT NULL,
      ALTER COLUMN proof_value DROP NOT NULL,
      ADD COLUMN status TEXT NOT NULL DEFAULT 'draft',
      ADD CONSTRAINT quotes_status_check CHECK (status IN ('draft', 'active', 'expired')),
      ADD CONSTRAINT quotes_proof_presence_check CHECK (
        (status = 'draft' AND proof_key_id IS NULL AND proof_value IS NULL) OR
        (status <> 'draft' AND proof_key_id IS NOT NULL AND proof_value IS NOT NULL)
      );

    CREATE INDEX quotes_status_expiry_idx ON aipay.quotes(status, expires_at);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS aipay.quotes_status_expiry_idx;
    ALTER TABLE aipay.quotes
      DROP CONSTRAINT quotes_proof_presence_check,
      DROP CONSTRAINT quotes_status_check,
      DROP COLUMN status,
      ALTER COLUMN proof_key_id SET NOT NULL,
      ALTER COLUMN proof_value SET NOT NULL;
  `);
};
