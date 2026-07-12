import { config } from '../../config.js';
import { all, one, run, setStatus } from '../../db/db.js';
import { centsToDecimal, newId, nowIso } from '../../domain/util.js';
import { audit } from '../audit.js';
import { raiseAlert } from '../alerts.js';
import { getApprover } from '../settings.js';
import { getInvoiceRow } from '../invoices.js';
import { GraphAuthError, graphFetch } from '../graph/graphClient.js';
import { buildAttachmentLink } from '../attachmentLinks.js';

/**
 * Teams Approvals integration. Two providers:
 *  - mock : records the request locally; the UI's approvals simulator plays
 *           the manager and drives the same decision path as Graph would.
 *  - graph: creates an Approvals item via the Microsoft Graph *beta* endpoint
 *           and polls it for the decision. The beta contract should be
 *           verified against current Graph docs before go-live (see README).
 */

interface GraphApprovalItem {
  id: string;
  state?: string; // 'pending' | 'completed' | ...
  result?: string; // 'Approved' | 'Rejected' | custom
  completedDateTime?: string;
}

export async function createApprovalRequest(
  invoiceId: string,
  approverId: string,
  who: string,
): Promise<void> {
  const row = getInvoiceRow(invoiceId);
  if (!row) return;
  const approver = getApprover(approverId);
  const requestId = newId();
  const now = nowIso();

  if (!approver) {
    run(
      `INSERT INTO approval_requests (id, invoice_id, approver_id, provider, status, error, created_at)
       VALUES (?, ?, ?, ?, 'failed', ?, ?)`,
      requestId, invoiceId, approverId, config.approvalsProvider,
      'Approver could not be resolved', now,
    );
    audit(invoiceId, 'approval_failed', 'system', { error: 'approver could not be resolved' });
    await raiseAlert('teams_api_failure', {
      invoiceId,
      vendor: row.vendor_name === null ? null : String(row.vendor_name),
      invoiceRef: row.invoice_ref === null ? null : String(row.invoice_ref),
      error: 'the assigned approver could not be resolved',
    });
    return;
  }

  const title = `Invoice ${row.invoice_ref ?? ''} — ${row.vendor_name ?? 'unknown vendor'} — €${centsToDecimal(
    row.gross_cents === null ? null : Number(row.gross_cents),
  )}`;

  try {
    let externalId: string | null = null;
    if (config.approvalsProvider === 'graph') {
      const item = await graphFetch<GraphApprovalItem>('/solutions/approval/approvalItems', {
        base: 'https://graph.microsoft.com/beta',
        method: 'POST',
        body: JSON.stringify({
          displayName: title,
          description:
            `Category: ${row.category ?? '—'} · PO: ${row.po_number ?? '—'} · ` +
            `Reviewed by ${who} in Finny. ` +
            // Managers are not Finny users — this revocable, logged link shows
            // them the invoice document without an account (expires in 14 days),
            // scoped to this approver.
            `View the invoice: ${buildAttachmentLink(invoiceId, { scope: 'approver', approverId, createdBy: who })}`,
          approvalType: 'basic',
          allowEmailNotification: true,
          approvers: [{ user: { id: approver.teams_user_id ?? undefined, email: approver.email } }],
        }),
      });
      externalId = item.id;
    }

    run(
      `INSERT INTO approval_requests (id, invoice_id, approver_id, provider, external_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      requestId, invoiceId, approverId, config.approvalsProvider, externalId, now,
    );
    run(`UPDATE invoices SET status = 'awaiting_approval', updated_at = ? WHERE id = ?`, now, invoiceId);
    audit(invoiceId, 'approval_created', who, {
      approver: approver.name, provider: config.approvalsProvider, external_id: externalId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run(
      `INSERT INTO approval_requests (id, invoice_id, approver_id, provider, status, error, created_at)
       VALUES (?, ?, ?, ?, 'failed', ?, ?)`,
      requestId, invoiceId, approverId, config.approvalsProvider, message, now,
    );
    audit(invoiceId, 'approval_failed', 'system', { error: message });
    await raiseAlert('teams_api_failure', {
      invoiceId,
      vendor: row.vendor_name === null ? null : String(row.vendor_name),
      invoiceRef: row.invoice_ref === null ? null : String(row.invoice_ref),
      error: message,
    });
  }
}

/** Shared decision path for the mock simulator and the Graph poller. */
export function recordApprovalDecision(
  requestId: string,
  decision: 'approved' | 'rejected',
  deciderName: string,
  note: string | null,
): boolean {
  const request = one('SELECT * FROM approval_requests WHERE id = ?', requestId);
  if (!request || request.status !== 'pending') return false;
  const now = nowIso();
  run(
    `UPDATE approval_requests SET status = ?, decided_at = ?, decided_by_name = ?, decision_note = ? WHERE id = ?`,
    decision, now, deciderName, note, requestId,
  );
  const invoiceId = String(request.invoice_id);
  run(`UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?`, decision, now, invoiceId);
  audit(invoiceId, `approval_${decision}`, deciderName, { note: note ?? undefined });
  return true;
}

/** Poll Graph for decisions on pending approval items (graph provider only). */
export async function pollGraphApprovals(): Promise<void> {
  if (config.approvalsProvider !== 'graph') return;
  const pending = all(
    `SELECT * FROM approval_requests WHERE provider = 'graph' AND status = 'pending' AND external_id IS NOT NULL`,
  );
  for (const request of pending) {
    try {
      const item = await graphFetch<GraphApprovalItem>(
        `/solutions/approval/approvalItems/${String(request.external_id)}`,
        { base: 'https://graph.microsoft.com/beta' },
      );
      if ((item.state ?? '').toLowerCase() === 'completed') {
        const approved = (item.result ?? '').toLowerCase().includes('approv');
        recordApprovalDecision(
          String(request.id),
          approved ? 'approved' : 'rejected',
          'Teams Approvals',
          item.result ?? null,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus('approvals_last_error', message);
      if (err instanceof GraphAuthError) {
        await raiseAlert('teams_api_failure', {
          invoiceId: String(request.invoice_id),
          error: `polling the approval failed: ${message}`,
        });
      }
      return; // try again next poll
    }
  }
  setStatus('approvals_last_poll', nowIso());
  setStatus('approvals_last_error', null);
}
