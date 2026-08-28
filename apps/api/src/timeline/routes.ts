import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { TimelineError, TransactionTimelineService } from './service.js';

const paramsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['transactionId'],
  properties: {
    transactionId: {
      type: 'string',
      pattern: '^txn_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
  },
} as const;

interface TimelineParams {
  readonly transactionId: string;
}

function developerId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendTimelineError(reply: FastifyReply, traceId: string) {
  return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
}

export function registerTimelineRoutes(app: FastifyInstance, database: Database): void {
  const requireDeveloper = createRequireDeveloper(database);
  const service = new TransactionTimelineService(database);

  app.get<{ Params: TimelineParams }>(
    '/v1/transactions/:transactionId/timeline',
    { schema: { params: paramsSchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const timeline = await service.get(
          developerId(request),
          parseResourceId(request.params.transactionId, 'txn'),
        );
        return await reply.send(createApiSuccess(timeline, traceId));
      } catch (error) {
        if (error instanceof TimelineError) {
          return sendTimelineError(reply, traceId);
        }

        throw error;
      }
    },
  );
}
