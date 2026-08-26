export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE aipay.developers (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT developers_status_check CHECK (status IN ('active', 'suspended', 'closed')),
      CONSTRAINT developers_timestamp_order_check CHECK (updated_at >= created_at)
    );

    CREATE TABLE aipay.agents (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      developer_id UUID NOT NULL REFERENCES aipay.developers(id),
      status TEXT NOT NULL DEFAULT 'enabled',
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT agents_id_developer_unique UNIQUE (id, developer_id),
      CONSTRAINT agents_status_check CHECK (status IN ('enabled', 'disabled', 'revoked')),
      CONSTRAINT agents_timestamp_order_check CHECK (updated_at >= created_at)
    );

    CREATE INDEX agents_developer_id_idx ON aipay.agents(developer_id);

    CREATE TABLE aipay.merchants (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      developer_id UUID NOT NULL REFERENCES aipay.developers(id),
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT merchants_name_length_check CHECK (char_length(name) BETWEEN 1 AND 200),
      CONSTRAINT merchants_status_check CHECK (status IN ('active', 'suspended', 'closed')),
      CONSTRAINT merchants_timestamp_order_check CHECK (updated_at >= created_at)
    );

    CREATE INDEX merchants_developer_id_idx ON aipay.merchants(developer_id);

    CREATE TABLE aipay.signing_keys (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      owner_type TEXT NOT NULL,
      developer_id UUID REFERENCES aipay.developers(id),
      agent_id UUID REFERENCES aipay.agents(id),
      merchant_id UUID REFERENCES aipay.merchants(id),
      algorithm TEXT NOT NULL DEFAULT 'ed25519',
      public_key BYTEA NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      revoked_at TIMESTAMPTZ(3),
      CONSTRAINT signing_keys_owner_check CHECK (
        (owner_type = 'developer' AND developer_id IS NOT NULL AND agent_id IS NULL AND merchant_id IS NULL) OR
        (owner_type = 'agent' AND developer_id IS NULL AND agent_id IS NOT NULL AND merchant_id IS NULL) OR
        (owner_type = 'merchant' AND developer_id IS NULL AND agent_id IS NULL AND merchant_id IS NOT NULL)
      ),
      CONSTRAINT signing_keys_algorithm_check CHECK (algorithm = 'ed25519'),
      CONSTRAINT signing_keys_public_key_length_check CHECK (octet_length(public_key) = 32),
      CONSTRAINT signing_keys_status_check CHECK (status IN ('active', 'revoked')),
      CONSTRAINT signing_keys_revocation_check CHECK (
        (status = 'active' AND revoked_at IS NULL) OR
        (status = 'revoked' AND revoked_at IS NOT NULL AND revoked_at >= created_at)
      )
    );

    CREATE INDEX signing_keys_developer_id_idx ON aipay.signing_keys(developer_id) WHERE developer_id IS NOT NULL;
    CREATE INDEX signing_keys_agent_id_idx ON aipay.signing_keys(agent_id) WHERE agent_id IS NOT NULL;
    CREATE INDEX signing_keys_merchant_id_idx ON aipay.signing_keys(merchant_id) WHERE merchant_id IS NOT NULL;

    CREATE TABLE aipay.services (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      merchant_id UUID NOT NULL REFERENCES aipay.merchants(id),
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      unit TEXT NOT NULL,
      unit_price_amount_minor BIGINT NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      refund_policy TEXT NOT NULL DEFAULT 'full_on_delivery_failure',
      status TEXT NOT NULL DEFAULT 'enabled',
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT services_id_merchant_unique UNIQUE (id, merchant_id),
      CONSTRAINT services_name_length_check CHECK (char_length(name) BETWEEN 1 AND 200),
      CONSTRAINT services_category_format_check CHECK (category ~ '^[a-z][a-z0-9._-]{0,63}$'),
      CONSTRAINT services_unit_format_check CHECK (unit ~ '^[a-z][a-z0-9._-]{0,63}$'),
      CONSTRAINT services_price_check CHECK (unit_price_amount_minor > 0),
      CONSTRAINT services_currency_check CHECK (currency = 'CNY'),
      CONSTRAINT services_refund_policy_check CHECK (refund_policy IN ('full_on_delivery_failure', 'non_refundable')),
      CONSTRAINT services_status_check CHECK (status IN ('enabled', 'disabled')),
      CONSTRAINT services_timestamp_order_check CHECK (updated_at >= created_at)
    );

    CREATE INDEX services_merchant_id_idx ON aipay.services(merchant_id);
    CREATE INDEX services_catalog_idx ON aipay.services(status, category, merchant_id);

    CREATE TABLE aipay.mandates (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      schema_version TEXT NOT NULL DEFAULT '1',
      principal_id UUID NOT NULL REFERENCES aipay.developers(id),
      agent_id UUID NOT NULL,
      purpose TEXT NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      max_per_transaction_amount_minor BIGINT NOT NULL,
      total_budget_amount_minor BIGINT NOT NULL,
      approval_required_above_amount_minor BIGINT NOT NULL,
      max_transactions INTEGER NOT NULL,
      issued_at TIMESTAMPTZ(3) NOT NULL,
      valid_until TIMESTAMPTZ(3) NOT NULL,
      instruction_hash BYTEA NOT NULL,
      proof_scheme TEXT NOT NULL DEFAULT 'aipay-jcs-ed25519-v1',
      proof_key_id UUID NOT NULL REFERENCES aipay.signing_keys(id),
      proof_value BYTEA NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT mandates_id_principal_agent_unique UNIQUE (id, principal_id, agent_id),
      CONSTRAINT mandates_agent_principal_fk FOREIGN KEY (agent_id, principal_id)
        REFERENCES aipay.agents(id, developer_id),
      CONSTRAINT mandates_schema_version_check CHECK (schema_version = '1'),
      CONSTRAINT mandates_purpose_length_check CHECK (char_length(purpose) BETWEEN 1 AND 500),
      CONSTRAINT mandates_currency_check CHECK (currency = 'CNY'),
      CONSTRAINT mandates_amounts_check CHECK (
        max_per_transaction_amount_minor >= 0 AND
        total_budget_amount_minor >= 0 AND
        approval_required_above_amount_minor >= 0 AND
        max_per_transaction_amount_minor <= total_budget_amount_minor
      ),
      CONSTRAINT mandates_max_transactions_check CHECK (max_transactions BETWEEN 1 AND 1000000),
      CONSTRAINT mandates_validity_check CHECK (issued_at < valid_until),
      CONSTRAINT mandates_instruction_hash_length_check CHECK (octet_length(instruction_hash) = 32),
      CONSTRAINT mandates_proof_scheme_check CHECK (proof_scheme = 'aipay-jcs-ed25519-v1'),
      CONSTRAINT mandates_proof_value_length_check CHECK (octet_length(proof_value) = 64),
      CONSTRAINT mandates_status_check CHECK (status IN ('active', 'paused', 'revoked', 'expired'))
    );

    CREATE INDEX mandates_principal_id_idx ON aipay.mandates(principal_id);
    CREATE INDEX mandates_agent_id_idx ON aipay.mandates(agent_id);
    CREATE INDEX mandates_proof_key_id_idx ON aipay.mandates(proof_key_id);

    CREATE TABLE aipay.mandate_allowed_merchants (
      mandate_id UUID NOT NULL REFERENCES aipay.mandates(id) ON DELETE CASCADE,
      merchant_id UUID NOT NULL REFERENCES aipay.merchants(id),
      PRIMARY KEY (mandate_id, merchant_id)
    );

    CREATE INDEX mandate_allowed_merchants_merchant_id_idx
      ON aipay.mandate_allowed_merchants(merchant_id);

    CREATE TABLE aipay.mandate_allowed_categories (
      mandate_id UUID NOT NULL REFERENCES aipay.mandates(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      PRIMARY KEY (mandate_id, category),
      CONSTRAINT mandate_allowed_categories_format_check
        CHECK (category ~ '^[a-z][a-z0-9._-]{0,63}$')
    );

    CREATE TABLE aipay.quotes (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      schema_version TEXT NOT NULL DEFAULT '1',
      merchant_id UUID NOT NULL REFERENCES aipay.merchants(id),
      service_id UUID NOT NULL,
      unit TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      unit_price_amount_minor BIGINT NOT NULL,
      subtotal_amount_minor BIGINT NOT NULL,
      tax_behavior TEXT NOT NULL,
      tax_amount_minor BIGINT NOT NULL,
      total_amount_minor BIGINT NOT NULL,
      issued_at TIMESTAMPTZ(3) NOT NULL,
      expires_at TIMESTAMPTZ(3) NOT NULL,
      proof_scheme TEXT NOT NULL DEFAULT 'aipay-jcs-ed25519-v1',
      proof_key_id UUID NOT NULL REFERENCES aipay.signing_keys(id),
      proof_value BYTEA NOT NULL,
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT quotes_service_merchant_fk FOREIGN KEY (service_id, merchant_id)
        REFERENCES aipay.services(id, merchant_id),
      CONSTRAINT quotes_binding_unique
        UNIQUE (id, merchant_id, service_id, total_amount_minor, currency),
      CONSTRAINT quotes_schema_version_check CHECK (schema_version = '1'),
      CONSTRAINT quotes_unit_format_check CHECK (unit ~ '^[a-z][a-z0-9._-]{0,63}$'),
      CONSTRAINT quotes_quantity_check CHECK (quantity BETWEEN 1 AND 1000000),
      CONSTRAINT quotes_currency_check CHECK (currency = 'CNY'),
      CONSTRAINT quotes_unit_price_check CHECK (unit_price_amount_minor > 0),
      CONSTRAINT quotes_subtotal_check CHECK (
        subtotal_amount_minor >= 0 AND
        subtotal_amount_minor::NUMERIC = unit_price_amount_minor::NUMERIC * quantity
      ),
      CONSTRAINT quotes_tax_behavior_check CHECK (tax_behavior IN ('inclusive', 'exclusive')),
      CONSTRAINT quotes_tax_amount_check CHECK (tax_amount_minor >= 0),
      CONSTRAINT quotes_total_check CHECK (
        total_amount_minor > 0 AND
        (
          (tax_behavior = 'inclusive' AND tax_amount_minor <= subtotal_amount_minor AND total_amount_minor = subtotal_amount_minor) OR
          (tax_behavior = 'exclusive' AND total_amount_minor::NUMERIC = subtotal_amount_minor::NUMERIC + tax_amount_minor)
        )
      ),
      CONSTRAINT quotes_validity_check CHECK (issued_at < expires_at),
      CONSTRAINT quotes_proof_scheme_check CHECK (proof_scheme = 'aipay-jcs-ed25519-v1'),
      CONSTRAINT quotes_proof_value_length_check CHECK (octet_length(proof_value) = 64)
    );

    CREATE INDEX quotes_merchant_id_idx ON aipay.quotes(merchant_id);
    CREATE INDEX quotes_service_id_idx ON aipay.quotes(service_id);
    CREATE INDEX quotes_proof_key_id_idx ON aipay.quotes(proof_key_id);
    CREATE INDEX quotes_expires_at_idx ON aipay.quotes(expires_at);

    CREATE TABLE aipay.transactions (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      schema_version TEXT NOT NULL DEFAULT '1',
      quote_id UUID NOT NULL,
      mandate_id UUID NOT NULL,
      principal_id UUID NOT NULL,
      agent_id UUID NOT NULL,
      merchant_id UUID NOT NULL,
      service_id UUID NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      amount_minor BIGINT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT transactions_quote_unique UNIQUE (quote_id),
      CONSTRAINT transactions_id_amount_unique UNIQUE (id, amount_minor, currency),
      CONSTRAINT transactions_quote_binding_fk
        FOREIGN KEY (quote_id, merchant_id, service_id, amount_minor, currency)
        REFERENCES aipay.quotes(id, merchant_id, service_id, total_amount_minor, currency),
      CONSTRAINT transactions_mandate_binding_fk
        FOREIGN KEY (mandate_id, principal_id, agent_id)
        REFERENCES aipay.mandates(id, principal_id, agent_id),
      CONSTRAINT transactions_agent_principal_fk
        FOREIGN KEY (agent_id, principal_id)
        REFERENCES aipay.agents(id, developer_id),
      CONSTRAINT transactions_schema_version_check CHECK (schema_version = '1'),
      CONSTRAINT transactions_currency_check CHECK (currency = 'CNY'),
      CONSTRAINT transactions_amount_check CHECK (amount_minor > 0),
      CONSTRAINT transactions_status_check CHECK (status IN (
        'requires_confirmation', 'authorized', 'payment_pending', 'payment_review',
        'paid', 'delivery_pending', 'delivery_review', 'delivered',
        'refund_pending', 'refund_review', 'refunded', 'settled', 'failed', 'cancelled'
      )),
      CONSTRAINT transactions_timestamp_order_check CHECK (updated_at >= created_at)
    );

    CREATE INDEX transactions_mandate_id_idx ON aipay.transactions(mandate_id);
    CREATE INDEX transactions_agent_id_idx ON aipay.transactions(agent_id);
    CREATE INDEX transactions_merchant_id_idx ON aipay.transactions(merchant_id);
    CREATE INDEX transactions_service_id_idx ON aipay.transactions(service_id);
    CREATE INDEX transactions_status_created_at_idx ON aipay.transactions(status, created_at);

    CREATE TABLE aipay.payment_attempts (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      transaction_id UUID NOT NULL,
      attempt_number INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_reference TEXT,
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      amount_minor BIGINT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT payment_attempts_id_transaction_unique UNIQUE (id, transaction_id),
      CONSTRAINT payment_attempts_number_unique UNIQUE (transaction_id, attempt_number),
      CONSTRAINT payment_attempts_transaction_amount_fk
        FOREIGN KEY (transaction_id, amount_minor, currency)
        REFERENCES aipay.transactions(id, amount_minor, currency),
      CONSTRAINT payment_attempts_number_check CHECK (attempt_number BETWEEN 1 AND 100),
      CONSTRAINT payment_attempts_provider_format_check CHECK (provider ~ '^[a-z][a-z0-9_-]{0,63}$'),
      CONSTRAINT payment_attempts_currency_check CHECK (currency = 'CNY'),
      CONSTRAINT payment_attempts_amount_check CHECK (amount_minor > 0),
      CONSTRAINT payment_attempts_status_check CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
      CONSTRAINT payment_attempts_error_check CHECK (
        (status = 'failed' AND error_code IS NOT NULL) OR
        (status <> 'failed' AND error_code IS NULL)
      ),
      CONSTRAINT payment_attempts_timestamp_order_check CHECK (updated_at >= created_at)
    );

    CREATE UNIQUE INDEX payment_attempts_provider_reference_unique
      ON aipay.payment_attempts(provider, provider_reference)
      WHERE provider_reference IS NOT NULL;
    CREATE INDEX payment_attempts_transaction_id_idx ON aipay.payment_attempts(transaction_id);

    CREATE TABLE aipay.deliveries (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      transaction_id UUID NOT NULL UNIQUE REFERENCES aipay.transactions(id),
      status TEXT NOT NULL,
      result_digest BYTEA,
      delivered_at TIMESTAMPTZ(3),
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT deliveries_status_check CHECK (status IN ('pending', 'succeeded', 'failed', 'timed_out', 'unknown')),
      CONSTRAINT deliveries_result_check CHECK (
        (status = 'succeeded' AND result_digest IS NOT NULL AND octet_length(result_digest) = 32 AND delivered_at IS NOT NULL) OR
        (status <> 'succeeded' AND result_digest IS NULL AND delivered_at IS NULL)
      ),
      CONSTRAINT deliveries_timestamp_order_check CHECK (updated_at >= created_at),
      CONSTRAINT deliveries_delivered_at_check CHECK (delivered_at IS NULL OR delivered_at >= created_at)
    );

    CREATE TABLE aipay.refunds (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      transaction_id UUID NOT NULL UNIQUE,
      payment_attempt_id UUID NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      amount_minor BIGINT NOT NULL,
      status TEXT NOT NULL,
      provider_reference TEXT,
      error_code TEXT,
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT refunds_payment_attempt_transaction_fk
        FOREIGN KEY (payment_attempt_id, transaction_id)
        REFERENCES aipay.payment_attempts(id, transaction_id),
      CONSTRAINT refunds_transaction_amount_fk
        FOREIGN KEY (transaction_id, amount_minor, currency)
        REFERENCES aipay.transactions(id, amount_minor, currency),
      CONSTRAINT refunds_currency_check CHECK (currency = 'CNY'),
      CONSTRAINT refunds_amount_check CHECK (amount_minor > 0),
      CONSTRAINT refunds_status_check CHECK (status IN ('pending', 'succeeded', 'failed', 'unknown')),
      CONSTRAINT refunds_error_check CHECK (
        (status = 'failed' AND error_code IS NOT NULL) OR
        (status <> 'failed' AND error_code IS NULL)
      ),
      CONSTRAINT refunds_timestamp_order_check CHECK (updated_at >= created_at)
    );

    CREATE UNIQUE INDEX refunds_provider_reference_unique
      ON aipay.refunds(provider_reference)
      WHERE provider_reference IS NOT NULL;
    CREATE INDEX refunds_payment_attempt_id_idx ON aipay.refunds(payment_attempt_id);

    CREATE TABLE aipay.audit_events (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      schema_version TEXT NOT NULL DEFAULT '1',
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id UUID,
      actor_provider_name TEXT,
      object_type TEXT NOT NULL,
      object_id UUID NOT NULL,
      occurred_at TIMESTAMPTZ(3) NOT NULL,
      trace_id UUID NOT NULL,
      parent_event_id UUID REFERENCES aipay.audit_events(id),
      outcome TEXT NOT NULL,
      result_code TEXT,
      CONSTRAINT audit_events_schema_version_check CHECK (schema_version = '1'),
      CONSTRAINT audit_events_event_type_format_check CHECK (
        event_type ~ '^[a-z][a-z0-9_]{0,31}(\\.[a-z][a-z0-9_]{0,31})+$'
      ),
      CONSTRAINT audit_events_actor_check CHECK (
        (actor_type IN ('developer', 'agent', 'merchant') AND actor_id IS NOT NULL AND actor_provider_name IS NULL) OR
        (actor_type = 'system' AND actor_id IS NULL AND actor_provider_name IS NULL) OR
        (actor_type = 'payment_provider' AND actor_id IS NULL AND actor_provider_name ~ '^[a-z][a-z0-9_-]{0,63}$')
      ),
      CONSTRAINT audit_events_object_type_check CHECK (object_type IN (
        'developer', 'agent', 'merchant', 'service', 'mandate', 'quote',
        'transaction', 'payment_attempt', 'delivery', 'refund', 'audit_event', 'outbox_event'
      )),
      CONSTRAINT audit_events_trace_id_check CHECK (trace_id <> '00000000-0000-0000-0000-000000000000'::UUID),
      CONSTRAINT audit_events_parent_check CHECK (parent_event_id IS NULL OR parent_event_id <> id),
      CONSTRAINT audit_events_outcome_check CHECK (outcome IN ('succeeded', 'failed', 'denied', 'pending')),
      CONSTRAINT audit_events_result_check CHECK (
        (outcome IN ('failed', 'denied') AND result_code IS NOT NULL AND result_code ~ '^[A-Z][A-Z0-9_]{0,63}$') OR
        (outcome IN ('succeeded', 'pending') AND result_code IS NULL)
      )
    );

    CREATE INDEX audit_events_object_timeline_idx
      ON aipay.audit_events(object_type, object_id, occurred_at, id);
    CREATE INDEX audit_events_trace_id_idx ON aipay.audit_events(trace_id);
    CREATE INDEX audit_events_parent_event_id_idx ON aipay.audit_events(parent_event_id)
      WHERE parent_event_id IS NOT NULL;

    CREATE TABLE aipay.outbox_events (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      aggregate_type TEXT NOT NULL,
      aggregate_id UUID NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      available_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      published_at TIMESTAMPTZ(3),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error_code TEXT,
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT outbox_events_aggregate_type_format_check CHECK (aggregate_type ~ '^[a-z][a-z0-9_]{0,63}$'),
      CONSTRAINT outbox_events_event_type_format_check CHECK (
        event_type ~ '^[a-z][a-z0-9_]{0,31}(\\.[a-z][a-z0-9_]{0,31})+$'
      ),
      CONSTRAINT outbox_events_payload_object_check CHECK (jsonb_typeof(payload) = 'object'),
      CONSTRAINT outbox_events_status_check CHECK (status IN ('pending', 'published', 'dead_letter')),
      CONSTRAINT outbox_events_attempt_count_check CHECK (attempt_count >= 0),
      CONSTRAINT outbox_events_publication_check CHECK (
        (status = 'published' AND published_at IS NOT NULL AND published_at >= created_at) OR
        (status <> 'published' AND published_at IS NULL)
      )
    );

    CREATE INDEX outbox_events_pending_idx
      ON aipay.outbox_events(available_at, id)
      WHERE status = 'pending';
    CREATE INDEX outbox_events_aggregate_idx
      ON aipay.outbox_events(aggregate_type, aggregate_id, created_at);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS aipay.outbox_events;
    DROP TABLE IF EXISTS aipay.audit_events;
    DROP TABLE IF EXISTS aipay.refunds;
    DROP TABLE IF EXISTS aipay.deliveries;
    DROP TABLE IF EXISTS aipay.payment_attempts;
    DROP TABLE IF EXISTS aipay.transactions;
    DROP TABLE IF EXISTS aipay.quotes;
    DROP TABLE IF EXISTS aipay.mandate_allowed_categories;
    DROP TABLE IF EXISTS aipay.mandate_allowed_merchants;
    DROP TABLE IF EXISTS aipay.mandates;
    DROP TABLE IF EXISTS aipay.services;
    DROP TABLE IF EXISTS aipay.signing_keys;
    DROP TABLE IF EXISTS aipay.merchants;
    DROP TABLE IF EXISTS aipay.agents;
    DROP TABLE IF EXISTS aipay.developers;
  `);
};
