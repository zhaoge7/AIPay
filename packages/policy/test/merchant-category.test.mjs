import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMandate, parseResourceId } from '@aipay/contracts';

import { evaluateMerchantCategoryPolicy } from '../dist/index.js';

const uuids = {
  mandate: '01890f3e-9e00-7cc2-98c5-7f6a1b2c3d4e',
  developer: '01890f3e-9e01-7cc2-a8c5-7f6a1b2c3d4e',
  agent: '01890f3e-9e02-7cc2-b8c5-7f6a1b2c3d4e',
  merchantOne: '01890f3e-9e03-7cc2-88c5-7f6a1b2c3d4e',
  merchantTwo: '01890f3e-9e04-7cc2-98c5-7f6a1b2c3d4e',
  merchantDenied: '01890f3e-9e05-7cc2-a8c5-7f6a1b2c3d4e',
  key: '01890f3e-9e06-7cc2-b8c5-7f6a1b2c3d4e',
};

function mandate() {
  return parseMandate({
    schemaVersion: '1',
    mandateId: `mdt_${uuids.mandate}`,
    principalId: `dev_${uuids.developer}`,
    agentId: `agt_${uuids.agent}`,
    purpose: 'Buy approved data services',
    allowedMerchantIds: [`mch_${uuids.merchantOne}`, `mch_${uuids.merchantTwo}`],
    allowedCategories: ['data.weather', 'data.maps'],
    maxPerTransaction: { currency: 'CNY', amountMinor: '1000' },
    totalBudget: { currency: 'CNY', amountMinor: '10000' },
    approvalRequiredAbove: { currency: 'CNY', amountMinor: '500' },
    maxTransactions: 100,
    issuedAt: '2026-08-27T00:00:00.000Z',
    validUntil: '2026-08-28T00:00:00.000Z',
    instructionHash: `sha256:${'0'.repeat(64)}`,
    proof: {
      scheme: 'aipay-jcs-ed25519-v1',
      keyId: `key_${uuids.key}`,
      value: 'A'.repeat(86),
    },
  });
}

test('allows only the exact merchant and category intersection', () => {
  const authorization = mandate();

  for (const merchantId of authorization.allowedMerchantIds) {
    for (const category of authorization.allowedCategories) {
      const decision = evaluateMerchantCategoryPolicy(authorization, { merchantId, category });
      assert.deepEqual(decision, { allowed: true });
      assert.equal(Object.isFrozen(decision), true);
    }
  }
});

test('deterministically rejects a merchant outside the allowlist first', () => {
  const authorization = mandate();
  const request = {
    merchantId: parseResourceId(`mch_${uuids.merchantDenied}`, 'mch'),
    category: 'not.allowed',
  };

  for (let index = 0; index < 100; index += 1) {
    assert.deepEqual(evaluateMerchantCategoryPolicy(authorization, request), {
      allowed: false,
      reason: 'merchant_not_allowed',
    });
  }
});

test('rejects non-allowlisted category without wildcard or case folding', () => {
  const authorization = mandate();
  const merchantId = authorization.allowedMerchantIds[0];

  for (const category of ['data.finance', 'DATA.WEATHER', 'data.*', '*']) {
    assert.deepEqual(evaluateMerchantCategoryPolicy(authorization, { merchantId, category }), {
      allowed: false,
      reason: 'category_not_allowed',
    });
  }
});

test('does not mutate the Mandate allowlists', () => {
  const authorization = mandate();
  const merchantsBefore = [...authorization.allowedMerchantIds];
  const categoriesBefore = [...authorization.allowedCategories];

  evaluateMerchantCategoryPolicy(authorization, {
    merchantId: authorization.allowedMerchantIds[0],
    category: authorization.allowedCategories[0],
  });

  assert.deepEqual(authorization.allowedMerchantIds, merchantsBefore);
  assert.deepEqual(authorization.allowedCategories, categoriesBefore);
  assert.equal(Object.isFrozen(authorization.allowedMerchantIds), true);
  assert.equal(Object.isFrozen(authorization.allowedCategories), true);
});
