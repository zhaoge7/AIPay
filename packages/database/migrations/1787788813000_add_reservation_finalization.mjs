export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.budget_reservations
      ADD COLUMN finalization_reason TEXT,
      ADD CONSTRAINT budget_reservations_reason_check CHECK (
        (status = 'held' AND finalization_reason IS NULL) OR
        (status = 'released' AND finalization_reason IN ('payment_failed', 'cancelled')) OR
        (status = 'confirmed' AND finalization_reason = 'payment_succeeded') OR
        (status = 'expired' AND finalization_reason = 'timeout')
      );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.budget_reservations
      DROP CONSTRAINT IF EXISTS budget_reservations_reason_check,
      DROP COLUMN IF EXISTS finalization_reason;
  `);
};
