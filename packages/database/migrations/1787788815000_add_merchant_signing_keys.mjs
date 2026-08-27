export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.quotes
      DROP CONSTRAINT quotes_proof_presence_check,
      ADD CONSTRAINT quotes_proof_presence_check CHECK (
        (status = 'draft' AND proof_key_id IS NULL AND proof_value IS NULL) OR
        (status = 'active' AND proof_key_id IS NOT NULL AND proof_value IS NOT NULL) OR
        (status = 'expired' AND ((proof_key_id IS NULL AND proof_value IS NULL) OR
          (proof_key_id IS NOT NULL AND proof_value IS NOT NULL)))
      );

    CREATE UNIQUE INDEX signing_keys_active_merchant_unique
      ON aipay.signing_keys(merchant_id)
      WHERE owner_type = 'merchant' AND status = 'active';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS aipay.signing_keys_active_merchant_unique;
    ALTER TABLE aipay.quotes
      DROP CONSTRAINT quotes_proof_presence_check,
      ADD CONSTRAINT quotes_proof_presence_check CHECK (
        (status = 'draft' AND proof_key_id IS NULL AND proof_value IS NULL) OR
        (status <> 'draft' AND proof_key_id IS NOT NULL AND proof_value IS NOT NULL)
      );
  `);
};
