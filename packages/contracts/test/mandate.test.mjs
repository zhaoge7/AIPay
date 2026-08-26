import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContractValidationError,
  getMandateJsonSchema,
  getMandateSigningPayload,
  MANDATE_SIGNATURE_DOMAIN,
  MandateWireSchema,
  parseMandate,
} from '../dist/index.js';

const ids = Object.freeze({
  mandate: '01890f3e-9b4a-7cc2-98c5-7f6a1b2c3d4e',
  developer: '01890f3e-9b4b-7cc2-a8c5-7f6a1b2c3d4e',
  agent: '01890f3e-9b4c-7cc2-b8c5-7f6a1b2c3d4e',
  merchant: '01890f3e-9b4d-7cc2-88c5-7f6a1b2c3d4e',
  merchantTwo: '01890f3e-9b4e-7cc2-98c5-7f6a1b2c3d4e',
  key: '01890f3e-9b4f-7cc2-a8c5-7f6a1b2c3d4e',
});

function createValidMandate() {
  return {
    schemaVersion: '1',
    mandateId: `mdt_${ids.mandate}`,
    principalId: `dev_${ids.developer}`,
    agentId: `agt_${ids.agent}`,
    purpose: 'Purchase research data for an approved task',
    allowedMerchantIds: [`mch_${ids.merchant}`, `mch_${ids.merchantTwo}`],
    allowedCategories: ['academic_data', 'search'],
    maxPerTransaction: { currency: 'CNY', amountMinor: '2000' },
    totalBudget: { currency: 'CNY', amountMinor: '20000' },
    approvalRequiredAbove: { currency: 'CNY', amountMinor: '5000' },
    maxTransactions: 50,
    issuedAt: '2026-08-26T04:00:00.000Z',
    validUntil: '2026-08-27T04:00:00.000Z',
    instructionHash: `sha256:${'a'.repeat(64)}`,
    proof: {
      scheme: 'aipay-jcs-ed25519-v1',
      keyId: `key_${ids.key}`,
      value: 'A'.repeat(86),
    },
  };
}

function assertContractError(callback, expectedIssue) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof ContractValidationError, true);
    assert.equal(
      error.issues.some(
        (issue) => issue.code === expectedIssue.code && issue.path === expectedIssue.path,
      ),
      true,
    );
    return true;
  });
}

test('parses a complete Mandate into immutable domain values', () => {
  const mandate = parseMandate(createValidMandate());

  assert.equal(mandate.schemaVersion, '1');
  assert.equal(mandate.maxPerTransaction.amountMinor, '2000');
  assert.equal(mandate.proof.scheme, 'aipay-jcs-ed25519-v1');
  assert.equal(Object.isFrozen(mandate), true);
  assert.equal(Object.isFrozen(mandate.allowedMerchantIds), true);
  assert.equal(Object.isFrozen(mandate.allowedCategories), true);
  assert.equal(Object.isFrozen(mandate.maxPerTransaction), true);
  assert.equal(Object.isFrozen(mandate.proof), true);
});

test('creates a deeply immutable signing payload without the signature value', () => {
  const wire = createValidMandate();
  const mandate = parseMandate(wire);
  const payload = getMandateSigningPayload(mandate);

  assert.equal(MANDATE_SIGNATURE_DOMAIN, 'AIPAY-MANDATE-V1\0');
  assert.equal('value' in payload.proof, false);
  assert.deepEqual(payload.proof, {
    scheme: mandate.proof.scheme,
    keyId: mandate.proof.keyId,
  });
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(Object.isFrozen(payload.proof), true);
  assert.equal(Object.isFrozen(payload.allowedMerchantIds), true);
  assert.equal(Object.isFrozen(payload.maxPerTransaction), true);

  wire.allowedMerchantIds.push(`mch_${ids.merchant}`);
  wire.maxPerTransaction.amountMinor = '1';
  assert.equal(payload.allowedMerchantIds.length, 2);
  assert.equal(payload.maxPerTransaction.amountMinor, '2000');
});

test('rejects unknown fields at root and nested proof boundaries', () => {
  const rootValue = { ...createValidMandate(), unexpected: true };
  const proofValue = createValidMandate();
  proofValue.proof.unexpected = true;

  assertContractError(() => parseMandate(rootValue), {
    code: 'unknown_field',
    path: '/',
  });
  assertContractError(() => parseMandate(proofValue), {
    code: 'unknown_field',
    path: '/proof',
  });
});

