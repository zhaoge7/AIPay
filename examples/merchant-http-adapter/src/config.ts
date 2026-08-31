import { Buffer } from 'node:buffer';
import { createPrivateKey } from 'node:crypto';

import { parseResourceId, type ResourceId } from '@aipay/contracts';

const pathPattern = /^\/[A-Za-z0-9._~/-]{1,255}$/u;
const queryKeyPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;
const headerNamePattern = /^[A-Za-z][A-Za-z0-9-]{0,63}$/u;
const reservedHeaders = new Set([
  'accept',
  'connection',
  'content-length',
  'host',
  'idempotency-key',
  'transfer-encoding',
]);

export interface MerchantAdapterConfig {
  readonly aipayBaseUrl: string;
  readonly apiKey: string;
  readonly merchantId: ResourceId<'mch'>;
  readonly keyId: ResourceId<'key'>;
  readonly privateKeyPkcs8Base64: string;
  readonly serviceId: ResourceId<'svc'>;
  readonly databaseUrl: string;
  readonly publicOrigin: string;
  readonly resourcePath: string;
  readonly upstreamOrigin: string;
  readonly upstreamPath: string;
  readonly allowedQueryKeys: readonly string[];
  readonly upstreamApiKeyLocation: 'header' | 'query';
  readonly upstreamApiKeyName: string;
  readonly upstreamApiKeyValue: string;
  readonly host: string;
  readonly port: number;
}

export class MerchantAdapterConfigurationError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    const sorted = [...new Set(variables)].sort();
    super(`Invalid Merchant adapter environment variables: ${sorted.join(', ')}`);
    this.name = 'MerchantAdapterConfigurationError';
    this.variables = Object.freeze(sorted);
  }
}

function required(environment: NodeJS.ProcessEnv, name: string, errors: string[]): string {
  const value = environment[name];

  if (value === undefined || value.length === 0) {
    errors.push(name);
    return '';
  }

  return value;
}

function origin(value: string, name: string, errors: string[], allowLocalHttp: boolean): string {
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);

    if (
      (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:')) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.pathname !== '/' ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error('invalid origin');
    }

    return url.toString().replace(/\/$/u, '');
  } catch {
    errors.push(name);
    return '';
  }
}

function path(value: string, name: string, errors: string[]): string {
  if (
    !pathPattern.test(value) ||
    value.startsWith('//') ||
    value.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    errors.push(name);
  }

  return value;
}

function resourceId<Prefix extends 'mch' | 'key' | 'svc'>(
  environment: NodeJS.ProcessEnv,
  name: string,
  prefix: Prefix,
  errors: string[],
): ResourceId<Prefix> {
  try {
    return parseResourceId(required(environment, name, errors), prefix);
  } catch {
    errors.push(name);
    return '' as ResourceId<Prefix>;
  }
}

