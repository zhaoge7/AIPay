import * as z from 'zod';

import { getResourceIdPattern } from './values/identifier.js';

const utcDateTimePattern =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const pilotIdPattern = /^pilot_[a-z0-9][a-z0-9_-]{0,63}$/;
const purposeCodePattern = /^[a-z][a-z0-9._-]{0,63}$/;
const workloadHashPattern = /^sha256:[0-9a-f]{64}$/;
const timestampSchema = z.string().regex(utcDateTimePattern);
const httpsUrlSchema = z.url().refine((value) => value.startsWith('https://'), {
  message: 'HTTPS URL required',
});
const transactionIdSchema = z.string().regex(getResourceIdPattern('txn'));

const acceptedEntrySchema = z
  .strictObject({
    transactionId: transactionIdSchema,
    workloadIdHash: z.string().regex(workloadHashPattern),
    occurredAt: timestampSchema,
    acceptedAt: timestampSchema,
    purposeCode: z.string().regex(purposeCodePattern),
  })
  .superRefine((value, context) => {
    if (Date.parse(value.acceptedAt) < Date.parse(value.occurredAt)) {
      context.addIssue({
        code: 'custom',
        path: ['acceptedAt'],
        message: 'Acceptance must not precede occurrence',
      });
    }
  });

export const pilotTrafficExclusionReasons = [
  'development',
  'synthetic',
  'automated_loop',
  'replay',
  'load_test',
  'failed_user_workflow',
  'other',
] as const;

const excludedEntrySchema = z.strictObject({
  transactionId: transactionIdSchema,
  reason: z.enum(pilotTrafficExclusionReasons),
  evidenceUrl: httpsUrlSchema,
});

export const PilotTrafficLedgerSchema = z
  .strictObject({
    schemaVersion: z.literal('1'),
    pilotId: z.string().regex(pilotIdPattern),
    generatedAt: timestampSchema,
    attestationEvidenceUrl: httpsUrlSchema,
    entries: z.array(acceptedEntrySchema).max(100_000),
    exclusions: z.array(excludedEntrySchema).max(100_000),
  })
  .superRefine((value, context) => {
    const transactionIds = value.entries.map(({ transactionId }) => transactionId);
    const workloadHashes = value.entries.map(({ workloadIdHash }) => workloadIdHash);
    const excludedIds = value.exclusions.map(({ transactionId }) => transactionId);

    if (new Set(transactionIds).size !== transactionIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['entries'],
        message: 'Accepted Transaction IDs must be unique',
      });
    }
    if (new Set(workloadHashes).size !== workloadHashes.length) {
      context.addIssue({
        code: 'custom',
        path: ['entries'],
        message: 'External workload hashes must be unique',
      });
    }
    if (new Set(excludedIds).size !== excludedIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['exclusions'],
        message: 'Excluded Transaction IDs must be unique',
      });
    }

    const accepted = new Set(transactionIds);

    if (excludedIds.some((transactionId) => accepted.has(transactionId))) {
      context.addIssue({
        code: 'custom',
        path: ['exclusions'],
        message: 'A Transaction cannot be accepted and excluded',
      });
    }
  });

export type PilotTrafficLedger = z.infer<typeof PilotTrafficLedgerSchema>;
export type PilotTrafficExclusionReason = (typeof pilotTrafficExclusionReasons)[number];

export class PilotTrafficValidationError extends Error {
  readonly paths: readonly string[];

  constructor(paths: readonly string[]) {
    super('Invalid pilot traffic ledger');
    this.name = 'PilotTrafficValidationError';
    this.paths = Object.freeze([...paths]);
  }
}

export function parsePilotTrafficLedger(value: unknown): PilotTrafficLedger {
  const result = PilotTrafficLedgerSchema.safeParse(value);

  if (!result.success) {
    throw new PilotTrafficValidationError(
      result.error.issues.map((issue) => `/${issue.path.map(String).join('/')}`),
    );
  }

  return Object.freeze(result.data);
}
