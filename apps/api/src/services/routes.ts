import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import {
  ServiceCatalogService,
  ServiceError,
  type CreateServiceInput,
  type UpdateServiceInput,
} from './service.js';

const catalogValueSchema = {
  type: 'string',
  pattern: '^[a-z][a-z0-9._-]{0,63}$',
} as const;
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
  required: ['type', 'name', 'category', 'unit', 'unitPrice', 'refundPolicy'],
  properties: {
    type: { type: 'string', enum: ['api', 'mcp', 'skill'] },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    category: catalogValueSchema,
    unit: catalogValueSchema,
    unitPrice: moneySchema,
    refundPolicy: {
      type: 'string',
      enum: ['full_on_delivery_failure', 'non_refundable'],
    },
  },
} as const;
const updateBodySchema = {
  type: 'object',
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 200 },
    category: catalogValueSchema,
    unit: catalogValueSchema,
    unitPrice: moneySchema,
    refundPolicy: {
      type: 'string',
      enum: ['full_on_delivery_failure', 'non_refundable'],
    },
    status: { type: 'string', enum: ['enabled', 'disabled'] },
  },
} as const;
const merchantParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['merchantId'],
  properties: {
    merchantId: {
      type: 'string',
      pattern: '^mch_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
  },
} as const;
const serviceParamsSchema = {
  ...merchantParamsSchema,
  required: ['merchantId', 'serviceId'],
  properties: {
    ...merchantParamsSchema.properties,
    serviceId: {
      type: 'string',
      pattern: '^svc_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
  },
} as const;

interface MerchantParams {
  readonly merchantId: string;
}

interface ServiceParams extends MerchantParams {
  readonly serviceId: string;
}

function getDeveloperId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendServiceError(reply: FastifyReply, traceId: string, error: ServiceError) {
  if (error.code === 'not_found' || error.code === 'merchant_unavailable') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  const pointer = error.code === 'invalid_price' ? '/unitPrice' : '/name';
  return sendProblem(
    reply,
    createApiProblem('INVALID_REQUEST', traceId, {
      errors: [{ code: error.code, pointer }],
    }),
  );
}

export function registerServiceRoutes(app: FastifyInstance, database: Database): void {
  const service = new ServiceCatalogService(database);
  const requireDeveloper = createRequireDeveloper(database);

  app.post<{ Params: MerchantParams; Body: CreateServiceInput }>(
    '/v1/merchants/:merchantId/services',
    {
      schema: { params: merchantParamsSchema, body: createBodySchema },
      preHandler: requireDeveloper,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.create(
          getDeveloperId(request),
          parseResourceId(request.params.merchantId, 'mch'),
          request.body,
        );
        return await reply.status(201).send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof ServiceError) {
          return sendServiceError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.get<{ Params: MerchantParams }>(
    '/v1/merchants/:merchantId/services',
    { schema: { params: merchantParamsSchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.listOwned(
          getDeveloperId(request),
          parseResourceId(request.params.merchantId, 'mch'),
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof ServiceError) {
          return sendServiceError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.patch<{ Params: ServiceParams; Body: UpdateServiceInput }>(
    '/v1/merchants/:merchantId/services/:serviceId',
    {
      schema: { params: serviceParamsSchema, body: updateBodySchema },
      preHandler: requireDeveloper,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.update(
          getDeveloperId(request),
          parseResourceId(request.params.merchantId, 'mch'),
          parseResourceId(request.params.serviceId, 'svc'),
          request.body,
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof ServiceError) {
          return sendServiceError(reply, traceId, error);
        }

        throw error;
      }
    },
  );
}
