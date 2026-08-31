import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePilotReviewEvidence } from '@aipay/contracts';

import {
  PilotReviewError,
  buildMvpReview,
  parsePilotReportForReview,
} from '../dist/pilot/review.js';

function report(overrides = {}) {
  return parsePilotReportForReview({
    schemaVersion: '1',
    pilotId: 'pilot_review',
    generatedAt: '2026-09-30T00:30:00.000Z',
    manifestSha256: 'a'.repeat(64),
    trafficSha256: 'b'.repeat(64),
    onboarding: {
      merchantMinutes: 25,
      agentMinutes: 420,
      failureCount: 2,
      unresolvedFailureCount: 0,
      ...overrides.onboarding,
    },
    metrics: {
      acceptedCallCount: 1_000,
      unclassifiedTransactionCount: 0,
      ledgerMissingTransactionCount: 0,
      exclusionMissingTransactionCount: 0,
      unauthorizedPaymentCount: 0,
      duplicateChargeCount: 0,
      fakeProviderCount: 0,
      auditCompletenessPercent: 100,
      paymentSuccessPercent: 99,
      deliverySuccessPercent: 99,
      autonomousPercent: 35,
      ...overrides.metrics,
    },
    automatedChecks: {
      commercialIntentConfirmed: true,
      externalTrafficFullyClassified: true,
      ...overrides.automatedChecks,
    },
  });
}

function evidence(overrides = {}) {
  return parsePilotReviewEvidence({
    schemaVersion: '1',
    pilotId: 'pilot_review',
    reviewedAt: '2026-09-30T01:00:00.000Z',
    evidenceReviewerAlias: 'reviewer',
    externalMerchantApproved: true,
    externalAgentApproved: true,
    capabilityAndPriceApproved: true,
    trafficEvidenceApproved: true,
    commercialEvidenceApproved: true,
    incidents: [],
    economics: {
      infrastructureCostAmountMinor: '1000',
      softwareFeeAmountMinor: '2000',
      supportMinutes: 120,
      evidenceUrl: 'https://evidence.example.com/pilot/economics',
    },
    ...overrides,
  });
}

test('recommends continuing payment orchestration only when every threshold passes', () => {
  const review = buildMvpReview(
    report(),
    evidence(),
    'c'.repeat(64),
    'd'.repeat(64),
    new Date('2026-09-30T01:01:00.000Z'),
  );
  assert.equal(review.gateMvpPassed, true);
  assert.equal(review.recommendation, 'continue_payment_orchestration');
  assert.deepEqual(review.failedChecks, []);
  assert.equal(review.economics.infrastructureCostPerAcceptedCallAmountMinor, '1.0000');
  assert.equal(review.economics.softwareFeePerAcceptedCallAmountMinor, '2.0000');
  assert.equal(review.economics.supportMinutesPerThousandCalls, 120);
  assert.equal(review.finalDecisionRequiresOwnerSignoff, true);
});

test('recommends metering and billing when autonomy or reliability misses the bar', () => {
  const review = buildMvpReview(
    report({ metrics: { autonomousPercent: 29, deliverySuccessPercent: 98 } }),
    evidence(),
    'e'.repeat(64),
    'f'.repeat(64),
  );
  assert.equal(review.gateMvpPassed, true);
  assert.equal(review.recommendation, 'shrink_to_metering_billing');
  assert.ok(review.failedChecks.includes('fully_autonomous_percent'));
  assert.ok(review.failedChecks.includes('delivery_success_percent'));
});

test('fails Gate MVP without 1000 calls, external evidence or commercial intent', () => {
  const review = buildMvpReview(
    report({
      metrics: { acceptedCallCount: 999 },
      automatedChecks: { commercialIntentConfirmed: false },
    }),
    evidence({ externalAgentApproved: false }),
    '1'.repeat(64),
    '2'.repeat(64),
  );
  assert.equal(review.gateMvpPassed, false);
  assert.equal(review.recommendation, 'shrink_to_metering_billing');
  assert.ok(review.failedChecks.includes('accepted_calls'));
  assert.ok(review.failedChecks.includes('external_agent_evidence'));
  assert.ok(review.failedChecks.includes('commercial_intent'));
});

test('rejects mismatched pilot evidence', () => {
  assert.throws(
    () =>
      buildMvpReview(
        report(),
        evidence({ pilotId: 'pilot_other' }),
        '3'.repeat(64),
        '4'.repeat(64),
      ),
    (error) => error instanceof PilotReviewError && error.code === 'pilot_mismatch',
  );
});
