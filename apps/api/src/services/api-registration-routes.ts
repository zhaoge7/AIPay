import { createApiProblem, createApiSuccess, parseResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import {
  ApiRegistrationError,
  ApiRegistrationService,
  type ApiRegistrationInput,
} from './api-registration.js';

const resourceIdPattern = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const paramsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['merchantId', 'serviceId'],
  properties: {
    merchantId: { type: 'string', pattern: `^mch_${resourceIdPattern}$` },
    serviceId: { type: 'string', pattern: `^svc_${resourceIdPattern}$` },
  },
} as const;
const bodySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'endpointUrl',
    'httpMethod',
    'description',
    'capabilities',
    'inputSchema',
    'timeoutMs',
  ],
  properties: {
    endpointUrl: { type: 'string', minLength: 8, maxLength: 2_048 },
    httpMethod: { type: 'string', const: 'POST' },
    description: { type: 'string', minLength: 1, maxLength: 1_000 },
    capabilities: {
      type: 'array',
      minItems: 1,
      maxItems: 32,
      uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 80 },
    },
    inputSchema: { type: 'object' },
    timeoutMs: { type: 'integer', minimum: 1_000, maximum: 30_000 },
    status: { type: 'string', enum: ['enabled', 'disabled'] },
  },
} as const;

interface Params {
  readonly merchantId: string;
  readonly serviceId: string;
}

function developerId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendRegistrationError(reply: FastifyReply, traceId: string, error: ApiRegistrationError) {
  if (error.code === 'not_found') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  const pointers: Record<Exclude<ApiRegistrationError['code'], 'not_found'>, string> = {
    invalid_endpoint_url: '/endpointUrl',
    invalid_description: '/description',
    invalid_capabilities: '/capabilities',
    invalid_input_schema: '/inputSchema',
    invalid_timeout: '/timeoutMs',
    parameters_invalid: '/parameters',
  };
  return sendProblem(
    reply,
    createApiProblem('INVALID_REQUEST', traceId, {
      errors: [{ code: error.code, pointer: pointers[error.code] }],
    }),
  );
}

export function registerApiRegistrationRoutes(app: FastifyInstance, database: Database): void {
  const service = new ApiRegistrationService(database);
  const requireDeveloper = createRequireDeveloper(database);
  const path = '/v1/merchants/:merchantId/services/:serviceId/api-registration';

  app.put<{ Params: Params; Body: ApiRegistrationInput }>(
    path,
    { schema: { params: paramsSchema, body: bodySchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.put(
          developerId(request),
          parseResourceId(request.params.merchantId, 'mch'),
          parseResourceId(request.params.serviceId, 'svc'),
          request.body,
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof ApiRegistrationError) {
          return sendRegistrationError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.get<{ Params: Params }>(
    path,
    { schema: { params: paramsSchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await service.getOwned(
          developerId(request),
          parseResourceId(request.params.merchantId, 'mch'),
          parseResourceId(request.params.serviceId, 'svc'),
        );
        return await reply.send(createApiSuccess(result, traceId));
      } catch (error) {
        if (error instanceof ApiRegistrationError) {
          return sendRegistrationError(reply, traceId, error);
        }

        throw error;
      }
    },
  );
}
