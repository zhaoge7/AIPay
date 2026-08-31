import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

import { PilotReviewEvidenceValidationError, parsePilotReviewEvidence } from '../dist/index.js';

const exampleUrl = new URL('../../../pilot/review-evidence.example.json', import.meta.url);

test('parses private external review, incident and economics evidence', async () => {
  const evidence = parsePilotReviewEvidence(JSON.parse(await readFile(exampleUrl, 'utf8')));
  assert.equal(evidence.pilotId, 'pilot_example');
  assert.equal(evidence.commercialEvidenceApproved, false);
  assert.equal(evidence.economics.supportMinutes, 0);
});

test('rejects unknown or malformed review evidence without echoing values', () => {
  const value = {
    schemaVersion: '1',
    pilotId: 'pilot_review',
    reviewedAt: '2026-09-30T01:00:00.000Z',
    evidenceReviewerAlias: 'reviewer',
    externalMerchantApproved: true,
    externalAgentApproved: true,
    capabilityAndPriceApproved: true,
    trafficEvidenceApproved: true,
    commercialEvidenceApproved: true,
    incidents: [],
    economics: {
      infrastructureCostAmountMinor: '-1',
      softwareFeeAmountMinor: '0',
      supportMinutes: 0,
      evidenceUrl: 'https://evidence.example/review',
    },
    privateNote: 'must-not-be-echoed',
  };
  assert.throws(
    () => parsePilotReviewEvidence(value),
    (error) => {
      assert.ok(error instanceof PilotReviewEvidenceValidationError);
      assert.ok(error.paths.includes('/'));
      assert.ok(error.paths.includes('/economics/infrastructureCostAmountMinor'));
      assert.equal(error.message.includes(value.privateNote), false);
      return true;
    },
  );
});
