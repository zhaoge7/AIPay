import { ValueValidationError } from './validation-error.js';

export const resourcePrefixes = [
  'dev',
  'agt',
  'key',
  'apk',
  'mch',
  'svc',
  'mdt',
  'qte',
  'txn',
  'pat',
  'pcl',
  'dlv',
  'rfd',
  'rsv',
  'evt',
  'obx',
  'whd',
  'wha',
  'ppf',
  'rcn',
  'rcl',
  'rci',
] as const;

export type ResourcePrefix = (typeof resourcePrefixes)[number];

declare const resourceIdBrand: unique symbol;

export type ResourceId<Prefix extends ResourcePrefix = ResourcePrefix> = `${Prefix}_${string}` & {
  readonly [resourceIdBrand]: Prefix;
};

const canonicalUuidV7Source = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const canonicalUuidV7 = new RegExp(`^${canonicalUuidV7Source}$`);

function isResourcePrefix(value: unknown): value is ResourcePrefix {
  return typeof value === 'string' && resourcePrefixes.some((prefix) => prefix === value);
}

export function parseResourceId<Prefix extends ResourcePrefix>(
  value: unknown,
  expectedPrefix: Prefix,
): ResourceId<Prefix> {
  if (!isResourcePrefix(expectedPrefix)) {
    throw new ValueValidationError('invalid_resource_prefix');
  }

  if (typeof value !== 'string') {
    throw new ValueValidationError('invalid_resource_id');
  }

  const marker = `${expectedPrefix}_`;
  const uuid = value.startsWith(marker) ? value.slice(marker.length) : '';

  if (!canonicalUuidV7.test(uuid)) {
    throw new ValueValidationError('invalid_resource_id');
  }

  return value as ResourceId<Prefix>;
}

export function getResourceIdPattern(prefix: ResourcePrefix): RegExp {
  return new RegExp(`^${prefix}_${canonicalUuidV7Source}$`);
}

export function getResourceUuid<Prefix extends ResourcePrefix>(id: ResourceId<Prefix>): string {
  return id.slice(id.indexOf('_') + 1);
}
