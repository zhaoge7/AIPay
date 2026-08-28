import {
  createApiProblem,
  createApiSuccess,
  getDeliveryReceiptJsonSchema,
  parseResourceId,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createRequireDeveloper } from '../auth/session.js';
import { createTraceId, sendProblem } from '../http/problem.js';
import { DeliveryReceiptError, DeliveryReceiptService } from './receipts.js';

const resourcePattern = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const paramsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['merchantId', 'deliveryId'],
  properties: {
    merchantId: { type: 'string', pattern: `^mch_${resourcePattern}$` },
    deliveryId: { type: 'string', pattern: `^dlv_${resourcePattern}$` },
  },
} as const;
const receiptSchema = { ...getDeliveryReceiptJsonSchema(), $schema: undefined };

interface ReceiptParams {
  readonly merchantId: string;
  readonly deliveryId: string;
}

function developerId(request: FastifyRequest) {
  if (request.authenticatedDeveloperId === null) {
    throw new Error('Authenticated developer is missing after pre-handler');
  }

  return request.authenticatedDeveloperId;
}

function sendReceiptError(reply: FastifyReply, traceId: string, error: DeliveryReceiptError) {
  if (error.code === 'invalid_signature' || error.code === 'binding_mismatch') {
    return sendProblem(reply, createApiProblem('SIGNATURE_INVALID', traceId));
  }

  if (error.code === 'not_found') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  return sendProblem(reply, createApiProblem('TRANSACTION_STATE_CONFLICT', traceId));
}

export function registerDeliveryReceiptRoutes(app: FastifyInstance, database: Database): void {
  const service = new DeliveryReceiptService(database);
  const requireDeveloper = createRequireDeveloper(database);

  app.post<{ Body: unknown }>(
    '/v1/deliveries/verify',
    { schema: { body: receiptSchema } },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const receipt = await service.verify(request.body);
        return await reply.send(
          createApiSuccess(
            {
              valid: true,
              deliveryId: receipt.deliveryId,
              transactionId: receipt.transactionId,
              merchantId: receipt.merchantId,
              serviceId: receipt.serviceId,
              status: receipt.status,
              keyId: receipt.proof.keyId,
            },
            traceId,
          ),
        );
      } catch (error) {
        if (error instanceof DeliveryReceiptError) {
          return sendReceiptError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.post<{ Params: ReceiptParams; Body: unknown }>(
    '/v1/merchants/:merchantId/deliveries/:deliveryId/receipt',
    {
      schema: { params: paramsSchema, body: receiptSchema },
      preHandler: requireDeveloper,
    },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const receipt = await service.submit(
          developerId(request),
          parseResourceId(request.params.merchantId, 'mch'),
          parseResourceId(request.params.deliveryId, 'dlv'),
          request.body,
        );
        return await reply.send(createApiSuccess(receipt, traceId));
      } catch (error) {
        if (error instanceof DeliveryReceiptError) {
          return sendReceiptError(reply, traceId, error);
        }

        throw error;
      }
    },
  );
}
