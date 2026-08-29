import {
  createApiProblem,
  createApiSuccess,
  getPaymentProofJsonSchema,
  parseResourceId,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireAgentSignature } from '../agent-signatures/routes.js';
import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { PaymentProofError, PaymentProofIssuer } from './proofs.js';

const resourcePattern = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const transactionParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['transactionId'],
  properties: { transactionId: { type: 'string', pattern: `^txn_${resourcePattern}$` } },
} as const;
const merchantParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['merchantId'],
  properties: { merchantId: { type: 'string', pattern: `^mch_${resourcePattern}$` } },
} as const;
const paymentProofSchema = { ...getPaymentProofJsonSchema(), $schema: undefined };
const consumeBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['paymentProof'],
  properties: { paymentProof: paymentProofSchema },
} as const;

interface TransactionParams {
  readonly transactionId: string;
}

interface MerchantParams {
  readonly merchantId: string;
}

interface ConsumeBody {
  readonly paymentProof: unknown;
}

function developerId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function agentId(request: FastifyRequest) {
  if (request.authenticatedAgentId === null) {
    throw new Error('Authenticated Agent is missing after signature pre-handler');
  }

  return request.authenticatedAgentId;
}

function sendPaymentProofError(reply: FastifyReply, traceId: string, error: PaymentProofError) {
  if (error.code === 'invalid_signature' || error.code === 'binding_mismatch') {
    return sendProblem(reply, createApiProblem('SIGNATURE_INVALID', traceId));
  }

  if (error.code === 'expired') {
    return sendProblem(reply, createApiProblem('PAYMENT_PROOF_EXPIRED', traceId));
  }

  if (error.code === 'not_found') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  return sendProblem(reply, createApiProblem('TRANSACTION_STATE_CONFLICT', traceId));
}

export function registerPaymentProofRoutes(
  app: FastifyInstance,
  database: Database,
  issuer: PaymentProofIssuer,
): void {
  const requireDeveloper = createRequireDeveloper(database);
  const requireAgentSignature = createRequireAgentSignature(database);

  app.post<{ Params: TransactionParams }>(
    '/v1/transactions/:transactionId/payment-proof',
    { schema: { params: transactionParamsSchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const paymentProof = await issuer.issue(
          developerId(request),
          parseResourceId(request.params.transactionId, 'txn'),
        );
        return await reply.status(201).send(createApiSuccess(paymentProof, traceId));
      } catch (error) {
        if (error instanceof PaymentProofError) {
          return sendPaymentProofError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.post<{ Params: TransactionParams; Body: Record<string, never> }>(
    '/v1/agent/transactions/:transactionId/payment-proof',
    {
      config: { rawBody: true },
      schema: {
        params: transactionParamsSchema,
        body: { type: 'object', additionalProperties: false, maxProperties: 0 },
      },
      preHandler: requireAgentSignature,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const paymentProof = await issuer.issueForAgent(
          agentId(request),
          parseResourceId(request.params.transactionId, 'txn'),
        );
        return await reply.status(201).send(createApiSuccess(paymentProof, traceId));
      } catch (error) {
        if (error instanceof PaymentProofError) {
          return sendPaymentProofError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.post<{ Body: unknown }>(
    '/v1/payment-proofs/verify',
    { schema: { body: paymentProofSchema } },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const paymentProof = await issuer.verify(request.body);
        return await reply.send(
          createApiSuccess(
            {
              valid: true,
              paymentProofId: paymentProof.paymentProofId,
              transactionId: paymentProof.transactionId,
              merchantId: paymentProof.merchantId,
              serviceId: paymentProof.serviceId,
              expiresAt: paymentProof.expiresAt,
              keyId: paymentProof.proof.keyId,
            },
            traceId,
          ),
        );
      } catch (error) {
        if (error instanceof PaymentProofError) {
          return sendPaymentProofError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.post<{ Params: MerchantParams; Body: ConsumeBody }>(
    '/v1/merchants/:merchantId/payment-proofs/consume',
    {
      schema: { params: merchantParamsSchema, body: consumeBodySchema },
      preHandler: requireDeveloper,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const consumed = await issuer.consume(
          developerId(request),
          parseResourceId(request.params.merchantId, 'mch'),
          request.body.paymentProof,
        );
        return await reply.send(createApiSuccess(consumed, traceId));
      } catch (error) {
        if (error instanceof PaymentProofError) {
          return sendPaymentProofError(reply, traceId, error);
        }

        throw error;
      }
    },
  );
}
