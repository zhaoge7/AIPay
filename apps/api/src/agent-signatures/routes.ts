import { Buffer } from 'node:buffer';

import { createApiProblem, createApiSuccess, type ResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { createTraceId, sendProblem } from '../http/problem.js';
import { AgentSignatureError, AgentSignatureService } from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    authenticatedAgentId: ResourceId<'agt'> | null;
    authenticatedSigningKeyId: ResourceId<'key'> | null;
  }
}

const verifyBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: { action: { type: 'string', const: 'verify' } },
} as const;

interface VerifyBody {
  readonly action: 'verify';
}

function toSignatureRequest(request: FastifyRequest) {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }

  const host = headers.host;
  const rawUrl = request.raw.url;

  if (host === undefined || rawUrl === undefined) {
    throw new AgentSignatureError('invalid_profile');
  }

  return {
    method: request.method,
    url: `${request.protocol}://${host}${rawUrl}`,
    headers,
    body:
      request.rawBody === undefined
        ? Buffer.alloc(0)
        : typeof request.rawBody === 'string'
          ? request.rawBody
          : Buffer.from(request.rawBody),
  };
}

function sendSignatureError(reply: FastifyReply, traceId: string, error: AgentSignatureError) {
  if (error.code === 'replay_detected') {
    return sendProblem(reply, createApiProblem('REPLAY_DETECTED', traceId));
  }

  if (error.code === 'agent_disabled') {
    return sendProblem(reply, createApiProblem('AUTHORIZATION_DENIED', traceId));
  }

  return sendProblem(reply, createApiProblem('SIGNATURE_INVALID', traceId));
}

export function registerAgentSignatureRoutes(app: FastifyInstance, database: Database): void {
  const requireAgentSignature = createRequireAgentSignature(database);

  app.post<{ Body: VerifyBody }>(
    '/v1/agent/verify',
    {
      config: { rawBody: true },
      schema: { body: verifyBodySchema },
      preHandler: requireAgentSignature,
    },
    async (request, reply) => {
      if (request.authenticatedAgentId === null || request.authenticatedSigningKeyId === null) {
        throw new Error('Authenticated Agent is missing after signature pre-handler');
      }

      return reply.send(
        createApiSuccess(
          {
            agentId: request.authenticatedAgentId,
            keyId: request.authenticatedSigningKeyId,
          },
          createTraceId(),
        ),
      );
    },
  );
}

export function createRequireAgentSignature(database: Database) {
  const service = new AgentSignatureService(database);

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const traceId = createTraceId();

    try {
      const verified = await service.verify(toSignatureRequest(request));
      request.authenticatedAgentId = verified.agentId;
      request.authenticatedSigningKeyId = verified.keyId;
    } catch (error) {
      if (error instanceof AgentSignatureError) {
        return sendSignatureError(reply, traceId, error);
      }

      throw error;
    }
  };
}
