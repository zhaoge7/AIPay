import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rawArguments = process.argv.slice(2);
const arguments_ = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments;
const [requestedOutput] = arguments_;

if (requestedOutput === undefined || arguments_.length !== 1) {
  throw new Error('Usage: build-partner-kit.mjs <new-output-directory>');
}

const outputDirectory = resolve(process.cwd(), requestedOutput);
await mkdir(outputDirectory, { mode: 0o700 });

async function run(file, arguments_, options = {}) {
  try {
    return await execute(file, arguments_, {
      cwd: repositoryRoot,
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
  } catch (error) {
    throw new Error(`Partner kit command failed: ${file}`, { cause: error });
  }
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

const contractsArchive = 'aipay-contracts-0.1.0.tgz';
const sdkArchive = 'aipay-sdk-ts-0.1.0.tgz';
await run('pnpm', ['--filter', '@aipay/contracts', 'build']);
await run('pnpm', ['--filter', '@aipay/sdk-ts', 'build']);
await run('pnpm', ['pack', '--out', join(outputDirectory, contractsArchive)], {
  cwd: join(repositoryRoot, 'packages/contracts'),
});
await run('pnpm', ['pack', '--out', join(outputDirectory, sdkArchive)], {
  cwd: join(repositoryRoot, 'packages/sdk-ts'),
});

const archives = await Promise.all(
  [contractsArchive, sdkArchive].map(async (filename) =>
    Object.freeze({ filename, sha256: await sha256(join(outputDirectory, filename)) }),
  ),
);
const { stdout: revisionOutput } = await run('git', ['rev-parse', 'HEAD']);
const { stdout: statusOutput } = await run('git', ['status', '--porcelain']);
const metadata = Object.freeze({
  schemaVersion: '1',
  sourceRevision: revisionOutput.trim(),
  sourceDirty: statusOutput.trim().length > 0,
  nodeVersion: process.version,
  packages: archives,
});
const checksums = `${archives.map(({ filename, sha256: digest }) => `${digest}  ${filename}`).join('\n')}\n`;
const instructions = `# AIPay private pilot SDK kit

Requires Node.js 24.x. Verify the two archives against \`SHA256SUMS\`, then install both into the partner's independent project:

\`\`\`bash
npm install ./aipay-contracts-0.1.0.tgz ./aipay-sdk-ts-0.1.0.tgz
\`\`\`

Import \`AgentClient\` or \`MerchantClient\` from \`@aipay/sdk-ts\`. Generate private keys in the partner environment and register only public keys. This kit is for the named closed-test partner; it is not an npm publication or a license grant.
`;

await Promise.all([
  writeFile(join(outputDirectory, 'KIT.json'), `${JSON.stringify(metadata, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  }),
  writeFile(join(outputDirectory, 'SHA256SUMS'), checksums, { flag: 'wx', mode: 0o600 }),
  writeFile(join(outputDirectory, 'INSTALL.md'), instructions, { flag: 'wx', mode: 0o600 }),
]);

process.stdout.write(`Partner kit created: ${outputDirectory}\n${checksums}`);
