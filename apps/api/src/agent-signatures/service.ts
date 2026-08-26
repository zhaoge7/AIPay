import { Buffer } from 'node:buffer';
import { createHash, webcrypto } from 'node:crypto';

import {
  createWebCryptoVerifier,
  parseSignature,
  verifySignature,
  type ParsedSignature,
  type SignatureRequest,
} from '@peac/http-signatures';
import { getResourceUuid, parseResourceId, type ResourceId } from '@aipay/contracts';
import type { Database } from '@aipay/database';

const requiredComponents = [
  '@method',
  '@target-uri',
  'content-digest',
  'content-type',
  'x-aipay-agent-id',
] as const;
const signatureWindowSeconds = 300;
const clockSkewSeconds = 30;
const noncePattern = /^[A-Za-z0-9_-]{22}$/u;

export type AgentSignatureErrorCode =
  | 'missing_signature'
  | 'invalid_profile'
  | 'invalid_content_digest'
  | 'invalid_time_window'
  | 'invalid_agent'
  | 'agent_disabled'
  | 'invalid_signature'
  | 'replay_detected';

export class AgentSignatureError extends Error {
  readonly code: AgentSignatureErrorCode;

  constructor(code: AgentSignatureErrorCode) {
    super('Agent request authentication failed');
    this.name = 'AgentSignatureError';
    this.code = code;
  }
}

export interface VerifiedAgentRequest {
  readonly agentId: ResourceId<'agt'>;
  readonly keyId: ResourceId<'key'>;
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }

  return undefined;
}

function assertExactProfile(signature: ParsedSignature, nowSeconds: number) {
  const { params } = signature;

  if (
    signature.label !== 'aipay' ||
    params.alg !== 'ed25519' ||
    params.tag !== 'aipay-agent-v1' ||
    params.created === undefined ||
    params.expires === undefined ||
    params.nonce === undefined ||
    params.coveredComponents.length !== requiredComponents.length ||
    !params.coveredComponents.every((component, index) => component === requiredComponents[index])
  ) {
    throw new AgentSignatureError('invalid_profile');
  }

  const nonceBytes = noncePattern.test(params.nonce)
    ? Buffer.from(params.nonce, 'base64url')
    : undefined;

  if (nonceBytes?.byteLength !== 16 || nonceBytes.toString('base64url') !== params.nonce) {
    throw new AgentSignatureError('invalid_profile');
  }

  if (
    !Number.isSafeInteger(params.created) ||
    !Number.isSafeInteger(params.expires) ||
    params.expires <= params.created ||
    params.expires - params.created > signatureWindowSeconds ||
    params.created > nowSeconds + clockSkewSeconds ||
    nowSeconds - params.created > signatureWindowSeconds ||
    nowSeconds > params.expires
  ) {
    throw new AgentSignatureError('invalid_time_window');
  }

  return Object.freeze({ nonce: params.nonce, expires: params.expires });
}

function assertContentDigest(request: SignatureRequest): void {
  const contentDigest = getHeader(request.headers, 'content-digest');
  const body = request.body;

  if (contentDigest === undefined || body === undefined) {
    throw new AgentSignatureError('invalid_content_digest');
  }

  const bodyBytes =
    typeof body === 'string'
      ? Buffer.from(body, 'utf8')
      : body instanceof Uint8Array
        ? Buffer.from(body)
        : Buffer.from(body);
  const expected = `sha-256=:${createHash('sha256').update(bodyBytes).digest('base64')}:`;

  if (contentDigest !== expected) {
    throw new AgentSignatureError('invalid_content_digest');
  }
}

function hasDatabaseConstraint(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    error.constraint === constraint
  );
}

export class AgentSignatureService {
  readonly #database: Database;
  readonly #now: () => Date;

  constructor(database: Database, now: () => Date = () => new Date()) {
    this.#database = database;
    this.#now = now;
  }

  async verify(request: SignatureRequest): Promise<Readonly<VerifiedAgentRequest>> {
    const signatureInput = getHeader(request.headers, 'signature-input');
    const signatureHeader = getHeader(request.headers, 'signature');

    if (signatureInput === undefined || signatureHeader === undefined) {
      throw new AgentSignatureError('missing_signature');
    }

    let parsed: ParsedSignature;

    try {
      parsed = parseSignature(signatureInput, signatureHeader, 'aipay');
    } catch {
      throw new AgentSignatureError('invalid_profile');
    }

    const now = this.#now();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const profile = assertExactProfile(parsed, nowSeconds);
    assertContentDigest(request);

    let agentId: ResourceId<'agt'>;
    let keyId: ResourceId<'key'>;

    try {
      agentId = parseResourceId(getHeader(request.headers, 'x-aipay-agent-id'), 'agt');
      keyId = parseResourceId(parsed.params.keyid, 'key');
    } catch {
      throw new AgentSignatureError('invalid_agent');
    }

    const key = await this.#database
      .selectFrom('agents')
      .innerJoin('signingKeys', (join) =>
        join
          .onRef('signingKeys.agentId', '=', 'agents.id')
          .on('signingKeys.ownerType', '=', 'agent'),
      )
      .select(['agents.status as agentStatus', 'signingKeys.publicKey'])
      .where('agents.id', '=', getResourceUuid(agentId))
      .where('signingKeys.id', '=', getResourceUuid(keyId))
      .where('signingKeys.status', '=', 'active')
      .executeTakeFirst();

    if (key === undefined) {
      throw new AgentSignatureError('invalid_agent');
    }

    if (key.agentStatus !== 'enabled') {
      throw new AgentSignatureError('agent_disabled');
    }

    let cryptoKey: webcrypto.CryptoKey;

    try {
      cryptoKey = await webcrypto.subtle.importKey(
        'raw',
        Buffer.from(key.publicKey),
        { name: 'Ed25519' },
        false,
        ['verify'],
      );
    } catch {
      throw new AgentSignatureError('invalid_agent');
    }

    const verification = await verifySignature(request, {
      now: nowSeconds,
      clockSkewSeconds,
      label: 'aipay',
      keyResolver: (requestedKeyId) =>
        Promise.resolve(requestedKeyId === keyId ? createWebCryptoVerifier(cryptoKey) : null),
    });

    if (!verification.valid) {
      throw new AgentSignatureError('invalid_signature');
    }

    const nonceHash = createHash('sha256').update(profile.nonce, 'utf8').digest();
    const retentionExpiresAt = new Date((profile.expires + clockSkewSeconds + 1) * 1_000);

    try {
      await this.#database
        .insertInto('agentRequestNonces')
        .values({
          agentId: getResourceUuid(agentId),
          nonceHash,
          expiresAt: retentionExpiresAt,
        })
        .executeTakeFirstOrThrow();
    } catch (error) {
      if (hasDatabaseConstraint(error, 'agent_request_nonces_agent_hash_unique')) {
        throw new AgentSignatureError('replay_detected');
      }

      throw error;
    }

    return Object.freeze({ agentId, keyId });
  }
}
