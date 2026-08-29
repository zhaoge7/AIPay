export interface DeveloperSession {
  readonly developerId: string;
  readonly email: string;
  readonly createdAt: string;
}

export interface AgentView {
  readonly agentId: string;
  readonly name: string;
  readonly status: 'enabled' | 'disabled' | 'revoked';
  readonly signingKey: Readonly<{
    keyId: string;
    algorithm: 'ed25519';
    publicKey: string;
    status: 'active' | 'revoked';
  }>;
  readonly createdAt: string;
  readonly updatedAt: string;
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
  agents: () => request<readonly AgentView[]>('/v1/agents'),
  createAgent: (name: string, publicKey: string) =>
    request<AgentView>('/v1/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, publicKey }),
    }),
  setAgentStatus: (agentId: string, status: 'enabled' | 'disabled') =>
    request<AgentView>(`/v1/agents/${agentId}/status`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
  rotateAgentKey: (agentId: string, publicKey: string) =>
    request<AgentView>(`/v1/agents/${agentId}/rotate-key`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ publicKey }),
    }),
  revokeAgent: (agentId: string) =>
    request<AgentView>(`/v1/agents/${agentId}`, { method: 'DELETE' }),
});
