import process from 'node:process';

import type { ResourceId } from '@aipay/sdk-ts';

export function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export const aipayBaseUrl = () => required('AIPAY_BASE_URL');
export const serviceId = () => required('AIPAY_SERVICE_ID') as ResourceId<'svc'>;
