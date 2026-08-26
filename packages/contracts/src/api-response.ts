import * as z from 'zod';

import {
  ContractValidationError,
  mapSchemaIssueCode,
  toJsonPointer,
  type ContractValidationIssue,
} from './contract-validation.js';

export const API_JSON_MEDIA_TYPE = 'application/json';
export const API_PROBLEM_MEDIA_TYPE = 'application/problem+json';

export const apiErrorCodes = [
  'INVALID_REQUEST',
  'UNAUTHENTICATED',
  'SIGNATURE_INVALID',
  'REPLAY_DETECTED',
  'AUTHORIZATION_DENIED',
  'MANDATE_EXPIRED',
  'QUOTE_EXPIRED',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'RATE_LIMITED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'TRANSACTION_STATE_CONFLICT',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
] as const;

export type ApiErrorCode = (typeof apiErrorCodes)[number];
export type ApiErrorKind = 'retryable' | 'rejected' | 'expired' | 'system';

export interface ApiErrorDefinition {
  readonly slug: string;
  readonly title: string;
  readonly status: number;
  readonly kind: ApiErrorKind;
  readonly retryable: boolean;
}

export const apiErrorCatalog = Object.freeze({
  INVALID_REQUEST: Object.freeze({
    slug: 'invalid-request',
    title: 'The request is invalid',
    status: 400,
    kind: 'rejected',
    retryable: false,
  }),
  UNAUTHENTICATED: Object.freeze({
    slug: 'unauthenticated',
    title: 'Authentication is required',
    status: 401,
    kind: 'rejected',
    retryable: false,
  }),
  SIGNATURE_INVALID: Object.freeze({
    slug: 'signature-invalid',
    title: 'The request signature is invalid',
    status: 401,
    kind: 'rejected',
    retryable: false,
  }),
  REPLAY_DETECTED: Object.freeze({
    slug: 'replay-detected',
    title: 'The request was already used',
    status: 409,
    kind: 'rejected',
    retryable: false,
  }),
  AUTHORIZATION_DENIED: Object.freeze({
    slug: 'authorization-denied',
    title: 'The authorization policy denied the request',
    status: 403,
    kind: 'rejected',
    retryable: false,
  }),
  MANDATE_EXPIRED: Object.freeze({
    slug: 'mandate-expired',
    title: 'The mandate has expired',
    status: 410,
    kind: 'expired',
    retryable: false,
  }),
  QUOTE_EXPIRED: Object.freeze({
    slug: 'quote-expired',
    title: 'The quote has expired',
    status: 410,
    kind: 'expired',
    retryable: false,
  }),
  IDEMPOTENCY_CONFLICT: Object.freeze({
    slug: 'idempotency-conflict',
    title: 'The idempotency key was reused with different input',
    status: 409,
    kind: 'rejected',
    retryable: false,
  }),
  IDEMPOTENCY_IN_PROGRESS: Object.freeze({
    slug: 'idempotency-in-progress',
    title: 'The idempotent request is still in progress',
    status: 409,
    kind: 'retryable',
    retryable: true,
  }),
  RATE_LIMITED: Object.freeze({
    slug: 'rate-limited',
    title: 'The request rate limit was exceeded',
    status: 429,
    kind: 'retryable',
    retryable: true,
  }),
  PROVIDER_TIMEOUT: Object.freeze({
    slug: 'provider-timeout',
    title: 'The payment provider did not respond in time',
    status: 504,
    kind: 'retryable',
    retryable: true,
  }),
  PROVIDER_UNAVAILABLE: Object.freeze({
    slug: 'provider-unavailable',
    title: 'The payment provider is temporarily unavailable',
    status: 503,
    kind: 'retryable',
    retryable: true,
  }),
  TRANSACTION_STATE_CONFLICT: Object.freeze({
    slug: 'transaction-state-conflict',
    title: 'The transaction state does not allow this operation',
    status: 409,
    kind: 'rejected',
    retryable: false,
  }),
  INTERNAL_ERROR: Object.freeze({
    slug: 'internal-error',
    title: 'An internal error occurred',
    status: 500,
    kind: 'system',
    retryable: false,
  }),
  SERVICE_UNAVAILABLE: Object.freeze({
    slug: 'service-unavailable',
    title: 'The service is temporarily unavailable',
    status: 503,
    kind: 'system',
    retryable: true,
  }),
} as const satisfies Readonly<Record<ApiErrorCode, ApiErrorDefinition>>);

const traceIdPattern = /^(?!0{32}$)[0-9a-f]{32}$/;
const problemTypePattern = /^urn:aipay:problem:[a-z][a-z0-9-]{0,63}$/;
const problemInstancePattern = /^urn:aipay:trace:(?!0{32}$)[0-9a-f]{32}$/;
const jsonPointerPattern = /^(?:\/(?:[^~/]|~[01])*)*$/;

export const ApiValidationIssueWireSchema = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  pointer: z.string().regex(jsonPointerPattern),
});

