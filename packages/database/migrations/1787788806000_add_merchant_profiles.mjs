export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.merchants ADD COLUMN callback_url TEXT NOT NULL;

    ALTER TABLE aipay.merchants
      ADD CONSTRAINT merchants_callback_url_length_check
        CHECK (char_length(callback_url) BETWEEN 8 AND 2048),
      ADD CONSTRAINT merchants_callback_url_scheme_check
        CHECK (callback_url ~ '^https?://');

    CREATE UNIQUE INDEX merchants_active_name_unique
      ON aipay.merchants(developer_id, lower(name))
      WHERE status <> 'closed';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS aipay.merchants_active_name_unique;
    ALTER TABLE aipay.merchants
      DROP CONSTRAINT IF EXISTS merchants_callback_url_scheme_check,
      DROP CONSTRAINT IF EXISTS merchants_callback_url_length_check,
      DROP COLUMN IF EXISTS callback_url;
  `);
};