test('rejects invalid IDs, amount types, hashes, timestamps and signatures', () => {
  const cases = [
    ['principalId', 'agt_01890f3e-9b4b-7cc2-a8c5-7f6a1b2c3d4e', '/principalId'],
    ['instructionHash', `sha256:${'A'.repeat(64)}`, '/instructionHash'],
    ['issuedAt', '2026-08-26T12:00:00+08:00', '/issuedAt'],
  ];

  for (const [field, value, path] of cases) {
    const mandate = createValidMandate();
    mandate[field] = value;
    assertContractError(() => parseMandate(mandate), { code: 'invalid_format', path });
  }

  const numericAmount = createValidMandate();
  numericAmount.totalBudget.amountMinor = 20000;
  assertContractError(() => parseMandate(numericAmount), {
    code: 'invalid_type',
    path: '/totalBudget/amountMinor',
  });

  const nonCanonicalSignature = createValidMandate();
  nonCanonicalSignature.proof.value = `${'A'.repeat(85)}B`;
  assertContractError(() => parseMandate(nonCanonicalSignature), {
    code: 'invalid_format',
    path: '/proof/value',
  });
});

test('rejects duplicate allowlists and invalid cross-field relationships', () => {
  const duplicates = createValidMandate();
  duplicates.allowedMerchantIds = [
    duplicates.allowedMerchantIds[0],
    duplicates.allowedMerchantIds[0],
  ];
  duplicates.allowedCategories = ['search', 'search'];

  assertContractError(() => parseMandate(duplicates), {
    code: 'duplicate_allowed_merchant',
    path: '/allowedMerchantIds',
  });
  assertContractError(() => parseMandate(duplicates), {
    code: 'duplicate_allowed_category',
    path: '/allowedCategories',
  });

  const invalidWindow = createValidMandate();
  invalidWindow.validUntil = invalidWindow.issuedAt;
  assertContractError(() => parseMandate(invalidWindow), {
    code: 'invalid_validity_window',
    path: '/validUntil',
  });

  const excessiveTransaction = createValidMandate();
  excessiveTransaction.maxPerTransaction.amountMinor = '20001';
  assertContractError(() => parseMandate(excessiveTransaction), {
    code: 'max_per_transaction_exceeds_budget',
    path: '/maxPerTransaction',
  });
});

test('rejects non-I-JSON text, impossible dates and PostgreSQL BIGINT overflow', () => {
  for (const purpose of [
    `invalid-${String.fromCharCode(0xd800)}`,
    `invalid${String.fromCharCode(0)}control`,
  ]) {
    const invalidUnicode = createValidMandate();
    invalidUnicode.purpose = purpose;
    assertContractError(() => parseMandate(invalidUnicode), {
      code: 'invalid_unicode',
      path: '/purpose',
    });
  }

  const impossibleDate = createValidMandate();
  impossibleDate.validUntil = '2026-02-29T04:00:00.000Z';
  assertContractError(() => parseMandate(impossibleDate), {
    code: 'invalid_format',
    path: '/validUntil',
  });

  const overflowingBudget = createValidMandate();
  overflowingBudget.totalBudget.amountMinor = '9223372036854775808';
  assertContractError(() => parseMandate(overflowingBudget), {
    code: 'out_of_range',
    path: '/totalBudget',
  });
});

test('does not echo rejected Mandate input through validation errors', () => {
  const privateValue = 'PRIVATE_VALUE_THAT_MUST_NOT_APPEAR';
  const mandate = createValidMandate();
  mandate.mandateId = privateValue;

  assert.throws(
    () => parseMandate(mandate),
    (error) => {
      assert.equal(error instanceof ContractValidationError, true);
      assert.equal(error.message.includes(privateValue), false);
      assert.equal(JSON.stringify(error.issues).includes(privateValue), false);
      return true;
    },
  );
});

test('exports a strict Draft 2020-12 JSON Schema', () => {
  const schema = getMandateJsonSchema();

  assert.equal(MandateWireSchema.safeParse(createValidMandate()).success, true);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.proof.additionalProperties, false);
  assert.equal(schema.properties.maxPerTransaction.additionalProperties, false);
  assert.equal(schema.properties.proof.properties.scheme.const, 'aipay-jcs-ed25519-v1');
  assert.equal(schema.properties.totalBudget.properties.amountMinor.maxLength, 19);
  assert.deepEqual(schema.required, [
    'schemaVersion',
    'mandateId',
    'principalId',
    'agentId',
    'purpose',
    'allowedMerchantIds',
    'allowedCategories',
    'maxPerTransaction',
    'totalBudget',
    'approvalRequiredAbove',
    'maxTransactions',
    'issuedAt',
    'validUntil',
    'instructionHash',
    'proof',
  ]);
});
