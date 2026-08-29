import { createPrivateKey, createPublicKey } from 'node:crypto';

import { cleanEnv, EnvError, host, makeValidator, port, str, type ReporterOptions } from 'envalid';

const runtimeEnvironments = ['development', 'test', 'production'] as const;

export type RuntimeEnvironment = (typeof runtimeEnvironments)[number];

export interface ApiConfig {
  readonly environment: RuntimeEnvironment;
  readonly host: string;
  readonly port: number;
}

export interface WorkerConfig {
  readonly environment: RuntimeEnvironment;
  readonly concurrency: number;
}

export interface DatabaseConfig {
  readonly url: string;
}

export interface MandateIssuerConfig {
  readonly keyId: string;
  readonly privateKeyPkcs8Base64: string;
}

export interface AlipayConfig {
  readonly mode: 'sandbox' | 'production';
  readonly gatewayUrl:
    'https://openapi-sandbox.dl.alipaydev.com/gateway.do' | 'https://openapi.alipay.com/gateway.do';
  readonly appId: string;
  readonly sellerId: string;
  readonly privateKeyPkcs8Base64: string;
  readonly alipayPublicKeySpkiBase64: string;
  readonly notifyUrl: string;
}

export class ConfigurationError extends Error {
  readonly variables: readonly string[];

  constructor(variables: readonly string[]) {
    const sortedVariables = [...variables].sort();
    super(`Invalid environment variables: ${sortedVariables.join(', ')}`);
    this.name = 'ConfigurationError';
    this.variables = Object.freeze(sortedVariables);
  }
}

const positiveInteger = makeValidator<number>((input) => {
  const value = Number(input);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new EnvError('Expected a positive integer');
  }

  return value;
});

const postgresUrl = makeValidator<string>((input) => {
  let parsed: URL;

  try {
    parsed = new URL(input);
  } catch {
    throw new EnvError('Expected a PostgreSQL URL');
  }

  if (
    (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') ||
    parsed.username.length === 0 ||
    parsed.hostname.length === 0 ||
    parsed.pathname.length <= 1
  ) {
    throw new EnvError('Expected a complete PostgreSQL URL');
  }

  return input;
});

const signingKeyId = makeValidator<string>((input) => {
  if (!/^key_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input)) {
    throw new EnvError('Expected a key_ UUIDv7 resource ID');
  }

  return input;
});

const privateKeyPkcs8 = makeValidator<string>((input) => {
  let decoded: Buffer;

  try {
    decoded = Buffer.from(input, 'base64');
  } catch {
    throw new EnvError('Expected canonical base64 PKCS8 data');
  }

  if (decoded.byteLength < 48 || decoded.toString('base64') !== input) {
    throw new EnvError('Expected canonical base64 PKCS8 data');
  }

  return input;
});

function canonicalBase64(input: string): Buffer {
  const decoded = Buffer.from(input, 'base64');

  if (decoded.byteLength === 0 || decoded.toString('base64') !== input) {
    throw new EnvError('Expected canonical base64 data');
  }

  return decoded;
}

const alipayAppId = makeValidator<string>((input) => {
  if (!/^\d{16,32}$/u.test(input)) {
    throw new EnvError('Expected an Alipay app ID');
  }

  return input;
});

const alipaySellerId = makeValidator<string>((input) => {
  if (!/^2088\d{12}$/u.test(input)) {
    throw new EnvError('Expected an Alipay seller ID');
  }

  return input;
});

const rsaPrivateKeyPkcs8 = makeValidator<string>((input) => {
  try {
    const key = createPrivateKey({ key: canonicalBase64(input), format: 'der', type: 'pkcs8' });

    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new EnvError('Expected an RSA-2048 PKCS8 private key');
    }
  } catch (error) {
    if (error instanceof EnvError) {
      throw error;
    }

    throw new EnvError('Expected an RSA-2048 PKCS8 private key');
  }

  return input;
});

const rsaPublicKeySpki = makeValidator<string>((input) => {
  try {
    const key = createPublicKey({ key: canonicalBase64(input), format: 'der', type: 'spki' });

    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new EnvError('Expected an RSA-2048 SPKI public key');
    }
  } catch (error) {
    if (error instanceof EnvError) {
      throw error;
    }

    throw new EnvError('Expected an RSA-2048 SPKI public key');
  }

  return input;
});

