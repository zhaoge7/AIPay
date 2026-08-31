import * as z from 'zod';

import { getResourceIdPattern } from './values/identifier.js';

const utcDateTimePattern =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const aliasPattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
const pilotIdPattern = /^pilot_[a-z0-9][a-z0-9_-]{0,63}$/;
const tokenPattern = /^[a-z][a-z0-9._-]{0,63}$/;
const failureCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const positiveAmountPattern = /^[1-9][0-9]{0,15}$/;

const resourceIdSchema = (prefix: Parameters<typeof getResourceIdPattern>[0]) =>
  z.string().regex(getResourceIdPattern(prefix));
const timestampSchema = z.string().regex(utcDateTimePattern);
const httpsUrlSchema = z.url().refine((value) => value.startsWith('https://'), {
  message: 'HTTPS URL required',
});
const onboardingSchema = z.strictObject({
  onboardingStartedAt: timestampSchema,
  onboardingCompletedAt: timestampSchema,
});

const merchantSchema = z
  .strictObject({
    operatorAlias: z.string().regex(aliasPattern),
    merchantId: resourceIdSchema('mch'),
    serviceId: resourceIdSchema('svc'),
    serviceType: z.enum(['api', 'mcp']),
    unit: z.string().regex(tokenPattern),
    unitPrice: z.strictObject({
      currency: z.literal('CNY'),
      amountMinor: z.string().regex(positiveAmountPattern),
    }),
    capabilityEvidenceUrl: httpsUrlSchema,
    pricingEvidenceUrl: httpsUrlSchema,
    implementationEvidenceUrl: httpsUrlSchema,
    ...onboardingSchema.shape,
  })
  .superRefine((value, context) => {
    if (Date.parse(value.onboardingCompletedAt) < Date.parse(value.onboardingStartedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['onboardingCompletedAt'],
        message: 'Completion must not precede start',
      });
    }
  });

const agentSchema = z
  .strictObject({
    operatorAlias: z.string().regex(aliasPattern),
    agentId: resourceIdSchema('agt'),
    implementationEvidenceUrl: httpsUrlSchema,
    trafficAttestationUrl: httpsUrlSchema,
    ...onboardingSchema.shape,
  })
  .superRefine((value, context) => {
    if (Date.parse(value.onboardingCompletedAt) < Date.parse(value.onboardingStartedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['onboardingCompletedAt'],
        message: 'Completion must not precede start',
      });
    }
  });

const failureSchema = z
  .strictObject({
    occurredAt: timestampSchema,
    resolvedAt: z.nullable(timestampSchema),
    actor: z.enum(['merchant', 'agent']),
    phase: z.string().regex(tokenPattern),
    code: z.string().regex(failureCodePattern),
    source: z.enum(['documentation', 'sdk', 'api', 'console', 'deployment', 'partner']),
    actionEvidenceUrl: z.nullable(httpsUrlSchema),
  })
  .superRefine((value, context) => {
    if (value.resolvedAt !== null && Date.parse(value.resolvedAt) < Date.parse(value.occurredAt)) {
      context.addIssue({
        code: 'custom',
        path: ['resolvedAt'],
        message: 'Resolution must not precede occurrence',
      });
    }
  });

const pendingIntentSchema = z.strictObject({
  status: z.literal('pending'),
  evidenceUrl: z.null(),
  recordedAt: z.null(),
});
const confirmedIntentSchema = z.strictObject({
  status: z.enum(['signed_intent', 'paid_fee']),
  evidenceUrl: httpsUrlSchema,
  recordedAt: timestampSchema,
});

export const PilotManifestSchema = z
  .strictObject({
    schemaVersion: z.literal('1'),
    pilotId: z.string().regex(pilotIdPattern),
    window: z.strictObject({
      startedAt: timestampSchema,
      endedAt: timestampSchema,
    }),
    environmentUrl: httpsUrlSchema,
    merchant: merchantSchema,
    agent: agentSchema,
    failures: z.array(failureSchema).max(10_000),
    commercialIntent: z.union([pendingIntentSchema, confirmedIntentSchema]),
  })
  .superRefine((value, context) => {
    if (Date.parse(value.window.endedAt) <= Date.parse(value.window.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['window', 'endedAt'],
        message: 'Pilot end must follow start',
      });
    }
  });

export type PilotManifest = z.infer<typeof PilotManifestSchema>;

export class PilotManifestValidationError extends Error {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super('Invalid pilot evidence manifest');
    this.name = 'PilotManifestValidationError';
    this.paths = Object.freeze([...paths]);
  }
}

export function parsePilotManifest(value: unknown): PilotManifest {
  const result = PilotManifestSchema.safeParse(value);

  if (!result.success) {
    throw new PilotManifestValidationError(
      result.error.issues.map((issue) => `/${issue.path.map(String).join('/')}`),
    );
  }

  return Object.freeze(result.data);
}
