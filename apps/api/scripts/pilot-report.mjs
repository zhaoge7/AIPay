import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

import { parsePilotManifest } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';

import { buildPilotReport } from '../dist/pilot/report.js';
import { loadDatabaseUrl } from '../../../packages/database/scripts/script-config.mjs';

const [manifestPath, outputPath] = process.argv.slice(2);

if (manifestPath === undefined || outputPath === undefined || process.argv.length !== 4) {
  throw new Error('Usage: pilot-report.mjs <manifest.json> <new-report.json>');
}

const manifestBytes = await readFile(manifestPath);
let manifestValue;

try {
  manifestValue = JSON.parse(manifestBytes.toString('utf8'));
} catch {
  throw new Error('Pilot manifest is not valid JSON');
}

const manifest = parsePilotManifest(manifestValue);
const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
const database = createDatabase(loadDatabaseUrl(), { maxConnections: 4 });

try {
  const report = await buildPilotReport(database, manifest, manifestSha256);
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, reportBytes, { flag: 'wx', mode: 0o600 });
  const reportSha256 = createHash('sha256').update(reportBytes).digest('hex');
  process.stdout.write(
    `Pilot report created: ${outputPath} (manifest_sha256=${manifestSha256}, report_sha256=${reportSha256})\n`,
  );
} finally {
  await database.destroy();
}
