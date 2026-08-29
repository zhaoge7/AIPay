import { createPrivateKey, createPublicKey } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { parseResourceId, type ResourceId } from '@aipay/contracts';
import type { AlipayA2MClientOptions } from '@aipay/payment';

export interface A2MRuntimeConfig extends AlipayA2MClientOptions {
  readonly merchantId: ResourceId<'mch'> | null;
}

export const DEFAULT_A2M_SANDBOX_PATH = fileURLToPath(
  new URL('../../../../.alipay-sandbox.json', import.meta.url),
);

function environmentRecord(environment: unknown): Readonly<Record<string, unknown>> {
  if (typeof environment !== 'object' || environment === null) {
    throw new Error('A2M environment is invalid');
  }

  return environment as Readonly<Record<string, unknown>>;
}

function requiredString(record: Readonly<Record<string, unknown>>, name: string): string {
  const value = record[name];

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`A2M configuration is missing ${name}`);
  }

  return value;
}

function firstSandboxApplication(
  record: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const appIds = record.appIds;
  const applications = Array.isArray(appIds) ? (appIds as readonly unknown[]) : [];
  const application = applications[0];

  if (typeof application !== 'object' || application === null || Array.isArray(application)) {
    throw new Error('A2M sandbox configuration has no application');
  }

  return application as Readonly<Record<string, unknown>>;
}

function validateCommon(config: A2MRuntimeConfig): Readonly<A2MRuntimeConfig> {
  if (!/^\d{16,32}$/u.test(config.appId)) {
    throw new Error('A2M app ID is invalid');
  }

  if (!/^2088\d{12}$/u.test(config.sellerId)) {
    throw new Error('A2M seller ID is invalid');
  }

  try {
    const privateKeyBytes = Buffer.from(config.privateKeyPkcs1Base64, 'base64');
    const publicKeyBytes = Buffer.from(config.alipayPublicKeySpkiBase64, 'base64');

    if (
      privateKeyBytes.toString('base64') !== config.privateKeyPkcs1Base64 ||
      publicKeyBytes.toString('base64') !== config.alipayPublicKeySpkiBase64
    ) {
      throw new Error('invalid');
    }

    const privateKey = createPrivateKey({
      key: privateKeyBytes,
      format: 'der',
      type: 'pkcs1',
    });
    const publicKey = createPublicKey({
      key: publicKeyBytes,
      format: 'der',
      type: 'spki',
    });

    if (
      privateKey.asymmetricKeyType !== 'rsa' ||
      publicKey.asymmetricKeyType !== 'rsa' ||
      (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048 ||
      (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    ) {
      throw new Error('invalid');
    }
  } catch {
    throw new Error('A2M RSA key configuration is invalid');
  }

  return Object.freeze(config);
}

async function loadSandbox(path: string): Promise<Readonly<A2MRuntimeConfig>> {
  const metadata = await lstat(path);

  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error('A2M sandbox configuration is not protected');
  }

  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const record = environmentRecord(parsed);
  const application = firstSandboxApplication(record);
  return validateCommon({
    appId: requiredString(application, 'appId'),
    privateKeyPkcs1Base64: requiredString(application, 'appPrivatePkcsKey'),
    alipayPublicKeySpkiBase64: requiredString(application, 'alipayPublicKey'),
    gatewayUrl: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
    sellerId: requiredString(application, 'pid'),
    sellerName: 'AIPay',
    serviceId: 'api_mock_service_id',
    sandbox: true,
    merchantId: null,
  });
}

function loadProduction(environment: Readonly<Record<string, unknown>>) {
  const merchantId = parseResourceId(requiredString(environment, 'AIPAY_A2M_MERCHANT_ID'), 'mch');
  return validateCommon({
    appId: requiredString(environment, 'AIPAY_A2M_APP_ID'),
    privateKeyPkcs1Base64: requiredString(environment, 'AIPAY_A2M_PRIVATE_PKCS_KEY'),
    alipayPublicKeySpkiBase64: requiredString(environment, 'AIPAY_A2M_ALIPAY_PUBLIC_KEY'),
    gatewayUrl: 'https://openapi.alipay.com/gateway.do',
    sellerId: requiredString(environment, 'AIPAY_A2M_SELLER_ID'),
    sellerName: requiredString(environment, 'AIPAY_A2M_SELLER_NAME'),
    serviceId: requiredString(environment, 'AIPAY_A2M_SERVICE_ID'),
    sandbox: false,
    merchantId,
  });
}

export async function loadA2MRuntimeConfig(
  environment: unknown,
  sandboxPath = DEFAULT_A2M_SANDBOX_PATH,
): Promise<Readonly<A2MRuntimeConfig>> {
  const record = environmentRecord(environment);
  const mode = record.AIPAY_A2M_MODE;

  if (record.NODE_ENV === 'production' && mode !== 'production') {
    throw new Error('A2M production mode must be explicit');
  }

  if (mode === 'production') {
    return loadProduction(record);
  }

  if (mode !== undefined && mode !== 'sandbox') {
    throw new Error('A2M mode is invalid');
  }

  return loadSandbox(sandboxPath);
}
