/* global Headers, Request, Response */

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync } from 'node:crypto';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

import { createDatabase } from '@aipay/database';
import { FakePaymentProvider } from '@aipay/payment';
import {
  AgentClient,
  MerchantClient,
  PAYMENT_NEEDED_HEADER,
  PAYMENT_PROOF_HEADER,
  decodePaymentProof,
  decodePaymentRequirement,
  encodePaymentProof,
} from '@aipay/sdk-ts';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { v7 as uuidv7 } from 'uuid';

import { buildApp } from '../dist/app.js';
import { MandateIssuer } from '../dist/mandates/issuer.js';
import { PaymentProofIssuer } from '../dist/payments/proofs.js';
import { runMigrations } from '../../../packages/database/scripts/migration-runner.mjs';
import {
  removePostgresContainer,
  startPostgresContainer,
} from '../../../packages/database/scripts/postgres-container.mjs';

const discardLog = () => undefined;

function body(response) {
  return JSON.parse(response.body);
}

function cookie(response) {
  const value = response.headers['set-cookie'];
  assert.equal(typeof value, 'string');
  return value.split(';', 1)[0];
}

async function injectJson(app, method, url, options = {}) {
  const response = await app.inject({
    method,
    url,
    headers: {
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.bearer === undefined ? {} : { authorization: `Bearer ${options.bearer}` }),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload }),
  });
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, response.body);
  return body(response).data;
}

function appFetch(app) {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const requestBody = Buffer.from(await request.arrayBuffer());
    const headers = Object.fromEntries(request.headers.entries());
    headers.host = url.host;
    const response = await app.inject({
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers,
      ...(requestBody.length === 0 ? {} : { payload: requestBody }),
    });
    const responseHeaders = new Headers();

    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) {
        responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : String(value));
      }
    }

    return new Response(response.body, { status: response.statusCode, headers: responseHeaders });
  };
}

