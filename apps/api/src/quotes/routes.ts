import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { QuoteDraftError, QuoteDraftService, type CreateQuoteDraftInput } from './drafts.js';

const paramsSchema = {
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
const bodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['serviceId', 'quantity', 'taxBehavior', 'taxAmount', 'expiresInSeconds'],
  properties: {
    serviceId: {
      type: 'string',
      pattern: '^svc_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
    quantity: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    taxBehavior: { type: 'string', enum: ['inclusive', 'exclusive'] },
    taxAmount: {
      type: 'object',
      additionalProperties: false,
      required: ['currency', 'amountMinor'],
      properties: {
        currency: { type: 'string', const: 'CNY' },
        amountMinor: { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$' },
      },
    },
    expiresInSeconds: { type: 'integer', minimum: 30, maximum: 900 },
  },
} as const;

interface Params {
  readonly merchantId: string;
}

function developerId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendQuoteError(reply: FastifyReply, traceId: string, error: QuoteDraftError) {
  if (error.code === 'not_found' || error.code === 'service_unavailable') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  return sendProblem(
    reply,
    createApiProblem('INVALID_REQUEST', traceId, {
      errors: [{ code: error.code, pointer: '/' }],
    }),
  );
}

export function registerQuoteRoutes(app: FastifyInstance, database: Database): void {
  const service = new QuoteDraftService(database);
  const requireDeveloper = createRequireDeveloper(database);

  app.post<{ Params: Params; Body: CreateQuoteDraftInput }>(
    '/v1/merchants/:merchantId/quotes',
    { schema: { params: paramsSchema, body: bodySchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.create(
          developerId(request),
          parseResourceId(request.params.merchantId, 'mch'),
          request.body,
        );
        return await reply.status(201).send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof QuoteDraftError) {
          return sendQuoteError(reply, traceId, error);
        }

        throw error;
      }
    },
  );
}
