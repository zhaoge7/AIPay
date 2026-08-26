import { randomBytes } from 'node:crypto';

import cookie from '@fastify/cookie';
import {
  API_PROBLEM_MEDIA_TYPE,
  createApiProblem,
  createApiSuccess,
  type ApiProblemWire,
} from '@aipay/contracts';
import type { Database } from '@aipay/database';
import Fastify, { type FastifyError, type FastifyReply } from 'fastify';

import { AuthError, AuthService, type AuthResult } from './auth/service.js';

const authBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'password'],
  properties: {
    email: { type: 'string', minLength: 1, maxLength: 254 },
    password: { type: 'string', minLength: 1, maxLength: 1_024 },
  },
} as const;

interface AuthBody {
  readonly email: string;
  readonly password: string;
}

export interface BuildAppOptions {
  readonly database: Database;
  readonly secureCookies?: boolean;
  readonly logger?: boolean;
}

function createTraceId(): string {
  return randomBytes(16).toString('hex');
}

function sendProblem(reply: FastifyReply, problem: Readonly<ApiProblemWire>) {
  return reply.type(API_PROBLEM_MEDIA_TYPE).status(problem.status).send(problem);
}

function sendAuthError(reply: FastifyReply, traceId: string, error: AuthError) {
  if (error.code === 'invalid_credentials') {
    return sendProblem(reply, createApiProblem('UNAUTHENTICATED', traceId));
  }

  const pointer = error.code === 'invalid_password' ? '/password' : '/email';
  return sendProblem(
    reply,
    createApiProblem('INVALID_REQUEST', traceId, {
      errors: [{ code: error.code, pointer }],
    }),
  );
}

function setSessionCookie(
  reply: FastifyReply,
  result: Readonly<AuthResult>,
  secure: boolean,
): void {
  const maxAgeSeconds = Math.floor((Date.parse(result.sessionExpiresAt) - Date.now()) / 1_000);
  reply.setCookie('aipay_session', result.sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
    maxAge: Math.max(1, maxAgeSeconds),
  });
}

function isValidationError(error: unknown): error is FastifyError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'validation' in error &&
    Array.isArray(error.validation)
  );
}

export async function buildApp(options: BuildAppOptions) {
  const app = Fastify({
    logger: options.logger ?? false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const authService = new AuthService(options.database);
  const secureCookies = options.secureCookies ?? false;

  await app.register(cookie);

  app.setErrorHandler((error, request, reply) => {
    const traceId = createTraceId();

    if (isValidationError(error)) {
      return sendProblem(
        reply,
        createApiProblem('INVALID_REQUEST', traceId, {
          errors: [{ code: 'invalid_request_body', pointer: '/' }],
        }),
      );
    }

    request.log.error({ error, traceId }, 'Unhandled API error');
    return sendProblem(reply, createApiProblem('INTERNAL_ERROR', traceId));
  });

  app.post<{ Body: AuthBody }>(
    '/v1/auth/register',
    { schema: { body: authBodySchema } },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await authService.register(request.body.email, request.body.password);
        setSessionCookie(reply, result, secureCookies);
        return await reply.status(201).send(createApiSuccess(result.developer, traceId));
      } catch (error) {
        if (error instanceof AuthError) {
          return sendAuthError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  app.post<{ Body: AuthBody }>(
    '/v1/auth/login',
    { schema: { body: authBodySchema } },
    async (request, reply) => {
      const traceId = createTraceId();

      try {
        const result = await authService.login(request.body.email, request.body.password);
        setSessionCookie(reply, result, secureCookies);
        return await reply.send(createApiSuccess(result.developer, traceId));
      } catch (error) {
        if (error instanceof AuthError) {
          return sendAuthError(reply, traceId, error);
        }

        throw error;
      }
    },
  );

  return app;
}
