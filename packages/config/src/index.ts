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
