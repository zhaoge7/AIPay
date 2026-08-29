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

export interface MerchantView {
  readonly merchantId: string;
  readonly name: string;
  readonly callbackUrl: string;
  readonly status: 'active' | 'suspended' | 'closed';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ServiceView {
  readonly serviceId: string;
  readonly merchantId: string;
  readonly type: 'api' | 'mcp' | 'skill';
  readonly name: string;
  readonly category: string;
  readonly unit: string;
  readonly unitPrice: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly refundPolicy: 'full_on_delivery_failure' | 'non_refundable';
  readonly status: 'enabled' | 'disabled';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ServiceInput {
  readonly type: ServiceView['type'];
  readonly name: string;
  readonly category: string;
  readonly unit: string;
  readonly unitPrice: Readonly<{ currency: 'CNY'; amountMinor: string }>;
  readonly refundPolicy: ServiceView['refundPolicy'];
}

export interface MoneyView {
  readonly currency: 'CNY';
  readonly amountMinor: string;
}

export interface MandateView {
  readonly mandateId: string;
  readonly principalId: string;
  readonly agentId: string;
  readonly purpose: string;
  readonly allowedMerchantIds: readonly string[];
  readonly allowedCategories: readonly string[];
  readonly maxPerTransaction: MoneyView;
  readonly totalBudget: MoneyView;
  readonly approvalRequiredAbove: MoneyView;
  readonly maxTransactions: number;
  readonly issuedAt: string;
  readonly validUntil: string;
  readonly instructionHash: string;
  readonly status: 'draft' | 'active' | 'paused' | 'revoked' | 'expired';
  readonly createdAt: string;
  readonly spentAmount: MoneyView;
  readonly reservedAmount: MoneyView;
  readonly completedTransactionCount: number;
  readonly reservedTransactionCount: number;
  readonly statusChangedAt: string;
  readonly revokedAt: string | null;
}

export interface MandateInput {
  readonly agentId: string;
  readonly purpose: string;
  readonly allowedMerchantIds: readonly string[];
  readonly allowedCategories: readonly string[];
  readonly maxPerTransaction: MoneyView;
  readonly totalBudget: MoneyView;
  readonly approvalRequiredAbove: MoneyView;
  readonly maxTransactions: number;
  readonly validUntil: string;
  readonly instructionHash: string;
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
  merchants: () => request<readonly MerchantView[]>('/v1/merchants'),
  createMerchant: (name: string, callbackUrl: string) =>
    request<MerchantView>('/v1/merchants', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, callbackUrl }),
    }),
  services: (merchantId: string) =>
    request<readonly ServiceView[]>(`/v1/merchants/${merchantId}/services`),
  createService: (merchantId: string, input: ServiceInput) =>
    request<ServiceView>(`/v1/merchants/${merchantId}/services`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  updateService: (
    merchantId: string,
    serviceId: string,
    input: Partial<ServiceInput> & {
      readonly status?: ServiceView['status'];
    },
  ) =>
    request<ServiceView>(`/v1/merchants/${merchantId}/services/${serviceId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  mandates: () => request<readonly MandateView[]>('/v1/mandates'),
  createMandate: (input: MandateInput) =>
    request<MandateView>('/v1/mandates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  issueMandate: (mandateId: string) =>
    request<Readonly<{ readonly mandateId: string }>>(`/v1/mandates/${mandateId}/issue`, {
      method: 'POST',
    }),
  mandate: (mandateId: string) => request<MandateView>(`/v1/mandates/${mandateId}`),
});
