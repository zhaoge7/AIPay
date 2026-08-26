import process from 'node:process';
import { URL } from 'node:url';

export function loadDatabaseUrl(environment = process.env) {
  const value = environment.AIPAY_DATABASE_URL;

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('AIPAY_DATABASE_URL is required');
  }

  const parsed = new URL(value);

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('AIPAY_DATABASE_URL must use PostgreSQL');
  }

  return value;
}
