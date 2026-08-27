export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.mandates
      ALTER COLUMN proof_key_id DROP NOT NULL,
      ALTER COLUMN proof_value DROP NOT NULL,
      ALTER COLUMN status SET DEFAULT 'draft';

    ALTER TABLE aipay.mandates
      DROP CONSTRAINT mandates_status_check,
      ADD CONSTRAINT mandates_status_check
        CHECK (status IN ('draft', 'active', 'paused', 'revoked', 'expired')),
      ADD CONSTRAINT mandates_proof_presence_check CHECK (
        (status = 'draft' AND proof_key_id IS NULL AND proof_value IS NULL) OR
        (status <> 'draft' AND proof_key_id IS NOT NULL AND proof_value IS NOT NULL)
      );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.mandates
      DROP CONSTRAINT mandates_proof_presence_check,
      DROP CONSTRAINT mandates_status_check,
      ADD CONSTRAINT mandates_status_check
        CHECK (status IN ('active', 'paused', 'revoked', 'expired')),
      ALTER COLUMN status SET DEFAULT 'active',
      ALTER COLUMN proof_key_id SET NOT NULL,
      ALTER COLUMN proof_value SET NOT NULL;
  `);
};
