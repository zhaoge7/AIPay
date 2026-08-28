export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.deliveries
      ADD COLUMN expires_at TIMESTAMPTZ(3),
      ADD COLUMN refund_policy TEXT;

    UPDATE aipay.deliveries AS delivery
      SET expires_at = delivery.created_at + INTERVAL '5 minutes',
          refund_policy = service.refund_policy
      FROM aipay.services AS service
      WHERE service.id = delivery.service_id;

    ALTER TABLE aipay.deliveries
      ALTER COLUMN expires_at SET NOT NULL,
      ALTER COLUMN refund_policy SET NOT NULL,
      ADD CONSTRAINT deliveries_expiry_check CHECK (
        expires_at > created_at AND expires_at <= created_at + INTERVAL '24 hours'
      ),
      ADD CONSTRAINT deliveries_refund_policy_check CHECK (
        refund_policy IN ('full_on_delivery_failure', 'non_refundable')
      );

    CREATE INDEX deliveries_timeout_idx
      ON aipay.deliveries(expires_at, id)
      WHERE status = 'pending';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS aipay.deliveries_timeout_idx;
    ALTER TABLE aipay.deliveries
      DROP CONSTRAINT deliveries_refund_policy_check,
      DROP CONSTRAINT deliveries_expiry_check,
      DROP COLUMN refund_policy,
      DROP COLUMN expires_at;
  `);
};
