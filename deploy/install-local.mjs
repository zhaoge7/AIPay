/* global fetch */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { loadDeploymentConfig, renderCaddyfile } from './config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = '/home/zz/.nvm/versions/node/v24.19.0/bin/node';
const pnpm = '/home/zz/.nvm/versions/node/v24.19.0/bin/pnpm';
const caddy = '/home/zz/.local/bin/caddy';
const unitDirectory = '/home/zz/.config/systemd/user';
const stateDirectory = resolve(root, '.local-state/caddy');
const caddyConfig = resolve(stateDirectory, 'Caddyfile');
const deployment = loadDeploymentConfig(process.env);
const runtimeEnvironment = {
  ...process.env,
  AIPAY_ROOT: root,
  PATH: `${dirname(node)}:${process.env.PATH ?? ''}`,
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: runtimeEnvironment,
    stdio: options.capture === true ? 'pipe' : 'inherit',
  });

  if (result.error !== undefined) throw result.error;

  if (result.status !== 0) {
    throw new Error(`${command} failed`);
  }

  return result.stdout?.trim() ?? '';
}

function succeeds(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: runtimeEnvironment,
    stdio: 'ignore',
  });
  return result.status === 0;
}

async function requireProtected(path) {
  const metadata = await lstat(path);

  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error(`${path} must be a protected regular file`);
  }
}

await requireProtected(resolve(root, '.env'));
await requireProtected(resolve(root, '.alipay-sandbox.json'));
assert.equal(run(node, ['--version'], { capture: true }), 'v24.19.0');

await mkdir(unitDirectory, { recursive: true });
await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
await mkdir(resolve(root, '.local-state/logs'), { recursive: true, mode: 0o700 });
run(pnpm, ['--filter', '@aipay/api', 'upgrade:env']);
run(pnpm, ['run', 'db:up']);
run(pnpm, ['run', 'db:migrate']);
run(pnpm, ['run', 'build']);
if (deployment.paymentProvider === 'alipay_web') {
  const { loadAlipayConfig } = await import('../packages/config/dist/index.js');
  const alipay = loadAlipayConfig(process.env);
  const expectedNotifyUrl = `${deployment.publicOrigin}/v1/payments/alipay/webhook`;

  if (alipay.notifyUrl !== expectedNotifyUrl) {
    throw new Error('AIPAY_ALIPAY_NOTIFY_URL must match the external payment webhook');
  }
}
const caddyTemplate = await readFile(resolve(root, 'deploy/Caddyfile.in'), 'utf8');
const renderedCaddy = renderCaddyfile(caddyTemplate, deployment);
await writeFile(caddyConfig, renderedCaddy, { encoding: 'utf8', mode: 0o600 });
run(caddy, ['validate', '--config', caddyConfig, '--adapter', 'caddyfile'], {
  capture: true,
});

for (const unit of ['aipay-api', 'aipay-caddy', 'aipay-worker']) {
  const template = await readFile(resolve(root, `deploy/systemd/${unit}.service.in`), 'utf8');
  const rendered = template
    .replaceAll('@@ROOT@@', root)
    .replaceAll('@@NODE@@', node)
    .replaceAll('@@CADDY@@', caddy)
    .replaceAll('@@CADDY_CONFIG@@', caddyConfig)
    .replaceAll('@@DEPLOYMENT_MODE@@', deployment.mode)
    .replaceAll('@@PUBLIC_ORIGIN@@', deployment.publicOrigin)
    .replaceAll(
      '@@NODE_EXTRA_CA@@',
      deployment.requiresInternalCa
        ? `Environment=NODE_EXTRA_CA_CERTS=${resolve(stateDirectory, 'data/caddy/pki/authorities/local/root.crt')}`
        : '',
    );
  await writeFile(resolve(unitDirectory, `${unit}.service`), rendered, { encoding: 'utf8' });
}

run('systemctl', ['--user', 'daemon-reload']);
run('systemctl', [
  '--user',
  'enable',
  'aipay-api.service',
  'aipay-caddy.service',
  'aipay-worker.service',
]);
run('systemctl', ['--user', 'restart', 'aipay-api.service']);
let apiReady = false;

for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    const response = await fetch('http://127.0.0.1:3101/internal/health');

    if (response.ok) {
      apiReady = true;
      break;
    }
  } catch {
    // Service startup is still in progress.
  }

  await setTimeout(250);
}

if (!apiReady) {
  throw new Error('AIPay API did not become healthy');
}

run('systemctl', ['--user', 'restart', 'aipay-caddy.service']);
const rootCertificate = resolve(stateDirectory, 'data/caddy/pki/authorities/local/root.crt');
let certificateReady = !deployment.requiresInternalCa;

for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    if (deployment.requiresInternalCa) await access(rootCertificate);
    certificateReady = true;
    break;
  } catch {
    await setTimeout(250);
  }
}

if (deployment.requiresInternalCa && !certificateReady) {
  throw new Error('Caddy local CA was not created');
}

let httpsReady = false;

for (let attempt = 0; attempt < 120; attempt += 1) {
  const curlArguments = ['--silent', '--show-error', '--fail'];

  if (deployment.requiresInternalCa) curlArguments.push('--cacert', rootCertificate);
  curlArguments.push(`${deployment.publicOrigin}/internal/health`);

  if (succeeds('curl', curlArguments)) {
    httpsReady = true;
    break;
  }

  await setTimeout(250);
}

if (!httpsReady) {
  throw new Error('AIPay HTTPS endpoint did not become healthy');
}

run('systemctl', ['--user', 'restart', 'aipay-worker.service']);
await setTimeout(1_000);
for (const unit of ['aipay-api.service', 'aipay-caddy.service', 'aipay-worker.service']) {
  assert.equal(run('systemctl', ['--user', 'is-active', unit], { capture: true }), 'active');
}

process.stdout.write(
  `AIPay ${deployment.mode} closed-test services installed for ${deployment.publicOrigin}${deployment.requiresInternalCa ? ` (CA: ${rootCertificate})` : ''}\n`,
);
