/* global fetch */

import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { URL } from 'node:url';

const baseUrl = new URL(process.env.AIPAY_BASE_URL ?? 'http://127.0.0.1:3000');
const outputPath = new URL('../examples/.env.quickstart', import.meta.url);

async function request(path, options = {}) {
  const headers = {
    ...options.headers,
    ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  const response = await fetch(new URL(path, baseUrl), {
    method: options.method ?? 'POST',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const payload = await response.json();

  if (!response.ok || typeof payload !== 'object' || payload === null || !('data' in payload)) {
    const code =
      typeof payload === 'object' && payload !== null && 'code' in payload
        ? String(payload.code)
        : `HTTP_${response.status}`;
    throw new Error(`Quickstart setup failed: ${code}`);
  }

  return { data: payload.data, response };
}

const suffix = randomBytes(6).toString('hex');
const registration = await request('/v1/auth/register', {
  body: {
    email: `quickstart-${suffix}@example.test`,
    password: `${randomBytes(24).toString('base64url')}Aa1!`,
  },
});
const setCookie = registration.response.headers.get('set-cookie');

if (setCookie === null) {
  throw new Error('Quickstart setup failed: session cookie missing');
}

const sessionCookie = setCookie.split(';', 1)[0];
const apiKey = (
  await request('/v1/api-keys', {
    headers: { cookie: sessionCookie },
    body: { name: 'Quickstart merchant SDK', expiresInDays: 1 },
  })
).data;
const authorization = { authorization: `Bearer ${apiKey.token}` };
const agentKeys = generateKeyPairSync('ed25519');
const agent = (
  await request('/v1/agents', {
    headers: authorization,
    body: {
      name: 'Quickstart external Agent',
      publicKey: agentKeys.publicKey
        .export({ format: 'der', type: 'spki' })
        .subarray(-32)
        .toString('base64url'),
    },
  })
).data;
const merchant = (
  await request('/v1/merchants', {
    headers: authorization,
    body: {
      name: 'Quickstart paid service',
      callbackUrl: 'http://127.0.0.1:3199/webhook',
    },
  })
).data;
const service = (
  await request(`/v1/merchants/${merchant.merchantId}/services`, {
    headers: authorization,
    body: {
      type: 'api',
      name: 'Quickstart paid weather',
      category: 'data.weather',
      unit: 'request',
      unitPrice: { currency: 'CNY', amountMinor: '1' },
      refundPolicy: 'full_on_delivery_failure',
    },
  })
).data;
const merchantKeys = generateKeyPairSync('ed25519');
const merchantKey = (
  await request(`/v1/merchants/${merchant.merchantId}/signing-key`, {
    headers: authorization,
    body: {
      publicKey: merchantKeys.publicKey
        .export({ format: 'der', type: 'spki' })
        .subarray(-32)
        .toString('base64url'),
    },
  })
).data;
const mandateDraft = (
  await request('/v1/mandates', {
    headers: authorization,
    body: {
      agentId: agent.agentId,
      purpose: 'Quickstart paid API and MCP calls',
      allowedMerchantIds: [merchant.merchantId],
      allowedCategories: ['data.weather'],
      maxPerTransaction: { currency: 'CNY', amountMinor: '100' },
      totalBudget: { currency: 'CNY', amountMinor: '1000' },
      approvalRequiredAbove: { currency: 'CNY', amountMinor: '100' },
      maxTransactions: 10,
      validUntil: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
      instructionHash: `sha256:${createHash('sha256').update('quickstart paid calls').digest('hex')}`,
    },
  })
).data;
const mandate = (
  await request(`/v1/mandates/${mandateDraft.mandateId}/issue`, {
    headers: authorization,
  })
).data;
const environment = [
  `AIPAY_BASE_URL=${baseUrl.toString()}`,
  `AIPAY_MERCHANT_API_KEY=${apiKey.token}`,
  `AIPAY_MERCHANT_ID=${merchant.merchantId}`,
  `AIPAY_MERCHANT_KEY_ID=${merchantKey.keyId}`,
  `AIPAY_MERCHANT_PRIVATE_KEY=${merchantKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}`,
  `AIPAY_SERVICE_ID=${service.serviceId}`,
  `AIPAY_AGENT_ID=${agent.agentId}`,
  `AIPAY_AGENT_KEY_ID=${agent.signingKey.keyId}`,
  `AIPAY_AGENT_PRIVATE_KEY=${agentKeys.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')}`,
  `AIPAY_MANDATE_ID=${mandate.mandateId}`,
  '',
].join('\n');

await writeFile(outputPath, environment, { encoding: 'utf8', mode: 0o600 });
process.stdout.write('Quickstart environment created at examples/.env.quickstart\n');
