import { lookup } from 'node:dns/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { AgentClient } from '@aipay/sdk-ts';
import ipaddr from 'ipaddr.js';

import { loadAgentBridgeConfig } from './config.js';
import { createAgentBridgeApp } from './server.js';
import { AgentBridgeService } from './service.js';
import { BridgeTokenSigner } from './tokens.js';

async function requirePublicResourceOrigin(resourceOrigin: string): Promise<void> {
  const { hostname } = new URL(resourceOrigin);
  const addresses = await lookup(hostname, { all: true, verbatim: true });

  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast')
  ) {
    throw new Error('AIPAY_RESOURCE_ORIGIN must resolve only to public unicast addresses');
  }
}

export async function startAgentBridge(environment: NodeJS.ProcessEnv = process.env) {
  const config = loadAgentBridgeConfig(environment);
  await requirePublicResourceOrigin(config.resourceOrigin);
  const agent = new AgentClient({
    baseUrl: config.aipayBaseUrl,
    agentId: config.agentId,
    keyId: config.keyId,
    privateKeyPkcs8Base64: config.privateKeyPkcs8Base64,
  });
  const service = new AgentBridgeService(
    config,
    agent,
    fetch,
    new BridgeTokenSigner(config.bearerToken),
  );
  const app = createAgentBridgeApp(config, service);
  await app.listen({ host: config.host, port: config.port });
  return app;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startAgentBridge();
  const close = async () => app.close();
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

export { loadAgentBridgeConfig } from './config.js';
export { createAgentBridgeApp, createAgentBridgeMcpServer } from './server.js';
export { AgentBridgeError, AgentBridgeService, type AgentPaymentPort } from './service.js';
export { BridgeTokenError, BridgeTokenSigner } from './tokens.js';
