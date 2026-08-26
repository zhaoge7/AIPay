import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { ApiKeyError, ApiKeyService } from './service.js';

const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    expiresInDays: { type: 'integer', minimum: 1, maximum: 365 },
  },
} as const;

const rotateBodySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    expiresInDays: { type: 'integer', minimum: 1, maximum: 365 },
  },
} as const;

const paramsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['apiKeyId'],
  properties: {
    apiKeyId: {
      type: 'string',
      pattern: '^apk_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
  },
} as const;

interface CreateBody {
  readonly name: string;
  readonly expiresInDays?: number;
}

interface RotateBody {
  readonly expiresInDays?: number;
}

interface ApiKeyParams {
  readonly apiKeyId: string;
}

function getDeveloperId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendApiKeyError(reply: FastifyReply, traceId: string, error: ApiKeyError) {
  if (error.code === 'not_found') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  const pointer = error.code === 'invalid_expiry' ? '/expiresInDays' : '/name';
  return sendProblem(
    reply,
    createApiProblem('INVALID_REQUEST', traceId, {
      errors: [{ code: error.code, pointer }],
    }),
  );
}

export function registerApiKeyRoutes(app: FastifyInstance, database: Database): void {
  const service = new ApiKeyService(database);
  const requireDeveloper = createRequireDeveloper(database);

  app.post<{ Body: CreateBody }>(
    '/v1/api-keys',
    { schema: { body: createBodySchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.create(
          getDeveloperId(request),
          request.body.name,
          request.body.expiresInDays,
        );
        return await reply.status(201).send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof ApiKeyError) {
          return sendApiKeyError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.get('/v1/api-keys', { preHandler: requireDeveloper }, async (request, reply) => {
    const result = await service.list(getDeveloperId(request));
    return reply.send(createApiSuccess(result, createTraceId()));
  });

  app.delete<{ Params: ApiKeyParams }>(
    '/v1/api-keys/:apiKeyId',
    { schema: { params: paramsSchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.revoke(
          getDeveloperId(request),
          parseResourceId(request.params.apiKeyId, 'apk'),
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof ApiKeyError) {
          return sendApiKeyError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.post<{ Params: ApiKeyParams; Body: RotateBody }>(
    '/v1/api-keys/:apiKeyId/rotate',
    {
      schema: { params: paramsSchema, body: rotateBodySchema },
      preHandler: requireDeveloper,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.rotate(
          getDeveloperId(request),
          parseResourceId(request.params.apiKeyId, 'apk'),
          request.body.expiresInDays,
        );
        return await reply.status(201).send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof ApiKeyError) {
          return sendApiKeyError(reply, traceId, error);
        }

        throw error;
      }
    },
  );
}
