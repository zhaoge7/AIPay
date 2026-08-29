export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.payment_attempts
      ADD COLUMN reservation_id UUID,
      ADD CONSTRAINT payment_attempts_reservation_fk
        FOREIGN KEY (reservation_id) REFERENCES aipay.budget_reservations(id),
      ADD CONSTRAINT payment_attempts_reservation_unique UNIQUE (reservation_id);

    CREATE INDEX payment_attempts_reservation_id_idx
      ON aipay.payment_attempts(reservation_id)
      WHERE reservation_id IS NOT NULL;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS aipay.payment_attempts_reservation_id_idx;
    ALTER TABLE aipay.payment_attempts
      DROP CONSTRAINT IF EXISTS payment_attempts_reservation_unique,
      DROP CONSTRAINT IF EXISTS payment_attempts_reservation_fk,
      DROP COLUMN IF EXISTS reservation_id;
  `);
};