export const ApiProblemWireSchema = z.strictObject({
  type: z.string().regex(problemTypePattern),
  title: z.string().min(1).max(200),
  status: z.number().int().min(400).max(599),
  detail: z.string().min(1).max(1_000).optional(),
  instance: z.string().regex(problemInstancePattern),
  code: z.enum(apiErrorCodes),
  kind: z.enum(['retryable', 'rejected', 'expired', 'system']),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().min(1).max(86_400_000).optional(),
  traceId: z.string().regex(traceIdPattern),
  errors: z.array(ApiValidationIssueWireSchema).min(1).max(100).optional(),
});

export type ApiProblemWire = z.infer<typeof ApiProblemWireSchema>;
export type ApiValidationIssueWire = z.infer<typeof ApiValidationIssueWireSchema>;

export const ApiResponseMetaWireSchema = z.strictObject({
  traceId: z.string().regex(traceIdPattern),
});

export interface ApiResponseMeta {
  readonly traceId: string;
}

export interface ApiSuccess<Data> {
  readonly data: Data;
  readonly meta: Readonly<ApiResponseMeta>;
}

export interface CreateApiProblemOptions {
  readonly detail?: string;
  readonly retryAfterMs?: number;
  readonly errors?: readonly ApiValidationIssueWire[];
}

function getProblemType(definition: ApiErrorDefinition): string {
  return `urn:aipay:problem:${definition.slug}`;
}

function validateProblemSemantics(problem: ApiProblemWire): readonly ContractValidationIssue[] {
  const issues: ContractValidationIssue[] = [];
  const definition = apiErrorCatalog[problem.code];
  const expected = {
    type: getProblemType(definition),
    title: definition.title,
    status: definition.status,
    kind: definition.kind,
    retryable: definition.retryable,
    instance: `urn:aipay:trace:${problem.traceId}`,
  } as const;

  for (const [field, value] of Object.entries(expected)) {
    if (problem[field as keyof typeof expected] !== value) {
      issues.push({ code: 'catalog_mismatch', path: `/${field}` });
    }
  }

  if (problem.retryAfterMs !== undefined && !definition.retryable) {
    issues.push({ code: 'retry_metadata_not_allowed', path: '/retryAfterMs' });
  }

  if (problem.errors !== undefined && problem.code !== 'INVALID_REQUEST') {
    issues.push({ code: 'catalog_mismatch', path: '/errors' });
  }

  return issues;
}

function freezeProblem(problem: ApiProblemWire): Readonly<ApiProblemWire> {
  const errors =
    problem.errors === undefined
      ? undefined
      : problem.errors.map((issue) => Object.freeze({ ...issue }));

  if (errors !== undefined) {
    Object.freeze(errors);
  }

  return Object.freeze({
    ...problem,
    ...(errors === undefined ? {} : { errors }),
  });
}

export function parseApiProblem(value: unknown): Readonly<ApiProblemWire> {
  const result = ApiProblemWireSchema.safeParse(value);

  if (!result.success) {
    throw new ContractValidationError(
      'ApiProblem',
      result.error.issues.map((issue) => ({
        code: mapSchemaIssueCode(issue.code),
        path: toJsonPointer(issue.path),
      })),
    );
  }

  const semanticIssues = validateProblemSemantics(result.data);

  if (semanticIssues.length > 0) {
    throw new ContractValidationError('ApiProblem', semanticIssues);
  }

  return freezeProblem(result.data);
}

export function createApiProblem(
  code: ApiErrorCode,
  traceId: string,
  options: CreateApiProblemOptions = {},
): Readonly<ApiProblemWire> {
  const definition = apiErrorCatalog[code];

  return parseApiProblem({
    type: getProblemType(definition),
    title: definition.title,
    status: definition.status,
    instance: `urn:aipay:trace:${traceId}`,
    code,
    kind: definition.kind,
    retryable: definition.retryable,
    traceId,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    ...(options.errors === undefined ? {} : { errors: options.errors }),
  });
}

export function createApiSuccessSchema<DataSchema extends z.ZodType>(dataSchema: DataSchema) {
  return z.strictObject({
    data: dataSchema,
    meta: ApiResponseMetaWireSchema,
  });
}

export function createApiSuccess<Data>(data: Data, traceId: string): Readonly<ApiSuccess<Data>> {
  const metaResult = ApiResponseMetaWireSchema.safeParse({ traceId });

  if (!metaResult.success) {
    throw new ContractValidationError(
      'ApiProblem',
      metaResult.error.issues.map((issue) => ({
        code: mapSchemaIssueCode(issue.code),
        path: toJsonPointer(['meta', ...issue.path]),
      })),
    );
  }

  return Object.freeze({
    data,
    meta: Object.freeze(metaResult.data),
  });
}

export function getApiProblemJsonSchema() {
  return z.toJSONSchema(ApiProblemWireSchema, { target: 'draft-2020-12' });
}
