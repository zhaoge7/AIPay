import * as z from 'zod';

const utcDateTimePattern =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const pilotIdPattern = /^pilot_[a-z0-9][a-z0-9_-]{0,63}$/;
const aliasPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const amountPattern = /^(0|[1-9][0-9]{0,15})$/;
const httpsUrlSchema = z.url().refine((value) => value.startsWith('https://'));

const incidentSchema = z.strictObject({
  incidentId: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{0,63}$/),
  severity: z.enum(['SEV-1', 'SEV-2', 'SEV-3']),
  resolved: z.boolean(),
  evidenceUrl: httpsUrlSchema,
});

export const PilotReviewEvidenceSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  pilotId: z.string().regex(pilotIdPattern),
  reviewedAt: z.string().regex(utcDateTimePattern),
  evidenceReviewerAlias: z.string().regex(aliasPattern),
  externalMerchantApproved: z.boolean(),
  externalAgentApproved: z.boolean(),
  capabilityAndPriceApproved: z.boolean(),
  trafficEvidenceApproved: z.boolean(),
  commercialEvidenceApproved: z.boolean(),
  incidents: z.array(incidentSchema).max(1_000),
  economics: z.strictObject({
    infrastructureCostAmountMinor: z.string().regex(amountPattern),
    softwareFeeAmountMinor: z.string().regex(amountPattern),
    supportMinutes: z.number().int().min(0).max(1_000_000),
    evidenceUrl: httpsUrlSchema,
  }),
});

export type PilotReviewEvidence = z.infer<typeof PilotReviewEvidenceSchema>;

export class PilotReviewEvidenceValidationError extends Error {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super('Invalid pilot review evidence');
    this.name = 'PilotReviewEvidenceValidationError';
    this.paths = Object.freeze([...paths]);
  }
}

export function parsePilotReviewEvidence(value: unknown): PilotReviewEvidence {
  const result = PilotReviewEvidenceSchema.safeParse(value);

  if (!result.success) {
    throw new PilotReviewEvidenceValidationError(
      result.error.issues.map((issue) => `/${issue.path.map(String).join('/')}`),
    );
  }

  return Object.freeze(result.data);
}
