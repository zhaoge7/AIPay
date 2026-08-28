export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.payment_proofs
      ADD CONSTRAINT payment_proofs_delivery_binding_unique
      UNIQUE (id, transaction_id, merchant_id, service_id);

    ALTER TABLE aipay.deliveries
      DROP CONSTRAINT deliveries_result_check,
      ADD COLUMN payment_proof_id UUID NOT NULL,
      ADD COLUMN merchant_id UUID NOT NULL,
      ADD COLUMN service_id UUID NOT NULL,
      ADD COLUMN error_code TEXT,
      ADD COLUMN proof_scheme TEXT,
      ADD COLUMN proof_key_id UUID REFERENCES aipay.signing_keys(id),
      ADD COLUMN proof_value BYTEA,
      ADD CONSTRAINT deliveries_payment_proof_unique UNIQUE (payment_proof_id),
      ADD CONSTRAINT deliveries_payment_proof_binding_fk
        FOREIGN KEY (payment_proof_id, transaction_id, merchant_id, service_id)
        REFERENCES aipay.payment_proofs(id, transaction_id, merchant_id, service_id),
      ADD CONSTRAINT deliveries_proof_scheme_check CHECK (
        proof_scheme IS NULL OR proof_scheme = 'aipay-jcs-ed25519-v1'
      ),
      ADD CONSTRAINT deliveries_proof_value_check CHECK (
        proof_value IS NULL OR octet_length(proof_value) = 64
      ),
      ADD CONSTRAINT deliveries_receipt_result_check CHECK (
        (
          status IN ('succeeded', 'failed') AND
          result_digest IS NOT NULL AND octet_length(result_digest) = 32 AND
          delivered_at IS NOT NULL AND
          proof_scheme = 'aipay-jcs-ed25519-v1' AND
          proof_key_id IS NOT NULL AND
          proof_value IS NOT NULL AND
          ((status = 'succeeded' AND error_code IS NULL) OR (status = 'failed' AND error_code IS NOT NULL))
        ) OR
        (
          status NOT IN ('succeeded', 'failed') AND
          result_digest IS NULL AND delivered_at IS NULL AND error_code IS NULL AND
          proof_scheme IS NULL AND proof_key_id IS NULL AND proof_value IS NULL
        )
      );

    CREATE INDEX deliveries_payment_proof_idx ON aipay.deliveries(payment_proof_id);
    CREATE INDEX deliveries_merchant_idx ON aipay.deliveries(merchant_id, created_at);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS aipay.deliveries_merchant_idx;
    DROP INDEX IF EXISTS aipay.deliveries_payment_proof_idx;
    ALTER TABLE aipay.deliveries
      DROP CONSTRAINT deliveries_receipt_result_check,
      DROP CONSTRAINT deliveries_proof_value_check,
      DROP CONSTRAINT deliveries_proof_scheme_check,
      DROP CONSTRAINT deliveries_payment_proof_binding_fk,
      DROP CONSTRAINT deliveries_payment_proof_unique,
      DROP COLUMN proof_value,
      DROP COLUMN proof_key_id,
      DROP COLUMN proof_scheme,
      DROP COLUMN error_code,
      DROP COLUMN service_id,
      DROP COLUMN merchant_id,
      DROP COLUMN payment_proof_id,
      ADD CONSTRAINT deliveries_result_check CHECK (
        (status = 'succeeded' AND result_digest IS NOT NULL AND octet_length(result_digest) = 32 AND delivered_at IS NOT NULL) OR
        (status <> 'succeeded' AND result_digest IS NULL AND delivered_at IS NULL)
      );
    ALTER TABLE aipay.payment_proofs
      DROP CONSTRAINT payment_proofs_delivery_binding_unique;
  `);
};
