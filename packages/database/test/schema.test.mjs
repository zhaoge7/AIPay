import assert from 'node:assert/strict';
import process from 'node:process';
import test from 'node:test';

import { transactionStatuses } from '@aipay/contracts';
import pg from 'pg';

import { runMigrations } from '../scripts/migration-runner.mjs';
import { removePostgresContainer, startPostgresContainer } from '../scripts/postgres-container.mjs';

const { Client } = pg;
const discardLog = () => undefined;
const expectedTables = [
  'agent_request_nonces',
  'agents',
  'api_keys',
  'audit_events',
  'auth_sessions',
  'deliveries',
  'developers',
  'mandate_allowed_categories',
  'mandate_allowed_merchants',
  'mandates',
  'merchants',
  'outbox_events',
  'payment_attempts',
  'quotes',
  'refunds',
  'services',
  'signing_keys',
  'transactions',
];

async function assertQueryFails(client, query, constraintName) {
  await assert.rejects(
    client.query(query),
    (error) =>
      (error.code === '23505' || error.code === '23514' || error.code === '23503') &&
      error.constraint === constraintName,
  );
}

test('creates the complete core schema and enforces Contract bindings', async (context) => {
  const config = {
    name: `aipay-schema-test-${process.pid}`,
    database: 'aipay_schema_test',
    user: 'aipay',
    password: 'schema-test-only',
  };
  context.after(() => removePostgresContainer(config.name));

  const { databaseUrl } = await startPostgresContainer(config);
  await runMigrations(databaseUrl, discardLog);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  context.after(() => client.end());

  const tables = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'aipay' ORDER BY table_name",
  );
  assert.deepEqual(
    tables.rows.map((row) => row.table_name),
    expectedTables,
  );

  const statusConstraint = await client.query(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'transactions_status_check'",
  );
  assert.equal(statusConstraint.rowCount, 1);
  for (const status of transactionStatuses) {
    assert.equal(statusConstraint.rows[0].definition.includes(`'${status}'`), true);
  }

  const developer = await client.query(
    `INSERT INTO aipay.developers (email, password_hash)
      VALUES ('schema-test@example.com', '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj')
      RETURNING id`,
  );
  const developerId = developer.rows[0].id;
  const agent = await client.query(
    "INSERT INTO aipay.agents (developer_id, name) VALUES ($1, 'Schema Agent') RETURNING id",
    [developerId],
  );
  const agentId = agent.rows[0].id;
  const merchant = await client.query(
    "INSERT INTO aipay.merchants (developer_id, name) VALUES ($1, 'Test Merchant') RETURNING id",
    [developerId],
  );
  const merchantId = merchant.rows[0].id;
  await assertQueryFails(
    client,
    {
      text: `INSERT INTO aipay.signing_keys
        (owner_type, developer_id, public_key)
        VALUES ('developer', $1, decode(repeat('01', 31), 'hex'))`,
      values: [developerId],
    },
    'signing_keys_public_key_length_check',
  );
  const signingKey = await client.query(
    "INSERT INTO aipay.signing_keys (owner_type, developer_id, public_key) VALUES ('developer', $1, decode(repeat('01', 32), 'hex')) RETURNING id",
    [developerId],
  );
  const signingKeyId = signingKey.rows[0].id;
  const service = await client.query(
    `INSERT INTO aipay.services
      (merchant_id, name, category, unit, unit_price_amount_minor)
      VALUES ($1, 'Weather API', 'data.weather', 'request', 200)
      RETURNING id`,
    [merchantId],
  );
  const serviceId = service.rows[0].id;
  const mandate = await client.query(
    `INSERT INTO aipay.mandates
      (principal_id, agent_id, purpose, max_per_transaction_amount_minor,
       total_budget_amount_minor, approval_required_above_amount_minor,
       max_transactions, issued_at, valid_until, instruction_hash,
       proof_key_id, proof_value)
      VALUES ($1, $2, 'Buy weather data', 1000, 10000, 500, 100,
        '2026-08-27T00:00:00.000Z', '2026-08-28T00:00:00.000Z',
        decode(repeat('02', 32), 'hex'), $3, decode(repeat('03', 64), 'hex'))
      RETURNING id`,
    [developerId, agentId, signingKeyId],
  );
  const mandateId = mandate.rows[0].id;
  await client.query(
    'INSERT INTO aipay.mandate_allowed_merchants (mandate_id, merchant_id) VALUES ($1, $2)',
    [mandateId, merchantId],
  );
  await client.query(
    "INSERT INTO aipay.mandate_allowed_categories (mandate_id, category) VALUES ($1, 'data.weather')",
    [mandateId],
  );
  await assertQueryFails(
    client,
    {
      text: `INSERT INTO aipay.quotes
        (merchant_id, service_id, unit, quantity, unit_price_amount_minor,
         subtotal_amount_minor, tax_behavior, tax_amount_minor, total_amount_minor,
         issued_at, expires_at, proof_key_id, proof_value)
        VALUES ($1, $2, 'request', 3, 200, 599, 'inclusive', 34, 599,
          '2026-08-27T01:00:00.000Z', '2026-08-27T01:05:00.000Z',
          $3, decode(repeat('04', 64), 'hex'))`,
      values: [merchantId, serviceId, signingKeyId],
    },
    'quotes_subtotal_check',
  );
  await assertQueryFails(
    client,
    {
      text: `INSERT INTO aipay.quotes
        (merchant_id, service_id, unit, quantity, unit_price_amount_minor,
         subtotal_amount_minor, tax_behavior, tax_amount_minor, total_amount_minor,
         issued_at, expires_at, proof_key_id, proof_value)
        VALUES ($1, $2, 'request', 3, 200, 600, 'inclusive', 34, 600,
          '2026-08-27T01:00:00.000Z', '2026-08-27T01:05:00.000Z',
          $3, decode(repeat('04', 63), 'hex'))`,
      values: [merchantId, serviceId, signingKeyId],
    },
    'quotes_proof_value_length_check',
  );
  const quote = await client.query(
    `INSERT INTO aipay.quotes
      (merchant_id, service_id, unit, quantity, unit_price_amount_minor,
       subtotal_amount_minor, tax_behavior, tax_amount_minor, total_amount_minor,
       issued_at, expires_at, proof_key_id, proof_value)
      VALUES ($1, $2, 'request', 3, 200, 600, 'inclusive', 34, 600,
        '2026-08-27T01:00:00.000Z', '2026-08-27T01:05:00.000Z',
        $3, decode(repeat('04', 64), 'hex'))
      RETURNING id`,
    [merchantId, serviceId, signingKeyId],
  );
  const quoteId = quote.rows[0].id;
  await assertQueryFails(
    client,
    {
      text: `INSERT INTO aipay.transactions
        (quote_id, mandate_id, principal_id, agent_id, merchant_id, service_id,
         amount_minor, status)
        VALUES ($1, $2, $3, $4, $5, $6, 599, 'authorized')`,
      values: [quoteId, mandateId, developerId, agentId, merchantId, serviceId],
    },
    'transactions_quote_binding_fk',
  );
  const transaction = await client.query(
    `INSERT INTO aipay.transactions
      (quote_id, mandate_id, principal_id, agent_id, merchant_id, service_id,
       amount_minor, status)
      VALUES ($1, $2, $3, $4, $5, $6, 600, 'authorized')
      RETURNING id`,
    [quoteId, mandateId, developerId, agentId, merchantId, serviceId],
  );
  const transactionId = transaction.rows[0].id;
  const attempt = await client.query(
    `INSERT INTO aipay.payment_attempts
      (transaction_id, attempt_number, provider, amount_minor, status)
      VALUES ($1, 1, 'fake', 600, 'succeeded') RETURNING id`,
    [transactionId],
  );
  const attemptId = attempt.rows[0].id;
  await client.query(
    `INSERT INTO aipay.deliveries
      (transaction_id, status, result_digest, delivered_at)
      VALUES ($1, 'succeeded', decode(repeat('05', 32), 'hex'), CURRENT_TIMESTAMP)`,
    [transactionId],
  );

  await assertQueryFails(
    client,
    {
      text: `INSERT INTO aipay.payment_attempts
        (transaction_id, attempt_number, provider, amount_minor, status)
        VALUES ($1, 1, 'fake', 600, 'succeeded')`,
      values: [transactionId],
    },
    'payment_attempts_number_unique',
  );

  await assertQueryFails(
    client,
    {
      text: `INSERT INTO aipay.refunds
        (transaction_id, payment_attempt_id, amount_minor, status)
        VALUES ($1, $2, 599, 'pending')`,
      values: [transactionId, attemptId],
    },
    'refunds_transaction_amount_fk',
  );
  await client.query(
    `INSERT INTO aipay.refunds
      (transaction_id, payment_attempt_id, amount_minor, status)
      VALUES ($1, $2, 600, 'pending')`,
    [transactionId, attemptId],
  );
});