const httpsUrl = makeValidator<string>((input) => {
  let parsed: URL;

  try {
    parsed = new URL(input);
  } catch {
    throw new EnvError('Expected an HTTPS URL');
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new EnvError('Expected an HTTPS URL');
  }

  return parsed.href;
});

function redactedReporter<T>({ errors }: ReporterOptions<T>): void {
  const invalidVariables = Object.keys(errors);

  if (invalidVariables.length > 0) {
    throw new ConfigurationError(invalidVariables);
  }
}

const runtimeSpec = {
  NODE_ENV: str({
    choices: runtimeEnvironments,
    desc: 'Application runtime environment',
    example: 'development',
  }),
};

export function loadApiConfig(environment: unknown): ApiConfig {
  const env = cleanEnv(
    environment,
    {
      ...runtimeSpec,
      AIPAY_API_HOST: host({ desc: 'API bind host', example: '127.0.0.1' }),
      AIPAY_API_PORT: port({ desc: 'API listen port', example: '3000' }),
    },
    { reporter: redactedReporter },
  );

  return Object.freeze({
    environment: env.NODE_ENV,
    host: env.AIPAY_API_HOST,
    port: env.AIPAY_API_PORT,
  });
}

export function loadWorkerConfig(environment: unknown): WorkerConfig {
  const env = cleanEnv(
    environment,
    {
      ...runtimeSpec,
      AIPAY_WORKER_CONCURRENCY: positiveInteger({
        desc: 'Maximum concurrent worker jobs',
        example: '1',
      }),
    },
    { reporter: redactedReporter },
  );

  return Object.freeze({
    environment: env.NODE_ENV,
    concurrency: env.AIPAY_WORKER_CONCURRENCY,
  });
}

export function loadDatabaseConfig(environment: unknown): DatabaseConfig {
  const env = cleanEnv(
    environment,
    {
      AIPAY_DATABASE_URL: postgresUrl({
        desc: 'PostgreSQL connection URL',
        example: 'postgresql://aipay:password@127.0.0.1:54329/aipay_dev',
      }),
    },
    { reporter: redactedReporter },
  );

  return Object.freeze({ url: env.AIPAY_DATABASE_URL });
}

export function loadMandateIssuerConfig(environment: unknown): MandateIssuerConfig {
  const env = cleanEnv(
    environment,
    {
      AIPAY_MANDATE_SIGNING_KEY_ID: signingKeyId({
        desc: 'Mandate issuer key ID',
        example: 'key_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4e',
      }),
      AIPAY_MANDATE_SIGNING_PRIVATE_KEY: privateKeyPkcs8({
        desc: 'Base64 PKCS8 Ed25519 private key',
      }),
    },
    { reporter: redactedReporter },
  );

  return Object.freeze({
    keyId: env.AIPAY_MANDATE_SIGNING_KEY_ID,
    privateKeyPkcs8Base64: env.AIPAY_MANDATE_SIGNING_PRIVATE_KEY,
  });
}

export function loadAlipayConfig(environment: unknown): AlipayConfig {
  const env = cleanEnv(
    environment,
    {
      AIPAY_ALIPAY_MODE: str({ choices: ['sandbox', 'production'] as const }),
      AIPAY_ALIPAY_APP_ID: alipayAppId(),
      AIPAY_ALIPAY_SELLER_ID: alipaySellerId(),
      AIPAY_ALIPAY_PRIVATE_KEY: rsaPrivateKeyPkcs8(),
      AIPAY_ALIPAY_PLATFORM_PUBLIC_KEY: rsaPublicKeySpki(),
      AIPAY_ALIPAY_NOTIFY_URL: httpsUrl(),
    },
    { reporter: redactedReporter },
  );
  const mode = env.AIPAY_ALIPAY_MODE;

  return Object.freeze({
    mode,
    gatewayUrl:
      mode === 'sandbox'
        ? 'https://openapi-sandbox.dl.alipaydev.com/gateway.do'
        : 'https://openapi.alipay.com/gateway.do',
    appId: env.AIPAY_ALIPAY_APP_ID,
    sellerId: env.AIPAY_ALIPAY_SELLER_ID,
    privateKeyPkcs8Base64: env.AIPAY_ALIPAY_PRIVATE_KEY,
    alipayPublicKeySpkiBase64: env.AIPAY_ALIPAY_PLATFORM_PUBLIC_KEY,
    notifyUrl: env.AIPAY_ALIPAY_NOTIFY_URL,
  });
}
