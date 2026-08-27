import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireAgentSignature } from '../agent-signatures/routes.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { TransactionCreationError, TransactionCreationService } from './create.js';

const bodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['quoteId', 'mandateId'],
  properties: {
    quoteId: {
      type: 'string',
      pattern: '^qte_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
    mandateId: {
      type: 'string',
      pattern: '^mdt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
  },
} as const;

interface Body {
  readonly quoteId: string;
  readonly mandateId: string;
}

function agentId(request: FastifyRequest) {
  if (request.authenticatedAgentId === null) {
    throw new Error('Authenticated Agent is missing after signature pre-handler');
  }

  return request.authenticatedAgentId;
}

function sendCreationError(reply: FastifyReply, traceId: string, error: TransactionCreationError) {
  if (error.code === 'quote_expired') {
    return sendProblem(reply, createApiProblem('QUOTE_EXPIRED', traceId));
  }

  if (error.code === 'mandate_inactive') {
    return sendProblem(reply, createApiProblem('MANDATE_EXPIRED', traceId));
  }

  if (error.code === 'transaction_exists') {
    return sendProblem(reply, createApiProblem('TRANSACTION_STATE_CONFLICT', traceId));
  }

  return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
}

export function registerTransactionCreationRoutes(app: FastifyInstance, database: Database): void {
  const service = new TransactionCreationService(database);
  const requireAgentSignature = createRequireAgentSignature(database);

  app.post<{ Body: Body }>(
    '/v1/transactions',
    {
      config: { rawBody: true },
      schema: { body: bodySchema },
      preHandler: requireAgentSignature,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.create(
          agentId(request),
          parseResourceId(request.body.quoteId, 'qte'),
          parseResourceId(request.body.mandateId, 'mdt'),
        );
        return await reply.status(201).send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof TransactionCreationError) {
          return sendCreationError(reply, traceId, error);
        }

        throw error;
      }
    },
  );
}
