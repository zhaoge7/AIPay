import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { QuoteSigningError, QuoteSigningService } from './signing.js';

const merchantParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['merchantId'],
  properties: {
    merchantId: {
      type: 'string',
      pattern: '^mch_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
  },
} as const;
const quoteParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['quoteId'],
  properties: {
    quoteId: {
      type: 'string',
      pattern: '^qte_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
  },
} as const;
const keyBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['publicKey'],
  properties: { publicKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
} as const;
const activationBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['keyId', 'signature'],
  properties: {
    keyId: {
      type: 'string',
      pattern: '^key_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
    signature: { type: 'string', pattern: '^[A-Za-z0-9_-]{85}[AQgw]$' },
  },
} as const;

interface MerchantParams {
  readonly merchantId: string;
}

interface QuoteParams {
  readonly quoteId: string;
}

interface KeyBody {
  readonly publicKey: string;
}

interface ActivationBody {
  readonly keyId: string;
  readonly signature: string;
}

function developerId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendSigningError(reply: FastifyReply, traceId: string, error: QuoteSigningError) {
  if (error.code === 'not_found') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  if (error.code === 'expired') {
    return sendProblem(reply, createApiProblem('QUOTE_EXPIRED', traceId));
  }

  if (error.code === 'invalid_state') {
    return sendProblem(reply, createApiProblem('TRANSACTION_STATE_CONFLICT', traceId));
  }

  if (error.code === 'invalid_signature') {
    return sendProblem(reply, createApiProblem('SIGNATURE_INVALID', traceId));
  }

  return sendProblem(
    reply,
    createApiProblem('INVALID_REQUEST', traceId, {
      errors: [{ code: error.code, pointer: '/' }],
    }),
  );
}

export function registerQuoteSigningRoutes(app: FastifyInstance, database: Database): void {
  const service = new QuoteSigningService(database);
  const requireDeveloper = createRequireDeveloper(database);

  app.post<{ Params: MerchantParams; Body: KeyBody }>(
    '/v1/merchants/:merchantId/signing-key',
    { schema: { params: merchantParamsSchema, body: keyBodySchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.registerMerchantKey(
          developerId(request),
          parseResourceId(request.params.merchantId, 'mch'),
          request.body.publicKey,
        );
        return await reply.status(201).send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof QuoteSigningError) {
          return sendSigningError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.post<{ Params: QuoteParams; Body: ActivationBody }>(
    '/v1/quotes/:quoteId/activate',
    {
      schema: { params: quoteParamsSchema, body: activationBodySchema },
      preHandler: requireDeveloper,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.activate(
          developerId(request),
          parseResourceId(request.params.quoteId, 'qte'),
          parseResourceId(request.body.keyId, 'key'),
          request.body.signature,
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof QuoteSigningError) {
          return sendSigningError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.post<{ Body: unknown }>('/v1/quotes/verify', async (request, reply) => {
    const traceId = createTraceId();

    try {
      const quote = await service.verify(request.body);
      return await reply.send(
        createApiSuccess(
          { valid: true, quoteId: quote.quoteId, keyId: quote.proof.keyId },
          traceId,
        ),
      );
    } catch (error) {
      if (error instanceof QuoteSigningError) {
        return sendSigningError(reply, traceId, error);
      }

      throw error;
    }
  });
}
