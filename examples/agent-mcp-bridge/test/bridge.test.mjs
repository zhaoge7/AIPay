/* global Headers, Response */

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { URL } from 'node:url';

import {
  createPaymentRequirement,
  encodePaymentRequirement,
  PAYMENT_NEEDED_HEADER,
  PAYMENT_PROOF_HEADER,
  PaymentActionRequiredError,
} from '@aipay/sdk-ts';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import { AgentBridgeConfigurationError, loadAgentBridgeConfig } from '../dist/config.js';
import { createAgentBridgeApp, createAgentBridgeMcpServer } from '../dist/server.js';
import { AgentBridgeError, AgentBridgeService } from '../dist/service.js';
import { BridgeTokenError, BridgeTokenSigner } from '../dist/tokens.js';

const quote = JSON.parse(
  await readFile(
    new URL('../../../packages/contracts/test/fixtures/v1/quote.json', import.meta.url),
  ),
);
const paymentProof = JSON.parse(
  await readFile(
    new URL('../../../packages/contracts/test/fixtures/v1/payment-proof.json', import.meta.url),
  ),
);
const now = new Date('2026-08-28T09:01:00.000Z');
const privateKey = generateKeyPairSync('ed25519')
  .privateKey.export({
    format: 'der',
    type: 'pkcs8',
  })
  .toString('base64');
const validEnvironment = {
  AIPAY_BASE_URL: 'http://127.0.0.1:3101',
  AIPAY_AGENT_ID: 'agt_01890f3e-9b44-7cc2-98c5-7f6a1b2c3d4e',
  AIPAY_AGENT_KEY_ID: 'key_01890f3e-9b53-7cc2-88c5-7f6a1b2c3d4e',
  AIPAY_AGENT_PRIVATE_KEY: privateKey,
  AIPAY_MANDATE_ID: 'mdt_01890f3e-9b45-7cc2-a8c5-7f6a1b2c3d4e',
  AIPAY_RESOURCE_ORIGIN: 'https://merchant.example.cn',
  AIPAY_RESOURCE_PATHS: '/v1/paid/weather',
  AIPAY_RESOURCE_QUERY_KEYS: 'city,date',
  AIPAY_BRIDGE_BEARER_TOKEN: 'bridge-test-token-with-at-least-thirty-two-bytes',
};

function config() {
  return loadAgentBridgeConfig(validEnvironment);
}

function attempt(status = 'pending') {
  return Object.freeze({
    paymentAttemptId: paymentProof.paymentAttemptId,
    transactionId: paymentProof.transactionId,
    reservationId: 'rsv_01890f3e-9b86-7cc2-b8c5-7f6a1b2c3d4e',
    provider: 'alipay_web',
    providerReference: 'pilot-order',
    status,
    errorCode: status === 'failed' ? 'TRADE_CLOSED' : null,
    action:
      status === 'pending'
        ? { type: 'redirect', method: 'GET', url: 'https://sandbox.example/pay' }
        : null,
  });
}

class FakeAgent {
  status = 'pending';

  async acquirePaymentProof() {
    throw new PaymentActionRequiredError(attempt('pending'));
  }

  async queryPayment() {
    return attempt(this.status);
  }

  async issuePaymentProof() {
    return paymentProof;
  }
}

function harness() {
  const resourceUrl = 'https://merchant.example.cn/v1/paid/weather?city=Hangzhou';
  const requirement = createPaymentRequirement({ quote, resourceUrl });
  const calls = [];
  const resourceFetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });

    if (new Headers(init.headers).has(PAYMENT_PROOF_HEADER)) {
      return new Response(JSON.stringify({ city: 'Hangzhou', condition: 'clear' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ code: 'PAYMENT_NEEDED' }), {
      status: 402,
      headers: { [PAYMENT_NEEDED_HEADER]: encodePaymentRequirement(requirement) },
    });
  };
  const agent = new FakeAgent();
  const tokens = new BridgeTokenSigner(config().bearerToken, () => now);
  return {
    agent,
    calls,
    service: new AgentBridgeService(config(), agent, resourceFetch, tokens),
  };
}

