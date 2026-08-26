import { ValueValidationError } from './validation-error.js';

declare const utcDateTimeBrand: unique symbol;

export type UtcDateTime = string & {
  readonly [utcDateTimeBrand]: true;
};

const canonicalUtcDateTime = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;

export function parseUtcDateTime(value: unknown): UtcDateTime {
  if (typeof value !== 'string' || value.startsWith('0000-') || !canonicalUtcDateTime.test(value)) {
    throw new ValueValidationError('invalid_utc_datetime');
  }

  const parsed = new Date(value);

  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ValueValidationError('invalid_utc_datetime');
  }

  return value as UtcDateTime;
}

export function formatUtcDateTime(value: Date): UtcDateTime {
  if (!Number.isFinite(value.getTime())) {
    throw new ValueValidationError('invalid_utc_datetime');
  }

  return parseUtcDateTime(value.toISOString());
}

export function utcDateTimeToDate(value: UtcDateTime): Date {
  return new Date(value);
}

export function isExpired(expiresAt: UtcDateTime, now: UtcDateTime): boolean {
  return Date.parse(now) >= Date.parse(expiresAt);
}
