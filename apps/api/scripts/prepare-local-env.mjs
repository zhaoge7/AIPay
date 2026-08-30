import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

import { v7 as uuidv7 } from 'uuid';

const templatePath = new URL('../../../.env.example', import.meta.url);
const outputPath = new URL('../../../.env', import.meta.url);
const template = await readFile(templatePath, 'utf8');
const { privateKey } = generateKeyPairSync('ed25519');
const issuer = [
  `AIPAY_MANDATE_SIGNING_KEY_ID=key_${uuidv7()}`,
  `AIPAY_MANDATE_SIGNING_PRIVATE_KEY=${privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')}`,
  `AIPAY_BACKUP_KEY=${randomBytes(32).toString('base64')}`,
  '',
].join('\n');

try {
  await writeFile(outputPath, `${template.trimEnd()}\n${issuer}`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
} catch (error) {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
    throw new Error('Local .env already exists; it was not changed', { cause: error });
  }

  throw error;
}

process.stdout.write('Protected local environment created at .env\n');
