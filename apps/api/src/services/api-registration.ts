import { formatUtcDateTime, getResourceUuid, type ResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';

const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
const capabilityPattern = /^[\p{L}\p{N}][\p{L}\p{N} ._/-]{0,79}$/u;
const supportedParameterTypes = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'object',
  'array',
]);

export type ApiRegistrationErrorCode =
  | 'not_found'
  | 'invalid_endpoint_url'
  | 'invalid_description'
  | 'invalid_capabilities'
  | 'invalid_input_schema'
  | 'invalid_timeout'
  | 'parameters_invalid';

export class ApiRegistrationError extends Error {
  readonly code: ApiRegistrationErrorCode;

  constructor(code: ApiRegistrationErrorCode) {
    super('API registration operation failed');
    this.name = 'ApiRegistrationError';
    this.code = code;
  }
}

export interface ApiParameterRule {
  readonly type: 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';
  readonly description?: string;
}

export interface ApiInputSchema {
  readonly type: 'object';
  readonly additionalProperties: boolean;
  readonly required: readonly string[];
  readonly properties: Readonly<Record<string, Readonly<ApiParameterRule>>>;
}

export interface ApiRegistrationInput {
  readonly endpointUrl: string;
  readonly httpMethod: 'POST';
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly inputSchema: unknown;
  readonly timeoutMs: number;
  readonly status?: 'enabled' | 'disabled';
}

export interface ApiRegistrationView {
  readonly serviceId: ResourceId<'svc'>;
  readonly merchantId: ResourceId<'mch'>;
  readonly endpointUrl: string;
  readonly httpMethod: 'POST';
  readonly description: string;
  readonly capabilities: readonly string[];
  readonly inputSchema: Readonly<ApiInputSchema>;
  readonly timeoutMs: number;
  readonly status: 'enabled' | 'disabled';
  readonly version: number;
  readonly quality: Readonly<{
    successCount: string;
    failureCount: string;
    averageLatencyMs: number | null;
  }>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ApiRegistrationRow {
  readonly serviceId: string;
  readonly merchantId: string;
  readonly endpointUrl: string;
  readonly httpMethod: 'POST';
  readonly description: string;
  readonly capabilities: unknown;
  readonly inputSchema: unknown;
  readonly timeoutMs: number;
  readonly status: 'enabled' | 'disabled';
  readonly version: number;
  readonly successCount: string;
  readonly failureCount: string;
  readonly totalLatencyMs: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);

    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }

  return false;
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];

  for (const item of value as unknown[]) {
    if (typeof item !== 'string') return null;
    result.push(item);
  }

  return result;
}

function normalizeEndpointUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new ApiRegistrationError('invalid_endpoint_url');
  }

  const isLoopback = loopbackHosts.has(url.hostname);

  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    value.length > 2_048
  ) {
    throw new ApiRegistrationError('invalid_endpoint_url');
  }

  return url.toString();
}

function normalizeDescription(value: string): string {
  const description = value.trim();

  if (
    description.length < 1 ||
    description.length > 1_000 ||
    containsControlCharacter(description)
  ) {
    throw new ApiRegistrationError('invalid_description');
  }

  return description;
}

function normalizeCapabilities(value: readonly string[]): readonly string[] {
  if (value.length < 1 || value.length > 32) {
    throw new ApiRegistrationError('invalid_capabilities');
  }

  const capabilities = value.map((item) => item.trim().toLocaleLowerCase('zh-CN'));

  if (
    capabilities.some((item) => !capabilityPattern.test(item)) ||
    new Set(capabilities).size !== capabilities.length
  ) {
    throw new ApiRegistrationError('invalid_capabilities');
  }

  return Object.freeze(capabilities);
}

export function parseApiInputSchema(value: unknown): Readonly<ApiInputSchema> {
  const schema = record(value);
  const properties = record(schema?.properties);
  const required = stringArray(schema?.required);

  if (
    schema?.type !== 'object' ||
    typeof schema.additionalProperties !== 'boolean' ||
    properties === null ||
    Object.keys(properties).length > 64 ||
    required === null
  ) {
    throw new ApiRegistrationError('invalid_input_schema');
  }

  if (new Set(required).size !== required.length) {
    throw new ApiRegistrationError('invalid_input_schema');
  }

  const normalizedProperties: Record<string, Readonly<ApiParameterRule>> = {};

  for (const [name, rawRule] of Object.entries(properties)) {
    const rule = record(rawRule);
    const description = rule?.description;

    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) ||
      typeof rule?.type !== 'string' ||
      !supportedParameterTypes.has(rule.type) ||
      (description !== undefined &&
        (typeof description !== 'string' ||
          description.length > 500 ||
          containsControlCharacter(description))) ||
      Object.keys(rule).some((key) => key !== 'type' && key !== 'description')
    ) {
      throw new ApiRegistrationError('invalid_input_schema');
    }

    normalizedProperties[name] = Object.freeze({
      type: rule.type as ApiParameterRule['type'],
      ...(description === undefined ? {} : { description }),
    });
  }

  if (required.some((name) => !Object.hasOwn(normalizedProperties, name))) {
    throw new ApiRegistrationError('invalid_input_schema');
  }

  return Object.freeze({
    type: 'object',
    additionalProperties: schema.additionalProperties,
    required: Object.freeze(required),
    properties: Object.freeze(normalizedProperties),
  });
}

function hasExpectedType(value: unknown, type: ApiParameterRule['type']): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return record(value) !== null;
    case 'array':
      return Array.isArray(value);
  }
}

