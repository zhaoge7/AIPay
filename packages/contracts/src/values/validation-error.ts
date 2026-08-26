export type ValueValidationErrorCode =
  | 'invalid_resource_prefix'
  | 'invalid_resource_id'
  | 'unsupported_currency'
  | 'invalid_minor_amount'
  | 'invalid_utc_datetime';

const errorMessages: Readonly<Record<ValueValidationErrorCode, string>> = Object.freeze({
  invalid_resource_prefix: 'Unsupported resource prefix',
  invalid_resource_id: 'Invalid resource identifier',
  unsupported_currency: 'Unsupported currency code',
  invalid_minor_amount: 'Invalid minor-unit amount',
  invalid_utc_datetime: 'Invalid UTC date-time',
});

export class ValueValidationError extends Error {
  readonly code: ValueValidationErrorCode;

  constructor(code: ValueValidationErrorCode) {
    super(errorMessages[code]);
    this.name = 'ValueValidationError';
    this.code = code;
  }
}
