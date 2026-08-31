import { Buffer } from 'node:buffer';

import { parseResourceId } from '@aipay/contracts';
import type { Ed25519WebhookSigner } from '@aipay/worker';
import type { FastifyInstance } from 'fastify';

export function registerClosedTestCallback(
  app: FastifyInstance,
  signer: Ed25519WebhookSigner,
): void {
  app.post(
    '/internal/closed-test/callback',
    { config: { rawBody: true } },
    async (request, reply) => {
      const eventId = request.headers['x-aipay-event-id'];
      const keyId = request.headers['x-aipay-key-id'];
      const timestamp = request.headers['x-aipay-timestamp'];
      const signatureHeader = request.headers['x-aipay-signature'];
      const signature =
        typeof signatureHeader === 'string'
          ? /^ed25519=:([A-Za-z0-9_-]{86}):$/u.exec(signatureHeader)?.[1]
          : undefined;
      const timestampSeconds = typeof timestamp === 'string' ? Number(timestamp) : Number.NaN;
      const rawBody = request.rawBody;

      if (
        typeof eventId !== 'string' ||
        typeof keyId !== 'string' ||
        keyId !== signer.keyId ||
        typeof timestamp !== 'string' ||
        !Number.isSafeInteger(timestampSeconds) ||
        Math.abs(Date.now() / 1_000 - timestampSeconds) > 300 ||
        signature === undefined ||
        rawBody === undefined
      ) {
        return reply.status(401).send();
      }

      let parsedEventId;

      try {
        parsedEventId = parseResourceId(eventId, 'obx');
      } catch {
        return reply.status(401).send();
      }

      const bytes = typeof rawBody === 'string' ? Buffer.from(rawBody) : Buffer.from(rawBody);

      if (!signer.verify(parsedEventId, timestamp, bytes, signature)) {
        return reply.status(401).send();
      }

      return reply.status(204).send();
    },
  );
}
