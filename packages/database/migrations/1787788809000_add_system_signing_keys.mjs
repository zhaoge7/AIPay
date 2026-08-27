export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.signing_keys DROP CONSTRAINT signing_keys_owner_check;

    ALTER TABLE aipay.signing_keys
      ADD CONSTRAINT signing_keys_owner_check CHECK (
        (owner_type = 'developer' AND developer_id IS NOT NULL AND agent_id IS NULL AND merchant_id IS NULL) OR
        (owner_type = 'agent' AND developer_id IS NULL AND agent_id IS NOT NULL AND merchant_id IS NULL) OR
        (owner_type = 'merchant' AND developer_id IS NULL AND agent_id IS NULL AND merchant_id IS NOT NULL) OR
        (owner_type = 'system' AND developer_id IS NULL AND agent_id IS NULL AND merchant_id IS NULL)
      );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.signing_keys DROP CONSTRAINT signing_keys_owner_check;

    ALTER TABLE aipay.signing_keys
      ADD CONSTRAINT signing_keys_owner_check CHECK (
        (owner_type = 'developer' AND developer_id IS NOT NULL AND agent_id IS NULL AND merchant_id IS NULL) OR
        (owner_type = 'agent' AND developer_id IS NULL AND agent_id IS NOT NULL AND merchant_id IS NULL) OR
        (owner_type = 'merchant' AND developer_id IS NULL AND agent_id IS NULL AND merchant_id IS NOT NULL)
      );
  `);
};
