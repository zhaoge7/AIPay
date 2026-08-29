import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { ManualApprovalError, ManualApprovalService } from './manual-approval.js';

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
const bodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: { action: { type: 'string', enum: ['approve', 'reject'] } },
} as const;

interface Params {
  readonly transactionId: string;
}

interface Body {
  readonly action: 'approve' | 'reject';
}

function principalId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendApprovalError(reply: FastifyReply, traceId: string, error: ManualApprovalError) {
  if (error.code === 'not_found') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  if (error.code === 'quote_expired') {
    return sendProblem(reply, createApiProblem('QUOTE_EXPIRED', traceId));
  }

  return sendProblem(reply, createApiProblem('TRANSACTION_STATE_CONFLICT', traceId));
}

export function registerManualApprovalRoutes(app: FastifyInstance, database: Database): void {
  const service = new ManualApprovalService(database);
  const requireDeveloper = createRequireDeveloper(database);

  app.get(
    '/v1/transactions/confirmations',
    { preHandler: requireDeveloper },
    async (request, reply) => {
      const result = await service.listPending(principalId(request));
      return reply.send(createApiSuccess(result, createTraceId()));
    },
  );

  app.post<{ Params: Params; Body: Body }>(
    '/v1/transactions/:transactionId/confirmation',
    { schema: { params: paramsSchema, body: bodySchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.decide(
          principalId(request),
          parseResourceId(request.params.transactionId, 'txn'),
          request.body.action,
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof ManualApprovalError) {
          return sendApprovalError(reply, traceId, error);
        }

        throw error;
      }
    },
  );
}
