export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.outbox_events
      DROP CONSTRAINT outbox_events_status_check,
      ADD COLUMN locked_at TIMESTAMPTZ(3),
      ADD COLUMN locked_by TEXT,
      ADD CONSTRAINT outbox_events_status_check CHECK (
        status IN ('pending', 'processing', 'published', 'dead_letter')
      ),
      ADD CONSTRAINT outbox_events_lock_check CHECK (
        (status = 'processing' AND locked_at IS NOT NULL AND locked_by IS NOT NULL) OR
        (status <> 'processing' AND locked_at IS NULL AND locked_by IS NULL)
      );

    ALTER TABLE aipay.outbox_events
      DROP CONSTRAINT outbox_events_publication_check,
      ADD CONSTRAINT outbox_events_publication_check CHECK (
        (status = 'published' AND published_at IS NOT NULL AND published_at >= created_at) OR
        (status <> 'published' AND published_at IS NULL)
      );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE aipay.outbox_events
      DROP CONSTRAINT outbox_events_publication_check,
      ADD CONSTRAINT outbox_events_publication_check CHECK (
        (status = 'published' AND published_at IS NOT NULL AND published_at >= created_at) OR
        (status <> 'published' AND published_at IS NULL)
      ),
      DROP CONSTRAINT outbox_events_lock_check,
      DROP CONSTRAINT outbox_events_status_check,
      ADD CONSTRAINT outbox_events_status_check CHECK (
        status IN ('pending', 'published', 'dead_letter')
      ),
      DROP COLUMN locked_by,
      DROP COLUMN locked_at;
  `);
};
