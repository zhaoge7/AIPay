import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import test from 'node:test';

import { parseResourceId } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';

import { PaymentControlService } from '../dist/controls/service.js';
import {
  TransactionCreationError,
  TransactionCreationService,
} from '../dist/transactions/create.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

test('creates Transactions only from matching active Quote and Mandate references', async (context) => {
  const container = {
    name: `aipay-transaction-create-test-${process.pid}`,
    database: 'aipay_transaction_create_test',
    user: 'aipay',
    password: 'transaction-create-only',
  };
  let database;
  context.after(async () => {
    await database?.destroy();
    removePostgresContainer(container.name);
  });

  const { databaseUrl } = await startPostgresContainer(container);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 4 });
  const developer = await database
    .insertInto('developers')
    .values({
      email: 'transaction-create@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'Transaction Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'Transaction Merchant',
      callbackUrl: 'https://transaction.example.com/webhook',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const systemKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'system',
      developerId: null,
      agentId: null,
      merchantId: null,
      publicKey: Buffer.alloc(32, 30),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchantKey = await database
    .insertInto('signingKeys')
    .values({
      ownerType: 'merchant',
      developerId: null,
      agentId: null,
      merchantId: merchant.id,
      publicKey: Buffer.alloc(32, 31),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const service = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Transaction Service',
      category: 'data.transaction',
      unit: 'request',
      unitPriceAmountMinor: '200',
      refundPolicy: 'full_on_delivery_failure',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandate = await database
    .insertInto('mandates')
    .values({
      principalId: developer.id,
      agentId: agent.id,
      purpose: 'Transaction creation integration',
      maxPerTransactionAmountMinor: '1000',
      totalBudgetAmountMinor: '5000',
      approvalRequiredAboveAmountMinor: '500',
      maxTransactions: 10,
      issuedAt: new Date(Date.now() - 1_000),
      validUntil: new Date(Date.now() + 60_000),
      instructionHash: Buffer.alloc(32, 32),
      proofKeyId: systemKey.id,
      proofValue: Buffer.alloc(64, 33),
      status: 'active',
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await database
    .insertInto('mandateAllowedMerchants')
    .values({ mandateId: mandate.id, merchantId: merchant.id })
    .execute();
  await database
    .insertInto('mandateAllowedCategories')
    .values({ mandateId: mandate.id, category: 'data.transaction' })
    .execute();

  async function quote(amountMinor, status = 'active', serviceId = service.id) {
    return database
      .insertInto('quotes')
      .values({
        merchantId: merchant.id,
        serviceId,
        unit: 'request',
        quantity: 1,
        unitPriceAmountMinor: amountMinor,
        subtotalAmountMinor: amountMinor,
        taxBehavior: 'inclusive',
        taxAmountMinor: '0',
        totalAmountMinor: amountMinor,
        issuedAt: new Date(Date.now() - 1_000),
        expiresAt: new Date(Date.now() + 60_000),
        proofKeyId: status === 'draft' ? null : merchantKey.id,
        proofValue: status === 'draft' ? null : Buffer.alloc(64, Number(amountMinor) % 255),
        status,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
  }

  const creation = new TransactionCreationService(database);
  const mandateId = parseResourceId(`mdt_${mandate.id}`, 'mdt');
  const agentId = parseResourceId(`agt_${agent.id}`, 'agt');
  const quote200 = await quote('200');
  const authorized = await creation.create(
    agentId,
    parseResourceId(`qte_${quote200.id}`, 'qte'),
    mandateId,
    'transaction-test-200',
  );
  assert.equal(authorized.status, 'authorized');
  assert.equal(authorized.quoteId, `qte_${quote200.id}`);
  assert.equal(authorized.mandateId, mandateId);
  assert.equal(authorized.agentId, agentId);
  assert.equal(authorized.merchantId, `mch_${merchant.id}`);
  assert.equal(authorized.serviceId, `svc_${service.id}`);
  assert.deepEqual(authorized.amount, { currency: 'CNY', amountMinor: '200' });
  assert.deepEqual(authorized.paymentAttemptIds, []);
  assert.equal(authorized.deliveryId, null);
  assert.deepEqual(authorized.refundIds, []);

  await assert.rejects(
    creation.create(
      agentId,
      parseResourceId(`qte_${quote200.id}`, 'qte'),
      mandateId,
      'transaction-test-200-other',
    ),
    (error) => error instanceof TransactionCreationError && error.code === 'transaction_exists',
  );

  const quote600 = await quote('600');
  const pending = await creation.create(
    agentId,
    parseResourceId(`qte_${quote600.id}`, 'qte'),
    mandateId,
    'transaction-test-600',
  );
  assert.equal(pending.status, 'requires_confirmation');

  const draftQuote = await quote('300', 'draft');
  await assert.rejects(
    creation.create(
      agentId,
      parseResourceId(`qte_${draftQuote.id}`, 'qte'),
      mandateId,
      'transaction-test-draft',
    ),
    (error) => error instanceof TransactionCreationError && error.code === 'quote_inactive',
  );

  const wrongAgent = parseResourceId('agt_01890f3e-a200-7cc2-98c5-7f6a1b2c3d4e', 'agt');
  const wrongAgentQuote = await quote('300');
  await assert.rejects(
    creation.create(
      wrongAgent,
      parseResourceId(`qte_${wrongAgentQuote.id}`, 'qte'),
      mandateId,
      'transaction-test-wrong-agent',
    ),
    (error) => error instanceof TransactionCreationError && error.code === 'agent_unavailable',
  );

  const deniedService = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'Denied Category Service',
      category: 'data.denied',
      unit: 'request',
      unitPriceAmountMinor: '300',
      refundPolicy: 'non_refundable',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const deniedQuote = await quote('300', 'active', deniedService.id);
  await assert.rejects(
    creation.create(
      agentId,
      parseResourceId(`qte_${deniedQuote.id}`, 'qte'),
      mandateId,
      'transaction-test-policy-denied',
    ),
    (error) => error instanceof TransactionCreationError && error.code === 'policy_denied',
  );

  const paymentControls = new PaymentControlService(database);
  const developerId = parseResourceId(`dev_${developer.id}`, 'dev');
  assert.deepEqual(await paymentControls.get(developerId), {
    paymentsPaused: false,
    updatedAt: null,
  });
  const pausedControl = await paymentControls.set(developerId, true);
  assert.equal(pausedControl.paymentsPaused, true);
  assert.notEqual(pausedControl.updatedAt, null);
  const globallyPausedQuote = await quote('300');
  await assert.rejects(
    creation.create(
      agentId,
      parseResourceId(`qte_${globallyPausedQuote.id}`, 'qte'),
      mandateId,
      'transaction-test-globally-paused',
    ),
    (error) => error instanceof TransactionCreationError && error.code === 'principal_paused',
  );
  assert.equal((await paymentControls.set(developerId, false)).paymentsPaused, false);

  await database
    .updateTable('mandates')
    .set({ status: 'paused', statusChangedAt: new Date() })
    .where('id', '=', mandate.id)
    .executeTakeFirstOrThrow();
  const pausedQuote = await quote('300');
  await assert.rejects(
    creation.create(
      agentId,
      parseResourceId(`qte_${pausedQuote.id}`, 'qte'),
      mandateId,
      'transaction-test-paused',
    ),
    (error) => error instanceof TransactionCreationError && error.code === 'mandate_inactive',
  );

  const rows = await database
    .selectFrom('transactions')
    .select(['quoteId', 'mandateId', 'status'])
    .orderBy('createdAt', 'asc')
    .execute();
  assert.deepEqual(rows, [
    { quoteId: quote200.id, mandateId: mandate.id, status: 'authorized' },
    { quoteId: quote600.id, mandateId: mandate.id, status: 'requires_confirmation' },
  ]);
  const attempts = await database
    .selectFrom('paymentAttempts')
    .select(({ fn }) => fn.countAll().as('count'))
    .executeTakeFirstOrThrow();
  assert.equal(Number(attempts.count), 0);
});
