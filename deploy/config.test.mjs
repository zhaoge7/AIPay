import assert from 'node:assert/strict';
import test from 'node:test';

import { loadDeploymentConfig, renderCaddyfile } from './config.mjs';

test('keeps the closed-test local deployment fixed and isolated', () => {
  assert.deepEqual(loadDeploymentConfig({}), {
    mode: 'local',
    publicOrigin: 'https://aipay.localhost:8443',
    caddySite: 'aipay.localhost:8443',
    caddyTlsDirective: '\ttls internal\n',
    paymentProvider: 'fake',
    allowLoopbackWebhooks: true,
    requiresInternalCa: true,
  });
  assert.throws(
    () =>
      loadDeploymentConfig({
        AIPAY_DEPLOYMENT_MODE: 'local',
        AIPAY_PUBLIC_ORIGIN: 'https://other.localhost:8443',
      }),
    /fixed/u,
  );
});

test('requires a public HTTPS port-443 origin and real provider in external mode', () => {
  assert.deepEqual(
    loadDeploymentConfig({
      AIPAY_DEPLOYMENT_MODE: 'external',
      AIPAY_PUBLIC_ORIGIN: 'https://pilot.aipay.cn',
    }),
    {
      mode: 'external',
      publicOrigin: 'https://pilot.aipay.cn',
      caddySite: 'pilot.aipay.cn',
      caddyTlsDirective: '',
      paymentProvider: 'alipay_web',
      allowLoopbackWebhooks: false,
      requiresInternalCa: false,
    },
  );

  for (const publicOrigin of [
    'http://pilot.aipay.example.com',
    'https://pilot.aipay.example.com:8443',
    'https://aipay.localhost',
    'https://pilot.example',
    'https://pilot.aipay.example.com/path',
    'https://pilot.example.com',
  ]) {
    assert.throws(() =>
      loadDeploymentConfig({
        AIPAY_DEPLOYMENT_MODE: 'external',
        AIPAY_PUBLIC_ORIGIN: publicOrigin,
      }),
    );
  }
});

test('rejects missing and unknown external deployment settings', () => {
  assert.throws(
    () => loadDeploymentConfig({ AIPAY_DEPLOYMENT_MODE: 'external' }),
    /AIPAY_PUBLIC_ORIGIN/u,
  );
  assert.throws(
    () => loadDeploymentConfig({ AIPAY_DEPLOYMENT_MODE: 'preview' }),
    /AIPAY_DEPLOYMENT_MODE/u,
  );
});

test('renders mutually exclusive internal and public TLS Caddy sites', () => {
  const template = '@@SITE@@ {\n@@TLS@@\tencode gzip\n}\n';
  const local = renderCaddyfile(template, loadDeploymentConfig({}));
  const external = renderCaddyfile(
    template,
    loadDeploymentConfig({
      AIPAY_DEPLOYMENT_MODE: 'external',
      AIPAY_PUBLIC_ORIGIN: 'https://pilot.aipay.cn',
    }),
  );

  assert.match(local, /aipay\.localhost:8443/u);
  assert.match(local, /tls internal/u);
  assert.match(external, /pilot\.aipay\.cn/u);
  assert.doesNotMatch(external, /tls internal/u);
  assert.throws(
    () => renderCaddyfile(`${template}@@UNKNOWN@@`, loadDeploymentConfig({})),
    /unknown placeholder/u,
  );
});
