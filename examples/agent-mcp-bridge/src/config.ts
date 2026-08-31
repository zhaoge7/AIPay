import { Buffer } from 'node:buffer';
import { createPrivateKey } from 'node:crypto';

import { parseResourceId, type ResourceId } from '@aipay/contracts';

const pathPattern = /^\/[A-Za-z0-9._~/-]{1,255}$/u;
const queryKeyPattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const hostnamePattern = /^[A-Za-z0-9.-]{1,253}$/u;

export interface AgentBridgeConfig {
  readonly aipayBaseUrl: string;
  readonly agentId: ResourceId<'agt'>;
  readonly keyId: ResourceId<'key'>;
  readonly privateKeyPkcs8Base64: string;
  readonly mandateId: ResourceId<'mdt'>;
  readonly resourceOrigin: string;
  readonly allowedPaths: readonly string[];
  readonly allowedQueryKeys: readonly string[];
  readonly bearerToken: string;
  readonly host: string;
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins: readonly string[];
}

export class AgentBridgeConfigurationError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    const sorted = [...new Set(variables)].sort();
    super(`Invalid Agent bridge environment variables: ${sorted.join(', ')}`);
    this.name = 'AgentBridgeConfigurationError';
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

function parseCsv(
  value: string,
  name: string,
  errors: string[],
  pattern: RegExp,
  maximum = 20,
): readonly string[] {
  const values = value.length === 0 ? [] : value.split(',');

  if (
    values.length > maximum ||
    new Set(values).size !== values.length ||
    values.some((item) => !pattern.test(item))
  ) {
    errors.push(name);
  }

  return Object.freeze(values);
}

function parseBaseUrl(
  value: string,
  name: string,
  errors: string[],
  allowLocalHttp: boolean,
): string {
  try {
    const url = new URL(value);
    const local =
      url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';

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

export function loadAgentBridgeConfig(environment: NodeJS.ProcessEnv): AgentBridgeConfig {
  const errors: string[] = [];
  const aipayBaseUrl = parseBaseUrl(
    required(environment, 'AIPAY_BASE_URL', errors),
    'AIPAY_BASE_URL',
    errors,
    true,
  );
  const resourceOrigin = parseBaseUrl(
    required(environment, 'AIPAY_RESOURCE_ORIGIN', errors),
    'AIPAY_RESOURCE_ORIGIN',
    errors,
    false,
  );
  const allowedPaths = parseCsv(
    required(environment, 'AIPAY_RESOURCE_PATHS', errors),
    'AIPAY_RESOURCE_PATHS',
    errors,
    pathPattern,
  );
  const allowedQueryKeys = parseCsv(
    environment.AIPAY_RESOURCE_QUERY_KEYS ?? '',
    'AIPAY_RESOURCE_QUERY_KEYS',
    errors,
    queryKeyPattern,
  );
  const bearerToken = required(environment, 'AIPAY_BRIDGE_BEARER_TOKEN', errors);
  const privateKeyPkcs8Base64 = required(environment, 'AIPAY_AGENT_PRIVATE_KEY', errors);
  const host = environment.AIPAY_BRIDGE_HOST ?? '127.0.0.1';
  const rawPort = environment.AIPAY_BRIDGE_PORT ?? '3200';
  const port = Number(rawPort);
  const allowedHosts = parseCsv(
    environment.AIPAY_BRIDGE_ALLOWED_HOSTS ?? (host === '127.0.0.1' ? '127.0.0.1,localhost' : ''),
    'AIPAY_BRIDGE_ALLOWED_HOSTS',
    errors,
    hostnamePattern,
    50,
  );
  const allowedOrigins = parseCsv(
    environment.AIPAY_BRIDGE_ALLOWED_ORIGINS ?? allowedHosts.join(','),
    'AIPAY_BRIDGE_ALLOWED_ORIGINS',
    errors,
    hostnamePattern,
    50,
  );

  if (allowedPaths.length === 0) errors.push('AIPAY_RESOURCE_PATHS');
  if (bearerToken.length < 32 || bearerToken.length > 512) {
    errors.push('AIPAY_BRIDGE_BEARER_TOKEN');
  }
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(privateKeyPkcs8Base64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });

    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('invalid key');
  } catch {
    errors.push('AIPAY_AGENT_PRIVATE_KEY');
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    errors.push('AIPAY_BRIDGE_PORT');
  }
  if (host === '0.0.0.0' && allowedHosts.length === 0) {
    errors.push('AIPAY_BRIDGE_ALLOWED_HOSTS');
  }

  let agentId = '' as ResourceId<'agt'>;
  let keyId = '' as ResourceId<'key'>;
  let mandateId = '' as ResourceId<'mdt'>;

  try {
    agentId = parseResourceId(required(environment, 'AIPAY_AGENT_ID', errors), 'agt');
  } catch {
    errors.push('AIPAY_AGENT_ID');
  }

  try {
    keyId = parseResourceId(required(environment, 'AIPAY_AGENT_KEY_ID', errors), 'key');
  } catch {
    errors.push('AIPAY_AGENT_KEY_ID');
  }

  try {
    mandateId = parseResourceId(required(environment, 'AIPAY_MANDATE_ID', errors), 'mdt');
  } catch {
    errors.push('AIPAY_MANDATE_ID');
  }

  if (errors.length > 0) {
    throw new AgentBridgeConfigurationError(errors);
  }

  return Object.freeze({
    aipayBaseUrl,
    agentId,
    keyId,
    privateKeyPkcs8Base64,
    mandateId,
    resourceOrigin,
    allowedPaths,
    allowedQueryKeys,
    bearerToken,
    host,
    port,
    allowedHosts,
    allowedOrigins,
  });
}
