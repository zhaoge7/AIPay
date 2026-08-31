import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(tmpdir(), 'aipay-partner-kit-'));
const kitDirectory = join(temporary, 'kit');
const consumerDirectory = join(temporary, 'consumer');
const nodeDirectory = dirname(process.execPath);
const childEnvironment = {
  ...process.env,
  PATH: `${nodeDirectory}:${process.env.PATH ?? ''}`,
};

async function run(file, arguments_, cwd = repositoryRoot) {
  try {
    return await execute(file, arguments_, {
      cwd,
      env: childEnvironment,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Partner kit verification failed: ${file}`, { cause: error });
  }
}

try {
  await run(process.execPath, ['scripts/build-partner-kit.mjs', kitDirectory]);
  await mkdir(consumerDirectory, { mode: 0o700 });
  await writeFile(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ name: 'aipay-external-consumer-test', private: true, type: 'module' }, null, 2)}\n`,
  );
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(kitDirectory, 'aipay-contracts-0.2.0.tgz'),
      join(kitDirectory, 'aipay-sdk-ts-0.2.0.tgz'),
      join(kitDirectory, 'aipay-agent-mcp-bridge-0.2.0.tgz'),
      join(kitDirectory, 'aipay-merchant-http-adapter-0.2.0.tgz'),
    ],
    consumerDirectory,
  );
  await writeFile(
    join(consumerDirectory, 'verify.mjs'),
    `import assert from 'node:assert/strict';
import { AgentClient, MerchantClient, decodePaymentRequirement } from '@aipay/sdk-ts';
import { parseResourceId } from '@aipay/contracts';
import { createAgentBridgeMcpServer } from '@aipay/agent-mcp-bridge';
import { createMerchantAdapterApp } from '@aipay/merchant-http-adapter';

assert.equal(typeof AgentClient, 'function');
assert.equal(typeof MerchantClient, 'function');
assert.equal(typeof decodePaymentRequirement, 'function');
assert.equal(typeof parseResourceId, 'function');
assert.equal(typeof createAgentBridgeMcpServer, 'function');
assert.equal(typeof createMerchantAdapterApp, 'function');
`,
  );
  await run(process.execPath, ['verify.mjs'], consumerDirectory);
  const metadata = JSON.parse(await readFile(join(kitDirectory, 'KIT.json'), 'utf8'));
  assert.equal(metadata.schemaVersion, '1');
  assert.equal(metadata.nodeVersion, process.version);
  assert.equal(metadata.packages.length, 4);
  assert.equal(
    metadata.packages.every(({ sha256 }) => /^[0-9a-f]{64}$/.test(sha256)),
    true,
  );
  process.stdout.write('External npm project installed and imported the AIPay partner kit.\n');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
