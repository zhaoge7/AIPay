import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { MerchantError, MerchantService, type MerchantUpdate } from './service.js';

const callbackUrlSchema = { type: 'string', minLength: 8, maxLength: 2_048 } as const;
const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'callbackUrl'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    callbackUrl: callbackUrlSchema,
  },
} as const;
const updateBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    callbackUrl: callbackUrlSchema,
    status: { type: 'string', enum: ['active', 'suspended'] },
  },
} as const;
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

interface CreateBody {
  readonly name: string;
  readonly callbackUrl: string;
}

interface MerchantParams {
  readonly merchantId: string;
}

function getDeveloperId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendMerchantError(reply: FastifyReply, traceId: string, error: MerchantError) {
  if (error.code === 'not_found') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  const pointer = error.code === 'invalid_callback_url' ? '/callbackUrl' : '/name';
  return sendProblem(
    reply,
    createApiProblem('INVALID_REQUEST', traceId, {
      errors: [{ code: error.code, pointer }],
    }),
  );
}

export function registerMerchantRoutes(app: FastifyInstance, database: Database): void {
  const service = new MerchantService(database);
  const requireDeveloper = createRequireDeveloper(database);

  app.post<{ Body: CreateBody }>(
    '/v1/merchants',
    { schema: { body: createBodySchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.create(
          getDeveloperId(request),
          request.body.name,
          request.body.callbackUrl,
        );
        return await reply.status(201).send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof MerchantError) {
          return sendMerchantError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.get('/v1/merchants', { preHandler: requireDeveloper }, async (request, reply) => {
    const result = await service.list(getDeveloperId(request));
    return reply.send(createApiSuccess(result, createTraceId()));
  });

  app.patch<{ Params: MerchantParams; Body: MerchantUpdate }>(
    '/v1/merchants/:merchantId',
    {
      schema: { params: paramsSchema, body: updateBodySchema },
      preHandler: requireDeveloper,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.update(
          getDeveloperId(request),
          parseResourceId(request.params.merchantId, 'mch'),
          request.body,
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof MerchantError) {
          return sendMerchantError(reply, traceId, error);
        }

        throw error;
      }
    },
  );
}
