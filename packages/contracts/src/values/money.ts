import { ValueValidationError } from './validation-error.js';

export const currencyMetadata = Object.freeze({
  CNY: Object.freeze({ minorUnit: 2 }),
});

export type CurrencyCode = keyof typeof currencyMetadata;

declare const minorAmountBrand: unique symbol;

export type MinorAmount = string & {
  readonly [minorAmountBrand]: true;
};

export interface Money {
  readonly currency: CurrencyCode;
  readonly amountMinor: MinorAmount;
}

export const MAX_MINOR_AMOUNT = 9_223_372_036_854_775_807n;

const canonicalMinorAmount = /^(0|[1-9][0-9]*)$/;
const maxMinorAmountDigits = MAX_MINOR_AMOUNT.toString().length;

export function parseCurrencyCode(value: unknown): CurrencyCode {
  if (typeof value !== 'string' || !Object.hasOwn(currencyMetadata, value)) {
    throw new ValueValidationError('unsupported_currency');
  }

  return value as CurrencyCode;
}

export function parseMinorAmount(value: unknown): MinorAmount {
  if (
    typeof value !== 'string' ||
    value.length > maxMinorAmountDigits ||
    !canonicalMinorAmount.test(value)
  ) {
    throw new ValueValidationError('invalid_minor_amount');
  }

  const amount = BigInt(value);

  if (amount > MAX_MINOR_AMOUNT) {
    throw new ValueValidationError('invalid_minor_amount');
  }

  return value as MinorAmount;
}

export function minorAmountToBigInt(value: MinorAmount): bigint {
  return BigInt(value);
}

export function minorAmountFromBigInt(value: bigint): MinorAmount {
  if (value < 0n || value > MAX_MINOR_AMOUNT) {
    throw new ValueValidationError('invalid_minor_amount');
  }

  return value.toString() as MinorAmount;
}

export function createMoney(currency: unknown, amountMinor: unknown): Readonly<Money> {
  return Object.freeze({
    currency: parseCurrencyCode(currency),
    amountMinor: parseMinorAmount(amountMinor),
  });
}
