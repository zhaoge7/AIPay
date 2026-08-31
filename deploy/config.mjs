import process from 'node:process';
import { URL } from 'node:url';

const localOrigin = 'https://aipay.localhost:8443';

function parseOrigin(value, mode) {
  let origin;

  try {
    origin = new URL(value);
  } catch {
    throw new Error('AIPAY_PUBLIC_ORIGIN must be an absolute HTTPS origin');
  }

  if (
    origin.protocol !== 'https:' ||
    origin.username.length > 0 ||
    origin.password.length > 0 ||
    origin.pathname !== '/' ||
    origin.search.length > 0 ||
    origin.hash.length > 0
  ) {
    throw new Error('AIPAY_PUBLIC_ORIGIN must be an absolute HTTPS origin');
  }

  if (mode === 'external') {
    const hostname = origin.hostname.toLowerCase();

    if (
      origin.port.length > 0 ||
      !hostname.includes('.') ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.test') ||
      hostname.endsWith('.example') ||
      hostname === 'example.com' ||
      hostname.endsWith('.example.com') ||
      hostname === 'example.net' ||
      hostname.endsWith('.example.net') ||
      hostname === 'example.org' ||
      hostname.endsWith('.example.org') ||
      hostname.endsWith('.invalid')
    ) {
      throw new Error('External deployment requires a public hostname on HTTPS port 443');
    }
  }

  return origin;
}

export function loadDeploymentConfig(environment = process.env) {
  const mode = environment.AIPAY_DEPLOYMENT_MODE ?? 'local';

  if (mode !== 'local' && mode !== 'external') {
    throw new Error('AIPAY_DEPLOYMENT_MODE must be local or external');
  }

  const value = environment.AIPAY_PUBLIC_ORIGIN ?? (mode === 'local' ? localOrigin : undefined);

  if (value === undefined) {
    throw new Error('AIPAY_PUBLIC_ORIGIN is required for external deployment');
  }

  const origin = parseOrigin(value, mode);

  if (mode === 'local' && origin.toString().replace(/\/$/u, '') !== localOrigin) {
    throw new Error('Local deployment origin is fixed to aipay.localhost:8443');
  }

  const publicOrigin = origin.toString().replace(/\/$/u, '');

  return Object.freeze({
    mode,
    publicOrigin,
    caddySite: origin.host,
    caddyTlsDirective: mode === 'local' ? '\ttls internal\n' : '',
    paymentProvider: mode === 'local' ? 'fake' : 'alipay_web',
    allowLoopbackWebhooks: mode === 'local',
    requiresInternalCa: mode === 'local',
  });
}

export function renderCaddyfile(template, deployment) {
  const rendered = template
    .replaceAll('@@SITE@@', deployment.caddySite)
    .replaceAll('@@TLS@@', deployment.caddyTlsDirective);

  if (rendered.includes('@@')) {
    throw new Error('Caddyfile template contains an unknown placeholder');
  }

  return rendered;
}
