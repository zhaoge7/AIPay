export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE aipay.api_keys (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      developer_id UUID NOT NULL REFERENCES aipay.developers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash BYTEA NOT NULL,
      token_hint CHAR(4) NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ(3) NOT NULL,
      last_used_at TIMESTAMPTZ(3),
      revoked_at TIMESTAMPTZ(3),
      replaced_by_key_id UUID REFERENCES aipay.api_keys(id),
      CONSTRAINT api_keys_token_hash_unique UNIQUE (token_hash),
      CONSTRAINT api_keys_token_hash_length_check CHECK (octet_length(token_hash) = 32),
      CONSTRAINT api_keys_name_length_check CHECK (char_length(name) BETWEEN 1 AND 100),
      CONSTRAINT api_keys_name_canonical_check CHECK (name = btrim(name)),
      CONSTRAINT api_keys_token_hint_check CHECK (token_hint ~ '^[A-Za-z0-9_-]{4}$'),
      CONSTRAINT api_keys_status_check CHECK (status IN ('active', 'revoked')),
      CONSTRAINT api_keys_validity_check CHECK (created_at < expires_at),
      CONSTRAINT api_keys_last_used_check CHECK (
        last_used_at IS NULL OR (last_used_at >= created_at AND last_used_at <= expires_at)
      ),
      CONSTRAINT api_keys_revocation_check CHECK (
        (status = 'active' AND revoked_at IS NULL AND replaced_by_key_id IS NULL) OR
        (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_at >= created_at)
      ),
      CONSTRAINT api_keys_replacement_check CHECK (replaced_by_key_id IS NULL OR replaced_by_key_id <> id)
    );

    CREATE UNIQUE INDEX api_keys_active_name_unique
      ON aipay.api_keys(developer_id, lower(name))
      WHERE status = 'active';
    CREATE INDEX api_keys_developer_id_idx ON aipay.api_keys(developer_id, created_at);
    CREATE INDEX api_keys_expiry_idx ON aipay.api_keys(expires_at) WHERE status = 'active';
  `);
};

export const down = (pgm) => {
  pgm.dropTable({ schema: 'aipay', name: 'api_keys' }, { ifExists: true });
};
