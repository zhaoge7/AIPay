import { lookup } from 'node:dns/promises';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { MerchantClient } from '@aipay/sdk-ts';
import ipaddr from 'ipaddr.js';

import { loadMerchantAdapterConfig } from './config.js';
import { createMerchantAdapterApp } from './server.js';
import { MerchantAdapterService } from './service.js';
import { PostgresAdapterDeliveryStore } from './store.js';

async function requirePublicUpstream(upstreamOrigin: string): Promise<void> {
  const addresses = await lookup(new URL(upstreamOrigin).hostname, { all: true, verbatim: true });

  if (
    addresses.length === 0 ||
    addresses.some(({ address }) => ipaddr.process(address).range() !== 'unicast')
  ) {
    throw new Error('AIPAY_UPSTREAM_ORIGIN must resolve only to public unicast addresses');
  }
}

export async function startMerchantAdapter(environment: NodeJS.ProcessEnv = process.env) {
  const config = loadMerchantAdapterConfig(environment);
  await requirePublicUpstream(config.upstreamOrigin);
  const store = new PostgresAdapterDeliveryStore(config.databaseUrl);
  await store.initialize();
  const merchant = new MerchantClient({
    baseUrl: config.aipayBaseUrl,
    apiKey: config.apiKey,
    merchantId: config.merchantId,
    keyId: config.keyId,
    privateKeyPkcs8Base64: config.privateKeyPkcs8Base64,
  });
  const service = new MerchantAdapterService(config, merchant, store);
  const app = createMerchantAdapterApp(config, service);
  app.addHook('onClose', async () => store.close());
  await app.listen({ host: config.host, port: config.port });
  return app;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startMerchantAdapter();
  const close = async () => app.close();
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

export { loadMerchantAdapterConfig } from './config.js';
export { createMerchantAdapterApp } from './server.js';
export { MerchantAdapterError, MerchantAdapterService } from './service.js';
export { PostgresAdapterDeliveryStore } from './store.js';
