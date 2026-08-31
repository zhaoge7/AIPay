import { PAYMENT_PROOF_HEADER } from '@aipay/sdk-ts';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import type { MerchantAdapterConfig } from './config.js';
import { MerchantAdapterError, MerchantAdapterService } from './service.js';

function errorStatus(error: MerchantAdapterError): number {
  switch (error.code) {
    case 'invalid_request':
      return 400;
    case 'invalid_payment_proof':
      return 401;
    case 'payment_state_conflict':
      return 409;
    case 'upstream_failed':
      return 502;
    case 'aipay_failed':
      return 503;
  }
}

export function createMerchantAdapterApp(
  config: MerchantAdapterConfig,
  service: MerchantAdapterService,
) {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024, trustProxy: ['127.0.0.1', '::1'] });
  const allowedHosts = new Set([
    new URL(config.publicOrigin).hostname,
    'localhost',
    '127.0.0.1',
    '::1',
  ]);
  void app.register(rateLimit, { max: 60, timeWindow: 60_000 });
  app.addHook('onRequest', (request, reply, done) => {
    if (!allowedHosts.has(request.hostname)) {
      reply.status(403).send({ code: 'INVALID_HOST' });
      return;
    }

    done();
  });
  app.addHook('onSend', (_request, reply, payload, done) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'private, no-store');
    done(null, payload);
  });
  app.get('/health', () => Object.freeze({ status: 'ok' }));
  app.get(config.resourcePath, async (request, reply) => {
    const rawUrl = request.raw.url;

    if (rawUrl === undefined) return reply.status(400).send({ code: 'INVALID_REQUEST' });
    const resourceUrl = new URL(rawUrl, `${config.publicOrigin}/`).toString();
    const proofHeader = request.headers[PAYMENT_PROOF_HEADER];

    try {
      const response = await service.handle(
        resourceUrl,
        typeof proofHeader === 'string' ? proofHeader : undefined,
      );

      for (const [name, value] of Object.entries(response.headers)) reply.header(name, value);
      return await reply.status(response.statusCode).send(response.body);
    } catch (error) {
      if (error instanceof MerchantAdapterError) {
        return reply.status(errorStatus(error)).send({ code: error.code.toUpperCase() });
      }
      return reply.status(500).send({ code: 'INTERNAL_ERROR' });
    }
  });
  return app;
}
