export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.transactions
      ADD CONSTRAINT transactions_payment_proof_binding_unique
      UNIQUE (id, merchant_id, service_id, amount_minor, currency);

    CREATE TABLE aipay.payment_proofs (
      id UUID PRIMARY KEY,
      transaction_id UUID NOT NULL,
      payment_attempt_id UUID NOT NULL,
      merchant_id UUID NOT NULL,
      service_id UUID NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      amount_minor BIGINT NOT NULL,
      issued_at TIMESTAMPTZ(3) NOT NULL,
      expires_at TIMESTAMPTZ(3) NOT NULL,
      proof_scheme TEXT NOT NULL DEFAULT 'aipay-jcs-ed25519-v1',
      proof_key_id UUID NOT NULL REFERENCES aipay.signing_keys(id),
      proof_value BYTEA NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      consumed_at TIMESTAMPTZ(3),
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT payment_proofs_transaction_binding_fk
        FOREIGN KEY (transaction_id, merchant_id, service_id, amount_minor, currency)
        REFERENCES aipay.transactions(id, merchant_id, service_id, amount_minor, currency),
      CONSTRAINT payment_proofs_attempt_transaction_fk
        FOREIGN KEY (payment_attempt_id, transaction_id)
        REFERENCES aipay.payment_attempts(id, transaction_id),
      CONSTRAINT payment_proofs_currency_check CHECK (currency = 'CNY'),
      CONSTRAINT payment_proofs_amount_check CHECK (amount_minor > 0),
      CONSTRAINT payment_proofs_validity_check CHECK (
        issued_at < expires_at AND expires_at <= issued_at + INTERVAL '15 minutes'
      ),
      CONSTRAINT payment_proofs_scheme_check CHECK (proof_scheme = 'aipay-jcs-ed25519-v1'),
      CONSTRAINT payment_proofs_value_check CHECK (octet_length(proof_value) = 64),
      CONSTRAINT payment_proofs_status_check CHECK (status IN ('active', 'consumed', 'expired')),
      CONSTRAINT payment_proofs_consumption_check CHECK (
        (status = 'consumed' AND consumed_at IS NOT NULL AND consumed_at >= issued_at) OR
        (status <> 'consumed' AND consumed_at IS NULL)
      )
    );

    CREATE UNIQUE INDEX payment_proofs_transaction_active_unique
      ON aipay.payment_proofs(transaction_id)
      WHERE status = 'active';
    CREATE INDEX payment_proofs_attempt_idx ON aipay.payment_proofs(payment_attempt_id);
    CREATE INDEX payment_proofs_expiry_idx
      ON aipay.payment_proofs(expires_at, id)
      WHERE status = 'active';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS aipay.payment_proofs;
    ALTER TABLE aipay.transactions
      DROP CONSTRAINT IF EXISTS transactions_payment_proof_binding_unique;
  `);
};