test('validates bridge configuration without echoing key or token values', () => {
  assert.equal(config().allowedPaths[0], '/v1/paid/weather');
  assert.throws(
    () =>
      loadAgentBridgeConfig({
        ...validEnvironment,
        AIPAY_RESOURCE_ORIGIN: 'http://127.0.0.1:8080',
        AIPAY_AGENT_PRIVATE_KEY: 'must-not-be-echoed',
        AIPAY_BRIDGE_BEARER_TOKEN: 'short-secret',
      }),
    (error) => {
      assert.ok(error instanceof AgentBridgeConfigurationError);
      assert.ok(error.variables.includes('AIPAY_RESOURCE_ORIGIN'));
      assert.ok(error.variables.includes('AIPAY_AGENT_PRIVATE_KEY'));
      assert.ok(error.variables.includes('AIPAY_BRIDGE_BEARER_TOKEN'));
      assert.equal(error.message.includes('must-not-be-echoed'), false);
      return true;
    },
  );
});

test('binds action, resume, proof and delivery to one approved resource URL', async () => {
  const { agent, calls, service } = harness();
  const started = await service.start('/v1/paid/weather', { city: 'Hangzhou' });
  assert.equal(started.status, 'payment_action_required');
  assert.equal(started.action.url, 'https://sandbox.example/pay');

  const pending = await service.resume(started.resumeToken);
  assert.equal(pending.status, 'payment_pending');
  agent.status = 'succeeded';
  const ready = await service.resume(started.resumeToken);
  assert.equal(ready.status, 'delivery_ready');
  const delivered = await service.deliver(ready.deliveryToken);
  assert.deepEqual(delivered.result, { city: 'Hangzhou', condition: 'clear' });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://merchant.example.cn/v1/paid/weather?city=Hangzhou');
  assert.equal(new Headers(calls[1].init.headers).has(PAYMENT_PROOF_HEADER), true);

  await assert.rejects(
    service.deliver(`${ready.deliveryToken.slice(0, -1)}x`),
    (error) => error instanceof AgentBridgeError && error.code === 'invalid_token',
  );
  await assert.rejects(
    service.start('/admin', { city: 'Hangzhou' }),
    (error) => error instanceof AgentBridgeError && error.code === 'invalid_input',
  );
  await assert.rejects(
    service.start('/v1/paid/weather', { secret: 'value' }),
    (error) => error instanceof AgentBridgeError && error.code === 'invalid_input',
  );
});

test('expires and rejects modified bridge tokens', () => {
  const signer = new BridgeTokenSigner(config().bearerToken, () => now);
  const token = signer.issueResume(
    paymentProof.paymentAttemptId,
    paymentProof.transactionId,
    'https://merchant.example.cn/v1/paid/weather?city=Hangzhou',
  );
  assert.equal(signer.verifyResume(token).transactionId, paymentProof.transactionId);
  assert.throws(() => signer.verifyResume(`${token}x`), BridgeTokenError);
  const expired = new BridgeTokenSigner(
    config().bearerToken,
    () => new Date(now.getTime() + 16 * 60_000),
  );
  assert.throws(() => expired.verifyResume(token), BridgeTokenError);
});

test('exposes the three-step flow through MCP and protects the HTTP endpoint', async (context) => {
  const { service } = harness();
  const server = createAgentBridgeMcpServer(service);
  const client = new Client({ name: 'external-fastgpt-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  context.after(async () => {
    await client.close();
    await server.close();
  });
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map(({ name }) => name).sort(), [
    'aipay_deliver_paid_get',
    'aipay_resume_payment',
    'aipay_start_paid_get',
  ]);
  const result = await client.callTool({
    name: 'aipay_start_paid_get',
    arguments: { path: '/v1/paid/weather', query: { city: 'Hangzhou' } },
  });
  assert.equal(result.structuredContent.status, 'payment_action_required');

  const app = createAgentBridgeApp(config(), service);
  context.after(async () => app.close());
  assert.equal((await app.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/mcp', payload: {} })).statusCode, 401);
  assert.notEqual(
    (
      await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${config().bearerToken}` },
        payload: {},
      })
    ).statusCode,
    401,
  );
});
