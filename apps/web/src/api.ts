import type {
  Alert,
  Approver,
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
} from '@finny/shared';

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: init?.body && !(init.body instanceof Blob) ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
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
  devLogin: (user: SessionUser) => post<SessionUser>('/auth/dev-login', user),
  logout: () => post<{ ok: boolean }>('/auth/logout'),

  overview: () => get<Overview>('/overview'),
  status: () => get<ConnectorStatus>('/status'),

  invoices: (tab: string) => get<InvoiceSummary[]>(`/invoices?tab=${encodeURIComponent(tab)}`),
  invoice: (id: string) => get<InvoiceDetail>(`/invoices/${id}`),
  review: (id: string, submission: ReviewSubmission) =>
    post<InvoiceDetail>(`/invoices/${id}/review`, submission),
  retryExtraction: (id: string) => post<{ ok: boolean }>(`/invoices/${id}/retry-extraction`),
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
  markImported: (id: string) => post<SageBatch>(`/exports/${id}/mark-imported`),

  dashboard: () => get<DashboardMetrics>('/metrics/dashboard'),

  settings: () => get<Settings>('/settings'),
  updateSettings: (patchBody: Partial<Settings>) => patch<Settings>('/settings', patchBody),
  approvers: () => get<Approver[]>('/approvers'),
  addApprover: (body: { name: string; email: string }) => post<Approver>('/approvers', body),
  updateApprover: (id: string, body: Partial<Approver>) => patch<Approver>(`/approvers/${id}`, body),

  simulateInvoice: (scenario: string, count = 1) => post<{ ids: string[] }>('/simulate/invoice', { scenario, count }),
  simulateApproval: (invoiceId: string, decision: 'approved' | 'rejected', note?: string) =>
    post<InvoiceDetail>('/simulate/approval-decision', { invoice_id: invoiceId, decision, note }),
};
