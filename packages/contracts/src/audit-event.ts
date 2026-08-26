import * as z from 'zod';

import {
  ContractValidationError,
  mapSchemaIssueCode,
  toJsonPointer,
  type ContractValidationIssue,
} from './contract-validation.js';
import { getResourceIdPattern, parseResourceId, type ResourceId } from './values/identifier.js';
import { parseUtcDateTime, type UtcDateTime } from './values/time.js';

const utcDateTimePattern =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const traceIdPattern = /^(?!0{32}$)[0-9a-f]{32}$/;
const eventTypePattern = /^[a-z][a-z0-9_]{0,31}(?:\.[a-z][a-z0-9_]{0,31})+$/;
const resultCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;
const providerNamePattern = /^[a-z][a-z0-9_-]{0,63}$/;

const resourceIdSchema = (prefix: Parameters<typeof getResourceIdPattern>[0]) =>
  z.string().regex(getResourceIdPattern(prefix));

const DeveloperActorWireSchema = z.strictObject({
  type: z.literal('developer'),
  id: resourceIdSchema('dev'),
});

const AgentActorWireSchema = z.strictObject({
  type: z.literal('agent'),
  id: resourceIdSchema('agt'),
});

const MerchantActorWireSchema = z.strictObject({
  type: z.literal('merchant'),
  id: resourceIdSchema('mch'),
});

const SystemActorWireSchema = z.strictObject({
  type: z.literal('system'),
  id: z.null(),
});

const PaymentProviderActorWireSchema = z.strictObject({
  type: z.literal('payment_provider'),
  id: z.null(),
  providerName: z.string().regex(providerNamePattern),
});

export const AuditActorWireSchema = z.discriminatedUnion('type', [
  DeveloperActorWireSchema,
  AgentActorWireSchema,
  MerchantActorWireSchema,
  SystemActorWireSchema,
  PaymentProviderActorWireSchema,
]);

export const AuditObjectWireSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('developer'), id: resourceIdSchema('dev') }),
  z.strictObject({ type: z.literal('agent'), id: resourceIdSchema('agt') }),
  z.strictObject({ type: z.literal('merchant'), id: resourceIdSchema('mch') }),
  z.strictObject({ type: z.literal('service'), id: resourceIdSchema('svc') }),
  z.strictObject({ type: z.literal('mandate'), id: resourceIdSchema('mdt') }),
  z.strictObject({ type: z.literal('quote'), id: resourceIdSchema('qte') }),
  z.strictObject({ type: z.literal('transaction'), id: resourceIdSchema('txn') }),
  z.strictObject({ type: z.literal('payment_attempt'), id: resourceIdSchema('pat') }),
  z.strictObject({ type: z.literal('delivery'), id: resourceIdSchema('dlv') }),
  z.strictObject({ type: z.literal('refund'), id: resourceIdSchema('rfd') }),
  z.strictObject({ type: z.literal('audit_event'), id: resourceIdSchema('evt') }),
  z.strictObject({ type: z.literal('outbox_event'), id: resourceIdSchema('obx') }),
]);

export const auditOutcomes = ['succeeded', 'failed', 'denied', 'pending'] as const;
export type AuditOutcome = (typeof auditOutcomes)[number];

export const AuditResultWireSchema = z.strictObject({
  outcome: z.enum(auditOutcomes),
  code: z.nullable(z.string().regex(resultCodePattern)),
});

export const AuditEventWireSchema = z.strictObject({
  schemaVersion: z.literal('1'),
  eventId: resourceIdSchema('evt'),
  eventType: z.string().regex(eventTypePattern),
  actor: AuditActorWireSchema,
  object: AuditObjectWireSchema,
  occurredAt: z.string().regex(utcDateTimePattern),
  traceId: z.string().regex(traceIdPattern),
  parentEventId: z.nullable(resourceIdSchema('evt')),
  result: AuditResultWireSchema,
});

export type AuditEventWire = z.infer<typeof AuditEventWireSchema>;
export type AuditActorWire = z.infer<typeof AuditActorWireSchema>;
export type AuditObjectWire = z.infer<typeof AuditObjectWireSchema>;
export type AuditResultWire = z.infer<typeof AuditResultWireSchema>;
export type AuditObjectType = AuditObjectWire['type'];

type AuditActor =
  | Readonly<{ type: 'developer'; id: ResourceId<'dev'> }>
  | Readonly<{ type: 'agent'; id: ResourceId<'agt'> }>
  | Readonly<{ type: 'merchant'; id: ResourceId<'mch'> }>
  | Readonly<{ type: 'system'; id: null }>
  | Readonly<{ type: 'payment_provider'; id: null; providerName: string }>;

