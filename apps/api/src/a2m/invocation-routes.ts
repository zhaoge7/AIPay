import { Buffer } from 'node:buffer';

import { createApiProblem } from '@aipay/contracts';
import { PaymentProviderError } from '@aipay/payment';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  ApiInvocationError,
  ApiInvocationService,
  type AggregatedPaymentRequired,
  type CreateApiInvocationInput,
} from './invocation-service.js';
import { createRequireAgentSignature } from '../agent-signatures/routes.js';
import { createTraceId, sendProblem } from '../http/problem.js';

const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['intent', 'parameters', 'idempotencyKey'],
  properties: {
    intent: { type: 'string', minLength: 2, maxLength: 500 },
    category: { type: 'string', pattern: '^[a-z][a-z0-9._-]{0,63}$' },
    parameters: { type: 'object' },
    idempotencyKey: { type: 'string', minLength: 16, maxLength: 128 },
  },
} as const;
const paramsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['outTradeNo'],
  properties: { outTradeNo: { type: 'string', pattern: '^A2M[0-9A-F]{32}$' } },
} as const;

interface InvocationParams {
  readonly outTradeNo: string;
}

function agentId(request: FastifyRequest) {
  if (request.authenticatedAgentId === null) {
    throw new Error('Authenticated Agent is missing after signature pre-handler');
  }

  return request.authenticatedAgentId;
}

function validationHeader(value: {
  readonly tradeNo: string;
  readonly outTradeNo: string;
  readonly resourceId: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      trade_no: value.tradeNo,
      out_trade_no: value.outTradeNo,
      validated: true,
      resource_id: value.resourceId,
    }),
    'utf8',
  ).toString('base64url');
}

async function sendPaymentRequired(reply: FastifyReply, required: AggregatedPaymentRequired) {
  return reply.status(402).header('payment-needed', required.headerValue).send({
    code: 'PAYMENT_NEEDED',
    outTradeNo: required.outTradeNo,
    resourceId: required.resourceId,
    amount: required.amount,
    currency: required.currency,
    goodsName: required.goodsName,
    selectedServiceId: required.selectedServiceId,
    resolvedCategory: required.resolvedCategory,
  });
}

function sendInvocationError(reply: FastifyReply, error: ApiInvocationError) {
  const traceId = createTraceId();

  if (error.code === 'invalid_request') {
    return sendProblem(reply, createApiProblem('INVALID_REQUEST', traceId));
  }

  if (error.code === 'idempotency_conflict') {
    return sendProblem(reply, createApiProblem('IDEMPOTENCY_CONFLICT', traceId));
  }

  if (error.code === 'order_expired') {
    return sendProblem(reply, createApiProblem('QUOTE_EXPIRED', traceId));
  }

  if (error.code === 'invocation_in_progress') {
    reply.header('retry-after', '1');
    return sendProblem(
      reply,
      createApiProblem('IDEMPOTENCY_IN_PROGRESS', traceId, { retryAfterMs: 1_000 }),
    );
  }

  return sendProblem(reply, createApiProblem('SERVICE_UNAVAILABLE', traceId));
}

export function registerApiInvocationRoutes(
  app: FastifyInstance,
  database: Database,
  service: ApiInvocationService,
): void {
  const requireAgentSignature = createRequireAgentSignature(database);

  app.post<{ Body: CreateApiInvocationInput }>(
    '/v1/a2m/invocations',
    {
      config: { rawBody: true },
      schema: { body: createBodySchema },
      preHandler: requireAgentSignature,
    },
    async (request, reply) => {
      try {
        return await sendPaymentRequired(
          reply,
          await service.createPaymentRequired(agentId(request), request.body),
        );
      } catch (error) {
        if (error instanceof ApiInvocationError) return sendInvocationError(reply, error);
        throw error;
      }
    },
  );

  app.post<{ Params: InvocationParams }>(
    '/v1/a2m/invocations/:outTradeNo',
    {
      config: { rawBody: true },
      schema: { params: paramsSchema },
      preHandler: requireAgentSignature,
    },
    async (request, reply) => {
      const authenticatedAgentId = agentId(request);
      const paymentProof = request.headers['payment-proof'];

      if (typeof paymentProof !== 'string' || paymentProof.length === 0) {
        try {
          return await sendPaymentRequired(
            reply,
            await service.paymentRequiredForOrder(authenticatedAgentId, request.params.outTradeNo),
          );
        } catch (error) {
          if (error instanceof ApiInvocationError) return sendInvocationError(reply, error);
          throw error;
        }
      }

      try {
        const fulfilled = await service.verifyAndFulfill(
          authenticatedAgentId,
          request.params.outTradeNo,
          paymentProof,
        );
        return await reply.header('payment-validation', validationHeader(fulfilled)).send({
          resource_id: fulfilled.resourceId,
          content: fulfilled.serviceResult,
          trade_no: fulfilled.tradeNo,
          out_trade_no: fulfilled.outTradeNo,
          selected_service_id: fulfilled.selectedServiceId,
          resolved_category: fulfilled.resolvedCategory,
          already_fulfilled: fulfilled.alreadyFulfilled,
          fulfillment_confirmed: true,
        });
      } catch (error) {
        if (error instanceof ApiInvocationError && error.code === 'invalid_payment_proof') {
          try {
            return await sendPaymentRequired(
              reply,
              await service.paymentRequiredForOrder(
                authenticatedAgentId,
                request.params.outTradeNo,
              ),
            );
          } catch (billError) {
            if (billError instanceof ApiInvocationError) {
              return sendInvocationError(reply, billError);
            }
            throw billError;
          }
        }

        if (error instanceof ApiInvocationError) return sendInvocationError(reply, error);
        if (error instanceof PaymentProviderError) {
          return sendProblem(reply, createApiProblem('PROVIDER_UNAVAILABLE', createTraceId()));
        }
        throw error;
      }
    },
  );
}
