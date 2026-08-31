import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

import { createMcpFastifyApp } from '@modelcontextprotocol/fastify';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { AgentBridgeConfig } from './config.js';
import { AgentBridgeError, AgentBridgeService } from './service.js';

const querySchema = z.record(z.string(), z.string()).default({});

function toolResult(value: object) {
  return Object.freeze({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
  });
}

function toolError(error: unknown) {
  const code = error instanceof AgentBridgeError ? error.code : 'internal_error';
  const value = Object.freeze({ status: 'error', code });
  return Object.freeze({
    content: [{ type: 'text' as const, text: `AIPay bridge error: ${code}` }],
    structuredContent: value,
    isError: true,
  });
}

export function createAgentBridgeMcpServer(service: AgentBridgeService): McpServer {
  const server = new McpServer({ name: 'aipay-agent-bridge', version: '0.1.0' });

  server.registerTool(
    'aipay_start_paid_get',
    {
      description: 'Start a paid GET request to one operator-approved resource path',
      inputSchema: z.object({ path: z.string(), query: querySchema }),
    },
    async ({ path, query }) => {
      try {
        return toolResult(await service.start(path, query));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    'aipay_resume_payment',
    {
      description: 'Query the exact payment bound by a bridge resume token',
      inputSchema: z.object({ resumeToken: z.string() }),
    },
    async ({ resumeToken }) => {
      try {
        return toolResult(await service.resume(resumeToken));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  server.registerTool(
    'aipay_deliver_paid_get',
    {
      description: 'Present the bound Payment Proof and return the paid JSON resource',
      inputSchema: z.object({ deliveryToken: z.string() }),
    },
    async ({ deliveryToken }) => {
      try {
        return toolResult(await service.deliver(deliveryToken));
      } catch (error) {
        return toolError(error);
      }
    },
  );
  return server;
}

function authenticated(header: string | undefined, expectedToken: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

export function createAgentBridgeApp(config: AgentBridgeConfig, service: AgentBridgeService) {
  const app = createMcpFastifyApp({
    host: config.host,
    allowedHosts: [...config.allowedHosts],
    allowedOrigins: [...config.allowedOrigins],
  });

  app.get('/health', () => Object.freeze({ status: 'ok' }));
  app.addHook('onRequest', (request, reply, done) => {
    if (
      request.url.startsWith('/mcp') &&
      !authenticated(request.headers.authorization, config.bearerToken)
    ) {
      reply.header('www-authenticate', 'Bearer').status(401).send();
      return;
    }

    done();
  });
  app.post('/mcp', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = createAgentBridgeMcpServer(service);
    const close = () => {
      void transport.close();
      void server.close();
    };
    reply.raw.once('close', close);
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });
  app.get('/mcp', (_request, reply) => reply.status(405).send());
  app.delete('/mcp', (_request, reply) => reply.status(405).send());
  return app;
}
