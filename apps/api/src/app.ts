import cookie from '@fastify/cookie';
import rawBody from 'fastify-raw-body';
import { createApiProblem, createApiSuccess } from '@aipay/contracts';
import type { Database } from '@aipay/database';
import type { PaymentProvider } from '@aipay/payment';
import Fastify, { type FastifyError, type FastifyReply } from 'fastify';

import { registerAgentRoutes } from './agents/routes.js';
import { registerA2MRoutes } from './a2m/routes.js';
import type { A2MService } from './a2m/service.js';
import { registerAgentSignatureRoutes } from './agent-signatures/routes.js';
import { registerApiKeyRoutes } from './api-keys/routes.js';
import { AuthError, AuthService, type AuthResult } from './auth/service.js';
import { createRequireSession } from './auth/session.js';
import { createTraceId, sendProblem } from './http/problem.js';
import { registerMerchantRoutes } from './merchants/routes.js';
import { registerDeliveryReceiptRoutes } from './deliveries/routes.js';
import { registerMandateRoutes } from './mandates/routes.js';
import type { MandateIssuer } from './mandates/issuer.js';
import { registerMandateLifecycleRoutes } from './mandates/lifecycle-routes.js';
import { registerCatalogRoutes } from './services/catalog-routes.js';
import { registerServiceRoutes } from './services/routes.js';
import { registerQuoteRoutes } from './quotes/routes.js';
import { registerQuoteSigningRoutes } from './quotes/signing-routes.js';
import { registerAgentPaymentRoutes } from './payments/agent-routes.js';
import { registerAlipayWebhookRoutes } from './payments/webhook-routes.js';
import { registerPaymentProofRoutes } from './payments/proof-routes.js';
import type { PaymentProofIssuer } from './payments/proofs.js';
import { registerManualApprovalRoutes } from './transactions/manual-approval-routes.js';
import { registerTransactionCreationRoutes } from './transactions/create-routes.js';
import { registerTransactionQueryRoutes } from './transactions/query-routes.js';
import { registerTimelineRoutes } from './timeline/routes.js';

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
  readonly mandateIssuer?: MandateIssuer;
  readonly paymentProvider?: PaymentProvider;
  readonly paymentCallbackUrl?: string;
  readonly alipayProvider?: PaymentProvider;
  readonly paymentProofIssuer?: PaymentProofIssuer;
  readonly a2mService?: A2MService;
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
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const authService = new AuthService(options.database);
  const requireSession = createRequireSession(options.database);
  const secureCookies = options.secureCookies ?? false;

  await app.register(cookie);
  await app.register(rawBody, { global: false, encoding: false, runFirst: true });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'buffer' },
    (_request, body, done) => {
      done(null, body);
    },
  );
  app.decorateRequest('authenticatedDeveloperId', null);
  app.decorateRequest('authenticatedAgentId', null);
  app.decorateRequest('authenticatedSigningKeyId', null);
  registerApiKeyRoutes(app, options.database);
  registerAgentRoutes(app, options.database);
  if (options.a2mService !== undefined) {
    registerA2MRoutes(app, options.a2mService);
  }
  registerAgentSignatureRoutes(app, options.database);
  registerMerchantRoutes(app, options.database);
  registerDeliveryReceiptRoutes(app, options.database);
  registerServiceRoutes(app, options.database);
  registerCatalogRoutes(app, options.database);
  registerMandateRoutes(app, options.database, options.mandateIssuer);
  registerMandateLifecycleRoutes(app, options.database);
  registerManualApprovalRoutes(app, options.database);
  registerQuoteRoutes(app, options.database);
  registerQuoteSigningRoutes(app, options.database);
  registerTransactionCreationRoutes(app, options.database);
  registerTransactionQueryRoutes(app, options.database);
  registerTimelineRoutes(app, options.database);
  const paymentProvider = options.paymentProvider ?? options.alipayProvider;

  if (paymentProvider !== undefined) {
    registerAgentPaymentRoutes(
      app,
      options.database,
      paymentProvider,
      options.paymentCallbackUrl ?? 'http://127.0.0.1/v1/payments/alipay/webhook',
    );
  }
  if (options.alipayProvider !== undefined) {
    registerAlipayWebhookRoutes(app, options.database, options.alipayProvider);
  }
  if (options.paymentProofIssuer !== undefined) {
    registerPaymentProofRoutes(app, options.database, options.paymentProofIssuer);
  }

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

  app.get('/v1/auth/session', { preHandler: requireSession }, async (request, reply) => {
    if (request.authenticatedDeveloperId === null) {
      throw new Error('Authenticated developer is missing after pre-handler');
    }

    const developer = await authService.current(request.authenticatedDeveloperId);
    return reply.send(createApiSuccess(developer, createTraceId()));
  });

  app.post('/v1/auth/logout', { preHandler: requireSession }, async (request, reply) => {
    const sessionToken = request.cookies.aipay_session;

    if (typeof sessionToken !== 'string') {
      return sendProblem(reply, createApiProblem('UNAUTHENTICATED', createTraceId()));
    }

    try {
      await authService.logout(sessionToken);
      reply.clearCookie('aipay_session', { path: '/' });
      return await reply.send(createApiSuccess({ loggedOut: true }, createTraceId()));
    } catch (error) {
      if (error instanceof AuthError) {
        return sendAuthError(reply, createTraceId(), error);
      }

      throw error;
    }
  });

  return app;
}
