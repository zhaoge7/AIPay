export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.agents ADD COLUMN name TEXT NOT NULL;

    ALTER TABLE aipay.agents
      ADD CONSTRAINT agents_name_length_check CHECK (char_length(name) BETWEEN 1 AND 100),
      ADD CONSTRAINT agents_name_canonical_check CHECK (name = btrim(name));

    CREATE UNIQUE INDEX agents_active_name_unique
      ON aipay.agents(developer_id, lower(name))
      WHERE status <> 'revoked';

    CREATE UNIQUE INDEX signing_keys_public_key_unique
      ON aipay.signing_keys(algorithm, public_key);

    CREATE UNIQUE INDEX signing_keys_active_agent_unique
      ON aipay.signing_keys(agent_id)
      WHERE owner_type = 'agent' AND status = 'active';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS aipay.signing_keys_active_agent_unique;
    DROP INDEX IF EXISTS aipay.signing_keys_public_key_unique;
    DROP INDEX IF EXISTS aipay.agents_active_name_unique;
    ALTER TABLE aipay.agents
      DROP CONSTRAINT IF EXISTS agents_name_canonical_check,
      DROP CONSTRAINT IF EXISTS agents_name_length_check,
      DROP COLUMN IF EXISTS name;
  `);
};
