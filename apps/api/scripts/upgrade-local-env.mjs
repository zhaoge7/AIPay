import { randomBytes } from 'node:crypto';
import { chmod, lstat, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

const path = new URL('../../../.env', import.meta.url);
const metadata = await lstat(path);

if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
  throw new Error('Local .env must be a protected regular file');
}

let content = await readFile(path, 'utf8');
const additions = [];

if (!/^AIPAY_BACKUP_KEY=/mu.test(content)) {
  additions.push(`AIPAY_BACKUP_KEY=${randomBytes(32).toString('base64')}`);
}

if (!/^AIPAY_METRICS_TOKEN=/mu.test(content)) {
  additions.push(`AIPAY_METRICS_TOKEN=${randomBytes(32).toString('base64url')}`);
}

if (additions.length > 0) {
  content = `${content.trimEnd()}\n${additions.join('\n')}\n`;
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

process.stdout.write(
  `Protected local environment is current (${String(additions.length)} added).\n`,
);
