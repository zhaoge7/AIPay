import type { PilotReviewEvidence } from '@aipay/contracts';
import * as z from 'zod/v4';

const sha256Pattern = /^[0-9a-f]{64}$/u;
const nonnegative = z.number().min(0);
const percentage = z.number().min(0).max(100);

const PilotReportReviewInputSchema = z.object({
  schemaVersion: z.literal('1'),
  pilotId: z.string(),
  generatedAt: z.string(),
  manifestSha256: z.string().regex(sha256Pattern),
  trafficSha256: z.string().regex(sha256Pattern),
  onboarding: z.object({
    merchantMinutes: nonnegative,
    agentMinutes: nonnegative,
    failureCount: z.number().int().min(0),
    unresolvedFailureCount: z.number().int().min(0),
  }),
  metrics: z.object({
    acceptedCallCount: z.number().int().min(0),
    unclassifiedTransactionCount: z.number().int().min(0),
    ledgerMissingTransactionCount: z.number().int().min(0),
    exclusionMissingTransactionCount: z.number().int().min(0),
    unauthorizedPaymentCount: z.number().int().min(0),
    duplicateChargeCount: z.number().int().min(0),
    fakeProviderCount: z.number().int().min(0),
    auditCompletenessPercent: percentage,
    paymentSuccessPercent: percentage,
    deliverySuccessPercent: percentage,
    autonomousPercent: percentage,
  }),
  automatedChecks: z.object({
    commercialIntentConfirmed: z.boolean(),
    externalTrafficFullyClassified: z.boolean(),
  }),
});

export type PilotReportReviewInput = z.infer<typeof PilotReportReviewInputSchema>;

export class PilotReviewError extends Error {
  readonly code: 'invalid_report' | 'pilot_mismatch';

  constructor(code: PilotReviewError['code']) {
    super(`Pilot review failed: ${code}`);
    this.name = 'PilotReviewError';
    this.code = code;
  }
}

export function parsePilotReportForReview(value: unknown): PilotReportReviewInput {
  const result = PilotReportReviewInputSchema.safeParse(value);

  if (!result.success) throw new PilotReviewError('invalid_report');
  return Object.freeze(result.data);
}

interface ReviewCheck {
  readonly name: string;
  readonly category: 'gate_mvp' | 'continue_orchestration';
  readonly actual: string | number | boolean;
  readonly requirement: string;
  readonly passed: boolean;
}

function check(
  name: string,
  category: ReviewCheck['category'],
  actual: ReviewCheck['actual'],
  requirement: string,
  passed: boolean,
): Readonly<ReviewCheck> {
  return Object.freeze({ name, category, actual, requirement, passed });
}

function amountPerCall(amountMinor: string, calls: number): string | null {
  if (calls === 0) return null;
  const scaled = (BigInt(amountMinor) * 10_000n) / BigInt(calls);
  const whole = scaled / 10_000n;
  const fraction = (scaled % 10_000n).toString().padStart(4, '0');
  return `${whole.toString()}.${fraction}`;
}