export function loadMerchantAdapterConfig(environment: NodeJS.ProcessEnv): MerchantAdapterConfig {
  const errors: string[] = [];
  const aipayBaseUrl = origin(
    required(environment, 'AIPAY_BASE_URL', errors),
    'AIPAY_BASE_URL',
    errors,
    true,
  );
  const publicOrigin = origin(
    required(environment, 'AIPAY_ADAPTER_PUBLIC_ORIGIN', errors),
    'AIPAY_ADAPTER_PUBLIC_ORIGIN',
    errors,
    false,
  );
  const upstreamOrigin = origin(
    required(environment, 'AIPAY_UPSTREAM_ORIGIN', errors),
    'AIPAY_UPSTREAM_ORIGIN',
    errors,
    false,
  );
  const resourcePath = path(
    required(environment, 'AIPAY_ADAPTER_RESOURCE_PATH', errors),
    'AIPAY_ADAPTER_RESOURCE_PATH',
    errors,
  );
  const upstreamPath = path(
    required(environment, 'AIPAY_UPSTREAM_PATH', errors),
    'AIPAY_UPSTREAM_PATH',
    errors,
  );
  if (resourcePath === '/health') errors.push('AIPAY_ADAPTER_RESOURCE_PATH');
  const queryValue = environment.AIPAY_ADAPTER_QUERY_KEYS ?? '';
  const allowedQueryKeys = queryValue.length === 0 ? [] : queryValue.split(',');

  if (
    allowedQueryKeys.length > 20 ||
    new Set(allowedQueryKeys).size !== allowedQueryKeys.length ||
    allowedQueryKeys.some((key) => !queryKeyPattern.test(key))
  ) {
    errors.push('AIPAY_ADAPTER_QUERY_KEYS');
  }

  const rawUpstreamApiKeyLocation = required(
    environment,
    'AIPAY_UPSTREAM_API_KEY_LOCATION',
    errors,
  );
  const upstreamApiKeyLocation: 'header' | 'query' =
    rawUpstreamApiKeyLocation === 'header' || rawUpstreamApiKeyLocation === 'query'
      ? rawUpstreamApiKeyLocation
      : 'header';
  const upstreamApiKeyName = required(environment, 'AIPAY_UPSTREAM_API_KEY_NAME', errors);
  const upstreamApiKeyValue = required(environment, 'AIPAY_UPSTREAM_API_KEY_VALUE', errors);

  if (rawUpstreamApiKeyLocation !== 'header' && rawUpstreamApiKeyLocation !== 'query') {
    errors.push('AIPAY_UPSTREAM_API_KEY_LOCATION');
  }
  if (
    !(upstreamApiKeyLocation === 'header' ? headerNamePattern : queryKeyPattern).test(
      upstreamApiKeyName,
    ) ||
    (upstreamApiKeyLocation === 'header' &&
      reservedHeaders.has(upstreamApiKeyName.toLowerCase())) ||
    (upstreamApiKeyLocation === 'query' && allowedQueryKeys.includes(upstreamApiKeyName))
  ) {
    errors.push('AIPAY_UPSTREAM_API_KEY_NAME');
  }
  if (upstreamApiKeyValue.length > 4096) errors.push('AIPAY_UPSTREAM_API_KEY_VALUE');

  const databaseUrl = required(environment, 'AIPAY_ADAPTER_DATABASE_URL', errors);

  try {
    const parsed = new URL(databaseUrl);

    if (
      !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
      parsed.username.length === 0 ||
      parsed.hostname.length === 0 ||
      parsed.pathname.length <= 1
    ) {
      throw new Error('invalid database URL');
    }
  } catch {
    errors.push('AIPAY_ADAPTER_DATABASE_URL');
  }

  const privateKeyPkcs8Base64 = required(environment, 'AIPAY_MERCHANT_PRIVATE_KEY', errors);

  try {
    const key = createPrivateKey({
      key: Buffer.from(privateKeyPkcs8Base64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });

    if (key.asymmetricKeyType !== 'ed25519') throw new Error('invalid key');
  } catch {
    errors.push('AIPAY_MERCHANT_PRIVATE_KEY');
  }

  const apiKey = required(environment, 'AIPAY_MERCHANT_API_KEY', errors);
  const host = environment.AIPAY_ADAPTER_HOST ?? '127.0.0.1';
  const port = Number(environment.AIPAY_ADAPTER_PORT ?? '3300');
  const merchantId = resourceId(environment, 'AIPAY_MERCHANT_ID', 'mch', errors);
  const keyId = resourceId(environment, 'AIPAY_MERCHANT_KEY_ID', 'key', errors);
  const serviceId = resourceId(environment, 'AIPAY_SERVICE_ID', 'svc', errors);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    errors.push('AIPAY_ADAPTER_PORT');
  }
  if (errors.length > 0) throw new MerchantAdapterConfigurationError(errors);

  return Object.freeze({
    aipayBaseUrl,
    apiKey,
    merchantId,
    keyId,
    privateKeyPkcs8Base64,
    serviceId,
    databaseUrl,
    publicOrigin,
    resourcePath,
    upstreamOrigin,
    upstreamPath,
    allowedQueryKeys: Object.freeze(allowedQueryKeys),
    upstreamApiKeyLocation,
    upstreamApiKeyName,
    upstreamApiKeyValue,
    host,
    port,
  });
}
