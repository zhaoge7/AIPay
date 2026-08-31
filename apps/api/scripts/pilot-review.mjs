import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

import { parsePilotReviewEvidence } from '@aipay/contracts';

import { buildMvpReview, parsePilotReportForReview } from '../dist/pilot/review.js';

const rawArguments = process.argv.slice(2);
const arguments_ = rawArguments[0] === '--' ? rawArguments.slice(1) : rawArguments;
const [reportPath, evidencePath, outputPath] = arguments_;

if (
  reportPath === undefined ||
  evidencePath === undefined ||
  outputPath === undefined ||
  arguments_.length !== 3
) {
  throw new Error('Usage: pilot-review.mjs <report.json> <review-evidence.json> <new-review.json>');
}

const [reportBytes, evidenceBytes] = await Promise.all([
  readFile(reportPath),
  readFile(evidencePath),
]);
let reportValue;
let evidenceValue;

try {
  reportValue = JSON.parse(reportBytes.toString('utf8'));
  evidenceValue = JSON.parse(evidenceBytes.toString('utf8'));
} catch {
  throw new Error('Pilot review input is not valid JSON');
}

const report = parsePilotReportForReview(reportValue);
const evidence = parsePilotReviewEvidence(evidenceValue);
const reportSha256 = createHash('sha256').update(reportBytes).digest('hex');
const evidenceSha256 = createHash('sha256').update(evidenceBytes).digest('hex');
const review = buildMvpReview(report, evidence, reportSha256, evidenceSha256);
const reviewBytes = Buffer.from(`${JSON.stringify(review, null, 2)}\n`, 'utf8');
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, reviewBytes, { flag: 'wx', mode: 0o600 });
const reviewSha256 = createHash('sha256').update(reviewBytes).digest('hex');
process.stdout.write(
  `Pilot review created: ${outputPath} (report_sha256=${reportSha256}, evidence_sha256=${evidenceSha256}, review_sha256=${reviewSha256})\n`,
);
