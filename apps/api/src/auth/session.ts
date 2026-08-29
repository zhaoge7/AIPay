import { createHash } from 'node:crypto';

import { createApiProblem, parseResourceId, type ResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ApiKeyError, ApiKeyService } from '../api-keys/service.js';
import { createTraceId, sendProblem } from '../http/problem.js';

const sessionTokenPattern = /^aps_[A-Za-z0-9_-]{43}$/u;

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedDeveloperId: ResourceId<'dev'> | null;
  }
}

export async function authenticateSession(
  database: Database,
  token: string,
  now = new Date(),
): Promise<ResourceId<'dev'> | undefined> {
  if (!sessionTokenPattern.test(token)) {
    return undefined;
  }

  const tokenHash = createHash('sha256').update(token, 'utf8').digest();
  const session = await database
    .selectFrom('authSessions')
    .innerJoin('developers', 'developers.id', 'authSessions.developerId')
    .select(['authSessions.id', 'authSessions.developerId'])
    .where('authSessions.tokenHash', '=', tokenHash)
    .where('authSessions.revokedAt', 'is', null)
    .where('authSessions.expiresAt', '>', now)
    .where('developers.status', '=', 'active')
    .executeTakeFirst();

  if (session === undefined) {
    return undefined;
  }

  await database
    .updateTable('authSessions')
    .set({ lastUsedAt: now })
    .where('id', '=', session.id)
    .executeTakeFirst();

  return parseResourceId(`dev_${session.developerId}`, 'dev');
}

export function createRequireDeveloper(database: Database) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionToken = request.cookies.aipay_session;
    const sessionDeveloperId =
      typeof sessionToken === 'string'
        ? await authenticateSession(database, sessionToken)
        : undefined;
    const authorization = request.headers.authorization;
    const bearerMatch =
      typeof authorization === 'string' ? /^Bearer ([^\s]+)$/u.exec(authorization) : null;
    let apiKeyDeveloperId: ResourceId<'dev'> | undefined;

    if (bearerMatch?.[1] !== undefined) {
      try {
        apiKeyDeveloperId = await new ApiKeyService(database).authenticate(bearerMatch[1]);
      } catch (error) {
        if (!(error instanceof ApiKeyError && error.code === 'invalid_token')) {
          throw error;
        }
      }
    }

    if (
      sessionDeveloperId !== undefined &&
      apiKeyDeveloperId !== undefined &&
      sessionDeveloperId !== apiKeyDeveloperId
    ) {
      return sendProblem(reply, createApiProblem('UNAUTHENTICATED', createTraceId()));
    }

    const developerId = sessionDeveloperId ?? apiKeyDeveloperId;

    if (developerId === undefined) {
      return sendProblem(reply, createApiProblem('UNAUTHENTICATED', createTraceId()));
    }

    request.authenticatedDeveloperId = developerId;
  };
}

export function createRequireSession(database: Database) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies.aipay_session;
    const developerId =
      typeof token === 'string' ? await authenticateSession(database, token) : undefined;

    if (developerId === undefined) {
      return sendProblem(reply, createApiProblem('UNAUTHENTICATED', createTraceId()));
    }

    request.authenticatedDeveloperId = developerId;
  };
}
