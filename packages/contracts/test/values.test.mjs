import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMoney,
  currencyMetadata,
  formatUtcDateTime,
  getResourceUuid,
  isExpired,
  MAX_MINOR_AMOUNT,
  minorAmountFromBigInt,
  minorAmountToBigInt,
  parseCurrencyCode,
  parseMinorAmount,
  parseResourceId,
  parseUtcDateTime,
  resourcePrefixes,
  utcDateTimeToDate,
  ValueValidationError,
} from '../dist/index.js';

function assertValueError(callback, expectedCode) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof ValueValidationError, true);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

test('accepts canonical prefixed UUIDv7 resource identifiers', () => {
  const uuid = '01890f3e-9b4a-7cc2-98c5-7f6a1b2c3d4e';
  const id = parseResourceId(`mdt_${uuid}`, 'mdt');

  assert.equal(id, `mdt_${uuid}`);
  assert.equal(getResourceUuid(id), uuid);
  assert.equal(resourcePrefixes.includes('txn'), true);
});

test('rejects wrong prefixes, UUID versions, variants and casing without echoing input', () => {
  const privateInput = 'PRIVATE_INPUT_THAT_MUST_NOT_APPEAR';
  const invalidIds = [
    'txn_01890f3e-9b4a-7cc2-98c5-7f6a1b2c3d4e',
    'mdt_01890f3e-9b4a-4cc2-98c5-7f6a1b2c3d4e',
    'mdt_01890f3e-9b4a-7cc2-78c5-7f6a1b2c3d4e',
    'mdt_01890F3E-9B4A-7CC2-98C5-7F6A1B2C3D4E',
    privateInput,
  ];

  for (const invalidId of invalidIds) {
    assert.throws(
      () => parseResourceId(invalidId, 'mdt'),
      (error) => {
        assert.equal(error instanceof ValueValidationError, true);
        assert.equal(error.code, 'invalid_resource_id');
        assert.equal(error.message.includes(privateInput), false);
        return true;
      },
    );
  }

  assertValueError(() => parseResourceId('bad_value', 'bad'), 'invalid_resource_prefix');
});

test('creates immutable CNY money using canonical minor-unit strings', () => {
  const money = createMoney('CNY', '123');

  assert.deepEqual(money, { currency: 'CNY', amountMinor: '123' });
  assert.equal(Object.isFrozen(money), true);
  assert.equal(currencyMetadata.CNY.minorUnit, 2);
  assert.equal(minorAmountToBigInt(money.amountMinor), 123n);
  assert.equal(minorAmountFromBigInt(MAX_MINOR_AMOUNT), MAX_MINOR_AMOUNT.toString());
  assert.equal(parseCurrencyCode('CNY'), 'CNY');
});

test('rejects ambiguous, negative, non-string and out-of-range amounts', () => {
  for (const value of [
    '01',
    '-1',
    '+1',
    '1.00',
    ' 1',
    '',
    '9'.repeat(10_000),
    MAX_MINOR_AMOUNT + 1n,
    1,
  ]) {
    assertValueError(() => parseMinorAmount(value), 'invalid_minor_amount');
  }

  assertValueError(() => minorAmountFromBigInt(-1n), 'invalid_minor_amount');
  assertValueError(() => minorAmountFromBigInt(MAX_MINOR_AMOUNT + 1n), 'invalid_minor_amount');
  assertValueError(() => parseCurrencyCode('cny'), 'unsupported_currency');
  assertValueError(() => parseCurrencyCode('USD'), 'unsupported_currency');
});

test('parses and formats canonical UTC timestamps with millisecond precision', () => {
  const value = parseUtcDateTime('2026-08-26T12:34:56.789Z');

  assert.equal(formatUtcDateTime(new Date('2026-08-26T12:34:56.789Z')), value);
  assert.equal(utcDateTimeToDate(value).toISOString(), value);
});

test('rejects offsets, missing milliseconds and impossible UTC timestamps', () => {
  const invalidValues = [
    '2026-08-26T20:34:56.789+08:00',
    '2026-08-26T12:34:56Z',
    '2026-02-29T12:34:56.789Z',
    '0000-01-01T00:00:00.000Z',
    '2026-08-26T12:34:56.789z',
  ];

  for (const value of invalidValues) {
    assertValueError(() => parseUtcDateTime(value), 'invalid_utc_datetime');
  }

  assertValueError(() => formatUtcDateTime(new Date(Number.NaN)), 'invalid_utc_datetime');
  assertValueError(
    () => formatUtcDateTime(new Date('+010000-01-01T00:00:00.000Z')),
    'invalid_utc_datetime',
  );
});

test('treats equality as expired and requires the caller to provide now', () => {
  const expiresAt = parseUtcDateTime('2026-08-26T12:00:00.000Z');
  const before = parseUtcDateTime('2026-08-26T11:59:59.999Z');
  const equal = parseUtcDateTime('2026-08-26T12:00:00.000Z');
  const after = parseUtcDateTime('2026-08-26T12:00:00.001Z');

  assert.equal(isExpired(expiresAt, before), false);
  assert.equal(isExpired(expiresAt, equal), true);
  assert.equal(isExpired(expiresAt, after), true);
});