test('passes Gate P8 with public SDKs and an independent paid HTTP resource', async (context) => {
  const container = {
    name: `aipay-gate-p8-${process.pid}`,
    database: 'aipay_gate_p8_test',
    user: 'aipay',
    password: 'gate-p8-only',
  };
  let app;
  let database;
  context.after(async () => {
    await app?.close();
    await database?.destroy();
    removePostgresContainer(container.name);
  });

  const { databaseUrl } = await startPostgresContainer(container);
  await runMigrations(databaseUrl, discardLog);
  database = createDatabase(databaseUrl, { maxConnections: 10 });
  const issuerPair = generateKeyPairSync('ed25519');
  const issuerOptions = {
    keyId: `key_${uuidv7()}`,
    privateKeyPkcs8Base64: issuerPair.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
  };
  const provider = new FakePaymentProvider({ webhookSecret: 'gate-p8-provider-secret' });
  provider.enqueuePaymentOutcome('succeeded');
  app = await buildApp({
    database,
    mandateIssuer: new MandateIssuer(database, issuerOptions),
    paymentProofIssuer: new PaymentProofIssuer(database, issuerOptions),
    paymentProvider: provider,
    paymentCallbackUrl: 'http://127.0.0.1/v1/payments/fake/webhook',
  });

  const registration = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {
      email: 'gate-p8@example.com',
      password: 'Correct horse battery staple 2026!',
    },
  });
  assert.equal(registration.statusCode, 201, registration.body);
  const session = cookie(registration);
  const apiKey = await injectJson(app, 'POST', '/v1/api-keys', {
    cookie: session,
    payload: { name: 'Gate P8 merchant SDK' },
  });
  const agentKeys = generateKeyPairSync('ed25519');
  const agent = await injectJson(app, 'POST', '/v1/agents', {
    bearer: apiKey.token,
    payload: {
      name: 'External Gate P8 Agent',
      publicKey: agentKeys.publicKey
        .export({ format: 'der', type: 'spki' })
        .subarray(-32)
        .toString('base64url'),
    },
  });
  const merchant = await injectJson(app, 'POST', '/v1/merchants', {
    bearer: apiKey.token,
    payload: {
      name: 'External Gate P8 Merchant',
      callbackUrl: 'https://merchant-gate-p8.example/webhook',
    },
  });
  const service = await injectJson(app, 'POST', `/v1/merchants/${merchant.merchantId}/services`, {
    bearer: apiKey.token,
    payload: {
      type: 'api',
      name: 'Paid weather',
      category: 'data.weather',
      unit: 'request',
      unitPrice: { currency: 'CNY', amountMinor: '10' },
      refundPolicy: 'full_on_delivery_failure',
    },
  });
  const merchantKeys = generateKeyPairSync('ed25519');
  const merchantKey = await injectJson(
    app,
    'POST',
    `/v1/merchants/${merchant.merchantId}/signing-key`,
    {
      bearer: apiKey.token,
      payload: {
        publicKey: merchantKeys.publicKey
          .export({ format: 'der', type: 'spki' })
          .subarray(-32)
          .toString('base64url'),
      },
    },
  );
  const mandateDraft = await injectJson(app, 'POST', '/v1/mandates', {
    bearer: apiKey.token,
    payload: {
      agentId: agent.agentId,
      purpose: 'Buy paid weather data',
      allowedMerchantIds: [merchant.merchantId],
      allowedCategories: ['data.weather'],
      maxPerTransaction: { currency: 'CNY', amountMinor: '100' },
      totalBudget: { currency: 'CNY', amountMinor: '1000' },
      approvalRequiredAbove: { currency: 'CNY', amountMinor: '100' },
      maxTransactions: 10,
      validUntil: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
      instructionHash: `sha256:${createHash('sha256').update('buy weather').digest('hex')}`,
    },
  });
  const mandate = await injectJson(app, 'POST', `/v1/mandates/${mandateDraft.mandateId}/issue`, {
    bearer: apiKey.token,
  });
  const apiFetch = appFetch(app);
  const merchantClient = new MerchantClient({
    baseUrl: 'http://127.0.0.1',
    apiKey: apiKey.token,
    merchantId: merchant.merchantId,
    keyId: merchantKey.keyId,
    privateKeyPkcs8Base64: merchantKeys.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    fetch: apiFetch,
  });
  const delivered = new Map();
  const paidResource = async (request) => {
    const proofHeader = request.headers.get(PAYMENT_PROOF_HEADER);

    if (proofHeader === null) {
      const payment = await merchantClient.createPaymentRequirement({
        serviceId: service.serviceId,
        resourceUrl: request.url,
      });
      return Response.json(
        { code: 'PAYMENT_NEEDED', quoteId: payment.requirement.quote.quoteId },
        { status: 402, headers: { [PAYMENT_NEEDED_HEADER]: payment.headerValue } },
      );
    }

    const proof = decodePaymentProof(proofHeader);
    const previous = delivered.get(proof.paymentProofId);

    if (previous !== undefined) {
      return Response.json(previous);
    }

    const consumed = await merchantClient.consumePaymentProof(proof);
    const result = { city: 'Hangzhou', condition: 'clear', temperatureCelsius: 27 };
    await merchantClient.submitDeliveryReceipt({
      deliveryId: consumed.deliveryId,
      paymentProof: proof,
      status: 'succeeded',
      result: JSON.stringify(result),
    });
    delivered.set(proof.paymentProofId, result);
    return Response.json(result);
  };
  const clientFetch = async (input, init) => {
    const request = new Request(input, init);
    return request.url.startsWith('https://merchant.example/')
      ? paidResource(request)
      : apiFetch(request);
  };
  const agentClient = new AgentClient({
    baseUrl: 'http://127.0.0.1',
    agentId: agent.agentId,
    keyId: agent.signingKey.keyId,
    privateKeyPkcs8Base64: agentKeys.privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    fetch: clientFetch,
  });

  const catalog = await agentClient.discoverServices({ type: 'api' });
  assert.equal(
    catalog.items.some((item) => item.serviceId === service.serviceId),
    true,
  );
  const response = await agentClient.callPaid(
    'https://merchant.example/paid/weather',
    { method: 'GET' },
    { mandateId: mandate.mandateId, pollIntervalMs: 0 },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    city: 'Hangzhou',
    condition: 'clear',
    temperatureCelsius: 27,
  });

  const transaction = await database
    .selectFrom('transactions')
    .innerJoin('paymentAttempts', 'paymentAttempts.transactionId', 'transactions.id')
    .innerJoin('budgetReservations', 'budgetReservations.id', 'paymentAttempts.reservationId')
    .innerJoin('paymentProofs', 'paymentProofs.transactionId', 'transactions.id')
    .innerJoin('deliveries', 'deliveries.transactionId', 'transactions.id')
    .select([
      'transactions.status',
      'paymentAttempts.status as paymentStatus',
      'budgetReservations.status as reservationStatus',
      'paymentProofs.status as proofStatus',
      'deliveries.status as deliveryStatus',
    ])
    .executeTakeFirstOrThrow();
  assert.deepEqual(transaction, {
    status: 'delivered',
    paymentStatus: 'succeeded',
    reservationStatus: 'confirmed',
    proofStatus: 'consumed',
    deliveryStatus: 'succeeded',
  });

  const apiBaseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  provider.enqueuePaymentOutcome('succeeded');
  const mcpClient = new Client({ name: 'gate-p8-agent', version: '0.1.0' });
  const mcpTransport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL('../../../examples/paid-mcp-tool/dist/server.js', import.meta.url)),
    ],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry) => typeof entry[1] === 'string'),
      ),
      AIPAY_BASE_URL: apiBaseUrl,
      AIPAY_MERCHANT_API_KEY: apiKey.token,
      AIPAY_MERCHANT_ID: merchant.merchantId,
      AIPAY_MERCHANT_KEY_ID: merchantKey.keyId,
      AIPAY_MERCHANT_PRIVATE_KEY: merchantKeys.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      AIPAY_SERVICE_ID: service.serviceId,
    },
  });
  await mcpClient.connect(mcpTransport);

  try {
    const tools = await mcpClient.listTools();
    assert.equal(
      tools.tools.some((tool) => tool.name === 'paid_weather'),
      true,
    );
    const firstCall = await mcpClient.callTool({
      name: 'paid_weather',
      arguments: { city: 'Hangzhou' },
    });
    assert.equal(firstCall.structuredContent?.status, 'payment_required');
    assert.equal(typeof firstCall.structuredContent?.paymentNeeded, 'string');
    const requirement = decodePaymentRequirement(firstCall.structuredContent.paymentNeeded);
    const networkAgent = new AgentClient({
      baseUrl: apiBaseUrl,
      agentId: agent.agentId,
      keyId: agent.signingKey.keyId,
      privateKeyPkcs8Base64: agentKeys.privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
    });
    const proof = await networkAgent.acquirePaymentProof(requirement, {
      mandateId: mandate.mandateId,
      pollIntervalMs: 0,
    });
    const secondCall = await mcpClient.callTool({
      name: 'paid_weather',
      arguments: { city: 'Hangzhou', paymentProof: encodePaymentProof(proof) },
    });
    assert.deepEqual(secondCall.structuredContent, {
      status: 'delivered',
      city: 'Hangzhou',
      condition: 'clear',
      temperatureCelsius: 27,
    });
  } finally {
    await mcpClient.close();
  }

  const counts = await database
    .selectFrom('transactions')
    .select((expression) => expression.fn.countAll().as('count'))
    .where('status', '=', 'delivered')
    .executeTakeFirstOrThrow();
  assert.equal(Number(counts.count), 2);
});
