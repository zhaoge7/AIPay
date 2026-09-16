export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE aipay.api_registrations (
      service_id UUID PRIMARY KEY,
      merchant_id UUID NOT NULL,
      endpoint_url TEXT NOT NULL,
      http_method TEXT NOT NULL DEFAULT 'POST',
      description TEXT NOT NULL,
      capabilities JSONB NOT NULL,
      input_schema JSONB NOT NULL,
      timeout_ms INTEGER NOT NULL DEFAULT 10000,
      status TEXT NOT NULL DEFAULT 'enabled',
      version INTEGER NOT NULL DEFAULT 1,
      success_count BIGINT NOT NULL DEFAULT 0,
      failure_count BIGINT NOT NULL DEFAULT 0,
      total_latency_ms BIGINT NOT NULL DEFAULT 0,
      last_invoked_at TIMESTAMPTZ(3),
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT api_registrations_service_merchant_fk
        FOREIGN KEY (service_id, merchant_id) REFERENCES aipay.services(id, merchant_id),
      CONSTRAINT api_registrations_endpoint_check
        CHECK (char_length(endpoint_url) BETWEEN 8 AND 2048),
      CONSTRAINT api_registrations_method_check CHECK (http_method = 'POST'),
      CONSTRAINT api_registrations_description_check
        CHECK (char_length(description) BETWEEN 1 AND 1000),
      CONSTRAINT api_registrations_capabilities_check CHECK (
        jsonb_typeof(capabilities) = 'array' AND
        jsonb_array_length(capabilities) BETWEEN 1 AND 32
      ),
      CONSTRAINT api_registrations_input_schema_check CHECK (jsonb_typeof(input_schema) = 'object'),
      CONSTRAINT api_registrations_timeout_check CHECK (timeout_ms BETWEEN 1000 AND 30000),
      CONSTRAINT api_registrations_status_check CHECK (status IN ('enabled', 'disabled')),
      CONSTRAINT api_registrations_version_check CHECK (version > 0),
      CONSTRAINT api_registrations_metrics_check CHECK (
        success_count >= 0 AND failure_count >= 0 AND total_latency_ms >= 0
      ),
      CONSTRAINT api_registrations_timestamp_check CHECK (updated_at >= created_at)
    );

    CREATE INDEX api_registrations_selection_idx
      ON aipay.api_registrations(status, merchant_id, service_id);

    CREATE TABLE aipay.platform_funding_accounts (
      currency CHAR(3) PRIMARY KEY,
      available_amount_minor BIGINT NOT NULL DEFAULT 0,
      reserved_amount_minor BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT platform_funding_accounts_currency_check CHECK (currency = 'CNY'),
      CONSTRAINT platform_funding_accounts_balance_check CHECK (
        available_amount_minor >= 0 AND reserved_amount_minor >= 0
      )
    );

    INSERT INTO aipay.platform_funding_accounts (currency) VALUES ('CNY');

    CREATE TABLE aipay.merchant_settlement_accounts (
      merchant_id UUID NOT NULL REFERENCES aipay.merchants(id),
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      available_amount_minor BIGINT NOT NULL DEFAULT 0,
      pending_amount_minor BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (merchant_id, currency),
      CONSTRAINT merchant_settlement_accounts_currency_check CHECK (currency = 'CNY'),
      CONSTRAINT merchant_settlement_accounts_balance_check CHECK (
        available_amount_minor >= 0 AND pending_amount_minor >= 0
      )
    );

    ALTER TABLE aipay.a2m_orders
      ADD COLUMN agent_id UUID REFERENCES aipay.agents(id),
      ADD COLUMN idempotency_key_hash BYTEA,
      ADD COLUMN request_hash BYTEA,
      ADD COLUMN requested_category TEXT,
      ADD COLUMN resolved_category TEXT,
      ADD COLUMN intent TEXT,
      ADD COLUMN invocation_parameters JSONB,
      ADD COLUMN selection_score INTEGER,
      ADD COLUMN selection_version TEXT,
      ADD COLUMN api_registration_version INTEGER,
      ADD COLUMN invocation_url TEXT,
      ADD COLUMN invocation_timeout_ms INTEGER,
      ADD COLUMN invocation_attempt_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN invocation_lease_expires_at TIMESTAMPTZ(3);

    ALTER TABLE aipay.a2m_orders
      ADD CONSTRAINT a2m_orders_idempotency_hash_check CHECK (
        idempotency_key_hash IS NULL OR octet_length(idempotency_key_hash) = 32
      ),
      ADD CONSTRAINT a2m_orders_request_hash_check CHECK (
        request_hash IS NULL OR octet_length(request_hash) = 32
      ),
      ADD CONSTRAINT a2m_orders_requested_category_check CHECK (
        requested_category IS NULL OR requested_category ~ '^[a-z][a-z0-9._-]{0,63}$'
      ),
      ADD CONSTRAINT a2m_orders_resolved_category_check CHECK (
        resolved_category IS NULL OR resolved_category ~ '^[a-z][a-z0-9._-]{0,63}$'
      ),
      ADD CONSTRAINT a2m_orders_intent_check CHECK (
        intent IS NULL OR char_length(intent) BETWEEN 1 AND 500
      ),
      ADD CONSTRAINT a2m_orders_invocation_parameters_check CHECK (
        invocation_parameters IS NULL OR jsonb_typeof(invocation_parameters) = 'object'
      ),
      ADD CONSTRAINT a2m_orders_selection_score_check CHECK (
        selection_score IS NULL OR selection_score >= 0
      ),
      ADD CONSTRAINT a2m_orders_selection_version_check CHECK (
        selection_version IS NULL OR char_length(selection_version) BETWEEN 1 AND 32
      ),
      ADD CONSTRAINT a2m_orders_api_registration_version_check CHECK (
        api_registration_version IS NULL OR api_registration_version > 0
      ),
      ADD CONSTRAINT a2m_orders_invocation_url_check CHECK (
        invocation_url IS NULL OR char_length(invocation_url) BETWEEN 8 AND 2048
      ),
      ADD CONSTRAINT a2m_orders_invocation_timeout_check CHECK (
        invocation_timeout_ms IS NULL OR invocation_timeout_ms BETWEEN 1000 AND 30000
      ),
      ADD CONSTRAINT a2m_orders_invocation_attempts_check CHECK (invocation_attempt_count >= 0),
      ADD CONSTRAINT a2m_orders_aggregation_shape_check CHECK (
        (
          agent_id IS NULL AND idempotency_key_hash IS NULL AND request_hash IS NULL AND
          requested_category IS NULL AND resolved_category IS NULL AND intent IS NULL AND
          invocation_parameters IS NULL AND selection_score IS NULL AND selection_version IS NULL AND
          api_registration_version IS NULL AND invocation_url IS NULL AND invocation_timeout_ms IS NULL AND
          invocation_attempt_count = 0 AND invocation_lease_expires_at IS NULL
        ) OR
        (
          agent_id IS NOT NULL AND idempotency_key_hash IS NOT NULL AND request_hash IS NOT NULL AND
          resolved_category IS NOT NULL AND intent IS NOT NULL AND invocation_parameters IS NOT NULL AND
          selection_score IS NOT NULL AND selection_version IS NOT NULL AND
          api_registration_version IS NOT NULL AND invocation_url IS NOT NULL AND
          invocation_timeout_ms IS NOT NULL
        )
      );

    CREATE UNIQUE INDEX a2m_orders_agent_idempotency_unique
      ON aipay.a2m_orders(agent_id, idempotency_key_hash)
      WHERE agent_id IS NOT NULL;

    CREATE INDEX a2m_orders_agent_created_idx
      ON aipay.a2m_orders(agent_id, created_at DESC)
      WHERE agent_id IS NOT NULL;

    CREATE TABLE aipay.merchant_advances (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      a2m_order_id UUID NOT NULL UNIQUE REFERENCES aipay.a2m_orders(id),
      merchant_id UUID NOT NULL REFERENCES aipay.merchants(id),
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      amount_minor BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      advanced_at TIMESTAMPTZ(3),
      paid_at TIMESTAMPTZ(3),
      released_at TIMESTAMPTZ(3),
      release_reason TEXT,
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT merchant_advances_currency_check CHECK (currency = 'CNY'),
      CONSTRAINT merchant_advances_amount_check CHECK (amount_minor > 0),
      CONSTRAINT merchant_advances_status_check CHECK (
        status IN ('reserved', 'advanced', 'paid', 'released')
      ),
      CONSTRAINT merchant_advances_state_check CHECK (
        (status = 'reserved' AND advanced_at IS NULL AND paid_at IS NULL AND released_at IS NULL) OR
        (status = 'advanced' AND advanced_at IS NOT NULL AND paid_at IS NULL AND released_at IS NULL) OR
        (status = 'paid' AND advanced_at IS NOT NULL AND paid_at IS NOT NULL AND released_at IS NULL) OR
        (status = 'released' AND advanced_at IS NULL AND paid_at IS NULL AND released_at IS NOT NULL)
      ),
      CONSTRAINT merchant_advances_release_reason_check CHECK (
        (status = 'released' AND release_reason IS NOT NULL) OR
        (status <> 'released' AND release_reason IS NULL)
      ),
      CONSTRAINT merchant_advances_timestamp_check CHECK (updated_at >= created_at)
    );

    CREATE INDEX merchant_advances_merchant_status_idx
      ON aipay.merchant_advances(merchant_id, status, created_at);

    CREATE TABLE aipay.platform_receivables (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      a2m_order_id UUID NOT NULL UNIQUE REFERENCES aipay.a2m_orders(id),
      provider_trade_no TEXT NOT NULL UNIQUE,
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      amount_minor BIGINT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      received_at TIMESTAMPTZ(3),
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT platform_receivables_currency_check CHECK (currency = 'CNY'),
      CONSTRAINT platform_receivables_amount_check CHECK (amount_minor > 0),
      CONSTRAINT platform_receivables_status_check CHECK (
        status IN ('pending', 'received', 'disputed')
      ),
      CONSTRAINT platform_receivables_state_check CHECK (
        (status = 'received' AND received_at IS NOT NULL) OR
        (status <> 'received' AND received_at IS NULL)
      ),
      CONSTRAINT platform_receivables_timestamp_check CHECK (updated_at >= created_at)
    );

    ALTER TABLE aipay.a2m_orders DROP CONSTRAINT a2m_orders_state_check;
    ALTER TABLE aipay.a2m_orders DROP CONSTRAINT a2m_orders_fulfillment_status_check;
    ALTER TABLE aipay.a2m_orders
      ADD CONSTRAINT a2m_orders_fulfillment_status_check CHECK (
        fulfillment_status IN ('unfulfilled', 'invoking', 'pending_confirm', 'fulfilled')
      ),
      ADD CONSTRAINT a2m_orders_state_check CHECK (
        (
          order_status = 'pending_payment' AND fulfillment_status = 'unfulfilled' AND
          provider_trade_no IS NULL AND payment_proof_hash IS NULL AND service_result IS NULL AND
          fulfillment_error_code IS NULL AND fulfilled_at IS NULL AND
          invocation_lease_expires_at IS NULL
        ) OR
        (
          order_status = 'paid' AND fulfillment_status = 'invoking' AND
          provider_trade_no IS NOT NULL AND payment_proof_hash IS NOT NULL AND service_result IS NULL AND
          fulfilled_at IS NULL AND invocation_lease_expires_at IS NOT NULL
        ) OR
        (
          order_status = 'paid' AND fulfillment_status = 'pending_confirm' AND
          provider_trade_no IS NOT NULL AND payment_proof_hash IS NOT NULL AND service_result IS NOT NULL AND
          fulfilled_at IS NULL AND invocation_lease_expires_at IS NULL
        ) OR
        (
          order_status = 'paid' AND fulfillment_status = 'fulfilled' AND
          provider_trade_no IS NOT NULL AND payment_proof_hash IS NOT NULL AND service_result IS NOT NULL AND
          fulfillment_error_code IS NULL AND fulfilled_at IS NOT NULL AND
          invocation_lease_expires_at IS NULL
        )
      );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS aipay.platform_receivables;
    DROP TABLE IF EXISTS aipay.merchant_advances;
    DROP TABLE IF EXISTS aipay.merchant_settlement_accounts;
    DROP TABLE IF EXISTS aipay.platform_funding_accounts;
    DROP TABLE IF EXISTS aipay.api_registrations;

    DROP INDEX IF EXISTS aipay.a2m_orders_agent_created_idx;
    DROP INDEX IF EXISTS aipay.a2m_orders_agent_idempotency_unique;
    ALTER TABLE aipay.a2m_orders DROP CONSTRAINT a2m_orders_state_check;
    ALTER TABLE aipay.a2m_orders DROP CONSTRAINT a2m_orders_fulfillment_status_check;
    ALTER TABLE aipay.a2m_orders
      DROP CONSTRAINT a2m_orders_idempotency_hash_check,
      DROP CONSTRAINT a2m_orders_request_hash_check,
      DROP CONSTRAINT a2m_orders_requested_category_check,
      DROP CONSTRAINT a2m_orders_resolved_category_check,
      DROP CONSTRAINT a2m_orders_intent_check,
      DROP CONSTRAINT a2m_orders_invocation_parameters_check,
      DROP CONSTRAINT a2m_orders_selection_score_check,
      DROP CONSTRAINT a2m_orders_selection_version_check,
      DROP CONSTRAINT a2m_orders_api_registration_version_check,
      DROP CONSTRAINT a2m_orders_invocation_url_check,
      DROP CONSTRAINT a2m_orders_invocation_timeout_check,
      DROP CONSTRAINT a2m_orders_invocation_attempts_check,
      DROP CONSTRAINT a2m_orders_aggregation_shape_check,
      DROP COLUMN agent_id,
      DROP COLUMN idempotency_key_hash,
      DROP COLUMN request_hash,
      DROP COLUMN requested_category,
      DROP COLUMN resolved_category,
      DROP COLUMN intent,
      DROP COLUMN invocation_parameters,
      DROP COLUMN selection_score,
      DROP COLUMN selection_version,
      DROP COLUMN api_registration_version,
      DROP COLUMN invocation_url,
      DROP COLUMN invocation_timeout_ms,
      DROP COLUMN invocation_attempt_count,
      DROP COLUMN invocation_lease_expires_at;

    ALTER TABLE aipay.a2m_orders
      ADD CONSTRAINT a2m_orders_fulfillment_status_check CHECK (
        fulfillment_status IN ('unfulfilled', 'pending_confirm', 'fulfilled')
      ),
      ADD CONSTRAINT a2m_orders_state_check CHECK (
        (
          order_status = 'pending_payment' AND fulfillment_status = 'unfulfilled' AND
          provider_trade_no IS NULL AND payment_proof_hash IS NULL AND service_result IS NULL AND
          fulfillment_error_code IS NULL AND fulfilled_at IS NULL
        ) OR
        (
          order_status = 'paid' AND fulfillment_status = 'pending_confirm' AND
          provider_trade_no IS NOT NULL AND payment_proof_hash IS NOT NULL AND service_result IS NOT NULL AND
          fulfilled_at IS NULL
        ) OR
        (
          order_status = 'paid' AND fulfillment_status = 'fulfilled' AND
          provider_trade_no IS NOT NULL AND payment_proof_hash IS NOT NULL AND service_result IS NOT NULL AND
          fulfillment_error_code IS NULL AND fulfilled_at IS NOT NULL
        )
      );
  `);
};
