import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import http from 'node:http';
import test from 'node:test';

import { SafeWebhookTransport, WebhookTransportError } from '../dist/webhooks/transport.js';

const request = (url) => ({
  url,
  headers: { 'content-type': 'application/json', 'x-aipay-event-id': 'obx_test' },
  body: Buffer.from('{"ok":true}', 'utf8'),
});

test('rejects unsafe Webhook targets before connecting', async () => {
  const transport = new SafeWebhookTransport();
  const unsafeTargets = [
    'ftp://example.com/hook',
    'https://user:password@example.com/hook',
    'https://example.com/hook#fragment',
    'http://8.8.8.8/hook',
    'https://10.0.0.1/hook',
    'https://127.0.0.1/hook',
    'https://[::1]/hook',
  ];

  for (const target of unsafeTargets) {
    await assert.rejects(
      transport.deliver(request(target)),
      (error) => error instanceof WebhookTransportError && error.code === 'INVALID_TARGET',
    );
  }
});

test('allows explicit development loopback HTTP and preserves request metadata', async (context) => {
  let received;
  const server = http.createServer((incoming, response) => {
    const chunks = [];
    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      received = {
        method: incoming.method,
        url: incoming.url,
        host: incoming.headers.host,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      response.writeHead(202);
      response.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);
  const target = `http://127.0.0.1:${address.port}/aipay/hook?source=test`;

  const transport = new SafeWebhookTransport({ allowLoopbackHttp: true, timeoutMs: 1_000 });
  assert.deepEqual(await transport.deliver(request(target)), { statusCode: 202 });
  assert.deepEqual(received, {
    method: 'POST',
    url: '/aipay/hook?source=test',
    host: `127.0.0.1:${address.port}`,
    body: '{"ok":true}',
  });
});
