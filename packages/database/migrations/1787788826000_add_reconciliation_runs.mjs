export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE aipay.reconciliation_runs (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      provider TEXT NOT NULL,
      business_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      checked_count INTEGER NOT NULL DEFAULT 0,
      discrepancy_count INTEGER NOT NULL DEFAULT 0,
      repaired_count INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      started_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMPTZ(3),
      CONSTRAINT reconciliation_runs_identity_unique UNIQUE (provider, business_date),
      CONSTRAINT reconciliation_runs_provider_check CHECK (provider ~ '^[a-z][a-z0-9_]{0,63}$'),
      CONSTRAINT reconciliation_runs_status_check CHECK (status IN ('running', 'completed', 'failed')),
      CONSTRAINT reconciliation_runs_counts_check CHECK (
        checked_count >= 0 AND discrepancy_count >= 0 AND repaired_count >= 0 AND
        repaired_count <= discrepancy_count AND discrepancy_count <= checked_count
      ),
      CONSTRAINT reconciliation_runs_result_check CHECK (
        (status = 'running' AND completed_at IS NULL AND error_code IS NULL) OR
        (status = 'completed' AND completed_at IS NOT NULL AND error_code IS NULL) OR
        (status = 'failed' AND completed_at IS NOT NULL AND error_code IS NOT NULL)
      )
    );

    CREATE TABLE aipay.reconciliation_items (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      run_id UUID NOT NULL REFERENCES aipay.reconciliation_runs(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL,
      entity_id UUID NOT NULL,
      internal_status_before TEXT NOT NULL,
      provider_status TEXT,
      internal_status_after TEXT NOT NULL,
      resolution TEXT NOT NULL,
      error_code TEXT,
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT reconciliation_items_entity_unique UNIQUE (run_id, entity_type, entity_id),
      CONSTRAINT reconciliation_items_type_check CHECK (entity_type IN ('payment', 'refund')),
      CONSTRAINT reconciliation_items_status_length_check CHECK (
        char_length(internal_status_before) BETWEEN 1 AND 32 AND
        char_length(internal_status_after) BETWEEN 1 AND 32 AND
        (provider_status IS NULL OR char_length(provider_status) BETWEEN 1 AND 32)
      ),
      CONSTRAINT reconciliation_items_resolution_check CHECK (
        resolution IN ('consistent', 'repaired', 'manual_review', 'query_failed')
      ),
      CONSTRAINT reconciliation_items_error_check CHECK (
        (resolution = 'query_failed' AND error_code IS NOT NULL) OR
        (resolution <> 'query_failed' AND error_code IS NULL)
      )
    );

    CREATE INDEX reconciliation_items_run_idx
      ON aipay.reconciliation_items(run_id, resolution, entity_type);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS aipay.reconciliation_items;
    DROP TABLE IF EXISTS aipay.reconciliation_runs;
  `);
};
