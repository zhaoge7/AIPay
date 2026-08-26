import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContractValidationError,
  getQuoteJsonSchema,
  getQuoteSigningPayload,
  parseQuote,
  QUOTE_SIGNATURE_DOMAIN,
  QuoteWireSchema,
} from '../dist/index.js';

const ids = Object.freeze({
  quote: '01890f3e-9b50-7cc2-98c5-7f6a1b2c3d4e',
  merchant: '01890f3e-9b51-7cc2-a8c5-7f6a1b2c3d4e',
  service: '01890f3e-9b52-7cc2-b8c5-7f6a1b2c3d4e',
  key: '01890f3e-9b53-7cc2-88c5-7f6a1b2c3d4e',
});

function createValidQuote() {
  return {
    schemaVersion: '1',
    quoteId: `qte_${ids.quote}`,
    merchantId: `mch_${ids.merchant}`,
    serviceId: `svc_${ids.service}`,
    unit: 'request',
    quantity: 3,
    unitPrice: { currency: 'CNY', amountMinor: '200' },
    subtotal: { currency: 'CNY', amountMinor: '600' },
    taxBehavior: 'inclusive',
    taxAmount: { currency: 'CNY', amountMinor: '34' },
    total: { currency: 'CNY', amountMinor: '600' },
    issuedAt: '2026-08-27T01:00:00.000Z',
    expiresAt: '2026-08-27T01:05:00.000Z',
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

test('parses a complete inclusive-tax Quote into immutable domain values', () => {
  const quote = parseQuote(createValidQuote());

  assert.equal(quote.schemaVersion, '1');
  assert.equal(quote.quantity, 3);
  assert.equal(quote.total.amountMinor, '600');
  assert.equal(quote.taxBehavior, 'inclusive');
  assert.equal(Object.isFrozen(quote), true);
  assert.equal(Object.isFrozen(quote.unitPrice), true);
  assert.equal(Object.isFrozen(quote.subtotal), true);
  assert.equal(Object.isFrozen(quote.taxAmount), true);
  assert.equal(Object.isFrozen(quote.total), true);
  assert.equal(Object.isFrozen(quote.proof), true);
});

test('accepts an exclusive-tax Quote when total includes tax', () => {
  const wire = createValidQuote();
  wire.taxBehavior = 'exclusive';
  wire.taxAmount.amountMinor = '36';
  wire.total.amountMinor = '636';

  const quote = parseQuote(wire);

  assert.equal(quote.taxBehavior, 'exclusive');
  assert.equal(quote.taxAmount.amountMinor, '36');
  assert.equal(quote.total.amountMinor, '636');
});

test('creates a deeply immutable signing payload without the signature value', () => {
  const wire = createValidQuote();
  const quote = parseQuote(wire);
  const payload = getQuoteSigningPayload(quote);

  assert.equal(QUOTE_SIGNATURE_DOMAIN, 'AIPAY-QUOTE-V1\0');
  assert.equal('value' in payload.proof, false);
  assert.deepEqual(payload.proof, {
    scheme: quote.proof.scheme,
    keyId: quote.proof.keyId,
  });
  assert.equal(Object.isFrozen(payload), true);
  assert.equal(Object.isFrozen(payload.unitPrice), true);
  assert.equal(Object.isFrozen(payload.subtotal), true);
  assert.equal(Object.isFrozen(payload.taxAmount), true);
  assert.equal(Object.isFrozen(payload.total), true);
  assert.equal(Object.isFrozen(payload.proof), true);

  wire.unitPrice.amountMinor = '1';
  wire.proof.keyId = `key_${ids.quote}`;
  assert.equal(payload.unitPrice.amountMinor, '200');
  assert.equal(payload.proof.keyId, `key_${ids.key}`);
});

test('rejects unknown fields and malformed identifiers, units, quantities and signatures', () => {
  const unknownRoot = { ...createValidQuote(), unexpected: true };
  assertContractError(() => parseQuote(unknownRoot), {
    code: 'unknown_field',
    path: '/',
  });

  const unknownMoney = createValidQuote();
  unknownMoney.total.unexpected = true;
  assertContractError(() => parseQuote(unknownMoney), {
    code: 'unknown_field',
    path: '/total',
  });

  const cases = [
    ['merchantId', `svc_${ids.merchant}`, '/merchantId'],
    ['unit', 'API request', '/unit'],
  ];

  for (const [field, value, path] of cases) {
    const quote = createValidQuote();
    quote[field] = value;
    assertContractError(() => parseQuote(quote), { code: 'invalid_format', path });
  }

  const zeroQuantity = createValidQuote();
  zeroQuantity.quantity = 0;
  assertContractError(() => parseQuote(zeroQuantity), {
    code: 'out_of_range',
    path: '/quantity',
  });

  const invalidQuantity = createValidQuote();
  invalidQuantity.quantity = 1.5;
  assertContractError(() => parseQuote(invalidQuantity), {
    code: 'invalid_type',
    path: '/quantity',
  });

  const invalidSignature = createValidQuote();
  invalidSignature.proof.value = `${'A'.repeat(85)}B`;
  assertContractError(() => parseQuote(invalidSignature), {
    code: 'invalid_format',
    path: '/proof/value',
  });
});

test('rejects inconsistent subtotal and tax relationships', () => {
  const invalidSubtotal = createValidQuote();
  invalidSubtotal.subtotal.amountMinor = '599';
  invalidSubtotal.total.amountMinor = '599';
  assertContractError(() => parseQuote(invalidSubtotal), {
    code: 'subtotal_mismatch',
    path: '/subtotal',
  });

  const excessiveIncludedTax = createValidQuote();
  excessiveIncludedTax.taxAmount.amountMinor = '601';
  assertContractError(() => parseQuote(excessiveIncludedTax), {
    code: 'tax_exceeds_subtotal',
    path: '/taxAmount',
  });

  const invalidInclusiveTotal = createValidQuote();
  invalidInclusiveTotal.total.amountMinor = '634';
  assertContractError(() => parseQuote(invalidInclusiveTotal), {
    code: 'total_mismatch',
    path: '/total',
  });

  const invalidExclusiveTotal = createValidQuote();
  invalidExclusiveTotal.taxBehavior = 'exclusive';
  invalidExclusiveTotal.total.amountMinor = '600';
  assertContractError(() => parseQuote(invalidExclusiveTotal), {
    code: 'total_mismatch',
    path: '/total',
  });
});

test('rejects zero prices and arithmetic that exceeds the storage boundary', () => {
  const zeroPrice = createValidQuote();
  zeroPrice.unitPrice.amountMinor = '0';
  zeroPrice.subtotal.amountMinor = '0';
  zeroPrice.taxAmount.amountMinor = '0';
  zeroPrice.total.amountMinor = '0';
  assertContractError(() => parseQuote(zeroPrice), {
    code: 'non_positive_unit_price',
    path: '/unitPrice',
  });
  assertContractError(() => parseQuote(zeroPrice), {
    code: 'non_positive_total',
    path: '/total',
  });

  const subtotalOverflow = createValidQuote();
  subtotalOverflow.quantity = 2;
  subtotalOverflow.unitPrice.amountMinor = '9223372036854775807';
  subtotalOverflow.subtotal.amountMinor = '9223372036854775807';
  subtotalOverflow.taxAmount.amountMinor = '0';
  subtotalOverflow.total.amountMinor = '9223372036854775807';
  assertContractError(() => parseQuote(subtotalOverflow), {
    code: 'amount_overflow',
    path: '/subtotal',
  });

  const totalOverflow = createValidQuote();
  totalOverflow.quantity = 1;
  totalOverflow.unitPrice.amountMinor = '9223372036854775807';
  totalOverflow.subtotal.amountMinor = '9223372036854775807';
  totalOverflow.taxBehavior = 'exclusive';
  totalOverflow.taxAmount.amountMinor = '1';
  totalOverflow.total.amountMinor = '9223372036854775807';
  assertContractError(() => parseQuote(totalOverflow), {
    code: 'amount_overflow',
    path: '/total',
  });
});

test('rejects invalid validity windows, impossible dates and overflowing wire amounts', () => {
  const invalidWindow = createValidQuote();
  invalidWindow.expiresAt = invalidWindow.issuedAt;
  assertContractError(() => parseQuote(invalidWindow), {
    code: 'invalid_validity_window',
    path: '/expiresAt',
  });

  const impossibleDate = createValidQuote();
  impossibleDate.expiresAt = '2026-02-29T01:05:00.000Z';
  assertContractError(() => parseQuote(impossibleDate), {
    code: 'invalid_format',
    path: '/expiresAt',
  });

  const overflowingWireAmount = createValidQuote();
  overflowingWireAmount.total.amountMinor = '9223372036854775808';
  assertContractError(() => parseQuote(overflowingWireAmount), {
    code: 'out_of_range',
    path: '/total',
  });
});

test('does not echo rejected Quote input through validation errors', () => {
  const privateValue = 'PRIVATE_QUOTE_VALUE_THAT_MUST_NOT_APPEAR';
  const quote = createValidQuote();
  quote.quoteId = privateValue;

  assert.throws(
    () => parseQuote(quote),
    (error) => {
      assert.equal(error instanceof ContractValidationError, true);
      assert.equal(error.message.includes(privateValue), false);
      assert.equal(JSON.stringify(error.issues).includes(privateValue), false);
      return true;
    },
  );
});

test('exports a strict Draft 2020-12 JSON Schema', () => {
  const schema = getQuoteJsonSchema();

  assert.equal(QuoteWireSchema.safeParse(createValidQuote()).success, true);
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.proof.additionalProperties, false);
  assert.equal(schema.properties.unitPrice.additionalProperties, false);
  assert.equal(schema.properties.proof.properties.scheme.const, 'aipay-jcs-ed25519-v1');
  assert.equal(schema.properties.quantity.minimum, 1);
  assert.equal(schema.properties.quantity.maximum, 1_000_000);
  assert.deepEqual(schema.properties.taxBehavior.enum, ['inclusive', 'exclusive']);
  assert.deepEqual(schema.required, [
    'schemaVersion',
    'quoteId',
    'merchantId',
    'serviceId',
    'unit',
    'quantity',
    'unitPrice',
    'subtotal',
    'taxBehavior',
    'taxAmount',
    'total',
    'issuedAt',
    'expiresAt',
    'proof',
  ]);
});
