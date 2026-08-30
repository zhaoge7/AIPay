export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE aipay.developer_payment_controls (
      developer_id UUID PRIMARY KEY REFERENCES aipay.developers(id),
      payments_paused BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS aipay.developer_payment_controls;');
};
