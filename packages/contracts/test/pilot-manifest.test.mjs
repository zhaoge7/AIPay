import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

import { PilotManifestValidationError, parsePilotManifest } from '../dist/index.js';

const exampleUrl = new URL('../../../pilot/manifest.example.json', import.meta.url);

test('parses a strict design-partner evidence manifest', async () => {
  const manifest = parsePilotManifest(JSON.parse(await readFile(exampleUrl, 'utf8')));

  assert.equal(manifest.schemaVersion, '1');
  assert.equal(manifest.merchant.unitPrice.amountMinor, '1');
  assert.equal(manifest.commercialIntent.status, 'pending');
});

test('rejects non-HTTPS, unknown and secret-bearing shapes without echoing values', () => {
  const invalid = {
    schemaVersion: '1',
    pilotId: 'pilot_invalid',
    window: {
      startedAt: '2026-09-02T00:00:00.000Z',
      endedAt: '2026-09-01T00:00:00.000Z',
    },
    environmentUrl: 'http://localhost:3100',
    merchant: {
      operatorAlias: 'merchant',
      merchantId: 'mch_01890f3e-9b43-7cc2-88c5-7f6a1b2c3d4e',
      serviceId: 'svc_01890f3e-9b43-7cc2-88c5-7f6a1b2c3d4e',
      serviceType: 'api',
      unit: 'request',
      unitPrice: { currency: 'CNY', amountMinor: '0' },
      capabilityEvidenceUrl: 'https://evidence.example/capability',
      pricingEvidenceUrl: 'https://evidence.example/pricing',
      implementationEvidenceUrl: 'https://evidence.example/integration',
      onboardingStartedAt: '2026-09-01T01:00:00.000Z',
      onboardingCompletedAt: '2026-09-01T00:00:00.000Z',
      privateKey: 'must-not-be-echoed',
    },
    agent: {
      operatorAlias: 'agent',
      agentId: 'agt_01890f3e-9b43-7cc2-88c5-7f6a1b2c3d4e',
      implementationEvidenceUrl: 'https://evidence.example/agent',
      trafficAttestationUrl: 'https://evidence.example/traffic',
      onboardingStartedAt: '2026-09-01T00:00:00.000Z',
      onboardingCompletedAt: '2026-09-01T00:01:00.000Z',
    },
    failures: [],
    commercialIntent: { status: 'pending', evidenceUrl: null, recordedAt: null },
  };

  assert.throws(
    () => parsePilotManifest(invalid),
    (error) => {
      assert.ok(error instanceof PilotManifestValidationError);
      assert.ok(error.paths.includes('/environmentUrl'));
      assert.equal(error.message.includes('must-not-be-echoed'), false);
      return true;
    },
  );
});

test('rejects inconsistent pilot, onboarding and failure timestamps', async () => {
  const example = JSON.parse(await readFile(exampleUrl, 'utf8'));
  example.window.endedAt = '2026-08-31T00:00:00.000Z';
  assert.throws(
    () => parsePilotManifest(example),
    (error) =>
      error instanceof PilotManifestValidationError && error.paths.includes('/window/endedAt'),
  );

  const onboarding = JSON.parse(await readFile(exampleUrl, 'utf8'));
  onboarding.agent.onboardingCompletedAt = '2026-08-31T00:00:00.000Z';
  assert.throws(
    () => parsePilotManifest(onboarding),
    (error) =>
      error instanceof PilotManifestValidationError &&
      error.paths.includes('/agent/onboardingCompletedAt'),
  );

  const failure = JSON.parse(await readFile(exampleUrl, 'utf8'));
  failure.failures[0].resolvedAt = '2026-08-31T00:00:00.000Z';
  assert.throws(
    () => parsePilotManifest(failure),
    (error) =>
      error instanceof PilotManifestValidationError &&
      error.paths.includes('/failures/0/resolvedAt'),
  );
});
