import process from 'node:process';

import { AgentClient, type ResourceId } from '@aipay/sdk-ts';

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const client = new AgentClient({
  baseUrl: required('AIPAY_BASE_URL'),
  agentId: required('AIPAY_AGENT_ID') as ResourceId<'agt'>,
  keyId: required('AIPAY_AGENT_KEY_ID') as ResourceId<'key'>,
  privateKeyPkcs8Base64: required('AIPAY_AGENT_PRIVATE_KEY'),
});
const response = await client.callPaid(
  process.env.PAID_HTTP_URL ?? 'http://127.0.0.1:3100/paid/weather',
  { method: 'GET' },
  { mandateId: required('AIPAY_MANDATE_ID') as ResourceId<'mdt'> },
);

if (!response.ok) {
  throw new Error(`Paid HTTP call failed with status ${String(response.status)}`);
}

process.stdout.write(`${await response.text()}\n`);
