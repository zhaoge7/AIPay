import { Buffer } from 'node:buffer';

import { formatUtcDateTime } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import { PaymentProviderError, type PaymentProvider } from '@aipay/payment';
import type { FastifyInstance } from 'fastify';

import { PaymentWebhookError, PaymentWebhookService } from './webhook.js';

export function registerAlipayWebhookRoutes(
  app: FastifyInstance,
  database: Database,
  provider: PaymentProvider,
): void {
  const service = new PaymentWebhookService(database);

  app.post(
    '/v1/provider-webhooks/alipay',
    { config: { rawBody: true }, bodyLimit: 64 * 1_024 },
    async (request, reply) => {
      const rawBody =
        request.rawBody === undefined
          ? Buffer.alloc(0)
          : typeof request.rawBody === 'string'
            ? Buffer.from(request.rawBody, 'utf8')
            : Buffer.from(request.rawBody);
      const headers: Record<string, string> = {};

      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === 'string') {
          headers[name] = value;
        }
      }

      try {
        const result = await service.process(provider, {
          headers,
          rawBody,
          receivedAt: formatUtcDateTime(new Date()),
        });
        const acknowledgement = provider.acknowledgeWebhook(result.event);
        return await reply
          .status(acknowledgement.statusCode)
          .headers(acknowledgement.headers)
          .send(acknowledgement.body);
      } catch (error) {
        if (error instanceof PaymentProviderError || error instanceof PaymentWebhookError) {
          return await reply.status(400).type('text/plain; charset=utf-8').send('failure');
        }

        throw error;
      }
    },
  );
}
