export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE aipay.a2m_orders (
      id UUID PRIMARY KEY DEFAULT uuidv7(),
      out_trade_no TEXT NOT NULL UNIQUE,
      merchant_id UUID NOT NULL,
      service_id UUID NOT NULL,
      currency CHAR(3) NOT NULL DEFAULT 'CNY',
      amount_minor BIGINT NOT NULL,
      resource_id TEXT NOT NULL,
      goods_name TEXT NOT NULL,
      pay_before TIMESTAMPTZ(3) NOT NULL,
      order_status TEXT NOT NULL DEFAULT 'pending_payment',
      fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled',
      provider_trade_no TEXT UNIQUE,
      payment_proof_hash BYTEA,
      service_result JSONB,
      fulfillment_error_code TEXT,
      fulfilled_at TIMESTAMPTZ(3),
      created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT a2m_orders_service_merchant_fk
        FOREIGN KEY (service_id, merchant_id) REFERENCES aipay.services(id, merchant_id),
      CONSTRAINT a2m_orders_trade_no_check CHECK (out_trade_no ~ '^A2M[0-9A-F]{32}$'),
      CONSTRAINT a2m_orders_currency_check CHECK (currency = 'CNY'),
      CONSTRAINT a2m_orders_amount_check CHECK (amount_minor > 0),
      CONSTRAINT a2m_orders_resource_check CHECK (char_length(resource_id) BETWEEN 1 AND 256),
      CONSTRAINT a2m_orders_goods_check CHECK (char_length(goods_name) BETWEEN 1 AND 256),
      CONSTRAINT a2m_orders_validity_check CHECK (
        pay_before > created_at AND pay_before <= created_at + INTERVAL '24 hours'
      ),
      CONSTRAINT a2m_orders_order_status_check CHECK (order_status IN ('pending_payment', 'paid')),
      CONSTRAINT a2m_orders_fulfillment_status_check CHECK (
        fulfillment_status IN ('unfulfilled', 'pending_confirm', 'fulfilled')
      ),
      CONSTRAINT a2m_orders_proof_hash_check CHECK (
        payment_proof_hash IS NULL OR octet_length(payment_proof_hash) = 32
      ),
      CONSTRAINT a2m_orders_service_result_check CHECK (
        service_result IS NULL OR jsonb_typeof(service_result) = 'object'
      ),
      CONSTRAINT a2m_orders_state_check CHECK (
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
      ),
      CONSTRAINT a2m_orders_timestamp_check CHECK (
        updated_at >= created_at AND (fulfilled_at IS NULL OR fulfilled_at >= created_at)
      )
    );

    CREATE INDEX a2m_orders_service_idx ON aipay.a2m_orders(service_id, created_at);
    CREATE INDEX a2m_orders_pending_idx
      ON aipay.a2m_orders(pay_before, id)
      WHERE fulfillment_status <> 'fulfilled';
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE IF EXISTS aipay.a2m_orders;');
};
