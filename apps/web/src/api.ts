import type {
  AiModel,
  Alert,
  Approver,
  ApproverDirectory,
  ApproverSyncResult,
  ConnectorStatus,
  DashboardMetrics,
  InvoiceDetail,
  InvoiceSummary,
  Overview,
  ReviewSubmission,
  Rule,
  SageBatch,
  SessionUser,
  Settings,
  TeamDirectory,
  TeamMember,
  TeamRole,
  VolumeMetrics,
} from '@finny/shared';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** GET /sage/reference — live-Sage validation of the Settings mappings. */
export interface SageReferenceCheck {
  configured: boolean;
  entity?: string;
  counts?: { nominals: number; tax_codes: number; departments: number; projects: number };
  validation?: {
    categories: { name: string; nominal_code: string; ok: boolean; sage_name: string | null; inactive: boolean }[];
    tax_codes: { rate: string | null; code: string; ok: boolean; rate_matches: boolean; sage_rate: number | null; sage_description: string | null }[];
    fallback_dept_ok: boolean;
    projects: { code: string; name: string; dept: string; in_sage: boolean; dept_ok: boolean; sage_name: string | null }[];
    missing_projects: { reference: string; name: string }[];
  };
}

let reqSeq = 0;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // This app is dynamic and per-user, but a caching layer on the custom domain
  // was serving stale authenticated GETs — e.g. the team list reverting to an
  // old snapshot after an edit, because the browser/CDN answered the refetch
  // from cache instead of the server. Make every GET uncacheable end-to-end:
  // `cache: 'no-store'` bypasses the browser HTTP cache, and a unique query
  // param stops any edge "Cache Everything" rule from matching a cached URL.
  const isGet = !init?.method || init.method.toUpperCase() === 'GET';
  const url = `/api${path}` + (isGet ? `${path.includes('?') ? '&' : '?'}_=${Date.now()}.${++reqSeq}` : '');
  const res = await fetch(url, {
    headers: init?.body && !(init.body instanceof Blob) ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep default */
    }
    throw new ApiError(message, res.status);
  }
  return (await res.json()) as T;
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export const api = {
  me: () => get<SessionUser>('/me'),
  authMode: () => get<{ provider: 'dev' | 'entra' }>('/auth/mode'),
  devLogin: (user: SessionUser) => post<SessionUser>('/auth/dev-login', user),
  logout: () => post<{ ok: boolean }>('/auth/logout'),

  overview: () => get<Overview>('/overview'),
  status: () => get<ConnectorStatus>('/status'),

  invoices: (tab: string) => get<InvoiceSummary[]>(`/invoices?tab=${encodeURIComponent(tab)}`),
  invoice: (id: string) => get<InvoiceDetail>(`/invoices/${id}`),
  review: (id: string, submission: ReviewSubmission) =>
    post<InvoiceDetail>(`/invoices/${id}/review`, submission),
  retryExtraction: (id: string) => post<{ ok: boolean }>(`/invoices/${id}/retry-extraction`),
  reopenInvoice: (id: string) => post<InvoiceDetail>(`/invoices/${id}/reopen`),
  retryApproval: (id: string) => post<InvoiceDetail>(`/invoices/${id}/retry-approval`),
  upload: async (file: File): Promise<{ id: string }> => {
    const res = await fetch(`/api/invoices/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      body: file,
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
    });
    if (!res.ok) throw new ApiError('Upload failed', res.status);
    return (await res.json()) as { id: string };
  },

  rules: (status?: string) => get<Rule[]>(`/rules${status ? `?status=${status}` : ''}`),
  createRule: (body: {
    kind: 'routing' | 'extraction_hint';
    vendor: string;
    category?: string | null;
    approver_id?: string | null;
    hint_text?: string | null;
  }) => post<Rule>('/rules', body),
  updateRule: (id: string, body: Partial<Rule>) => patch<Rule>(`/rules/${id}`, body),
  decideRule: (id: string, decision: 'approve' | 'reject') => post<Rule>(`/rules/${id}/decide`, { decision }),
  retireRule: (id: string) => post<Rule>(`/rules/${id}/retire`),

  alerts: (status?: string) => get<Alert[]>(`/alerts${status ? `?status=${status}` : ''}`),
  ackAlert: (id: string) => post<Alert>(`/alerts/${id}/ack`),
  resolveAlert: (id: string) => post<Alert>(`/alerts/${id}/resolve`),

  exportPool: () => get<InvoiceSummary[]>('/exports/pool'),
  batches: () => get<SageBatch[]>('/exports'),
  generateBatches: (invoiceIds: string[]) => post<SageBatch[]>('/exports', { invoice_ids: invoiceIds }),
  sendBatch: (id: string) =>
    post<{
      batch: SageBatch;
      summary: {
        posted: number;
        adopted: number;
        duplicates: number;
        reassigned: number;
        skipped: number;
        failed: number;
      };
    }>(`/exports/${id}/send`),
  markImported: (id: string) => post<SageBatch>(`/exports/${id}/mark-imported`),
  sageReference: (entity?: string) =>
    get<SageReferenceCheck>(`/sage/reference${entity ? `?entity=${encodeURIComponent(entity)}` : ''}`),
  sageNominals: () => get<{ summary: { entity: string; count: number; pulled_at: string }[] }>('/sage/nominals'),
  pullNominals: (entity?: string) =>
    post<{ entity: string; pulled: number; categories: { name: string; nominal_code: string }[] }>(
      '/sage/nominals/pull',
      { entity: entity ?? '' },
    ),

  dashboard: () => get<DashboardMetrics>('/metrics/dashboard'),
  volume: (from: string, to: string) => get<VolumeMetrics>(`/metrics/volume?from=${from}&to=${to}`),

  settings: () => get<Settings>('/settings'),
  updateSettings: (patchBody: Partial<Settings>) => patch<Settings>('/settings', patchBody),
  setAnthropicKey: (key: string) =>
    post<{ set: boolean; source: 'settings' | 'env' | 'none' }>('/settings/anthropic-key', { key }),
  testWebhook: () => post<{ ok: boolean; host: string | null }>('/settings/webhook-test', {}),
  aiModels: () => get<AiModel[]>('/models'),
  approvers: () => get<Approver[]>('/approvers'),
  addApprover: (body: { name: string; email: string }) => post<Approver>('/approvers', body),
  updateApprover: (id: string, body: Partial<Approver>) => patch<Approver>(`/approvers/${id}`, body),
  approversDirectory: () => get<ApproverDirectory>('/approvers/directory'),
  syncApprovers: () => post<ApproverSyncResult>('/approvers/sync'),

  team: () => get<TeamDirectory>('/team'),
  syncTeam: () => post<TeamDirectory>('/team/sync'),
  setTeamRole: (email: string, role: TeamRole) => patch<TeamMember>('/team', { email, role }),

  simulateInvoice: (scenario: string, count = 1) => post<{ ids: string[] }>('/simulate/invoice', { scenario, count }),
  simulateApproval: (invoiceId: string, decision: 'approved' | 'rejected', note?: string) =>
    post<InvoiceDetail>('/simulate/approval-decision', { invoice_id: invoiceId, decision, note }),
};
