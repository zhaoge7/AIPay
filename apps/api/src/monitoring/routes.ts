import { createHash, timingSafeEqual } from 'node:crypto';

import { createApiProblem } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { createTraceId, sendProblem } from '../http/problem.js';
import { MonitoringService } from './service.js';

function tokenHash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function registerMonitoringRoutes(
  app: FastifyInstance,
  database: Database,
  metricsToken: string,
): void {
  if (metricsToken.length < 32) {
    throw new Error('Metrics token must contain at least 32 characters');
  }

  const expectedHash = tokenHash(metricsToken);
  const service = new MonitoringService(database);

  app.get('/internal/metrics', async (request: FastifyRequest, reply) => {
    const provided = request.headers.authorization;
    const match = typeof provided === 'string' ? /^Bearer ([^\s]+)$/u.exec(provided) : null;
    const actualHash = match?.[1] === undefined ? null : tokenHash(match[1]);

    if (
      actualHash?.byteLength !== expectedHash.byteLength ||
      !timingSafeEqual(actualHash, expectedHash)
    ) {
      return sendProblem(reply, createApiProblem('UNAUTHENTICATED', createTraceId()));
    }

    return reply.type(service.contentType).send(await service.metrics());
  });
}
