import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import test from 'node:test';

import { parsePilotManifest } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';
import { v7 as uuidv7 } from 'uuid';

import { buildPilotReport } from '../dist/pilot/report.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

test('counts only bound non-Fake paid deliveries and exposes Gate MVP invariants', async (context) => {
  const container = {
    name: `aipay-pilot-report-${process.pid}`,
    database: 'aipay_pilot_report_test',
    user: 'aipay',
    password: 'pilot-report-test-only',
  };
  let database;
  context.after(async () => {
    await database?.destroy();
    removePostgresContainer(container.name);
  });

  const { databaseUrl } = await startPostgresContainer(container);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 8 });
  const now = new Date();
  const developer = await database
    .insertInto('developers')
    .values({
      email: 'pilot-report@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$YWJj',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const agent = await database
    .insertInto('agents')
    .values({ developerId: developer.id, name: 'External Pilot Agent' })
    .returning('id')
    .executeTakeFirstOrThrow();
  const merchant = await database
    .insertInto('merchants')
    .values({
      developerId: developer.id,
      name: 'External Pilot Merchant',
      callbackUrl: 'https://pilot-merchant.example/webhook',
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
      publicKey: Buffer.alloc(32, 101),
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const service = await database
    .insertInto('services')
    .values({
      merchantId: merchant.id,
      serviceType: 'api',
      name: 'External Pilot Capability',
      category: 'data.pilot',
      unit: 'request',
      unitPriceAmountMinor: '1',
      refundPolicy: 'full_on_delivery_failure',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const mandate = await database
    .insertInto('mandates')
    .values({
      principalId: developer.id,
      agentId: agent.id,
      purpose: 'External design-partner pilot',
      maxPerTransactionAmountMinor: '10',
      totalBudgetAmountMinor: '10000',
      approvalRequiredAboveAmountMinor: '10',
      maxTransactions: 10_000,
      issuedAt: new Date(now.getTime() - 60_000),
      validUntil: new Date(now.getTime() + 86_400_000),
      instructionHash: Buffer.alloc(32, 102),
      proofKeyId: systemKey.id,
      proofValue: Buffer.alloc(64, 103),
      status: 'active',
      revokedAt: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const reservation = await database
    .insertInto('budgetReservations')
    .values({
      mandateId: mandate.id,
      agentId: agent.id,
      amountMinor: '1',
      status: 'confirmed',
      createdAt: new Date(now.getTime() - 10_000),
      expiresAt: new Date(now.getTime() + 60_000),
      finalizedAt: now,
      finalizationReason: 'payment_succeeded',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const quote = await database
    .insertInto('quotes')
    .values({
      merchantId: merchant.id,
      serviceId: service.id,
      unit: 'request',
      quantity: 1,
      unitPriceAmountMinor: '1',
      subtotalAmountMinor: '1',
      taxBehavior: 'inclusive',
      taxAmountMinor: '0',
      totalAmountMinor: '1',
      issuedAt: new Date(now.getTime() - 5_000),
      expiresAt: new Date(now.getTime() + 60_000),
      proofKeyId: systemKey.id,
      proofValue: Buffer.alloc(64, 104),
      status: 'active',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const transaction = await database
    .insertInto('transactions')
    .values({
      quoteId: quote.id,
      mandateId: mandate.id,
      principalId: developer.id,
      agentId: agent.id,
      merchantId: merchant.id,
      serviceId: service.id,
      amountMinor: '1',
      status: 'delivered',
      createdAt: new Date(now.getTime() - 4_000),
      updatedAt: now,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  const attempt = await database
    .insertInto('paymentAttempts')
    .values({
      transactionId: transaction.id,
      reservationId: reservation.id,
      attemptNumber: 1,
      provider: 'alipay_web',
      providerReference: 'pilot-provider-reference',
      providerTransactionId: 'pilot-provider-transaction',
      amountMinor: '1',
      status: 'succeeded',
      errorCode: null,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await database
    .insertInto('paymentProviderCalls')
    .values({
      paymentAttemptId: attempt.id,
      operation: 'payment.create',
      requestDigest: Buffer.alloc(32, 105),
      outcome: 'succeeded',
      providerStatus: 'succeeded',
      providerReference: 'pilot-provider-reference',
      providerTransactionId: 'pilot-provider-transaction',
      errorKind: null,
      errorCode: null,
      startedAt: new Date(now.getTime() - 3_000),
      completedAt: new Date(now.getTime() - 2_900),
      durationMs: 100,
    })
    .executeTakeFirstOrThrow();
  const paymentProofId = uuidv7();
  await database
    .insertInto('paymentProofs')
    .values({
      id: paymentProofId,
      transactionId: transaction.id,
      paymentAttemptId: attempt.id,
      merchantId: merchant.id,
      serviceId: service.id,
      amountMinor: '1',
      issuedAt: new Date(now.getTime() - 2_500),
      expiresAt: new Date(now.getTime() + 60_000),
      proofKeyId: systemKey.id,
      proofValue: Buffer.alloc(64, 106),
      status: 'consumed',
      consumedAt: new Date(now.getTime() - 2_000),
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto('deliveries')
    .values({
      transactionId: transaction.id,
      paymentProofId,
      merchantId: merchant.id,
      serviceId: service.id,
      refundPolicy: 'full_on_delivery_failure',
      expiresAt: new Date(now.getTime() + 60_000),
      status: 'succeeded',
      resultDigest: Buffer.alloc(32, 107),
      deliveredAt: new Date(now.getTime() - 1_000),
      errorCode: null,
      proofScheme: 'aipay-jcs-ed25519-v1',
      proofKeyId: systemKey.id,
      proofValue: Buffer.alloc(64, 108),
      createdAt: new Date(now.getTime() - 2_000),
      updatedAt: new Date(now.getTime() - 1_000),
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto('outboxEvents')
    .values([
      {
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        eventType: 'transaction.paid',
        payload: { transactionId: `txn_${transaction.id}` },
        status: 'published',
        publishedAt: now,
        attemptCount: 1,
        createdAt: new Date(now.getTime() - 1_500),
      },
      {
        aggregateType: 'transaction',
        aggregateId: transaction.id,
        eventType: 'transaction.delivered',
        payload: { transactionId: `txn_${transaction.id}` },
        status: 'published',
        publishedAt: now,
        attemptCount: 1,
        createdAt: new Date(now.getTime() - 900),
      },
    ])
    .execute();

  const manifest = parsePilotManifest({
    schemaVersion: '1',
    pilotId: 'pilot_report_test',
    window: {
      startedAt: new Date(now.getTime() - 60_000).toISOString(),
      endedAt: new Date(now.getTime() + 60_000).toISOString(),
    },
    environmentUrl: 'https://pilot.example.com',
    merchant: {
      operatorAlias: 'merchant-test',
      merchantId: `mch_${merchant.id}`,
      serviceId: `svc_${service.id}`,
      serviceType: 'api',
      unit: 'request',
      unitPrice: { currency: 'CNY', amountMinor: '1' },
      capabilityEvidenceUrl: 'https://evidence.example.com/merchant/capability',
      pricingEvidenceUrl: 'https://evidence.example.com/merchant/pricing',
      implementationEvidenceUrl: 'https://evidence.example.com/merchant/integration',
      onboardingStartedAt: new Date(now.getTime() - 3_600_000).toISOString(),
      onboardingCompletedAt: new Date(now.getTime() - 1_800_000).toISOString(),
    },
    agent: {
      operatorAlias: 'agent-test',
      agentId: `agt_${agent.id}`,
      implementationEvidenceUrl: 'https://evidence.example.com/agent/integration',
      trafficAttestationUrl: 'https://evidence.example.com/agent/traffic',
      onboardingStartedAt: new Date(now.getTime() - 1_800_000).toISOString(),
      onboardingCompletedAt: new Date(now.getTime() - 300_000).toISOString(),
    },
    failures: [],
    commercialIntent: { status: 'pending', evidenceUrl: null, recordedAt: null },
  });
  const report = await buildPilotReport(database, manifest, 'a'.repeat(64), now);

  assert.deepEqual(report.metrics, {
    scopedTransactionCount: 1,
    acceptedCallCount: 1,
    rejectedCallCount: 0,
    successfulPaymentCount: 1,
    successfulDeliveryCount: 1,
    unauthorizedPaymentCount: 0,
    duplicateChargeCount: 0,
    fakeProviderCount: 0,
    auditCompleteCount: 1,
    auditCompletenessPercent: 100,
    paymentSuccessPercent: 100,
    deliverySuccessPercent: 100,
    acceptedAmountMinor: '1',
    currency: 'CNY',
  });
  assert.equal(report.automatedChecks.firstEndToEndTransaction, true);
  assert.equal(report.automatedChecks.oneThousandAcceptedCalls, false);
  assert.equal(report.automatedChecks.commercialIntentConfirmed, false);
  assert.equal(report.automatedChecks.gateMvpDatabaseEligible, false);
  assert.deepEqual(report.acceptedTransactionIds, [`txn_${transaction.id}`]);

  await database
    .updateTable('paymentAttempts')
    .set({ provider: 'fake' })
    .where('id', '=', attempt.id)
    .executeTakeFirstOrThrow();
  const fakeReport = await buildPilotReport(database, manifest, 'b'.repeat(64), now);
  assert.equal(fakeReport.metrics.acceptedCallCount, 0);
  assert.equal(fakeReport.metrics.fakeProviderCount, 1);
  assert.deepEqual(fakeReport.rejectedTransactions[0]?.reasons, ['fake_provider']);

  await database
    .updateTable('paymentAttempts')
    .set({ provider: 'alipay_web' })
    .where('id', '=', attempt.id)
    .executeTakeFirstOrThrow();
  await database
    .updateTable('budgetReservations')
    .set({ amountMinor: '2' })
    .where('id', '=', reservation.id)
    .executeTakeFirstOrThrow();
  const misboundReport = await buildPilotReport(database, manifest, 'c'.repeat(64), now);
  assert.equal(misboundReport.metrics.acceptedCallCount, 0);
  assert.equal(misboundReport.metrics.unauthorizedPaymentCount, 1);
  assert.deepEqual(misboundReport.rejectedTransactions[0]?.reasons, [
    'missing_or_misbound_budget_reservation',
  ]);
});
