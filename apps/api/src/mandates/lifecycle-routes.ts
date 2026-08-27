import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import {
  MandateLifecycleError,
  MandateLifecycleService,
  type MandateLifecycleAction,
} from './lifecycle.js';

const paramsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mandateId'],
  properties: {
    mandateId: {
      type: 'string',
      pattern: '^mdt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
  },
} as const;
const actionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: { action: { type: 'string', enum: ['pause', 'resume', 'revoke'] } },
} as const;

interface Params {
  readonly mandateId: string;
}

interface ActionBody {
  readonly action: MandateLifecycleAction;
}

function principalId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendLifecycleError(reply: FastifyReply, traceId: string, error: MandateLifecycleError) {
  if (error.code === 'not_found') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  if (error.code === 'expired') {
    return sendProblem(reply, createApiProblem('MANDATE_EXPIRED', traceId));
  }

  return sendProblem(reply, createApiProblem('TRANSACTION_STATE_CONFLICT', traceId));
}

export function registerMandateLifecycleRoutes(app: FastifyInstance, database: Database): void {
  const service = new MandateLifecycleService(database);
  const requireDeveloper = createRequireDeveloper(database);

  app.get<{ Params: Params }>(
    '/v1/mandates/:mandateId/lifecycle',
    { schema: { params: paramsSchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.getOwned(
          principalId(request),
          parseResourceId(request.params.mandateId, 'mdt'),
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof MandateLifecycleError) {
          return sendLifecycleError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.post<{ Params: Params; Body: ActionBody }>(
    '/v1/mandates/:mandateId/lifecycle',
    {
      schema: { params: paramsSchema, body: actionSchema },
      preHandler: requireDeveloper,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.transition(
          principalId(request),
          parseResourceId(request.params.mandateId, 'mdt'),
          request.body.action,
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof MandateLifecycleError) {
          return sendLifecycleError(reply, traceId, error);
        }

        throw error;
      }
    },
  );
}
