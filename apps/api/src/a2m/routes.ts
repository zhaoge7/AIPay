import { Buffer } from 'node:buffer';

import { createApiProblem, parseResourceId, type ResourceId } from '@aipay/contracts';
import { PaymentProviderError } from '@aipay/payment';
import type { FastifyInstance, FastifyReply } from 'fastify';

import { createTraceId, sendProblem } from '../http/problem.js';
import { A2MError, A2MService } from './service.js';

const paramsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['serviceId'],
  properties: {
    serviceId: {
      type: 'string',
      pattern: '^svc_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
    },
  },
} as const;

interface ResourceParams {
  readonly serviceId: string;
}

function paymentValidationHeader(value: {
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

async function sendPaymentRequired(
  reply: FastifyReply,
  service: A2MService,
  serviceId: ResourceId<'svc'>,
) {
  try {
    const required = await service.createPaymentRequired(serviceId);
    return await reply.status(402).header('payment-needed', required.headerValue).send({
      code: 'PAYMENT_NEEDED',
      amount: required.amount,
      currency: required.currency,
      goodsName: required.goodsName,
    });
  } catch (error) {
    if (error instanceof A2MError && error.code === 'service_unavailable') {
      return sendProblem(reply, createApiProblem('SERVICE_UNAVAILABLE', createTraceId()));
    }

    throw error;
  }
}

export function registerA2MRoutes(app: FastifyInstance, service: A2MService): void {
  app.get<{ Params: ResourceParams }>(
    '/v1/a2m/resources/:serviceId',
    { schema: { params: paramsSchema } },
    async (request, reply) => {
      const serviceId = parseResourceId(request.params.serviceId, 'svc');
      const paymentProof = request.headers['payment-proof'];

      if (typeof paymentProof !== 'string' || paymentProof.length === 0) {
        return await sendPaymentRequired(reply, service, serviceId);
      }

      try {
        const fulfilled = await service.verifyAndFulfill(serviceId, paymentProof);
        return await reply.header('payment-validation', paymentValidationHeader(fulfilled)).send({
          resource_id: fulfilled.resourceId,
          content: fulfilled.serviceResult,
          trade_no: fulfilled.tradeNo,
          out_trade_no: fulfilled.outTradeNo,
          already_fulfilled: fulfilled.alreadyFulfilled,
          fulfillment_confirmed: true,
        });
      } catch (error) {
        if (error instanceof A2MError && error.code === 'invalid_payment_proof') {
          return await sendPaymentRequired(reply, service, serviceId);
        }

        if (
          (error instanceof A2MError && error.code === 'fulfillment_confirmation_failed') ||
          (error instanceof PaymentProviderError && error.kind === 'retryable')
        ) {
          return sendProblem(reply, createApiProblem('PROVIDER_UNAVAILABLE', createTraceId()));
        }

        throw error;
      }
    },
  );
}