export function buildMvpReview(
  report: PilotReportReviewInput,
  evidence: PilotReviewEvidence,
  reportSha256: string,
  evidenceSha256: string,
  generatedAt = new Date(),
) {
  if (report.pilotId !== evidence.pilotId) throw new PilotReviewError('pilot_mismatch');
  const majorIncidentCount = evidence.incidents.filter(
    ({ severity }) => severity === 'SEV-1',
  ).length;
  const unresolvedIncidentCount = evidence.incidents.filter(({ resolved }) => !resolved).length;
  const trafficComplete =
    report.automatedChecks.externalTrafficFullyClassified &&
    report.metrics.unclassifiedTransactionCount === 0 &&
    report.metrics.ledgerMissingTransactionCount === 0 &&
    report.metrics.exclusionMissingTransactionCount === 0;
  const checks: Readonly<ReviewCheck>[] = [
    check(
      'accepted_calls',
      'gate_mvp',
      report.metrics.acceptedCallCount,
      '>= 1000',
      report.metrics.acceptedCallCount >= 1_000,
    ),
    check(
      'unauthorized_payments',
      'gate_mvp',
      report.metrics.unauthorizedPaymentCount,
      '= 0',
      report.metrics.unauthorizedPaymentCount === 0,
    ),
    check(
      'duplicate_charges',
      'gate_mvp',
      report.metrics.duplicateChargeCount,
      '= 0',
      report.metrics.duplicateChargeCount === 0,
    ),
    check(
      'fake_provider_transactions',
      'gate_mvp',
      report.metrics.fakeProviderCount,
      '= 0',
      report.metrics.fakeProviderCount === 0,
    ),
    check(
      'audit_completeness_percent',
      'gate_mvp',
      report.metrics.auditCompletenessPercent,
      '= 100',
      report.metrics.auditCompletenessPercent === 100,
    ),
    check('traffic_classification', 'gate_mvp', trafficComplete, '= true', trafficComplete),
    check(
      'external_merchant_evidence',
      'gate_mvp',
      evidence.externalMerchantApproved,
      '= true',
      evidence.externalMerchantApproved,
    ),
    check(
      'external_agent_evidence',
      'gate_mvp',
      evidence.externalAgentApproved,
      '= true',
      evidence.externalAgentApproved,
    ),
    check(
      'capability_and_price_evidence',
      'gate_mvp',
      evidence.capabilityAndPriceApproved,
      '= true',
      evidence.capabilityAndPriceApproved,
    ),
    check(
      'traffic_evidence_review',
      'gate_mvp',
      evidence.trafficEvidenceApproved,
      '= true',
      evidence.trafficEvidenceApproved,
    ),
    check(
      'commercial_intent',
      'gate_mvp',
      report.automatedChecks.commercialIntentConfirmed && evidence.commercialEvidenceApproved,
      '= true',
      report.automatedChecks.commercialIntentConfirmed && evidence.commercialEvidenceApproved,
    ),
    check(
      'payment_success_percent',
      'continue_orchestration',
      report.metrics.paymentSuccessPercent,
      '>= 98.5',
      report.metrics.paymentSuccessPercent >= 98.5,
    ),
    check(
      'delivery_success_percent',
      'continue_orchestration',
      report.metrics.deliverySuccessPercent,
      '>= 98.5',
      report.metrics.deliverySuccessPercent >= 98.5,
    ),
    check(
      'merchant_onboarding_minutes',
      'continue_orchestration',
      report.onboarding.merchantMinutes,
      '<= 30',
      report.onboarding.merchantMinutes <= 30,
    ),
    check(
      'agent_onboarding_minutes',
      'continue_orchestration',
      report.onboarding.agentMinutes,
      '<= 480',
      report.onboarding.agentMinutes <= 480,
    ),
    check(
      'unresolved_integration_failures',
      'continue_orchestration',
      report.onboarding.unresolvedFailureCount,
      '= 0',
      report.onboarding.unresolvedFailureCount === 0,
    ),
    check(
      'fully_autonomous_percent',
      'continue_orchestration',
      report.metrics.autonomousPercent,
      '>= 30',
      report.metrics.autonomousPercent >= 30,
    ),
    check(
      'major_incidents',
      'continue_orchestration',
      majorIncidentCount,
      '= 0',
      majorIncidentCount === 0,
    ),
    check(
      'unresolved_incidents',
      'continue_orchestration',
      unresolvedIncidentCount,
      '= 0',
      unresolvedIncidentCount === 0,
    ),
  ];
  const gateMvpPassed = checks
    .filter(({ category }) => category === 'gate_mvp')
    .every(({ passed }) => passed);
  const continueOrchestration =
    gateMvpPassed &&
    checks
      .filter(({ category }) => category === 'continue_orchestration')
      .every(({ passed }) => passed);
  const recommendation = continueOrchestration
    ? 'continue_payment_orchestration'
    : 'shrink_to_metering_billing';

  return Object.freeze({
    schemaVersion: '1',
    pilotId: report.pilotId,
    reportSha256,
    evidenceSha256,
    generatedAt: generatedAt.toISOString(),
    gateMvpPassed,
    recommendation,
    failedChecks: Object.freeze(checks.filter(({ passed }) => !passed).map(({ name }) => name)),
    checks: Object.freeze(checks),
    economics: Object.freeze({
      ...evidence.economics,
      infrastructureCostPerAcceptedCallAmountMinor: amountPerCall(
        evidence.economics.infrastructureCostAmountMinor,
        report.metrics.acceptedCallCount,
      ),
      softwareFeePerAcceptedCallAmountMinor: amountPerCall(
        evidence.economics.softwareFeeAmountMinor,
        report.metrics.acceptedCallCount,
      ),
      supportMinutesPerThousandCalls:
        report.metrics.acceptedCallCount === 0
          ? null
          : Number(
              (
                (evidence.economics.supportMinutes * 1_000) /
                report.metrics.acceptedCallCount
              ).toFixed(2),
            ),
    }),
    finalDecisionRequiresOwnerSignoff: true,
  });
}