export function validateInvocationParameters(
  schemaValue: unknown,
  parametersValue: unknown,
): Readonly<Record<string, unknown>> {
  const schema = parseApiInputSchema(schemaValue);
  const parameters = record(parametersValue);

  if (parameters === null) {
    throw new ApiRegistrationError('parameters_invalid');
  }

  if (schema.required.some((name) => !Object.hasOwn(parameters, name))) {
    throw new ApiRegistrationError('parameters_invalid');
  }

  for (const [name, value] of Object.entries(parameters)) {
    const rule = schema.properties[name];

    if (rule === undefined) {
      if (!schema.additionalProperties) {
        throw new ApiRegistrationError('parameters_invalid');
      }
      continue;
    }

    if (!hasExpectedType(value, rule.type)) {
      throw new ApiRegistrationError('parameters_invalid');
    }
  }

  return Object.freeze({ ...parameters });
}

function parseCapabilities(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error('Stored API capabilities are invalid');
  }

  return Object.freeze(value as string[]);
}

function toView(row: ApiRegistrationRow): Readonly<ApiRegistrationView> {
  const attempts = BigInt(row.successCount) + BigInt(row.failureCount);
  return Object.freeze({
    serviceId: `svc_${row.serviceId}` as ResourceId<'svc'>,
    merchantId: `mch_${row.merchantId}` as ResourceId<'mch'>,
    endpointUrl: row.endpointUrl,
    httpMethod: row.httpMethod,
    description: row.description,
    capabilities: parseCapabilities(row.capabilities),
    inputSchema: parseApiInputSchema(row.inputSchema),
    timeoutMs: row.timeoutMs,
    status: row.status,
    version: row.version,
    quality: Object.freeze({
      successCount: row.successCount,
      failureCount: row.failureCount,
      averageLatencyMs: attempts === 0n ? null : Number(BigInt(row.totalLatencyMs) / attempts),
    }),
    createdAt: formatUtcDateTime(row.createdAt),
    updatedAt: formatUtcDateTime(row.updatedAt),
  });
}

const registrationColumns = [
  'serviceId',
  'merchantId',
  'endpointUrl',
  'httpMethod',
  'description',
  'capabilities',
  'inputSchema',
  'timeoutMs',
  'status',
  'version',
  'successCount',
  'failureCount',
  'totalLatencyMs',
  'createdAt',
  'updatedAt',
] as const;

export class ApiRegistrationService {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
  }

  async put(
    developerId: ResourceId<'dev'>,
    merchantId: ResourceId<'mch'>,
    serviceId: ResourceId<'svc'>,
    input: Readonly<ApiRegistrationInput>,
  ): Promise<Readonly<ApiRegistrationView>> {
    const endpointUrl = normalizeEndpointUrl(input.endpointUrl);
    const description = normalizeDescription(input.description);
    const capabilities = normalizeCapabilities(input.capabilities);
    const inputSchema = parseApiInputSchema(input.inputSchema);

    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 30_000) {
      throw new ApiRegistrationError('invalid_timeout');
    }

    return this.#database.transaction().execute(async (transaction) => {
      const service = await transaction
        .selectFrom('services')
        .innerJoin('merchants', 'merchants.id', 'services.merchantId')
        .select(['services.id', 'services.merchantId'])
        .where('services.id', '=', getResourceUuid(serviceId))
        .where('services.merchantId', '=', getResourceUuid(merchantId))
        .where('services.serviceType', '=', 'api')
        .where('merchants.developerId', '=', getResourceUuid(developerId))
        .where('merchants.status', '<>', 'closed')
        .forUpdate('services')
        .executeTakeFirst();

      if (service === undefined) {
        throw new ApiRegistrationError('not_found');
      }

      const now = new Date();
      const row = await transaction
        .insertInto('apiRegistrations')
        .values({
          serviceId: service.id,
          merchantId: service.merchantId,
          endpointUrl,
          httpMethod: input.httpMethod,
          description,
          capabilities: JSON.stringify(capabilities),
          inputSchema,
          timeoutMs: input.timeoutMs,
          status: input.status ?? 'enabled',
          lastInvokedAt: null,
        })
        .onConflict((conflict) =>
          conflict.column('serviceId').doUpdateSet((expressions) => ({
            endpointUrl,
            httpMethod: input.httpMethod,
            description,
            capabilities: JSON.stringify(capabilities),
            inputSchema,
            timeoutMs: input.timeoutMs,
            status: input.status ?? 'enabled',
            version: expressions('apiRegistrations.version', '+', 1),
            successCount: '0',
            failureCount: '0',
            totalLatencyMs: '0',
            lastInvokedAt: null,
            updatedAt: now,
          })),
        )
        .returning(registrationColumns)
        .executeTakeFirstOrThrow();
      return toView(row);
    });
  }

  async getOwned(
    developerId: ResourceId<'dev'>,
    merchantId: ResourceId<'mch'>,
    serviceId: ResourceId<'svc'>,
  ): Promise<Readonly<ApiRegistrationView>> {
    const row = await this.#database
      .selectFrom('apiRegistrations')
      .innerJoin('merchants', 'merchants.id', 'apiRegistrations.merchantId')
      .select(registrationColumns.map((column) => `apiRegistrations.${column}` as const))
      .where('apiRegistrations.serviceId', '=', getResourceUuid(serviceId))
      .where('apiRegistrations.merchantId', '=', getResourceUuid(merchantId))
      .where('merchants.developerId', '=', getResourceUuid(developerId))
      .executeTakeFirst();

    if (row === undefined) {
      throw new ApiRegistrationError('not_found');
    }

    return toView(row);
  }
}
