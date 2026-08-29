import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { AgentError, AgentService } from './service.js';

const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'publicKey'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    publicKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
  },
} as const;

const paramsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['agentId'],
  properties: {
    agentId: {
      type: 'string',
      pattern: '^agt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
  },
} as const;

const statusBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['status'],
  properties: { status: { type: 'string', enum: ['enabled', 'disabled'] } },
} as const;
const rotateKeyBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['publicKey'],
  properties: { publicKey: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } },
} as const;

interface CreateBody {
  readonly name: string;
  readonly publicKey: string;
}

interface AgentParams {
  readonly agentId: string;
}

interface StatusBody {
  readonly status: 'enabled' | 'disabled';
}

interface RotateKeyBody {
  readonly publicKey: string;
}

function getDeveloperId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendAgentError(reply: FastifyReply, traceId: string, error: AgentError) {
  if (error.code === 'not_found') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  const pointer = error.code.includes('public_key') ? '/publicKey' : '/name';
  return sendProblem(
    reply,
    createApiProblem('INVALID_REQUEST', traceId, {
      errors: [{ code: error.code, pointer }],
    }),
  );
}

export function registerAgentRoutes(app: FastifyInstance, database: Database): void {
  const service = new AgentService(database);
  const requireDeveloper = createRequireDeveloper(database);

  app.post<{ Body: CreateBody }>(
    '/v1/agents',
    { schema: { body: createBodySchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.create(
          getDeveloperId(request),
          request.body.name,
          request.body.publicKey,
        );
        return await reply.status(201).send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof AgentError) {
          return sendAgentError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.get('/v1/agents', { preHandler: requireDeveloper }, async (request, reply) => {
    const result = await service.list(getDeveloperId(request));
    return reply.send(createApiSuccess(result, createTraceId()));
  });

  app.patch<{ Params: AgentParams; Body: StatusBody }>(
    '/v1/agents/:agentId/status',
    {
      schema: { params: paramsSchema, body: statusBodySchema },
      preHandler: requireDeveloper,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.setStatus(
          getDeveloperId(request),
          parseResourceId(request.params.agentId, 'agt'),
          request.body.status,
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof AgentError) {
          return sendAgentError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.post<{ Params: AgentParams; Body: RotateKeyBody }>(
    '/v1/agents/:agentId/rotate-key',
    {
      schema: { params: paramsSchema, body: rotateKeyBodySchema },
      preHandler: requireDeveloper,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.rotateKey(
          getDeveloperId(request),
          parseResourceId(request.params.agentId, 'agt'),
          request.body.publicKey,
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof AgentError) {
          return sendAgentError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.delete<{ Params: AgentParams }>(
    '/v1/agents/:agentId',
    { schema: { params: paramsSchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.revoke(
          getDeveloperId(request),
          parseResourceId(request.params.agentId, 'agt'),
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof AgentError) {
          return sendAgentError(reply, traceId, error);
        }

        throw error;
      }
    },
  );
}
