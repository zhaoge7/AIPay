import {
  createApiProblem,
  createApiSuccess,
  parseResourceId,
  transactionStatuses,
  type TransactionStatus,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { TransactionQueryError, TransactionQueryService } from './query.js';

const resourcePattern = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const utcPattern = '^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$';
const querySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: transactionStatuses },
    agentId: { type: 'string', pattern: `^agt_${resourcePattern}$` },
    merchantId: { type: 'string', pattern: `^mch_${resourcePattern}$` },
    from: { type: 'string', pattern: utcPattern },
    to: { type: 'string', pattern: utcPattern },
    limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
  },
} as const;

interface Querystring {
  readonly status?: TransactionStatus;
  readonly agentId?: string;
  readonly merchantId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: string;
}

function developerId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendQueryError(reply: FastifyReply) {
  return sendProblem(reply, createApiProblem('INVALID_REQUEST', createTraceId()));
}

export function registerTransactionQueryRoutes(app: FastifyInstance, database: Database): void {
  const service = new TransactionQueryService(database);
  const requireDeveloper = createRequireDeveloper(database);

  app.get<{ Querystring: Querystring }>(
    '/v1/transactions',
    { schema: { querystring: querySchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      try {
        const result = await service.list(developerId(request), {
          ...(request.query.status === undefined ? {} : { status: request.query.status }),
          ...(request.query.agentId === undefined
            ? {}
            : { agentId: parseResourceId(request.query.agentId, 'agt') }),
          ...(request.query.merchantId === undefined
            ? {}
            : { merchantId: parseResourceId(request.query.merchantId, 'mch') }),
          ...(request.query.from === undefined ? {} : { from: new Date(request.query.from) }),
          ...(request.query.to === undefined ? {} : { to: new Date(request.query.to) }),
          ...(request.query.limit === undefined ? {} : { limit: Number(request.query.limit) }),
        });
        return await reply.send(createApiSuccess(result, createTraceId()));
      } catch (error) {
        if (error instanceof TransactionQueryError) {
          return sendQueryError(reply);
        }

        throw error;
      }
    },
  );
}
