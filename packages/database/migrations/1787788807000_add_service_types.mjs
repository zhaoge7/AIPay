export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.services ADD COLUMN service_type TEXT NOT NULL;

    ALTER TABLE aipay.services
      ADD CONSTRAINT services_type_check CHECK (service_type IN ('api', 'mcp', 'skill'));

    CREATE UNIQUE INDEX services_merchant_name_unique
      ON aipay.services(merchant_id, lower(name));
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS aipay.services_merchant_name_unique;
    ALTER TABLE aipay.services
      DROP CONSTRAINT IF EXISTS services_type_check,
      DROP COLUMN IF EXISTS service_type;
  `);
};
