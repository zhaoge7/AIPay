import { MerchantClient, decodePaymentProof, type ResourceId } from '@aipay/sdk-ts';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { aipayBaseUrl, required, serviceId } from './config.js';

export function createServer(): McpServer {
  const merchant = new MerchantClient({
    baseUrl: aipayBaseUrl(),
    apiKey: required('AIPAY_MERCHANT_API_KEY'),
    merchantId: required('AIPAY_MERCHANT_ID') as ResourceId<'mch'>,
    keyId: required('AIPAY_MERCHANT_KEY_ID') as ResourceId<'key'>,
    privateKeyPkcs8Base64: required('AIPAY_MERCHANT_PRIVATE_KEY'),
  });
  const paidServiceId = serviceId();
  const server = new McpServer({ name: 'aipay-paid-weather', version: '0.1.0' });

  server.registerTool(
    'paid_weather',
    {
      description: 'Return paid weather data for a city',
      inputSchema: z.object({
        city: z.string().min(1).max(100),
        paymentProof: z.string().optional(),
      }),
    },
    async ({ city, paymentProof }) => {
      if (paymentProof === undefined) {
        const payment = await merchant.createPaymentRequirement({
          serviceId: paidServiceId,
          resourceUrl: `urn:aipay:mcp:paid_weather:${encodeURIComponent(city)}`,
          method: 'CALL',
        });
        return {
          content: [{ type: 'text', text: 'Payment required' }],
          structuredContent: {
            status: 'payment_required',
            paymentNeeded: payment.headerValue,
          },
        };
      }

      const proof = decodePaymentProof(paymentProof);
      const consumed = await merchant.consumePaymentProof(proof);
      const result = { city, condition: 'clear', temperatureCelsius: 27 };
      await merchant.submitDeliveryReceipt({
        deliveryId: consumed.deliveryId,
        paymentProof: proof,
        status: 'succeeded',
        result: JSON.stringify(result),
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: { status: 'delivered', ...result },
      };
    },
  );

  return server;
}

void serveStdio(createServer);
