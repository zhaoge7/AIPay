import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import { PaymentProviderError, type PaymentProvider } from '@aipay/payment';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireAgentSignature } from '../agent-signatures/routes.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { AgentPaymentError, AgentPaymentExecutionService } from './agent-execution.js';
import { PaymentExecutionError } from './execution.js';

const resourcePattern = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const transactionParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['transactionId'],
  properties: { transactionId: { type: 'string', pattern: `^txn_${resourcePattern}$` } },
} as const;
const attemptParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['paymentAttemptId'],
  properties: { paymentAttemptId: { type: 'string', pattern: `^pat_${resourcePattern}$` } },
} as const;
const emptyBodySchema = {
  type: 'object',
  additionalProperties: false,
  maxProperties: 0,
} as const;

interface TransactionParams {
  readonly transactionId: string;
}

interface AttemptParams {
  readonly paymentAttemptId: string;
}

function agentId(request: FastifyRequest) {
  if (request.authenticatedAgentId === null) {
    throw new Error('Authenticated Agent is missing after signature pre-handler');
  }

  return request.authenticatedAgentId;
}

function sendAgentPaymentError(reply: FastifyReply, traceId: string, error: unknown) {
  if (
    (error instanceof AgentPaymentError && error.code === 'not_found') ||
    (error instanceof PaymentExecutionError && error.code === 'not_found')
  ) {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  if (error instanceof AgentPaymentError) {
    const code =
      error.code === 'budget_denied' ? 'AUTHORIZATION_DENIED' : 'TRANSACTION_STATE_CONFLICT';
    return sendProblem(reply, createApiProblem(code, traceId));
  }

  if (error instanceof PaymentExecutionError) {
    return sendProblem(reply, createApiProblem('TRANSACTION_STATE_CONFLICT', traceId));
  }

  if (error instanceof PaymentProviderError) {
    const code = error.kind === 'retryable' ? 'PROVIDER_UNAVAILABLE' : 'TRANSACTION_STATE_CONFLICT';
    return sendProblem(reply, createApiProblem(code, traceId));
  }

  return undefined;
}

export function registerAgentPaymentRoutes(
  app: FastifyInstance,
  database: Database,
  provider: PaymentProvider,
  callbackUrl: string,
): void {
  const requireAgentSignature = createRequireAgentSignature(database);
  const service = new AgentPaymentExecutionService(database, provider, callbackUrl);

  app.post<{ Params: TransactionParams; Body: Record<string, never> }>(
    '/v1/agent/transactions/:transactionId/payment',
    {
      config: { rawBody: true },
      schema: { params: transactionParamsSchema, body: emptyBodySchema },
      preHandler: requireAgentSignature,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const attempt = await service.create(
          agentId(request),
          parseResourceId(request.params.transactionId, 'txn'),
        );
        return await reply.send(createApiSuccess(attempt, traceId));
      } catch (error) {
        const response = sendAgentPaymentError(reply, traceId, error);

        if (response !== undefined) {
          return response;
        }

        throw error;
      }
    },
  );

  app.post<{ Params: AttemptParams; Body: Record<string, never> }>(
    '/v1/agent/payment-attempts/:paymentAttemptId/query',
    {
      config: { rawBody: true },
      schema: { params: attemptParamsSchema, body: emptyBodySchema },
      preHandler: requireAgentSignature,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const attempt = await service.query(
          agentId(request),
          parseResourceId(request.params.paymentAttemptId, 'pat'),
        );
        return await reply.send(createApiSuccess(attempt, traceId));
      } catch (error) {
        const response = sendAgentPaymentError(reply, traceId, error);

        if (response !== undefined) {
          return response;
        }

        throw error;
      }
    },
  );
}
