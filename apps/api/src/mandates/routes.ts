import { createApiProblem, createApiSuccess } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { MandateDraftError, MandateDraftService, type CreateMandateDraftInput } from './service.js';

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

function getDeveloperId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendDraftError(reply: FastifyReply, traceId: string, error: MandateDraftError) {
  if (error.code === 'agent_unavailable' || error.code === 'merchant_unavailable') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  return sendProblem(
    reply,
    createApiProblem('INVALID_REQUEST', traceId, {
      errors: [{ code: error.code, pointer: '/' }],
    }),
  );
}

export function registerMandateRoutes(app: FastifyInstance, database: Database): void {
  const service = new MandateDraftService(database);
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
}