type AuditObject =
  | Readonly<{ type: 'developer'; id: ResourceId<'dev'> }>
  | Readonly<{ type: 'agent'; id: ResourceId<'agt'> }>
  | Readonly<{ type: 'merchant'; id: ResourceId<'mch'> }>
  | Readonly<{ type: 'service'; id: ResourceId<'svc'> }>
  | Readonly<{ type: 'mandate'; id: ResourceId<'mdt'> }>
  | Readonly<{ type: 'quote'; id: ResourceId<'qte'> }>
  | Readonly<{ type: 'transaction'; id: ResourceId<'txn'> }>
  | Readonly<{ type: 'payment_attempt'; id: ResourceId<'pat'> }>
  | Readonly<{ type: 'delivery'; id: ResourceId<'dlv'> }>
  | Readonly<{ type: 'refund'; id: ResourceId<'rfd'> }>
  | Readonly<{ type: 'audit_event'; id: ResourceId<'evt'> }>
  | Readonly<{ type: 'outbox_event'; id: ResourceId<'obx'> }>;

export interface AuditEvent {
  readonly schemaVersion: '1';
  readonly eventId: ResourceId<'evt'>;
  readonly eventType: string;
  readonly actor: AuditActor;
  readonly object: AuditObject;
  readonly occurredAt: UtcDateTime;
  readonly traceId: string;
  readonly parentEventId: ResourceId<'evt'> | null;
  readonly result: Readonly<{
    outcome: AuditOutcome;
    code: string | null;
  }>;
}

function validateSemantics(event: AuditEventWire): readonly ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];

  try {
    parseUtcDateTime(event.occurredAt);
  } catch {
    issues.push({ code: 'invalid_format', path: '/occurredAt' });
  }

  const requiresCode = event.result.outcome === 'failed' || event.result.outcome === 'denied';

  if (requiresCode === (event.result.code === null)) {
    issues.push({ code: 'invalid_result_code', path: '/result/code' });
  }

  if (event.parentEventId === event.eventId) {
    issues.push({ code: 'duplicate_reference', path: '/parentEventId' });
  }

  return issues;
}

function toActor(wire: AuditActorWire): AuditActor {
  switch (wire.type) {
    case 'developer':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'dev') });
    case 'agent':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'agt') });
    case 'merchant':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'mch') });
    case 'system':
      return Object.freeze({ type: wire.type, id: null });
    case 'payment_provider':
      return Object.freeze({ type: wire.type, id: null, providerName: wire.providerName });
  }
}

function toObject(wire: AuditObjectWire): AuditObject {
  switch (wire.type) {
    case 'developer':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'dev') });
    case 'agent':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'agt') });
    case 'merchant':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'mch') });
    case 'service':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'svc') });
    case 'mandate':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'mdt') });
    case 'quote':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'qte') });
    case 'transaction':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'txn') });
    case 'payment_attempt':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'pat') });
    case 'delivery':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'dlv') });
    case 'refund':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'rfd') });
    case 'audit_event':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'evt') });
    case 'outbox_event':
      return Object.freeze({ type: wire.type, id: parseResourceId(wire.id, 'obx') });
  }
}

function toAuditEvent(wire: AuditEventWire): AuditEvent {
  return Object.freeze({
    schemaVersion: wire.schemaVersion,
    eventId: parseResourceId(wire.eventId, 'evt'),
    eventType: wire.eventType,
    actor: toActor(wire.actor),
    object: toObject(wire.object),
    occurredAt: parseUtcDateTime(wire.occurredAt),
    traceId: wire.traceId,
    parentEventId: wire.parentEventId === null ? null : parseResourceId(wire.parentEventId, 'evt'),
    result: Object.freeze({ ...wire.result }),
  });
}

export function parseAuditEvent(value: unknown): AuditEvent {
  const result = AuditEventWireSchema.safeParse(value);

  if (!result.success) {
    throw new ContractValidationError(
      'AuditEvent',
      result.error.issues.map((issue) => ({
        code: mapSchemaIssueCode(issue.code),
        path: toJsonPointer(issue.path),
      })),
    );
  }

  const semanticIssues = validateSemantics(result.data);

  if (semanticIssues.length > 0) {
    throw new ContractValidationError('AuditEvent', semanticIssues);
  }

  return toAuditEvent(result.data);
}

export function getAuditEventJsonSchema() {
  return z.toJSONSchema(AuditEventWireSchema, { target: 'draft-2020-12' });
}
