export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.mandates
      ADD COLUMN status_changed_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ADD COLUMN revoked_at TIMESTAMPTZ(3),
      ADD CONSTRAINT mandates_revocation_check CHECK (
        (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_at >= created_at) OR
        (status <> 'revoked' AND revoked_at IS NULL)
      );

    CREATE INDEX mandates_status_validity_idx
      ON aipay.mandates(status, valid_until)
      WHERE status IN ('active', 'paused');
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS aipay.mandates_status_validity_idx;
    ALTER TABLE aipay.mandates
      DROP CONSTRAINT IF EXISTS mandates_revocation_check,
      DROP COLUMN IF EXISTS revoked_at,
      DROP COLUMN IF EXISTS status_changed_at;
  `);
};
