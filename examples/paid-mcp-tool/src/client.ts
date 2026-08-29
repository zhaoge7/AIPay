import process from 'node:process';

import {
  AgentClient,
  decodePaymentRequirement,
  encodePaymentProof,
  type ResourceId,
} from '@aipay/sdk-ts';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { aipayBaseUrl, required } from './config.js';

const agent = new AgentClient({
  baseUrl: aipayBaseUrl(),
  agentId: required('AIPAY_AGENT_ID') as ResourceId<'agt'>,
  keyId: required('AIPAY_AGENT_KEY_ID') as ResourceId<'key'>,
  privateKeyPkcs8Base64: required('AIPAY_AGENT_PRIVATE_KEY'),
});
const mandateId = required('AIPAY_MANDATE_ID') as ResourceId<'mdt'>;
const client = new Client({ name: 'aipay-paid-agent', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('server.js', import.meta.url).pathname],
  env: process.env as Record<string, string>,
});

await client.connect(transport);

try {
  const tools = await client.listTools();

  if (!tools.tools.some((tool) => tool.name === 'paid_weather')) {
    throw new Error('paid_weather tool was not discovered');
  }

  const first = await client.callTool({ name: 'paid_weather', arguments: { city: 'Hangzhou' } });
  const structured = first.structuredContent as Record<string, unknown> | undefined;

  if (typeof structured?.paymentNeeded !== 'string') {
    throw new Error('MCP tool did not return a payment requirement');
  }

  const requirement = decodePaymentRequirement(structured.paymentNeeded);
  const proof = await agent.acquirePaymentProof(requirement, { mandateId });
  const delivered = await client.callTool({
    name: 'paid_weather',
    arguments: { city: 'Hangzhou', paymentProof: encodePaymentProof(proof) },
  });
  process.stdout.write(`${JSON.stringify(delivered.structuredContent)}\n`);
} finally {
  await client.close();
}
