import { config } from '../../config.js';
import { isValidWebhookUrl, urlHost } from '../teamsWebhook.js';

/**
 * Raising Teams Approvals through an HTTP-triggered Power Automate flow.
 *
 * Why not Microsoft Graph: the Graph Approvals API
 * (POST /beta/solutions/approval/approvalItems) supports DELEGATED permissions
 * only — "Application: Not supported" in Microsoft's own permissions table — so
 * Finny's client-credentials token can never carry the required scope and every
 * create returns 401 "required scope(s) or role(s) not present". No permission
 * grant fixes that. It is also beta-only and absent from Graph v1.0.
 *
 * A flow runs "Start and wait for an approval" under a service account's own
 * connection, which is the supported production path and needs no per-user
 * token storage. Finny POSTs the request; the flow POSTs the decision back to
 * /api/integrations/approvals/callback with the shared bearer token.
 */

export interface ApprovalFlowRequest {
  /**
   * Authenticates Finny to the flow. The flow's first action compares this to
   * its own copy and terminates on a mismatch — the trigger URL's signature is
   * otherwise the only thing standing between a leaked URL and anyone raising
   * Teams approvals that genuinely appear to come from Finny.
   */
  sharedSecret: string;
  /** Finny's approval_requests.id — echoed back on the callback to correlate. */
  requestId: string;
  invoiceId: string;
  title: string;
  description: string;
  approverName: string;
  approverEmail: string;
  /** Revocable, scoped, TTL-capped link letting the approver see the document. */
  documentUrl: string;
  /**
   * DEPRECATED — the flow must hardcode its callback URL instead of reading
   * this. Using an attacker-controllable value as the destination for a request
   * that carries APPROVALS_CALLBACK_TOKEN lets anyone who can trigger the flow
   * redirect that token to a server of their choosing. Still sent so an
   * existing flow keeps working while it is updated; ignore it.
   */
  callbackUrl: string;
  // Never null. The flow's trigger validates the body against a JSON Schema
  // generated from a sample payload, which types every field as String — a null
  // is rejected outright with TriggerInputSchemaMismatch and no approval is
  // raised. Most invoices legitimately lack a PO or project, so nulls here
  // would fail approvals for the majority of invoices, not a rare few. An
  // absent value is an empty string, which the flow renders as blank anyway.
  vendor: string;
  invoiceRef: string;
  amount: string;
  category: string;
  poNumber: string;
}

export function approvalsFlowConfigured(): boolean {
  return Boolean(config.approvalsFlowUrl);
}

/**
 * Where the flow posts the decision. APP_URL by default; override with
 * APPROVALS_CALLBACK_BASE_URL when APP_URL sits behind a CDN/WAF that
 * challenges machine callers — see config.ts. Trailing slashes are stripped so
 * the operator can paste either form without producing a double slash that a
 * strict router would 404.
 */
export function approvalCallbackUrl(): string {
  const base = (config.approvalsCallbackBaseUrl || config.appUrl).replace(/\/+$/, '');
  return `${base}/api/integrations/approvals/callback`;
}

/** Host of the configured flow — for the UI. Never the signed URL itself. */
export function approvalsFlowInfo(): { configured: boolean; host: string | null } {
  const url = config.approvalsFlowUrl;
  return { configured: Boolean(url), host: url ? urlHost(url) : null };
}

/**
 * Hand one approval to the flow. Resolves when the flow has accepted it —
 * NOT when a human decides, which arrives later on the callback.
 *
 * A "when an HTTP request is received" trigger answers 202 with no body unless
 * the flow author adds a Response action, so any 2xx counts as accepted and the
 * body is never required. (Assuming a JSON body here is precisely what broke
 * the Graph path: it expected 200-with-body from an endpoint that answers 202.)
 */
export async function sendApprovalToFlow(request: ApprovalFlowRequest): Promise<void> {
  const url = config.approvalsFlowUrl;
  if (!url) throw new Error('APPROVALS_FLOW_URL is not set — no approval flow to call');
  if (!isValidWebhookUrl(url)) {
    throw new Error('Refusing to post: APPROVALS_FLOW_URL is not an allowed Microsoft endpoint');
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    // Don't follow a redirect off the validated host, and don't hang forever.
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    // Never surface the upstream body: echoed into a stored error that is an
    // internal-response read oracle. Log server-side, return the status only.
    const body = await res.text().catch(() => '');
    if (body) console.error(`[approvals] flow ${urlHost(url)} error body:`, body.slice(0, 300));
    throw new Error(`Approval flow returned HTTP ${res.status}`);
  }
}
