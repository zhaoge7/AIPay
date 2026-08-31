import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

import { parsePilotManifest, parsePilotTrafficLedger } from '@aipay/contracts';
import { createDatabase } from '@aipay/database';

import { buildPilotReport } from '../dist/pilot/report.js';
import { loadDatabaseUrl } from '../../../packages/database/scripts/script-config.mjs';

const rawArguments = process.argv.slice(2);
const arguments_ = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments;
const [manifestPath, trafficPath, outputPath] = arguments_;

if (
  manifestPath === undefined ||
  trafficPath === undefined ||
  outputPath === undefined ||
  arguments_.length !== 3
) {
  throw new Error('Usage: pilot-report.mjs <manifest.json> <traffic.json> <new-report.json>');
}

const [manifestBytes, trafficBytes] = await Promise.all([
  readFile(manifestPath),
  readFile(trafficPath),
]);
let manifestValue;
let trafficValue;

try {
  manifestValue = JSON.parse(manifestBytes.toString('utf8'));
  trafficValue = JSON.parse(trafficBytes.toString('utf8'));
} catch {
  throw new Error('Pilot evidence input is not valid JSON');
}

const manifest = parsePilotManifest(manifestValue);
const trafficLedger = parsePilotTrafficLedger(trafficValue);
const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
const trafficSha256 = createHash('sha256').update(trafficBytes).digest('hex');
const database = createDatabase(loadDatabaseUrl(), { maxConnections: 4 });

try {
  const report = await buildPilotReport(
    database,
    manifest,
    trafficLedger,
    manifestSha256,
    trafficSha256,
  );
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await writeFile(outputPath, reportBytes, { flag: 'wx', mode: 0o600 });
  const reportSha256 = createHash('sha256').update(reportBytes).digest('hex');
  process.stdout.write(
    `Pilot report created: ${outputPath} (manifest_sha256=${manifestSha256}, traffic_sha256=${trafficSha256}, report_sha256=${reportSha256})\n`,
  );
} finally {
  await database.destroy();
}
