import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { MandateDraftError, MandateDraftService, type CreateMandateDraftInput } from './service.js';
import { MandateIssuer, MandateIssuerError, MandateVerifier } from './issuer.js';

const moneySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['currency', 'amountMinor'],
  properties: {
    currency: { type: 'string', const: 'CNY' },
    amountMinor: { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$' },
  },
} as const;
const createBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'agentId',
    'purpose',
    'allowedMerchantIds',
    'allowedCategories',
    'maxPerTransaction',
    'totalBudget',
    'approvalRequiredAbove',
    'maxTransactions',
    'validUntil',
    'instructionHash',
  ],
  properties: {
    agentId: {
      type: 'string',
      pattern: '^agt_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
    purpose: { type: 'string', minLength: 1, maxLength: 1_000 },
    allowedMerchantIds: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: {
        type: 'string',
        pattern: '^mch_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      },
    },
    allowedCategories: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      uniqueItems: true,
      items: { type: 'string', pattern: '^[a-z][a-z0-9._-]{0,63}$' },
    },
    maxPerTransaction: moneySchema,
    totalBudget: moneySchema,
    approvalRequiredAbove: moneySchema,
    maxTransactions: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    validUntil: {
      type: 'string',
      pattern: '^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$',
    },
    instructionHash: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
  },
} as const;
const mandateParamsSchema = {
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

interface MandateParams {
  readonly mandateId: string;
}

function getDeveloperId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendDraftError(reply: FastifyReply, traceId: string, error: MandateDraftError) {
  if (
    error.code === 'agent_unavailable' ||
    error.code === 'merchant_unavailable' ||
    error.code === 'not_found'
  ) {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  return sendProblem(
    reply,
    createApiProblem('INVALID_REQUEST', traceId, {
      errors: [{ code: error.code, pointer: '/' }],
    }),
  );
}

function sendIssuerError(reply: FastifyReply, traceId: string, error: MandateIssuerError) {
  if (error.code === 'not_found') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  if (error.code === 'expired') {
    return sendProblem(reply, createApiProblem('MANDATE_EXPIRED', traceId));
  }

  if (error.code === 'not_draft') {
    return sendProblem(reply, createApiProblem('TRANSACTION_STATE_CONFLICT', traceId));
  }

  if (error.code === 'invalid_signature') {
    return sendProblem(reply, createApiProblem('SIGNATURE_INVALID', traceId));
  }

  return sendProblem(reply, createApiProblem('SERVICE_UNAVAILABLE', traceId));
}

export function registerMandateRoutes(
  app: FastifyInstance,
  database: Database,
  issuer?: MandateIssuer,
): void {
  const service = new MandateDraftService(database);
  const verifier = new MandateVerifier(database);
  const requireDeveloper = createRequireDeveloper(database);

  app.post<{ Body: CreateMandateDraftInput }>(
    '/v1/mandates',
    { schema: { body: createBodySchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.create(getDeveloperId(request), request.body);
        return await reply.status(201).send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof MandateDraftError) {
          return sendDraftError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.get('/v1/mandates', { preHandler: requireDeveloper }, async (request, reply) => {
    const result = await service.list(getDeveloperId(request));
    return reply.send(createApiSuccess(result, createTraceId()));
  });

  app.get<{ Params: MandateParams }>(
    '/v1/mandates/:mandateId',
    { schema: { params: mandateParamsSchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.get(
          getDeveloperId(request),
          parseResourceId(request.params.mandateId, 'mdt'),
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof MandateDraftError) {
          return sendDraftError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.post<{ Params: MandateParams }>(
    '/v1/mandates/:mandateId/issue',
    { schema: { params: mandateParamsSchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      if (issuer === undefined) {
        return sendProblem(reply, createApiProblem('SERVICE_UNAVAILABLE', traceId));
      }

      try {
        const result = await issuer.issue(
          getDeveloperId(request),
          parseResourceId(request.params.mandateId, 'mdt'),
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof MandateIssuerError) {
          return sendIssuerError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.post<{ Body: unknown }>('/v1/mandates/verify', async (request, reply) => {
    const traceId = createTraceId();

    try {
      const mandate = await verifier.verify(request.body);
      return await reply.send(
        createApiSuccess(
          { valid: true, mandateId: mandate.mandateId, keyId: mandate.proof.keyId },
          traceId,
        ),
      );
    } catch (error) {
      if (error instanceof MandateIssuerError) {
        return sendIssuerError(reply, traceId, error);
      }

      throw error;
    }
  });
}
