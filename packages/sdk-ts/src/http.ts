import type { ApiErrorCode, ApiErrorKind } from '@aipay/contracts';

export type FetchLike = typeof fetch;

export class AIPayApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | 'UNEXPECTED_RESPONSE';
  readonly kind: ApiErrorKind | 'system';
  readonly retryable: boolean;
  readonly traceId: string | null;

  constructor(input: {
    readonly status: number;
    readonly code: ApiErrorCode | 'UNEXPECTED_RESPONSE';
    readonly kind?: ApiErrorKind | 'system';
    readonly retryable?: boolean;
    readonly traceId?: string | null;
  }) {
    super(`AIPay request failed with ${input.code}`);
    this.name = 'AIPayApiError';
    this.status = input.status;
    this.code = input.code;
    this.kind = input.kind ?? 'system';
    this.retryable = input.retryable ?? false;
    this.traceId = input.traceId ?? null;
  }
}

export function normalizeBaseUrl(value: string): URL {
  const url = new URL(value);
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';

  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  ) {
    throw new Error('AIPay base URL must be HTTPS or an HTTP loopback URL without credentials');
  }

  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`;
  return url;
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export async function responseData<Data>(response: Response): Promise<Data> {
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new AIPayApiError({ status: response.status, code: 'UNEXPECTED_RESPONSE' });
  }

  const root = record(payload);

  if (!response.ok) {
    const code = typeof root?.code === 'string' ? root.code : 'UNEXPECTED_RESPONSE';
    throw new AIPayApiError({
      status: response.status,
      code: code as AIPayApiError['code'],
      kind: typeof root?.kind === 'string' ? (root.kind as ApiErrorKind) : 'system',
      retryable: root?.retryable === true,
      traceId: typeof root?.traceId === 'string' ? root.traceId : null,
    });
  }

  if (root === null || !('data' in root)) {
    throw new AIPayApiError({ status: response.status, code: 'UNEXPECTED_RESPONSE' });
  }

  return root.data as Data;
}
