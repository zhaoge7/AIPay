export interface DeveloperSession {
  readonly developerId: string;
  readonly email: string;
  readonly createdAt: string;
}

interface SuccessEnvelope<Data> {
  readonly data: Data;
  readonly meta: Readonly<{ traceId: string }>;
}

interface ProblemDetails {
  readonly code?: string;
  readonly title?: string;
  readonly traceId?: string;
}

export class ConsoleApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId: string | null;

  constructor(status: number, problem: ProblemDetails = {}) {
    super(problem.title ?? '请求未完成');
    this.name = 'ConsoleApiError';
    this.status = status;
    this.code = problem.code ?? 'UNEXPECTED_RESPONSE';
    this.traceId = problem.traceId ?? null;
  }
}

async function request<Data>(path: string, init: RequestInit = {}): Promise<Data> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers,
  });
  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    throw new ConsoleApiError(response.status);
  }

  if (!response.ok) {
    const problem =
      typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    throw new ConsoleApiError(response.status, {
      ...(typeof problem.code === 'string' ? { code: problem.code } : {}),
      ...(typeof problem.title === 'string' ? { title: problem.title } : {}),
      ...(typeof problem.traceId === 'string' ? { traceId: problem.traceId } : {}),
    });
  }

  if (typeof payload !== 'object' || payload === null || !('data' in payload)) {
    throw new ConsoleApiError(response.status);
  }

  return (payload as SuccessEnvelope<Data>).data;
}

export const consoleApi = Object.freeze({
  session: () => request<DeveloperSession>('/v1/auth/session'),
  login: (email: string, password: string) =>
    request<DeveloperSession>('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string) =>
    request<DeveloperSession>('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ readonly loggedOut: true }>('/v1/auth/logout', { method: 'POST' }),
});
