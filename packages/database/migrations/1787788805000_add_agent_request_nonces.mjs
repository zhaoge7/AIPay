export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE aipay.agent_request_nonces (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      agent_id UUID NOT NULL REFERENCES aipay.agents(id) ON DELETE CASCADE,
      nonce_hash BYTEA NOT NULL,
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMPTZ(3) NOT NULL,
      CONSTRAINT agent_request_nonces_agent_hash_unique UNIQUE (agent_id, nonce_hash),
      CONSTRAINT agent_request_nonces_hash_length_check CHECK (octet_length(nonce_hash) = 32),
      CONSTRAINT agent_request_nonces_validity_check CHECK (created_at < expires_at)
    );

    CREATE INDEX agent_request_nonces_expiry_idx ON aipay.agent_request_nonces(expires_at);
  `);
};

export const down = (pgm) => {
  pgm.dropTable({ schema: 'aipay', name: 'agent_request_nonces' }, { ifExists: true });
};
