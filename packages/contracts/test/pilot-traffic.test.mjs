import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

import { PilotTrafficValidationError, parsePilotTrafficLedger } from '../dist/index.js';

const exampleUrl = new URL('../../../pilot/traffic.example.json', import.meta.url);

async function example() {
  return JSON.parse(await readFile(exampleUrl, 'utf8'));
}

test('parses accepted and explicitly excluded private pilot traffic', async () => {
  const ledger = parsePilotTrafficLedger(await example());
  assert.equal(ledger.entries.length, 1);
  assert.equal(ledger.exclusions[0]?.reason, 'development');
});

test('rejects duplicate workloads and accepted/excluded overlap without echoing values', async () => {
  const value = await example();
  value.entries.push({ ...value.entries[0], transactionId: value.exclusions[0].transactionId });
  assert.throws(
    () => parsePilotTrafficLedger(value),
    (error) => {
      assert.ok(error instanceof PilotTrafficValidationError);
      assert.ok(error.paths.includes('/entries'));
      assert.ok(error.paths.includes('/exclusions'));
      assert.equal(error.message.includes(value.entries[0].workloadIdHash), false);
      return true;
    },
  );
});

test('rejects acceptance before workload occurrence', async () => {
  const value = await example();
  value.entries[0].acceptedAt = '2026-09-01T01:59:59.000Z';
  assert.throws(
    () => parsePilotTrafficLedger(value),
    (error) =>
      error instanceof PilotTrafficValidationError && error.paths.includes('/entries/0/acceptedAt'),
  );
});