test('enforces quote arithmetic, proof lengths and audit result invariants', async (context) => {
  const config = {
    name: `aipay-constraints-test-${process.pid}`,
    database: 'aipay_constraints_test',
    user: 'aipay',
    password: 'constraints-test-only',
  };
  context.after(() => removePostgresContainer(config.name));

  const { databaseUrl } = await startPostgresContainer(config);
  await runMigrations(databaseUrl, discardLog);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  context.after(() => client.end());

  await assertQueryFails(
    client,
    `INSERT INTO aipay.audit_events
      (event_type, actor_type, object_type, object_id, occurred_at, trace_id, outcome)
      VALUES ('transaction.failed', 'system', 'transaction', uuidv7(), CURRENT_TIMESTAMP,
        '01234567-89ab-cdef-0123-456789abcdef', 'failed')`,
    'audit_events_result_check',
  );

  await assertQueryFails(
    client,
    `INSERT INTO aipay.audit_events
      (event_type, actor_type, object_type, object_id, occurred_at, trace_id, outcome, result_code)
      VALUES ('transaction.succeeded', 'system', 'transaction', uuidv7(), CURRENT_TIMESTAMP,
        '01234567-89ab-cdef-0123-456789abcdef', 'succeeded', 'UNEXPECTED_CODE')`,
    'audit_events_result_check',
  );
});
