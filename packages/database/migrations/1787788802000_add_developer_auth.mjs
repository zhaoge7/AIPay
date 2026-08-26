export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.developers
      ADD COLUMN email TEXT NOT NULL,
      ADD COLUMN password_hash TEXT NOT NULL;

    ALTER TABLE aipay.developers
      ADD CONSTRAINT developers_email_format_check CHECK (
        email = lower(btrim(email)) AND
        char_length(email) BETWEEN 3 AND 254 AND
        email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'
      ),
      ADD CONSTRAINT developers_password_hash_check CHECK (
        password_hash ~ '^\\$argon2id\\$v=19\\$'
      );

    CREATE UNIQUE INDEX developers_email_unique ON aipay.developers(email);

    CREATE TABLE aipay.auth_sessions (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      developer_id UUID NOT NULL REFERENCES aipay.developers(id) ON DELETE CASCADE,
      token_hash BYTEA NOT NULL,
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_used_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ(3) NOT NULL,
      revoked_at TIMESTAMPTZ(3),
      CONSTRAINT auth_sessions_token_hash_unique UNIQUE (token_hash),
      CONSTRAINT auth_sessions_token_hash_length_check CHECK (octet_length(token_hash) = 32),
      CONSTRAINT auth_sessions_validity_check CHECK (created_at < expires_at),
      CONSTRAINT auth_sessions_last_used_check CHECK (
        last_used_at >= created_at AND last_used_at <= expires_at
      ),
      CONSTRAINT auth_sessions_revoked_at_check CHECK (
        revoked_at IS NULL OR revoked_at >= created_at
      )
    );

    CREATE INDEX auth_sessions_developer_id_idx ON aipay.auth_sessions(developer_id);
    CREATE INDEX auth_sessions_expiry_idx ON aipay.auth_sessions(expires_at)
      WHERE revoked_at IS NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS aipay.auth_sessions;
    DROP INDEX IF EXISTS aipay.developers_email_unique;
    ALTER TABLE aipay.developers
      DROP CONSTRAINT IF EXISTS developers_password_hash_check,
      DROP CONSTRAINT IF EXISTS developers_email_format_check,
      DROP COLUMN IF EXISTS password_hash,
      DROP COLUMN IF EXISTS email;
  `);
};
