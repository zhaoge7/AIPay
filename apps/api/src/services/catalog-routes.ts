import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { createRequireAgentSignature } from '../agent-signatures/routes.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { ServiceCatalogService, ServiceError, type ServiceType } from './service.js';

const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', enum: ['api', 'mcp', 'skill'] },
    category: { type: 'string', pattern: '^[a-z][a-z0-9._-]{0,63}$' },
    merchantId: {
      type: 'string',
      pattern: '^mch_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
    cursor: {
      type: 'string',
      pattern: '^svc_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
    limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
  },
} as const;

interface CatalogQuerystring {
  readonly type?: ServiceType;
  readonly category?: string;
  readonly merchantId?: string;
  readonly cursor?: string;
  readonly limit?: string;
}

function sendCatalogError(reply: FastifyReply, traceId: string, error: ServiceError) {
  return sendProblem(
    reply,
    createApiProblem('INVALID_REQUEST', traceId, {
      errors: [{ code: error.code, pointer: '/query' }],
    }),
  );
}

export function registerCatalogRoutes(app: FastifyInstance, database: Database): void {
  const service = new ServiceCatalogService(database);
  const requireAgentSignature = createRequireAgentSignature(database);

  app.get<{ Querystring: CatalogQuerystring }>(
    '/v1/catalog/services',
    {
      config: { rawBody: true },
      schema: { querystring: querySchema },
      preHandler: requireAgentSignature,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.queryCatalog({
          ...(request.query.type === undefined ? {} : { type: request.query.type }),
          ...(request.query.category === undefined ? {} : { category: request.query.category }),
          ...(request.query.merchantId === undefined
            ? {}
            : { merchantId: parseResourceId(request.query.merchantId, 'mch') }),
          ...(request.query.cursor === undefined
            ? {}
            : { cursor: parseResourceId(request.query.cursor, 'svc') }),
          ...(request.query.limit === undefined ? {} : { limit: Number(request.query.limit) }),
        });
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof ServiceError) {
          return sendCatalogError(reply, traceId, error);
        }

        throw error;
      }
    },
  );
}
