import { spawnSync } from 'node:child_process';
import console from 'node:console';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const POSTGRES_IMAGE =
  'postgres:18.6-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2';

export const developmentContainer = Object.freeze({
  name: 'aipay-postgres-dev',
  database: 'aipay_dev',
  user: 'aipay',
  password: 'aipay-local-only',
  hostPort: 54329,
  volume: 'aipay-postgres-dev-data',
});

function runDocker(args, { allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });

  if (result.error !== undefined) {
    throw result.error;
  }

  if (!allowFailure && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || 'Docker command failed').trim());
  }

  return result;
}

function inspectContainer(name, format) {
  const result = runDocker(['inspect', '--format', format, name], { allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

async function waitUntilHealthy(name) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const status = inspectContainer(
      name,
      '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}',
    );

    if (status === 'healthy') {
      return;
    }

    if (status === 'unhealthy' || status === 'exited' || status === 'dead') {
      const logs = runDocker(['logs', name], { allowFailure: true });
      throw new Error(`PostgreSQL container failed: ${(logs.stderr || logs.stdout).trim()}`);
    }

    await setTimeout(500);
  }

  throw new Error(`PostgreSQL container ${name} did not become healthy within 60 seconds`);
}

async function waitUntilInitializationCompletes(name) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const logs = runDocker(['logs', name], { allowFailure: true });
    const output = `${logs.stdout}\n${logs.stderr}`;

    if (output.includes('PostgreSQL init process complete; ready for start up.')) {
      return;
    }

    const status = inspectContainer(name, '{{.State.Status}}');

    if (status === 'exited' || status === 'dead') {
      throw new Error(`PostgreSQL initialization failed: ${output.trim()}`);
    }

    await setTimeout(500);
  }

  throw new Error(`PostgreSQL container ${name} did not initialize within 60 seconds`);
}

async function waitUntilAcceptingQueries(config) {
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const result = runDocker(
      [
        'exec',
        config.name,
        'psql',
        '--username',
        config.user,
        '--dbname',
        config.database,
        '--tuples-only',
        '--no-align',
        '--command',
        'SELECT 1',
      ],
      { allowFailure: true },
    );

    if (result.status === 0 && result.stdout.trim() === '1') {
      return;
    }

    const status = inspectContainer(config.name, '{{.State.Status}}');

    if (status === 'exited' || status === 'dead') {
      throw new Error(
        `PostgreSQL stopped before accepting queries: ${(result.stderr || result.stdout).trim()}`,
      );
    }

    await setTimeout(250);
  }

  throw new Error(`PostgreSQL container ${config.name} did not accept queries within 60 seconds`);
}

function resolvePublishedPort(name) {
  const value = runDocker(['port', name, '5432/tcp']).stdout.trim();
  const port = Number(value.slice(value.lastIndexOf(':') + 1));

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Could not resolve PostgreSQL port for ${name}`);
  }

  return port;
}

export async function startPostgresContainer(config = developmentContainer) {
  const existingLabel = inspectContainer(config.name, '{{index .Config.Labels "com.aipay.role"}}');

  if (existingLabel !== undefined && existingLabel !== 'postgres-development') {
    throw new Error(`Container ${config.name} exists but is not owned by AIPay`);
  }

  const isNewContainer = existingLabel === undefined;

  if (isNewContainer) {
    const publish =
      config.hostPort === undefined ? '127.0.0.1::5432' : `127.0.0.1:${config.hostPort}:5432`;
    const args = [
      'run',
      '--detach',
      '--name',
      config.name,
      '--label',
      'com.aipay.role=postgres-development',
      '--publish',
      publish,
      '--env',
      `POSTGRES_DB=${config.database}`,
      '--env',
      `POSTGRES_USER=${config.user}`,
      '--env',
      `POSTGRES_PASSWORD=${config.password}`,
      '--health-cmd',
      `pg_isready -U ${config.user} -d ${config.database}`,
      '--health-interval',
      '1s',
      '--health-timeout',
      '3s',
      '--health-retries',
      '30',
    ];

    if (config.volume !== undefined) {
      args.push('--mount', `type=volume,source=${config.volume},target=/var/lib/postgresql`);
    }

    args.push(POSTGRES_IMAGE);
    runDocker(args);
  } else if (inspectContainer(config.name, '{{.State.Running}}') !== 'true') {
    runDocker(['start', config.name]);
  }

  if (isNewContainer) {
    await waitUntilInitializationCompletes(config.name);
  }

  await waitUntilHealthy(config.name);
  await waitUntilAcceptingQueries(config);
  const hostPort = resolvePublishedPort(config.name);

  return Object.freeze({
    hostPort,
    databaseUrl: `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@127.0.0.1:${hostPort}/${encodeURIComponent(config.database)}`,
  });
}

export function stopPostgresContainer(name = developmentContainer.name) {
  if (inspectContainer(name, '{{.State.Running}}') === 'true') {
    runDocker(['stop', '--time', '10', name]);
  }
}

export function removePostgresContainer(name) {
  if (
    inspectContainer(name, '{{index .Config.Labels "com.aipay.role"}}') === 'postgres-development'
  ) {
    runDocker(['rm', '--force', '--volumes', name]);
  }
}

async function main() {
  const command = process.argv[2];

  if (command === 'up') {
    const result = await startPostgresContainer();
    console.log(`PostgreSQL is ready at 127.0.0.1:${result.hostPort}`);
  } else if (command === 'down') {
    stopPostgresContainer();
    console.log('PostgreSQL container stopped; development data volume was preserved');
  } else {
    throw new Error('Usage: postgres-container.mjs <up|down>');
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
