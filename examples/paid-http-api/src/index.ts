import process from 'node:process';

import {
  MerchantClient,
  PAYMENT_NEEDED_HEADER,
  PAYMENT_PROOF_HEADER,
  decodePaymentProof,
  type ResourceId,
} from '@aipay/sdk-ts';
import Fastify from 'fastify';

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const merchant = new MerchantClient({
  baseUrl: required('AIPAY_BASE_URL'),
  apiKey: required('AIPAY_MERCHANT_API_KEY'),
  merchantId: required('AIPAY_MERCHANT_ID') as ResourceId<'mch'>,
  keyId: required('AIPAY_MERCHANT_KEY_ID') as ResourceId<'key'>,
  privateKeyPkcs8Base64: required('AIPAY_MERCHANT_PRIVATE_KEY'),
});
const serviceId = required('AIPAY_SERVICE_ID') as ResourceId<'svc'>;
const app = Fastify({ logger: true });
const delivered = new Map<string, Readonly<Record<string, unknown>>>();

app.get('/paid/weather', async (request, reply) => {
  const proofHeader = request.headers[PAYMENT_PROOF_HEADER];

  if (typeof proofHeader !== 'string') {
    const resourceUrl = `${request.protocol}://${request.host}${request.url}`;
    const payment = await merchant.createPaymentRequirement({ serviceId, resourceUrl });
    return reply
      .status(402)
      .header(PAYMENT_NEEDED_HEADER, payment.headerValue)
      .send({ code: 'PAYMENT_NEEDED', quoteId: payment.requirement.quote.quoteId });
  }

  const paymentProof = decodePaymentProof(proofHeader);
  const previous = delivered.get(paymentProof.paymentProofId);

  if (previous !== undefined) {
    return reply.send(previous);
  }

  const consumed = await merchant.consumePaymentProof(paymentProof);
  const result = Object.freeze({
    city: 'Hangzhou',
    condition: 'clear',
    temperatureCelsius: 27,
    paymentProofId: consumed.paymentProofId,
  });
  await merchant.submitDeliveryReceipt({
    deliveryId: consumed.deliveryId,
    paymentProof,
    status: 'succeeded',
    result: JSON.stringify(result),
  });
  delivered.set(paymentProof.paymentProofId, result);
  return reply.send(result);
});

await app.listen({ host: process.env.EXAMPLE_HOST ?? '127.0.0.1', port: 3100 });
