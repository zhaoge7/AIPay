/* global fetch */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const node = '/home/zz/.nvm/versions/node/v24.19.0/bin/node';
const pnpm = '/home/zz/.nvm/versions/node/v24.19.0/bin/pnpm';
const caddy = '/home/zz/.local/bin/caddy';
const unitDirectory = '/home/zz/.config/systemd/user';
const stateDirectory = resolve(root, '.local-state/caddy');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, AIPAY_ROOT: root },
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
    env: { ...process.env, AIPAY_ROOT: root },
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
run(caddy, ['validate', '--config', resolve(root, 'deploy/Caddyfile'), '--adapter', 'caddyfile'], {
  capture: true,
});

for (const unit of ['aipay-api', 'aipay-caddy', 'aipay-worker']) {
  const template = await readFile(resolve(root, `deploy/systemd/${unit}.service.in`), 'utf8');
  const rendered = template
    .replaceAll('@@ROOT@@', root)
    .replaceAll('@@NODE@@', node)
    .replaceAll('@@CADDY@@', caddy);
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
let certificateReady = false;

for (let attempt = 0; attempt < 120; attempt += 1) {
  try {
    await access(rootCertificate);
    certificateReady = true;
    break;
  } catch {
    await setTimeout(250);
  }
}

if (!certificateReady) {
  throw new Error('Caddy local CA was not created');
}

let httpsReady = false;

for (let attempt = 0; attempt < 120; attempt += 1) {
  if (
    succeeds('curl', [
      '--silent',
      '--show-error',
      '--fail',
      '--cacert',
      rootCertificate,
      'https://aipay.localhost:8443/internal/health',
    ])
  ) {
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
  `AIPay closed-test services installed for https://aipay.localhost:8443 (CA: ${rootCertificate})\n`,
);
