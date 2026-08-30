import { createApiSuccess } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId } from '../http/problem.js';
import { PaymentControlService } from './service.js';

const bodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['paymentsPaused'],
  properties: { paymentsPaused: { type: 'boolean' } },
} as const;

interface Body {
  readonly paymentsPaused: boolean;
}

function developerId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

export function registerPaymentControlRoutes(app: FastifyInstance, database: Database): void {
  const requireDeveloper = createRequireDeveloper(database);
  const service = new PaymentControlService(database);

  app.get('/v1/payment-controls', { preHandler: requireDeveloper }, async (request, reply) => {
    return reply.send(createApiSuccess(await service.get(developerId(request)), createTraceId()));
  });

  app.patch<{ Body: Body }>(
    '/v1/payment-controls',
    { schema: { body: bodySchema }, preHandler: requireDeveloper },
    async (request, reply) => {
      return reply.send(
        createApiSuccess(
          await service.set(developerId(request), request.body.paymentsPaused),
          createTraceId(),
        ),
      );
    },
  );
}
