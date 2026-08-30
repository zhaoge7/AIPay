import { createHash } from 'node:crypto';

import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export interface RateLimitOptions {
  readonly ipMax?: number;
  readonly accountMax?: number;
  readonly agentMax?: number;
  readonly sensitiveMax?: number;
  readonly timeWindowMs?: number;
}

export const DEFAULT_RATE_LIMITS = Object.freeze({
  ipMax: 120,
  accountMax: 60,
  agentMax: 60,
  sensitiveMax: 10,
  timeWindowMs: 60_000,
});

export class RateLimitExceededError extends Error {
  readonly statusCode = 429;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('Rate limit exceeded');
    this.name = 'RateLimitExceededError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function digest(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function credentialKey(request: FastifyRequest) {
  const authorization = request.headers.authorization;

  if (typeof authorization === 'string') {
    return `credential:${digest(authorization)}`;
  }

  const session = request.cookies.aipay_session;
  return typeof session === 'string' ? `credential:${digest(session)}` : null;
}

function agentKey(request: FastifyRequest) {
  const agentId = request.headers['x-aipay-agent-id'];
  return typeof agentId === 'string' ? `agent:${request.ip}:${agentId}` : null;
}

function sensitiveInterface(request: FastifyRequest) {
  if (request.method === 'GET') return false;
  const path = request.routeOptions.url ?? request.url;
  return (
    path.startsWith('/v1/auth/') ||
    path === '/v1/transactions' ||
    path.includes('/confirmation') ||
    path.includes('/payment') ||
    path.includes('/rotate') ||
    path === '/v1/payment-controls'
  );
}

export async function registerRateLimits(
  app: FastifyInstance,
  options: RateLimitOptions = {},
): Promise<void> {
  const limits = { ...DEFAULT_RATE_LIMITS, ...options };
  await app.register(rateLimit, {
    global: true,
    max: limits.ipMax,
    timeWindow: limits.timeWindowMs,
    skipOnError: false,
  });
  const accountLimiter = app.createRateLimit({
    max: limits.accountMax,
    timeWindow: limits.timeWindowMs,
    keyGenerator: (request) => credentialKey(request) ?? `anonymous:${request.ip}`,
  });
  const agentLimiter = app.createRateLimit({
    max: limits.agentMax,
    timeWindow: limits.timeWindowMs,
    keyGenerator: (request) => agentKey(request) ?? `anonymous-agent:${request.ip}`,
  });
  const sensitiveLimiter = app.createRateLimit({
    max: limits.sensitiveMax,
    timeWindow: limits.timeWindowMs,
    keyGenerator: (request) => {
      const identity = credentialKey(request) ?? agentKey(request) ?? `ip:${request.ip}`;
      return `interface:${request.method}:${request.routeOptions.url ?? request.url}:${identity}`;
    },
  });
  const enforce = async (
    limiter: typeof accountLimiter,
    request: FastifyRequest,
  ): Promise<void> => {
    const result = await limiter(request);

    if (!result.isAllowed && result.isExceeded) {
      throw new RateLimitExceededError(Math.max(1, result.ttlInSeconds));
    }
  };

  app.addHook('preHandler', async (request) => {
    if (credentialKey(request) !== null) {
      await enforce(accountLimiter, request);
    }

    if (agentKey(request) !== null) {
      await enforce(agentLimiter, request);
    }

    if (sensitiveInterface(request)) {
      await enforce(sensitiveLimiter, request);
    }
  });
}
